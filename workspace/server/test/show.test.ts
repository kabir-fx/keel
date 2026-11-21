import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SHOWS, PrivateBoardFile } from '@keel/protocol';
import type { KeptShow } from '../src/private';
import { PrivateBoard } from '../src/private';
import type { ShowServer } from '../src/show';
import { checkShow, startShowServer } from '../src/show';
import { STATE_ROOT, raw, tempRepo } from './helpers';

/** A folder with one of each kind of file a build may hand over, and the traps a build could leave. */
let root: string;
let site: string;
let outside: string;

const TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'about.htm': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.mjs': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'data.json': 'application/json; charset=utf-8',
  'app.js.map': 'application/json; charset=utf-8',
  'notes.txt': 'text/plain; charset=utf-8',
  'logo.svg': 'image/svg+xml',
  'a.png': 'image/png',
  'a.jpg': 'image/jpeg',
  'a.jpeg': 'image/jpeg',
  'a.gif': 'image/gif',
  'a.webp': 'image/webp',
  'a.avif': 'image/avif',
  'a.bmp': 'image/bmp',
  'favicon.ico': 'image/x-icon',
  'f.woff': 'font/woff',
  'f.woff2': 'font/woff2',
  'f.ttf': 'font/ttf',
  'f.otf': 'font/otf',
  'mod.wasm': 'application/wasm',
  's.mp3': 'audio/mpeg',
  's.wav': 'audio/wav',
  's.ogg': 'audio/ogg',
  's.oga': 'audio/ogg',
  's.m4a': 'audio/mp4',
  's.aac': 'audio/aac',
  's.flac': 'audio/flac',
  's.weba': 'audio/webm',
  'v.webm': 'video/webm',
  'v.mp4': 'video/mp4',
  'UPPER.PNG': 'image/png',
  'blob.xyz': 'application/octet-stream',
  'noext': 'application/octet-stream',
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-show-'));
  site = path.join(root, 'builder', 'show-1');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(site, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  for (const name of Object.keys(TYPES)) fs.writeFileSync(path.join(site, name), `file ${name}`);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><h1>Built</h1>');
  fs.writeFileSync(path.join(site, 'sub', 'index.html'), '<h1>Sub</h1>');
  fs.writeFileSync(path.join(site, '.secret'), 'hidden');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'the owner\'s secret');
  fs.writeFileSync(path.join(outside, 'index.html'), 'outside page');
  // Links a build could leave behind, each aimed out of the folder.
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(site, 'link.txt'));
  fs.symlinkSync(outside, path.join(site, 'linkdir'));
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(site, 'hard.txt'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the listener for shows', () => {
  let sv: ShowServer;
  let base: string;
  beforeAll(async () => {
    sv = await startShowServer();
    sv.put('first-idea', { dir: fs.realpathSync(site), page: 'index.html' });
    base = new URL(sv.url('first-idea')!).pathname.replace(/\/index\.html$/, '');
  });
  afterAll(async () => {
    await sv.close();
  });
  const get = (route: string, opts: Parameters<typeof raw>[2] = {}) => raw(sv.port, route, opts);

  it('gives an address on 127.0.0.1, on a port of its own, with a key and the chapter', () => {
    expect(sv.origin).toBe(`http://127.0.0.1:${sv.port}`);
    expect(sv.url('first-idea')).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${sv.port}/[\\w-]{32}/first-idea/index\\.html$`));
    expect(sv.url('other')).toBeUndefined();
  });

  it('serves a good file, with the headers on every response, framed by no one when no board is named', async () => {
    const r = await get(`${base}/index.html`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('<!doctype html><h1>Built</h1>');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    for (const res of [r, await get('/nope/first-idea/index.html')]) {
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "frame-ancestors 'none'",
      });
      expect(res.headers['x-frame-options']).toBeUndefined();
    }
  });

  it('answers HEAD with the length and no body', async () => {
    const r = await get(`${base}/index.html`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
    expect(r.headers['content-length']).toBe(String('<!doctype html><h1>Built</h1>'.length));
  });

  it('serves a folder\'s index.html, and sends a folder asked for with no slash to its slash first', async () => {
    expect((await get(`${base}/`)).body).toBe('<!doctype html><h1>Built</h1>');
    expect((await get(`${base}/sub/`)).body).toBe('<h1>Sub</h1>');
    const bare = await get(`${base}/sub`);
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe(`${base}/sub/`);
    const top = await get(base);
    expect(top.status).toBe(301);
    expect(top.headers.location).toBe(`${base}/`);
    // A file is not a folder.
    expect((await get(`${base}/index.html/`)).status).toBe(404);
  });

  it('serves each type it knows with its content type, and anything else as bytes', async () => {
    for (const [name, type] of Object.entries(TYPES)) {
      const r = await get(`${base}/${name}`);
      expect(r.status, name).toBe(200);
      expect(r.headers['content-type'], name).toBe(type);
    }
  });

  it('is a plain 404 with a wrong key, no key, or a chapter it does not show', async () => {
    const key = base.split('/')[1]!;
    const wrong = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    for (const route of [`/${wrong}/first-idea/index.html`, '/first-idea/index.html', '/', `/${key}`, `/${key}/`, `/${key}/other/index.html`, `/${key}/first%2Didea/index.html`]) {
      const r = await get(route);
      expect(r.status, route).toBe(404);
      expect(r.body).toBe('Not found.');
    }
  });

  it('answers only to its own host and port', async () => {
    const as = (host: string) => get(`${base}/index.html`, { headers: { host } });
    expect((await as(`localhost:${sv.port}`)).status).toBe(200);
    expect((await as(`LOCALHOST:${sv.port}`)).status).toBe(200);
    expect((await as('evil.example')).status).toBe(403);
    expect((await as(`evil.example:${sv.port}`)).status).toBe(403);
    expect((await as(`127.0.0.1:${sv.port + 1}`)).status).toBe(403);
    expect((await as('127.0.0.1')).status).toBe(403);
  });

  it('never serves a hidden file, a step up, or a part with a NUL, a slash or a backslash, encoded or not', async () => {
    for (const route of [
      `${base}/.secret`,
      `${base}/%2esecret`,
      `${base}/%2Esecret`,
      `${base}/../../outside/secret.txt`,
      `${base}/sub/../index.html`,
      `${base}/%2e%2e/%2e%2e/outside/secret.txt`,
      `${base}/%2E%2E/outside/secret.txt`,
      `${base}/.%2e/outside/secret.txt`,
      `${base}/sub/%2e%2e/index.html`,
      `${base}/sub%2Findex.html`,
      `${base}/sub%2findex.html`,
      `${base}/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt`,
      `${base}/index.html%00`,
      `${base}/index.html%00.png`,
      `${base}/sub%5Cindex.html`,
      `${base}/..%5C..%5Coutside%5Csecret.txt`,
      `${base}//index.html`,
      `${base}/sub//index.html`,
      `${base}/%E0%A4%A`,
    ]) {
      const r = await get(route);
      expect(r.status, route).toBe(404);
      expect(r.body).not.toMatch(/secret|outside|Sub|Built/);
    }
  });

  it('never follows a link inside the folder that points out of it, nor a hard link', async () => {
    for (const route of [`${base}/link.txt`, `${base}/linkdir/secret.txt`, `${base}/linkdir/`, `${base}/linkdir`, `${base}/hard.txt`]) {
      const r = await get(route);
      expect(r.status, route).toBe(404);
      expect(r.body).not.toMatch(/secret|outside/);
    }
  });

  it('takes GET and HEAD only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const r = await get(`${base}/index.html`, { method, body: method === 'OPTIONS' ? undefined : 'x' });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('serves what it is told: a new folder for a chapter, and only the chapters it keeps', async () => {
    const other = await startShowServer();
    try {
      other.put('a', { dir: fs.realpathSync(site), page: 'index.html' });
      other.put('b', { dir: fs.realpathSync(site), page: 'sub/index.html' });
      expect(other.url('b')).toMatch(/\/b\/sub\/index\.html$/);
      // A key of its own for each start.
      expect(new URL(other.url('a')!).pathname.split('/')[1]).not.toBe(base.split('/')[1]);
      other.retain(new Set(['b']));
      expect(other.url('a')).toBeUndefined();
      expect((await raw(other.port, new URL(other.url('b')!).pathname)).body).toBe('<h1>Sub</h1>');
    } finally {
      await other.close();
    }
    await expect(raw(other.port, '/')).rejects.toThrow();
  });
});

