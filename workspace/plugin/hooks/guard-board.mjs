#!/usr/bin/env node
// PreToolUse guard for the owner's own Claude Code session, where the plugin is installed.
//
// THIS STOPS MISTAKES, NOT AN ATTACKER. It reads the words of a tool call and guesses what
// they touch. A determined command (a variable built at run time, a script that computes a
// path, a tool it does not know) gets past it. The board's real protection is the board
// server, which checks every event, and the hosted agent, which has no tool that writes.
//
// It denies:
// - a Write, Edit, MultiEdit or NotebookEdit of a file inside `.keel/board/`;
// - a shell command that writes there, or that resets, restores or stashes what is there;
// - any read or write of keel's private folder, `~/.keel/boards/` or `$KEEL_STATE_DIR/boards/`,
//   which holds the owner's token and the builds the owner agreed to: the Read tool, a Grep
//   or a Glob there, and a shell command that names it or stands in it.
// Reading the board's own files is fine. `.keel/board/server.json` holds no token: it says
// only that a server is up.
// Paths are resolved as the file system would: against the folder the command stands in
// (following `cd`), through symbolic links, and with case folded, since `.KEEL` is `.keel`
// on a disk that ignores case.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_REASON =
  'The board changes only through the board server, so its log stays checked and whole. Use the board tools (board_post, board_answer, board_model, board_part, board_update) or the keel-board command, not a file write into .keel/board/.';
const PRIVATE_REASON =
  'keel keeps your token and the builds you agreed to in its private folder (~/.keel/boards, or $KEEL_STATE_DIR/boards). Nothing reads or writes it but the board server and the board tools, which find it by themselves.';

/** Commands that change files whatever their arguments say. */
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'touch', 'truncate', 'tee', 'ln', 'chmod', 'chown', 'mkdir', 'unlink', 'shred', 'dd', 'install']);
/** Commands whose last argument is where they write. */
const COPIERS = new Set(['cp', 'rsync', 'scp', 'ditto']);
/** Interpreters: given a script that names the board, they can write anything. */
const RUNNERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'deno', 'bun', 'php', 'osascript']);
/** git subcommands that rewrite files in the working tree from a pathspec. */
const GIT_PATH_WRITES = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'apply', 'stash']);
/** git subcommands that rewrite the whole working tree with no pathspec: `reset --hard`, `stash`, `clean`. */
const GIT_TREE_WRITES = new Set(['reset', 'stash', 'clean']);
/** Words a command is run through. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'timeout', 'nice', 'stdbuf', 'xargs']);

/**
 * A path as the file system will see it: resolved against `cwd`, through every symbolic
 * link on the part of it that exists, then case-folded.
 */
export function realish(file, cwd = process.cwd()) {
  const abs = path.resolve(cwd, file);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse()).toLowerCase();
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs.toLowerCase();
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

const homeOf = (env) => env.HOME || os.homedir();

/**
 * keel's private folders, as the file system sees them: `~/.keel/boards`, and
 * `$KEEL_STATE_DIR/boards` when this session has that set. The server keeps the owner's
 * token and the owner's agreements there, outside every repository.
 */
export function privateRoots(env = process.env) {
  const home = homeOf(env);
  const key = `${home}\n${env.KEEL_STATE_DIR ?? ''}`;
  if (rootsFor?.key === key) return rootsFor.roots;
  const out = [];
  if (home) out.push(realish(path.join(home, '.keel', 'boards'), '/'));
  if (env.KEEL_STATE_DIR) out.push(realish(path.join(path.resolve(env.KEEL_STATE_DIR), 'boards'), '/'));
  rootsFor = { key, roots: [...new Set(out)] };
  return rootsFor.roots;
}
let rootsFor;

/** A word of a command with `~`, `$HOME` and this session's `$KEEL_STATE_DIR` filled in. */
export function expand(word, env = process.env, stateDirIsLocal = false) {
  const home = homeOf(env);
  let w = word;
  if (home) w = w.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home);
  if (env.KEEL_STATE_DIR && !stateDirIsLocal) w = w.replace(/\$\{KEEL_STATE_DIR\}|\$KEEL_STATE_DIR\b/g, env.KEEL_STATE_DIR);
  return w;
}

/**
 * Where a path sits: "private" for keel's private folder and what is in it, "board" for
 * anything inside `.keel/board/`, "above" for a folder that holds the board, or undefined.
 */
