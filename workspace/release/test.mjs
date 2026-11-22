#!/usr/bin/env node
// Prove the package works once installed: pack it, install the tarball into a temp prefix,
// and run the installed keel-board. Build first (npm run build): this packs with --no-build.
// node release/test.mjs [tarball]
// With a tarball, it proves that file and stages nothing: the release proves the file it uploads.
// Everything it makes is in one temp folder, removed at the end. It never publishes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.dirname(HERE);
const STAGED = path.join(HERE, 'keel-workspace');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-package-test-')));
const CACHE = path.join(TMP, 'cache');
const PREFIX = path.join(TMP, 'prefix');
const STATE = path.join(TMP, 'state');
const EMPTY = path.join(TMP, 'empty');
const BIN = path.join(PREFIX, 'bin', 'keel-board');

let failed = false;
let server;

function line(ok, what, why) {
  if (!ok) failed = true;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}${why ? `: ${why}` : ''}\n`);
  return ok;
}

/** A step the rest needs: when it fails, the test ends here. */
class Stop extends Error {}
function must(ok, what, why) {
  if (!line(ok, what, why)) throw new Stop();
}

/** npm, kept to the temp folder: its own cache, no update check, no audit. */
function npm(args, opts = {}) {
  return spawnSync('npm', [...args, '--cache', CACHE, '--no-update-notifier', '--no-audit', '--no-fund'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function tail(r) {
  return `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim().split('\n').slice(-8).join(' | ');
}

/** The environment of the installed command: its own state folder, and no override of what it loads. */
function boardEnv() {
  const env = { ...process.env, KEEL_STATE_DIR: STATE };
  delete env.KEEL_BOARD_LINK;
  delete env.KEEL_BOARD_SOURCE;
  return env;
}

/** The files the package must hold, and nothing else. */
function expectedFiles() {
  const out = new Set([
    'package.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'server/bin/keel-board.mjs',
    'server/dist/keel-board.js',
    'plugin/dist/board-mcp.js',
    'plugin/dist/hosted-link.js',
    'plugin/dist/hosted-builder.js',
    'plugin/skills/board/SKILL.md',
    'plugin/skills/board/grammar.md',
    'plugin/skills/board/builder.md',
  ]);
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(WS, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.add(r);
    }
  };
  walk('app/dist');
  return out;
}