describe('what the server takes as a show', () => {
  const builder = () => path.join(root, 'builder');

  it('takes a real folder inside the builder\'s folder and a plain page in it, by real path', () => {
    expect(checkShow(builder(), site, 'index.html')).toEqual({ dir: fs.realpathSync(site), page: 'index.html' });
    expect(checkShow(builder(), site, 'about.htm')).toMatchObject({ page: 'about.htm' });
    expect(checkShow(builder(), site, 'sub/index.html')).toMatchObject({ page: 'sub/index.html' });
    // A path spelled through a step up that stays inside is taken by where it really is.
    expect(checkShow(builder(), `${site}/sub/..`, 'index.html')).toMatchObject({ dir: fs.realpathSync(site) });
  });

  it('refuses a folder outside the builder\'s folder, the builder\'s folder itself, a link out, and a relative path', () => {
    const inner = path.join(builder(), 'out-link');
    fs.symlinkSync(outside, inner);
    try {
      for (const [dir, page] of [
        [outside, 'index.html'],
        [builder(), 'show-1/index.html'],
        [inner, 'index.html'],
        [path.join(builder(), 'missing'), 'index.html'],
        [path.relative(process.cwd(), site), 'index.html'],
        [path.join(site, 'index.html'), 'index.html'],
      ] as const) {
        expect(checkShow(builder(), dir, page), `${dir} ${page}`).toHaveProperty('refused');
      }
    } finally {
      fs.unlinkSync(inner);
    }
  });

  it('refuses a page that is not a plain .html file inside the folder', () => {
    for (const page of ['', 'app.js', 'notes.txt', 'missing.html', '../outside/index.html', 'sub/../index.html', '.secret.html', '/index.html', 'sub', 'sub/', 'a\\index.html', 'index.html\0', 'linkdir/index.html']) {
      expect(checkShow(builder(), site, page), page).toHaveProperty('refused');
    }
    fs.symlinkSync(path.join(outside, 'index.html'), path.join(site, 'linked.html'));
    try {
      expect(checkShow(builder(), site, 'linked.html')).toHaveProperty('refused');
    } finally {
      fs.rmSync(path.join(site, 'linked.html'));
    }
    expect(checkShow(builder(), 42, 'index.html')).toHaveProperty('refused');
    expect(checkShow(builder(), site, undefined)).toHaveProperty('refused');
    expect(checkShow(builder(), site, `${'a/'.repeat(150)}index.html`)).toHaveProperty('refused');
  });
});

