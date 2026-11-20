// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// It records how it was started to $FAKE_CLAUDE_LOG, and answers each user line the way the
// real one does: an init line, an assistant tool call, a tool result, a result line.
// Started with --include-partial-messages, it also writes each message as it is written, in the
// shapes Claude Code 2.1.329 wrote on 2026-11-20: `stream_event` lines that start a block, add to
// it and stop it, around the whole `assistant` line.
//   A wake that holds "CRASH" makes it die mid-turn. One that holds "THINK" thinks before its last words.
//   A session id listed in $FAKE_CLAUDE_GONE cannot be resumed.
//   $FAKE_CLAUDE_STREAM=old: an older claude, which writes no `stream_event` line whatever the flags.
//   $FAKE_CLAUDE_STREAM=junk: malformed `stream_event` lines among the real ones.
//   $FAKE_CLAUDE_STREAM=late: a block's pieces come after its whole line, which the real one never does.
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const log = (rec) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(rec)}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const resume = flag('--resume');
const session = resume ?? flag('--session-id');

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
log({
  start: true,
  pid: process.pid,
  args,
  cwd: process.cwd(),
  leaked: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE') || k === 'ANTHROPIC_API_KEY'),
  skill: read(flag('--append-system-prompt-file')),
  mcp: read(flag('--mcp-config')),
  settings: read(flag('--settings')),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_CODE_DISABLE_'))),
});

if (resume && (process.env.FAKE_CLAUDE_GONE ?? '').split(',').includes(resume)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
let inited = false;

const mode = process.env.FAKE_CLAUDE_STREAM ?? '';
const partial = args.includes('--include-partial-messages') && mode !== 'old';
const late = mode === 'late';
let n = 0;
const event = (e) => out({ type: 'stream_event', event: e, session_id: session, parent_tool_use_id: null, uuid: `u${++n}` });
const JUNK = [
  { type: 'stream_event' },
  { type: 'stream_event', event: null },
  { type: 'stream_event', event: 'content_block_start' },
  { type: 'stream_event', event: [1, 2] },
  { type: 'stream_event', event: { type: 'content_block_start' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: null } },
  { type: 'stream_event', event: { type: 'content_block_start', index: '0', content_block: { type: 'tool_use', name: 'mcp__board__board_read' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 7 } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: null } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 5 } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"pictures":[{"picture":{"kind":"spread"' } } },
];
const junk = () => {
  if (mode === 'junk') for (const j of JUNK) out(j);
};

/**
 * One assistant message of one block. With partial messages: the message starts, the block
 * starts empty, its text or input comes in pieces, the whole `assistant` line, then the stops.
 */
function message(block, pieces) {
  const whole = { type: 'assistant', session_id: session, message: { id: `msg_${++n}`, content: [block] } };
  if (!partial) return out(whole);
  event({ type: 'message_start', message: { id: whole.message.id, type: 'message', role: 'assistant', content: [] } });
  junk();
  const empty = block.type === 'tool_use' ? { ...block, input: {}, caller: { type: 'direct' } } : block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' };
  event({ type: 'content_block_start', index: 0, content_block: empty });
  junk();
  if (!late) for (const piece of pieces) event({ type: 'content_block_delta', index: 0, delta: piece });
  out(whole);
  if (late) for (const piece of pieces) event({ type: 'content_block_delta', index: 0, delta: piece });
  event({ type: 'content_block_stop', index: 0 });
  event({ type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 51 } });
  event({ type: 'message_stop' });
}

/** The input as the model writes it: an empty piece first, then a few characters at a time. */
function inputPieces(input) {
  const text = JSON.stringify(input);
  const pieces = [{ type: 'input_json_delta', partial_json: '' }];
  for (let i = 0; i < text.length; i += 9) pieces.push({ type: 'input_json_delta', partial_json: text.slice(i, i + 9) });
  return pieces;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = msg.message?.content ?? '';
  log({ wake: text, pid: process.pid });
  if (!inited) {
    inited = true;
    out({ type: 'system', subtype: 'init', session_id: session, mcp_servers: [{ name: 'board', status: 'connected' }] });
  }
  const input = { pictures: [{ picture: { kind: 'text', title: 'How I read your note' }, answers: ['m1'] }] };
  message({ type: 'tool_use', id: 'tu1', name: 'mcp__board__board_post', input }, inputPieces(input));
  if (text.includes('CRASH')) {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Posted: a-abc123' }] } });
  if (text.includes('THINK')) message({ type: 'thinking', thinking: '', signature: 'sig' }, [{ type: 'thinking_delta', thinking: '' }, { type: 'signature_delta', signature: 'sig' }]);
  message({ type: 'text', text: 'done' }, [{ type: 'text_delta', text: 'done' }]);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: session, duration_ms: 12, total_cost_usd: 0.0012 });
});
rl.on('close', () => {
  log({ closed: true, pid: process.pid });
  process.exit(0);
});