export function placeOf(file, cwd = process.cwd(), env = process.env) {
  if (typeof file !== 'string' || file === '') return undefined;
  // Only `~` is filled in here. A shell command's own variables are the caller's to fill in.
  const real = realish(file.replace(/^~(?=\/|$)/, homeOf(env) || '~'), cwd);
  for (const root of privateRoots(env)) {
    if (real === root || real.startsWith(root + path.sep)) return 'private';
    // The default state folder itself, `~/.keel`: a search of it reads the private folder.
    if (real === path.dirname(root) && path.basename(real) === '.keel') return 'private';
  }
  const segs = real.split(/[\\/]+/);
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === '.keel' && segs[i + 1] === 'board') return 'board';
  }
  if (segs.at(-1) === '.keel') return 'above';
  if (fs.existsSync(path.join(path.resolve(cwd, file), '.keel', 'board'))) return 'above';
  return undefined;
}

/** Is there a board in this folder or one above it? */
function boardAbove(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.keel', 'board'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * The command's text with what hides a path undone, for spotting the board: case folded,
 * string literals that are joined put back together ('.ke' + 'el', join('.keel', 'board')),
 * and `./` and doubled slashes taken out.
 */
export function flatten(command) {
  let t = command.toLowerCase().replace(/\\/g, '/');
  for (let i = 0; i < 4; i++) {
    t = t
      .replace(/(['"`])\s*(?:\+|\.|\|\||\bconcat\b)\s*(['"`])/g, '')
      .replace(/(['"`])\s*,\s*(['"`])/g, '/')
      .replace(/(['"`])\s+(['"`])/g, '');
  }
  t = t.replace(/['"`]/g, '');
  for (let i = 0; i < 4; i++) t = t.replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
  return t;
}

const mentionsBoard = (flat) => /\.keel\/board(?:[/\s;&|)>]|$)/.test(flat);
/** Does flattened text name keel's private folder: by its usual name, or by where it is in this session? */
function mentionsPrivate(flat, env = process.env, stateDirIsLocal = false) {
  if (/\.keel\/boards(?:[/\s;&|)>]|$)/.test(flat)) return true;
  if (env.KEEL_STATE_DIR && !stateDirIsLocal && /\$\{?keel_state_dir\}?\/boards(?:[/\s;&|)>]|$)/.test(flat)) return true;
  return privateRoots(env).some((root) => flat.includes(root));
}

/**
 * The simple commands of a line of shell, split at `;`, `&&`, `||`, `|`, `&`, a new line, a
 * backtick and `$(`, but not inside quotes, so the code a `-c` or `-e` runs stays whole.
 */
export function segmentsOf(text) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (text[++i] ?? '');
        continue;
      }
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '`') {
      // `2>&1` and `>&2` are redirects, not a background `&`.
      if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function words(segment) {
  return segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^['"]+|['"]+$/g, ''));
}

/** The command word of a segment, past `VAR=x` and the wrappers. */
function commandOf(ws) {
  let i = 0;
  for (;;) {
    const w = ws[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) i++;
    else if (i > 0 && WRAPPERS.has(ws[i - 1] ?? '') && /^-/.test(w)) i++; // a wrapper's own flag
    else break;
  }
  return { cmd: path.basename(ws[i] ?? '').toLowerCase(), args: ws.slice(i + 1) };
}

/** A script file an interpreter runs, if it is small enough to read. */
function scriptText(args, dir) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) return '';
  try {
    const p = path.resolve(dir, file);
    if (fs.statSync(p).size > 256 * 1024) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** What a shell command does: "write" into the board, "private" for any touch of keel's private folder, or undefined. */
export function shellVerdict(command, cwd = process.cwd(), env = process.env) {
  if (typeof command !== 'string') return undefined;
  const text = command.replace(/>\|/g, '>'); // `>|` writes like `>`, past noclobber
  const flat = flatten(text);
  // A command that sets KEEL_STATE_DIR itself means its own folder, not this session's.
  const local = /(?:^|[\s;&|(])(?:export\s+)?KEEL_STATE_DIR=/.test(text);
  if (mentionsPrivate(flat, env, local)) return 'private';
  const named = mentionsBoard(flat);

  let dir = cwd;
  for (const raw of segmentsOf(text)) {
    const segment = raw.replace(/^[\s({!]+/, '').replace(/[\s)}]+$/, '');
    const ws = words(segment);
    if (ws.length === 0) continue;
    const { cmd, args } = commandOf(ws);
    const here = placeOf(dir, cwd, env);
    const inBoard = here === 'board';
    const segFlat = flatten(segment);
    const full = (a) => expand(a.replace(/^@/, ''), env, local);
    const where = (a) => placeOf(full(a), dir, env);

    if (cmd === 'cd' || cmd === 'pushd') {
      const to = args.find((a) => !a.startsWith('-'));
      if (to !== undefined && to !== '-') {
        const there = expand(to, env, local);
        if (!there.includes('$')) dir = path.resolve(dir, there);
      }
      continue;
    }

    // Anything run from inside the private folder, and any word that is a path into it.
    if (here === 'private' || ws.some((w) => where(w) === 'private')) return 'private';

    // A redirect into the board, wherever it is written from.
    for (const m of segment.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*([^\s;&|<>]+)/g)) {
      const target = m[1].replace(/^['"]|['"]$/g, '');
      if (target === '/dev/null' || target.startsWith('&')) continue;
      if (where(target) === 'private') return 'private';
      if (where(target) === 'board') return 'write';
      if (named && /[$`*?]/.test(target)) return 'write'; // a computed target, in a command that names the board
    }

    const hits = args.some((a) => !a.startsWith('-') && (where(a) === 'board' || where(a) === 'above'));
    const touches = hits || inBoard || mentionsBoard(segFlat);

    if (WRITERS.has(cmd) && touches) return 'write';
    if (COPIERS.has(cmd)) {
      const dest = args.filter((a) => !a.startsWith('-')).at(-1);
      if (dest !== undefined && (where(dest) === 'board' || inBoard)) return 'write';
    }
    if ((cmd === 'sed' || cmd === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a)) && touches) return 'write';
    if (cmd === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir') && (inBoard || mentionsBoard(segFlat) || args.some((a) => where(a) === 'board'))) return 'write';
    if (cmd === 'git') {
      // Past `-C <dir>` and `-c <key=value>`, to the subcommand.
      let gdir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C' && args[i + 1] !== undefined) gdir = path.resolve(dir, args[i + 1]);
        i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
      }
      const sub = args[i];
      const after = args.slice(i + 1);
      const paths = after.filter((a) => a !== '--' && !a.startsWith('-'));
      const at = (a) => placeOf(a, gdir);
      if (sub && GIT_PATH_WRITES.has(sub) && paths.some((a) => at(a) === 'board' || at(a) === 'above')) return 'write';
      if (sub && GIT_TREE_WRITES.has(sub) && boardAbove(gdir)) {
        if (sub === 'reset' && after.includes('--hard')) return 'write';
        if (sub === 'clean' && paths.length === 0) return 'write';
        if (sub === 'stash' && (paths.length === 0 || (paths.length === 1 && (paths[0] === 'push' || paths[0] === 'save')))) return 'write';
      }
    }
    if (RUNNERS.has(cmd)) {
      const script = flatten(scriptText(args, dir));
      if (mentionsPrivate(script, env, local)) return 'private';
      if (touches || mentionsBoard(script)) return 'write';
    }
  }
  return undefined;
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** The decision for one hook input, or undefined to let the call go on. */
export function decide(input) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const p = placeOf(ti.file_path ?? ti.notebook_path, cwd);
    if (p === 'private') return deny(PRIVATE_REASON);
    return p === 'board' ? deny(WRITE_REASON) : undefined;
  }
  if (tool === 'Read') return placeOf(ti.file_path, cwd) === 'private' ? deny(PRIVATE_REASON) : undefined;
  if (tool === 'Grep' || tool === 'Glob') {
    // A search reads what it finds: one that starts in the private folder, or names it, is a read of it.
    if (placeOf(typeof ti.path === 'string' ? ti.path : '.', cwd) === 'private') return deny(PRIVATE_REASON);
    // The files it looks in: Glob's `pattern`, Grep's `glob`. Grep's own pattern is words to look for, not a place.
    const files = tool === 'Glob' ? ti.pattern : ti.glob;
    if (typeof files === 'string' && (placeOf(files.replace(/[*?[{].*$/, ''), cwd) === 'private' || mentionsPrivate(flatten(files)))) return deny(PRIVATE_REASON);
    return undefined;
  }
  if (tool === 'Bash') {
    const v = shellVerdict(ti.command, cwd);
    if (v === 'write') return deny(WRITE_REASON);
    if (v === 'private') return deny(PRIVATE_REASON);
  }
  return undefined;
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return; // Not ours to judge.
  }
  const out = decide(input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** True when this file is the script node was started with, also when it was started through a link. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
