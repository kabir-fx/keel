#!/usr/bin/env node
// Decide what the release pipeline does with the staged package of keel-workspace.
// node release/next.mjs
// Stage first (release/pack.mjs). It reads the staged folder, npm, and git.
// It prints one line of JSON, and changes nothing:
//   {"action":"none","previous":"0.1.0","reason":"..."}
//   {"action":"publish","version":"0.2.0","commit":"<sha>","previous":"0.1.0","reason":"..."}
//   {"action":"promote","version":"0.2.0","commit":"<sha>","previous":"0.2.0","reason":"..."}
// publish: the package changed, so this version is new. promote: the newest version on npm holds
// this package and never became `latest`, so it is installed and promoted again, not published.
// docs/adr/0017 says why a release is decided by what the package holds.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const STAGED = path.join(HERE, 'keel-workspace');
const NAME = 'keel-workspace';
/** The paths in the repository that the package is made from. */
const SHIPPED = ['workspace', 'LICENSE'];
/** What a release stamps into package.json. Two packages that differ only here hold the same thing. */
const STAMP = ['version', 'gitHead'];

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;
const HEADER = /^(\w+)(?:\([^)]*\))?(!)?: /;
const BREAKING = /^BREAKING[ -]CHANGE: /m;

/** What one commit message asks for: 'major', 'minor' or 'patch'. A message that is not a conventional commit asks for a patch. */
export function level(message) {
  const m = HEADER.exec(message);
  if (m?.[2] || BREAKING.test(message)) return 'major';
  return m?.[1] === 'feat' ? 'minor' : 'patch';
}

function numbers(version) {
  const m = PLAIN.exec(version);
  if (!m) throw new Error(`"${version}" is not a plain version such as 1.2.3.`);
  return m.slice(1).map(Number);
}

/** The highest plain version in a list, or undefined. A version with a suffix, such as 0.0.0-stage, is no release. */
export function newest(versions) {
  const plain = versions.filter((v) => PLAIN.test(v)).map(numbers);
  plain.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return plain.at(-1)?.join('.');
}

/** The version after `previous`, for the commits since it. Before 1.0.0 a breaking change raises the minor number. */
export function nextVersion(previous, messages) {
  const [major, minor, patch] = numbers(previous);
  const asked = new Set(messages.map(level));
  if (asked.has('major') && major > 0) return `${major + 1}.0.0`;
  if (asked.has('major') || asked.has('minor')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function filesUnder(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(root, r));
    else out.push(r);
  }
  return out;
}

function unstamped(file) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of STAMP) delete pkg[key];
  return JSON.stringify(pkg);
}

/** The files that are not the same in two package folders, sorted. Empty when the two hold the same package. */
export function differences(a, b) {
  const inA = new Set(filesUnder(a));
  const inB = new Set(filesUnder(b));
  const out = [];
  for (const rel of new Set([...inA, ...inB])) {
    if (!inA.has(rel) || !inB.has(rel)) out.push(rel);
    else if (rel === 'package.json' ? unstamped(path.join(a, rel)) !== unstamped(path.join(b, rel)) : !fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel)))) out.push(rel);
  }
  return out.sort();
}

class Stop extends Error {}

const short = (sha) => sha.slice(0, 7);

/**
 * The decision, from the facts.
 *   previous, built, live   the newest version on npm, the commit it was built from, and whether it is `latest`
 *   head                    the commit that is staged
 *   comesAfter(a, b)        does commit b come after commit a
 *   changed(), messages()   the files that differ from `previous`, and the commit messages since `built`: asked for only when needed
 */
export function decide({ previous, built, live, head, comesAfter, changed, messages }) {
  const same = (why) =>
    live
      ? { action: 'none', previous, reason: why }
      : { action: 'promote', version: previous, commit: built, previous, reason: `${why} It is not \`latest\` yet.` };

  if (built === head) return same(`${NAME}@${previous} was built from this commit.`);
  if (comesAfter(head, built)) return { action: 'none', previous, reason: `${NAME}@${previous} was built from ${short(built)}, a later commit than this one.` };
  if (!comesAfter(built, head)) {
    throw new Stop(`${NAME}@${previous} was built from ${short(built)}, and this commit (${short(head)}) does not come after it. Nothing is released from a history npm has not seen. Is the clone shallow?`);
  }
  const files = changed();
  if (files.length === 0) return same(`The staged package holds what ${NAME}@${previous} holds.`);
  const said = messages();
  return {
    action: 'publish',
    version: nextVersion(previous, said),
    commit: head,
    previous,
    reason: `${files.length} file(s) differ from ${NAME}@${previous}, over ${said.length} commit(s) since ${short(built)}.`,
  };
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Stop(`${cmd} ${args.join(' ')} failed: ${`${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().split('\n').slice(-4).join(' | ')}`);
  return r.stdout;
}

function facts(tmp) {
  if (!fs.existsSync(path.join(STAGED, 'package.json'))) throw new Stop(`${STAGED} is not staged. Run release/pack.mjs first.`);
  const listed = JSON.parse(run('npm', ['view', NAME, 'versions', 'dist-tags', '--json'], tmp));
  const previous = newest([listed.versions].flat());
  if (!previous) throw new Stop(`npm lists no version of ${NAME}.`);
  const built = run('npm', ['view', `${NAME}@${previous}`, 'gitHead'], tmp).trim();
  if (!built) throw new Stop(`npm does not say which commit ${NAME}@${previous} was built from.`);
  const head = run('git', ['rev-parse', 'HEAD'], REPO).trim();
  return {
    previous,
    built,
    live: listed['dist-tags']?.latest === previous,
    head,
    comesAfter: (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: REPO }).status === 0,
    changed: () => {
      const { filename } = JSON.parse(run('npm', ['pack', `${NAME}@${previous}`, '--json', '--pack-destination', tmp], tmp))[0];
      run('tar', ['-xzf', path.join(tmp, filename), '-C', tmp]);
      return differences(STAGED, path.join(tmp, 'package'));
    },
    messages: () => run('git', ['log', '--format=%B%x00', `${built}..${head}`, '--', ...SHIPPED], REPO).split('\0').map((m) => m.trim()).filter(Boolean),
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-next-'));
  try {
    process.stdout.write(`${JSON.stringify(decide(facts(tmp)))}\n`);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    process.stderr.write(`release/next: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
