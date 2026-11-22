#!/usr/bin/env node
// Stage the npm package keel-workspace in release/keel-workspace/.
// node release/pack.mjs [--no-build] [--version <x.y.z>]
// The package keeps the workspace's relative layout, so the bundles find their files as they do here.
// --version stamps a release: that version, and the commit it is built from. Without it the package
// takes the workspace's version, which is no release.
// This never publishes: .github/workflows/release.yml does (docs/adr/0017).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.dirname(HERE);
const REPO = path.dirname(WS);
const OUT = path.join(HERE, 'keel-workspace');
const NAME = 'keel-workspace';

const LAUNCHER = 'server/bin/keel-board.mjs';
/** The bundles a build makes. Without them there is nothing to ship. */
const BUNDLES = ['server/dist/keel-board.js', 'plugin/dist/board-mcp.js', 'plugin/dist/hosted-link.js', 'plugin/dist/hosted-builder.js', 'app/dist/index.html'];
/** Files copied from the workspace, at the same path. `app/dist` is added file by file. */
const FROM_WORKSPACE = [
  LAUNCHER,
  'server/dist/keel-board.js',
  'plugin/dist/board-mcp.js',
  'plugin/dist/hosted-link.js',
  'plugin/dist/hosted-builder.js',
  'plugin/skills/board/SKILL.md',
  'plugin/skills/board/grammar.md',
  'plugin/skills/board/builder.md',
  'THIRD_PARTY_NOTICES.md',
];
const APP_DIST = 'app/dist';

const SECRET_NAMES = [/^\.env/, /\.pem$/i, /\.key$/i, /^id_rsa/, /^credentials/i, /\.p12$/i];

function fail(message) {
  process.stderr.write(`release/pack: ${message}\n`);
  process.exit(1);
}

/** The relative paths of the regular files under `dir`. A link or anything else that is not a file or folder stops the pack. */
function filesUnder(root, rel) {
  const full = path.join(root, rel);
  const st = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!st) fail(`${full} is missing. Run a build first: npm run build`);
  if (st.isSymbolicLink()) fail(`${full} is a symbolic link. The package copies regular files only.`);
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) fail(`${full} is not a regular file or folder.`);
  const out = [];
  for (const name of fs.readdirSync(full).sort()) out.push(...filesUnder(root, path.posix.join(rel, name)));
  return out;
}

/** A source that must be one regular file. */
function regularFile(full) {
  const st = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!st) return 'missing';
  if (st.isSymbolicLink()) fail(`${full} is a symbolic link. The package copies regular files only.`);
  if (!st.isFile()) fail(`${full} is not a regular file.`);
  return 'ok';
}

function size(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const USAGE = 'Usage: node release/pack.mjs [--no-build] [--version <x.y.z>]';
const args = process.argv.slice(2);
let build = true;
let release;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-build') build = false;
  else if (args[i] === '--version' && /^\d+\.\d+\.\d+$/.test(args[i + 1] ?? '')) release = args[++i];
  else fail(`unknown option "${args[i]}". ${USAGE}`);
}

// 1. Build.
if (build) {
  process.stdout.write('Building: npm run build\n');
  const b = spawnSync('npm', ['run', 'build'], { cwd: WS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) {
    process.stderr.write(`${b.stdout ?? ''}${b.stderr ?? ''}`);
    fail(`the build failed${b.error ? ` (${b.error.message})` : ''}.`);
  }
}

// 2. The bundles are there.
const missing = BUNDLES.filter((f) => regularFile(path.join(WS, f)) === 'missing');
if (missing.length) fail(`missing: ${missing.join(', ')}. Build first: npm run build (in ${WS}).`);

// What goes in, from where. Paths in the package use "/".
const sources = new Map();
for (const f of FROM_WORKSPACE) sources.set(f, path.join(WS, f));
for (const f of filesUnder(WS, APP_DIST)) sources.set(f, path.join(WS, f));
sources.set('README.md', path.join(HERE, 'README.md'));
sources.set('LICENSE', path.join(REPO, 'LICENSE'));
for (const [rel, from] of sources) {
  if (regularFile(from) !== 'missing') continue;
  if (rel === 'README.md') fail(`${from} is missing. It is the package's README: write it, then pack again.`);
  fail(`${from} is missing.`);
}

// 3. Stage. The folder is always this one, inside release/.
if (path.basename(OUT) !== NAME || path.dirname(OUT) !== HERE) fail(`refusing to empty ${OUT}.`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (const [rel, from] of sources) {
  const to = path.join(OUT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, rel === LAUNCHER ? 0o755 : 0o644);
}

// 4. The package's own package.json: no dependencies, no scripts.
const version = release ?? JSON.parse(fs.readFileSync(path.join(WS, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !version) fail(`no version in ${path.join(WS, 'package.json')}.`);
const pkg = {
  name: NAME,
  version,
  description: 'A board where you work out an idea with an agent, solidify it, and watch it get built. Runs on your machine, beside Claude Code.',
  license: 'MIT',
  type: 'module',
  bin: { 'keel-board': LAUNCHER },
  engines: { node: '>=22' },
  os: ['darwin', 'linux'],
  repository: { type: 'git', url: 'git+https://github.com/kabir-fx/keel.git', directory: 'workspace' },
  homepage: 'https://github.com/kabir-fx/keel#readme',
  bugs: { url: 'https://github.com/kabir-fx/keel/issues' },
  keywords: ['claude-code', 'agent', 'canvas', 'whiteboard', 'mcp'],
  files: ['server/bin', 'server/dist', 'plugin/dist', 'plugin/skills', 'app/dist', 'THIRD_PARTY_NOTICES.md'],
};
if (release) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  if (head.status !== 0) fail(`--version needs the commit this is built from, and git rev-parse HEAD failed: ${(head.stderr ?? '').trim()}`);
  pkg.gitHead = head.stdout.trim();
}
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
fs.chmodSync(path.join(OUT, 'package.json'), 0o644);

// 5. Guards on what was staged.
const staged = filesUnder(OUT, '.').map((f) => path.posix.normalize(f));
const expected = new Set([...sources.keys(), 'package.json']);
const problems = [];
const maps = [];
const home = os.homedir();
for (const rel of staged) {
  if (!expected.has(rel)) problems.push(`${rel} is not in the copy list`);
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (parts.some((p) => p.startsWith('.'))) problems.push(`${rel} has a part that starts with a dot`);
  if (SECRET_NAMES.some((re) => re.test(name))) problems.push(`${rel} has the name of a secret`);
  if (name.endsWith('.map')) {
    if (rel.startsWith(`${APP_DIST}/`)) maps.push(rel);
    else problems.push(`${rel} is a source map outside ${APP_DIST}`);
  }
  const body = fs.readFileSync(path.join(OUT, rel));
  if (home && home !== '/' && body.includes(home)) problems.push(`${rel} holds this machine's home folder (${home})`);
  if (body.includes('docs/private')) problems.push(`${rel} holds "docs/private"`);
}
for (const rel of expected) if (!staged.includes(rel)) problems.push(`${rel} was not staged`);
if (problems.length) fail(`the staged package is not safe to publish:\n  ${problems.join('\n  ')}`);

// 6. Say what was made.
const total = staged.reduce((n, rel) => n + fs.statSync(path.join(OUT, rel)).size, 0);
const lines = [
  `Staged ${NAME}@${version} in ${OUT}`,
  `${staged.length} files, ${size(total)}`,
];
if (maps.length) lines.push(`Source maps in the page (${maps.length}):`, ...maps.map((m) => `  ${m}`));
process.stdout.write(`${lines.join('\n')}\n`);