describe('the shows in the private file', () => {
  const show = (chapter: string, extra: Partial<KeptShow> = {}): KeptShow => ({ chapter, dir: `/x/${chapter}`, page: 'index.html', at: '2026-01-01T00:00:00.000Z', ...extra });
  const fileOf = (own: PrivateBoard) => PrivateBoardFile.parse(JSON.parse(fs.readFileSync(own.place.file, 'utf8')));

  it('keeps one per chapter, the newest, across a reopen', () => {
    const boardDir = tempRepo();
    const own = PrivateBoard.open(boardDir, STATE_ROOT);
    expect(own.shows).toEqual([]);
    own.addShow(show('a'));
    own.addShow(show('b', { opened: true }));
    own.addShow(show('a', { dir: '/x/a2', at: '2026-01-02T00:00:00.000Z' }));
    expect(own.shows.map((s) => s.chapter)).toEqual(['b', 'a']);
    const again = PrivateBoard.open(boardDir, STATE_ROOT);
    expect(again.shows).toEqual([show('b', { opened: true }), show('a', { dir: '/x/a2', at: '2026-01-02T00:00:00.000Z' })]);
    expect(fileOf(again).shows).toHaveLength(2);
  });

  it(`keeps at most ${MAX_SHOWS}, and the oldest go first`, () => {
    const own = PrivateBoard.open(tempRepo(), STATE_ROOT);
    for (let i = 0; i <= MAX_SHOWS; i++) own.addShow(show(`c${i}`));
    expect(own.shows).toHaveLength(MAX_SHOWS);
    expect(own.shows[0]!.chapter).toBe('c1');
    expect(own.shows.at(-1)!.chapter).toBe(`c${MAX_SHOWS}`);
    expect(fileOf(own).shows).toHaveLength(MAX_SHOWS);
  });

  it('drops the shows it is told to, or all of them, and says how many went', () => {
    const own = PrivateBoard.open(tempRepo(), STATE_ROOT);
    for (const c of ['a', 'b', 'c']) own.addShow(show(c));
    expect(own.dropShows((s) => s.chapter !== 'b')).toBe(1);
    expect(own.shows.map((s) => s.chapter)).toEqual(['a', 'c']);
    expect(own.dropShows(() => true)).toBe(0);
    expect(own.dropShows()).toBe(2);
    expect(own.shows).toEqual([]);
    expect(fileOf(own)).not.toHaveProperty('shows');
    expect(own.dropShows()).toBe(0);
  });
});
