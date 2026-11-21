// A stand-in for the builder's `claude -p --input-format stream-json --output-format stream-json`.
// It starts the board tools from its --mcp-config, as the real one does, and builds each part it
// is sent the way the builder's instructions say: board_part "building", a file, a git commit,
// board_check, board_update. It records how it was started to $FAKE_CLAUDE_LOG.
//   $FAKE_DENY=1      every turn reports a denied shell command.
//   $FAKE_SLOW_MS=n   each turn waits n ms before it ends.
//   $FAKE_FAIL_PART=x the part x gets a file that makes the check fail.
//   $FAKE_NO_COMMIT=1 no commit is made, so board_check refuses.
//   $FAKE_FILES={...} the first part also commits these files, by path, with their text.
//   $FAKE_LINKS={...} and these symbolic links, by path, with their target.
//   $FAKE_START_FIX={...} a turn that says the app does not start commits these files.
//   $FAKE_RESOLVE={...}   a turn that asks to join the home branch writes these files, adds and commits them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const log = (rec) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(rec)}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const mcpFile = flag('--mcp-config');
const mcp = JSON.parse(read(mcpFile) ?? '{}');
log({
  start: true,
  pid: process.pid,
  args,
  cwd: process.cwd(),
  leaked: Object.keys(process.env).filter((k) => (k.startsWith('CLAUDE') && !k.startsWith('CLAUDE_CODE_DISABLE_')) || k === 'ANTHROPIC_API_KEY' || k.startsWith('KEEL_')),
  prompt: read(flag('--append-system-prompt-file')),
  mcpFile,
  mcp,
  settings: read(flag('--settings')),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_CODE_DISABLE_') || k.startsWith('GIT_AUTHOR') || k === 'MCP_TOOL_TIMEOUT')),
});

const server = mcp.mcpServers.board;
const client = new Client({ name: 'fake-claude', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env }, stderr: 'ignore' }));

const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
let n = 0;
async function tool(name, input) {
  const id = `tu${++n}`;
  out({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id, name: `mcp__board__${name}`, input }] } });
  const r = await client.callTool({ name, arguments: input });
  const text = r.content.map((c) => c.text).join('\n');
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: r.isError === true, content: [{ type: 'text', text }] }] } });
  log({ tool: name, input, isError: r.isError === true, text });
  return { text, isError: r.isError === true };
}
const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let inited = false;
let extrasDone = false;
let spent = 0;
let busy = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  busy = busy.then(() => turn(line));
});
rl.on('close', async () => {
  await busy;
  log({ closed: true, pid: process.pid });
  await client.close();
  process.exit(0);
});

async function turn(line) {
  if (!line.trim()) return;
  const text = JSON.parse(line).message?.content ?? '';
  log({ turn: text, pid: process.pid });
  if (!inited) {
    inited = true;
    out({ type: 'system', subtype: 'init', session_id: 'fake', mcp_servers: [{ name: 'board', status: 'connected' }] });
  }
  const part = /\(`([a-z0-9-]+)`\)/.exec(text)?.[1] ?? /Part `([a-z0-9-]+)`/.exec(text)?.[1];
  const fix = text.startsWith('THE APP DOES NOT START') ? process.env.FAKE_START_FIX : text.startsWith('JOIN ') ? process.env.FAKE_RESOLVE : undefined;
  if (fix) {
    const files = JSON.parse(fix);
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    git('add', '--', ...Object.keys(files));
    if (text.startsWith('JOIN ')) git('commit', '--quiet', '--no-edit');
    else git('commit', '--quiet', '-m', 'the app starts');
  } else if (part) {
    if (!/building already/.test(text) && !/^Part `/.test(text)) await tool('board_part', { part, state: 'building' });
    if (!process.env.FAKE_NO_COMMIT) {
      fs.mkdirSync('parts', { recursive: true });
      const bad = process.env.FAKE_FAIL_PART === part;
      fs.writeFileSync(path.join('parts', `${part}.txt`), bad ? 'FAIL\n' : `the ${part} part\n`);
      let extra = [];
      if (!extrasDone) {
        extrasDone = true;
        const files = JSON.parse(process.env.FAKE_FILES ?? '{}');
        const links = JSON.parse(process.env.FAKE_LINKS ?? '{}');
        for (const [f, text] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, text);
        }
        for (const [f, target] of Object.entries(links)) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.symlinkSync(target, f);
        }
        extra = [...Object.keys(files), ...Object.keys(links)];
      }
      await tool('board_try', {});
      git('add', 'parts');
      if (extra.length) git('add', '-f', '--', ...extra);
      git('commit', '--quiet', '-m', `${part}: the part`);
    }
    const check = await tool('board_check', { part });
    if (!check.isError) await tool('board_update', { text: `The ${part} part is in.`, part });
  }
  if (process.env.FAKE_SLOW_MS) await sleep(Number(process.env.FAKE_SLOW_MS));
  const denials = process.env.FAKE_DENY ? [{ tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'rm -rf build' } }] : [];
  out({ type: 'assistant', message: { id: `m${++n}`, content: [{ type: 'text', text: 'done' }] } });
  // Like the real stream: the session's running total, not the turn's own cost.
  spent += 0.01;
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 5, total_cost_usd: spent, permission_denials: denials });
}