async function main() {
  // 1. Stage, then pack into the temp folder. A tarball that was handed in is read as it is.
  const given = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!given) {
    const packed = spawnSync(process.execPath, [path.join(HERE, 'pack.mjs'), '--no-build'], { encoding: 'utf8' });
    must(packed.status === 0, 'stage the package (release/pack.mjs --no-build)', packed.status === 0 ? '' : tail(packed));
  }

  const out = given ? npm(['pack', given, '--json', '--dry-run'], { cwd: TMP }) : npm(['pack', '--json', '--pack-destination', TMP], { cwd: STAGED });
  let info;
  try {
    info = JSON.parse(out.stdout)[0];
  } catch {
    // Said below.
  }
  const tarball = given || (info ? path.join(TMP, info.filename) : '');
  must(out.status === 0 && info && fs.existsSync(tarball), given ? `read ${given}` : 'npm pack', out.status === 0 ? '' : tail(out));
  line(true, `tarball ${info.filename}`, `${info.size} bytes packed, ${info.unpackedSize} bytes unpacked, ${info.entryCount} files`);

  // 2. Exactly the expected files: no source, no node_modules, no test, nothing private.
  const got = info.files.map((f) => f.path).sort();
  const want = [...expectedFiles()].sort();
  const extra = got.filter((f) => !want.includes(f));
  const lacking = want.filter((f) => !got.includes(f));
  line(extra.length === 0 && lacking.length === 0, 'the tarball holds exactly the expected files', [
    extra.length ? `extra: ${extra.join(', ')}` : '',
    lacking.length ? `missing: ${lacking.join(', ')}` : '',
  ].filter(Boolean).join('; '));
  const bad = got.filter((f) => /(^|\/)(node_modules|src|test|tests|e2e|docs)\//.test(f) || /\.(ts|tsx)$/.test(f) || f.split('/').some((p) => p.startsWith('.')));
  line(bad.length === 0, 'no source, test, node_modules or dot file in the tarball', bad.join(', '));
  const launcher = info.files.find((f) => f.path === 'server/bin/keel-board.mjs');
  line(Boolean(launcher && (launcher.mode & 0o111) === 0o111), 'the launcher is executable in the tarball', launcher ? `mode ${launcher.mode.toString(8)}` : 'not there');

  // 3. Install into a temp prefix. Offline first: the package has no dependencies.
  const install = (extraArgs) => npm(['install', '-g', '--prefix', PREFIX, ...extraArgs, tarball], { cwd: TMP });
  let inst = install(['--offline']);
  if (inst.status === 0) {
    line(true, 'npm install -g --offline into a temp prefix');
  } else {
    line(true, 'npm install -g --offline did not work, so a normal install is tried', tail(inst));
    inst = install([]);
    must(inst.status === 0, 'npm install -g into a temp prefix', inst.status === 0 ? '' : tail(inst));
  }
  must(fs.existsSync(BIN), `the command is at ${BIN}`);
  const installed = path.join(PREFIX, 'lib', 'node_modules', 'keel-workspace');
  const target = fs.realpathSync(BIN);
  must(target === path.join(installed, 'server', 'bin', 'keel-board.mjs'), 'the command runs the installed launcher', target);
  line(!fs.existsSync(path.join(installed, 'node_modules')), 'the install has no node_modules of its own');

  // 4a. --help.
  const help = spawnSync(BIN, ['--help'], { encoding: 'utf8', env: boardEnv(), cwd: TMP });
  line(help.status === 0 && /^keel-board: the board server for one repository\./.test(help.stdout) && /keel-board \[open\]/.test(help.stdout), 'keel-board --help prints the usage', help.status === 0 ? '' : tail(help));

  // 4b. The bare command in an empty folder opens that folder, with the agent and builder from the package.
  fs.mkdirSync(EMPTY);
  server = spawn(BIN, ['--no-browser', '--port', '0', '--link-opt', 'bin=/usr/bin/false'], { cwd: EMPTY, env: boardEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '';
  let se = '';
  server.stdout.on('data', (c) => (so += c));
  server.stderr.on('data', (c) => (se += c));
  const exited = new Promise((r) => server.on('exit', (code, signal) => r({ code, signal })));
  const started = await Promise.race([
    (async () => {
      while (!/^http:\/\/127\.0\.0\.1:\d+\/\?code=\S+$/m.test(so) || !/agent: /.test(se)) await new Promise((r) => setTimeout(r, 50));
      return true;
    })(),
    exited.then(() => false),
    new Promise((r) => setTimeout(() => r(false), 20_000)),
  ]);
  must(started, 'keel-board (no command word) starts in an empty folder and prints an address', started ? '' : `stdout: ${so.trim()} | stderr: ${se.trim()}`);
  const url = so.match(/^(http:\/\/127\.0\.0\.1:(\d+))\/\?code=\S+$/m);
  const status = se.split('\n').find((l) => l.startsWith('Board "')) ?? '';
  line(/ · agent: claude \(/.test(status), 'the status line names the hosted agent', status);
  line(/ · builder: (?!none)\S/.test(status), 'the status line names a builder', status);
  const boardDir = path.join(EMPTY, '.keel', 'board');
  line(status.endsWith(boardDir) && fs.statSync(boardDir, { throwIfNoEntry: false })?.isDirectory() === true, 'the board is in the folder it ran in', boardDir);
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(server.pid)], { encoding: 'utf8' });
  line(ps.stdout.includes(PREFIX), 'the process runs from the temp prefix', ps.stdout.trim());
  try {
    const res = await fetch(`${url[1]}/`);
    const body = await res.text();
    line(res.status === 200 && /html/.test(res.headers.get('content-type') ?? '') && /<html/i.test(body), 'GET / answers the page from the package', `HTTP ${res.status}`);
  } catch (e) {
    line(false, 'GET / answers the page from the package', e instanceof Error ? e.message : String(e));
  }

  server.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 10_000))]);
  line(end?.code === 0, 'SIGTERM stops it, with exit 0', end ? `code ${end.code}, signal ${end.signal}` : 'it did not stop within 10 s');

  // 4c. status after the stop: no server, no crash.
  const st = spawnSync(BIN, ['status'], { encoding: 'utf8', env: boardEnv(), cwd: EMPTY });
  line(/No board server runs/.test(st.stderr) && !/\n\s+at /.test(st.stderr) && st.signal === null, 'keel-board status says no server runs', `exit ${st.status}: ${st.stderr.trim()}`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) line(false, 'the test itself', e instanceof Error ? e.stack : String(e));
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    line(false, 'the server had to be killed');
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.stdout.write(`PACKAGE TEST · ${failed ? 'FAIL' : 'pass'}\n`);
process.exitCode = failed ? 1 : 0;
