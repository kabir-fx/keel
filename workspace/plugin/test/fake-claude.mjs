// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// It records how it was started to $FAKE_CLAUDE_LOG, and answers each user line the way the
// real one does: an init line, an assistant tool call, a tool result, a result line.
//   A wake that holds "CRASH" makes it die mid-turn.
//   A session id listed in $FAKE_CLAUDE_GONE cannot be resumed.
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
  out({
    type: 'assistant',
    session_id: session,
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'mcp__board__board_post',
          input: { pictures: [{ picture: { kind: 'text', title: 'How I read your note' }, answers: ['m1'] }] },
        },
      ],
    },
  });
  if (text.includes('CRASH')) {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Posted: a-abc123' }] } });
  out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'done' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: session, duration_ms: 12, total_cost_usd: 0.0012 });
});
rl.on('close', () => {
  log({ closed: true, pid: process.pid });
  process.exit(0);
});
