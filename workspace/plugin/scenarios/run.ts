// Run one recorded board against the real agent: seed a copy of uLLM with a cut of the
// golden log, start the real board server with the hosted link, let the agent answer the
// wake, then check the log. One run is one real agent turn on the signed-in subscription.
//
//   npx tsx scenarios/run.ts <a|b|c|d> [model=opus] [effort=low] ...   (from workspace/plugin)
//
// Build first, from workspace/: npm run build. KEEP=1 keeps the temporary repository.
// ULLM points at the uLLM repository (default: ../uLLM beside keel). It is only read.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLog } from '@keel/protocol';
import type { BoardSpec } from './boards';
import { BOARDS, FIXTURE_DIR, ULLM_COMMIT, seedEvents, splitSeed } from './boards';
import { checkRun, report } from './check';
import { RUNS, WORKSPACE, missingBuild, oneTurn, readTranscript } from './serve';

const KEEL = path.join(WORKSPACE, '..');
const CACHE = path.join(RUNS, '.cache', 'ullm');
const ULLM = process.env.ULLM ?? path.join(KEEL, '..', 'uLLM');

const say = (line: string) => process.stdout.write(`${line}\n`);

function sh(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer } = {}): Buffer {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${String(r.stderr)}`);
  return r.stdout;
}

/** A copy of uLLM at the commit before the engine loop, with no history to read ahead in. */
function repoCopy(into: string): void {
  if (!fs.existsSync(path.join(CACHE, 'HEAD')) && !fs.existsSync(path.join(CACHE, '.git'))) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    say(`Cloning ${ULLM} into ${CACHE} (once).`);
    sh('git', ['clone', '--quiet', '--no-checkout', ULLM, CACHE]);
  }
  fs.mkdirSync(into, { recursive: true });
  const tar = sh('git', ['-C', CACHE, 'archive', '--format=tar', ULLM_COMMIT]);
  sh('tar', ['-x', '-C', into], { input: tar });
}

function seed(repo: string, board: BoardSpec): void {
  const dir = path.join(repo, '.keel', 'board');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  // The owner's last moves go in live, after the server starts: see splitSeed.
  fs.writeFileSync(path.join(dir, 'log.jsonl'), `${splitSeed(board).disk.join('\n')}\n`);
  for (const f of fs.readdirSync(path.join(FIXTURE_DIR, 'assets'))) {
    fs.copyFileSync(path.join(FIXTURE_DIR, 'assets', f), path.join(dir, 'assets', f));
  }
}

async function main(): Promise<number> {
  const [which, ...rest] = process.argv.slice(2);
  const board = BOARDS[which as BoardSpec['id']];
  if (!board) {
    say(`Usage: npx tsx scenarios/run.ts <${Object.keys(BOARDS).join('|')}> [key=value ...]`);
    return 2;
  }
  const missing = missingBuild();
  if (missing) {
    say(missing);
    return 2;
  }
  const opts = Object.fromEntries(rest.map((kv) => kv.split('=') as [string, string]));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(RUNS, `${board.id}-${stamp}${opts.model ? `-${opts.model}` : ''}`);
  fs.mkdirSync(out, { recursive: true });
  const transcript = path.join(out, 'transcript.jsonl');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-scenario-'));
  const repo = path.join(tmp, 'uLLM');
  say(`Board ${board.id}: ${board.title}. Repository ${repo} at ${ULLM_COMMIT}, seed up to ${board.cut}.`);
  repoCopy(repo);
  seed(repo, board);

  const turn = await oneTurn(repo, transcript, opts, splitSeed(board).live);
  const serverLog = turn.serverLog;
  const code = turn.error ? 1 : 0;
  if (turn.error) say(`RUN FAILED: ${turn.error}`);

  const logText = fs.readFileSync(path.join(repo, '.keel', 'board', 'log.jsonl'), 'utf8');
  fs.writeFileSync(path.join(out, 'log.jsonl'), logText);
  fs.writeFileSync(path.join(out, 'server.log'), serverLog);
  const { events } = parseLog(logText);
  const result = checkRun(board, seedEvents(board), events, readTranscript(transcript));
  fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify({ ...result, options: opts }, null, 2)}\n`);
  const text = report(result);
  fs.writeFileSync(path.join(out, 'report.txt'), `${text}\n`);
  say(text.split('\n\n')[0]!);
  say(`\nWritten to ${out}`);

  if (process.env.KEEP) say(`Kept ${repo}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  return code !== 0 ? code : result.ok ? 0 : 1;
}

process.exitCode = await main();
