#!/usr/bin/env node
// The live check: the owner writes a note, and the agent's card lands beside it.
//
// It starts the real board server on a temporary repository with the hosted link, posts a
// note as the owner over HTTP, and waits for an agent picture whose `answers` holds the note.
// It prints the seconds from the note to the card, and the card's words. It costs one real
// agent turn on the signed-in subscription. Build the plugin first.
//
//   node scripts/live-check.mjs [key=value ...]     extra --link-opt values, such as model=haiku
//   KEEP=1 keeps the temporary repository.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const KEEL_BOARD = path.join(PLUGIN, '..', 'server', 'bin', 'keel-board.mjs');
const LINK = path.join(PLUGIN, 'dist', 'hosted-link.js');
const TIMEOUT_MS = 180_000;
const NOTE = 'I want a small tool that turns my daily notes into a short summary each Friday. Not sure yet how it should work.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The presence pill, as the owner would read it. */
const pill = (p) => `${p.state}${p.note ? ` (${p.note})` : ''}${p.cursor?.item ? ` on ${p.cursor.item}` : ''}`;
const say = (line) => process.stdout.write(`${line}\n`);

for (const f of [KEEL_BOARD, LINK]) {
  if (!fs.existsSync(f)) {
    say(`Missing ${f}. Build first: npm run build -w @keel/board-server -w @keel/board-plugin`);
    process.exit(2);
  }
}

// A small repository for the agent to read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-live-'));
const repo = path.join(tmp, 'daily-notes');
fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
fs.writeFileSync(path.join(repo, 'README.md'), '# daily-notes\n\nOne markdown file per day in notes/, named by date. Nothing reads them yet.\n');
fs.writeFileSync(path.join(repo, 'notes', '2026-11-16.md'), '- met Sam about the launch\n- fixed the login bug\n- idea: weekly digest?\n');

const linkOpts = process.argv.slice(2).flatMap((kv) => ['--link-opt', kv]);
const server = spawn(process.execPath, [KEEL_BOARD, 'open', repo, '--port', '0', '--no-browser', '--link', LINK, ...linkOpts], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // The board's private folder goes in the temporary folder, never in the home folder.
  env: { ...process.env, KEEL_STATE_DIR: path.join(tmp, 'keel-state') },
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const serverExit = new Promise((r) => server.on('exit', (code, signal) => r({ code, signal })));

async function stop(code) {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([serverExit, sleep(30_000)]);
  }
  if (code !== 0 || process.env.VERBOSE) say(`\n--- board server log ---\n${serverLog.trim()}`);
  if (process.env.KEEP) say(`Kept ${repo}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

try {
  // The address "open" prints holds a code that works once. No token is in it, or in the repository.
  const t0 = Date.now();
  let page;
  while (!(page = /http:\/\/127\.0\.0\.1:(\d+)\/\?code=([^\s&]+)/.exec(serverLog))) {
    if (server.exitCode !== null) throw new Error('the board server exited before it started');
    if (Date.now() - t0 > 20_000) throw new Error('the board server printed no address in 20 s');
    await sleep(100);
  }
  const base = `http://127.0.0.1:${page[1]}`;
  // Trade the code for the owner's token, as the page does when it opens.
  const traded = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: decodeURIComponent(page[2]) }) });
  const owner = (await traded.json()).token;
  if (!traded.ok || !owner) throw new Error(`the board server did not take the code from its own address (HTTP ${traded.status})`);
  const as = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const get = async (route) => (await fetch(`${base}${route}`, { headers: as(owner) })).json();

  // The owner opens a chapter and writes a note.
  const posted = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: as(owner),
    body: JSON.stringify({
      drafts: [
        { type: 'chapter.open', chapter: 'weekly', title: 'A weekly summary' },
        { type: 'item.add', chapter: 'weekly', item: { id: 'm1', kind: 'note', box: [80, 80, 320, 140], text: NOTE } },
      ],
    }),
  });
  const body = await posted.json();
  if (!posted.ok) throw new Error(`the note was refused: ${JSON.stringify(body)}`);
  const noteEvent = body.events.at(-1);
  const sentAt = Date.now();
  say(`The owner wrote m1 (${noteEvent.id}): "${NOTE}"`);

  // Watch the board as the page would: events and the presence pill.
  let seq = Number(noteEvent.id.slice(1));
  const seen = [];
  let last = '';
  let card;
  while (!card) {
    if (Date.now() - sentAt > TIMEOUT_MS) throw new Error(`no card answered the note in ${TIMEOUT_MS / 1000} s`);
    if (server.exitCode !== null) throw new Error('the board server exited');
    const p = pill((await get('/api/board')).presence);
    if (p !== last) {
      seen.push(`${((Date.now() - sentAt) / 1000).toFixed(1)} s ${p}`);
      last = p;
    }
    const { events } = await get(`/api/events?after=${seq}`);
    for (const ev of events) {
      seq = Math.max(seq, Number(ev.id.slice(1)));
      if (ev.by === 'agent') seen.push(`${((Date.now() - sentAt) / 1000).toFixed(1)} s agent ${ev.type}${ev.item?.id ? ` ${ev.item.id}` : ''}`);
      if (ev.by === 'agent' && ev.type === 'item.add' && ev.item.answers?.includes('m1')) card = { ev, seenAt: Date.now() };
    }
    if (!card) await sleep(150);
  }

  const secs = (Date.parse(card.ev.at) - Date.parse(noteEvent.at)) / 1000;
  const pic = card.ev.item.picture;
  say(`\nThe agent's card answered m1 in ${secs.toFixed(1)} s (seen by the watcher at ${((card.seenAt - sentAt) / 1000).toFixed(1)} s).`);
  say(`Card ${card.ev.item.id}, a "${pic.kind}" picture${card.ev.item.place?.near ? ` placed near ${card.ev.item.place.near}` : ''}:`);
  for (const [k, v] of Object.entries(pic)) {
    if (k === 'kind') continue;
    say(`  ${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | ') : typeof v === 'string' ? v : JSON.stringify(v)}`);
  }

  // Let the turn end, so the timeline shows the pill going back to listening.
  const settle = Date.now();
  while (Date.now() - settle < 60_000) {
    const presence = (await get('/api/board')).presence;
    const p = pill(presence);
    if (p !== last) {
      seen.push(`${((Date.now() - sentAt) / 1000).toFixed(1)} s ${p}`);
      last = p;
    }
    if (presence.state === 'listening') break;
    await sleep(150);
  }
  const { events } = await get(`/api/events?after=${seq}`);
  for (const ev of events) if (ev.by === 'agent') seen.push(`later: agent ${ev.type}${ev.item?.id ? ` ${ev.item.id}` : ''}`);
  const open = (await get('/api/board')).open;
  say(`\nTimeline: ${seen.join(' · ')}`);
  say(`Open marks now: ${open}`);
  await stop(0);
} catch (e) {
  say(`LIVE CHECK FAILED: ${e instanceof Error ? e.message : String(e)}`);
  await stop(1);
}
