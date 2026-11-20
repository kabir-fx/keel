import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureWorktree, pinEnv } from '../src/git';
import { SHOW_LIMITS, makeShow, notStandingAlone, pickPage, showable } from '../src/show';
import { makeRepo, sh } from './build-board';

/**
 * What a finished build shows: a page that stands alone, and a copy of the committed files
 * beside it, taken from the builder's worktree into its private folder.
 */

let tmp: string;
let logs: string[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-show-')));
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A repository with these files committed, the builder's worktree of it, and where the show goes. */
async function built(files: Record<string, string>, o: { links?: Record<string, string>; sub?: string } = {}) {
  const repo = makeRepo(path.join(tmp, 'repo'), files);
  for (const [f, target] of Object.entries(o.links ?? {})) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.symlinkSync(target, path.join(repo, f));
  }
  if (o.links) {
    sh(repo, 'git', 'add', '-A');
    sh(repo, 'git', 'commit', '--quiet', '-m', 'links');
  }
  const tree = path.join(tmp, 'state', 'build', 'c', 'tree');
  const { gitDir } = await ensureWorktree(repo, tree, 'board/c');
  const dest = path.join(tmp, 'state', 'build', 'c', 'show');
  const workdir = o.sub ? path.join(tree, o.sub) : tree;
  return { repo, tree, workdir, dest, env: pinEnv(gitDir, tree) };
}

const show = (b: Awaited<ReturnType<typeof built>>, limits = SHOW_LIMITS) => makeShow({ workdir: b.workdir, env: b.env, dest: b.dest, log: (m) => logs.push(m), limits });

const list = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).sort();

const PAGE = '<!doctype html><link rel="stylesheet" href="css/site.css"><script src="app.js"></script>';

describe('the show of a finished build', () => {
  it('copies the committed files, not a link, a dot file or a secret, and opens index.html', async () => {
    const b = await built(
      { 'index.html': PAGE, 'app.js': '1;\n', 'css/site.css': 'a{}\n', '.env': 'X=1\n', 'conf/credentials-prod.json': '{}\n', '.keel/board/e.jsonl': '{}\n', 'lib/.cache/x.js': '1;\n' },
      { links: { 'link.js': 'app.js', 'out.txt': '/etc/hosts' } },
    );
    const r = await show(b);
    expect(r).toEqual({ dir: b.dest, page: 'index.html' });
    expect(list(b.dest)).toEqual(['app.js', 'css', 'css/site.css', 'index.html']);
    expect(fs.readFileSync(path.join(b.dest, 'css', 'site.css'), 'utf8')).toBe('a{}\n');
    for (const d of [b.dest, path.join(b.dest, 'css')]) expect((fs.statSync(d).mode & 0o777).toString(8)).toBe('700');
    // Nothing temporary is left beside it.
    expect(fs.readdirSync(path.dirname(b.dest)).sort()).toEqual(['show', 'tree']);
  });

  it('replaces an older show, and takes it away when there is no new one', async () => {
    const b = await built({ 'index.html': PAGE, 'app.js': '1;\n', 'css/site.css': 'a{}\n' });
    fs.mkdirSync(b.dest, { recursive: true });
    fs.writeFileSync(path.join(b.dest, 'stale.txt'), 'old\n');
    await show(b);
    expect(list(b.dest)).not.toContain('stale.txt');
    expect(await show(b, { ...SHOW_LIMITS, files: 1 })).toBeUndefined();
    expect(fs.existsSync(b.dest)).toBe(false);
  });

  it('shows only the board\'s folder, by paths inside it', async () => {
    const b = await built({ 'README.md': '# top\n', 'web/index.html': '<script src="js/a.js"></script>', 'web/js/a.js': '1;\n' }, { sub: 'web' });
    expect(await show(b)).toEqual({ dir: b.dest, page: 'index.html' });
    expect(list(b.dest)).toEqual(['index.html', 'js', 'js/a.js']);
  });

  it('no page at the top of the folder, or two and no index.html, gives none', async () => {
    let b = await built({ 'README.md': '# no page\n', 'docs/index.html': '<p>deep</p>' });
    expect(await show(b)).toBeUndefined();
    expect(logs.at(-1)).toMatch(/^no show: no index\.html/);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    b = await built({ 'a.html': '<p>a</p>', 'b.html': '<p>b</p>' });
    expect(await show(b)).toBeUndefined();
  });

  it('a page that is a link is never the page: the only regular page is', async () => {
    const b = await built({ 'about.htm': '<p>hi</p>' }, { links: { 'index.html': 'about.htm' } });
    expect(await show(b)).toEqual({ dir: b.dest, page: 'about.htm' });
    expect(list(b.dest)).not.toContain('index.html');
  });

  it('a page that needs a server or a build step gives none, and says why in one line', async () => {
    const b = await built({ 'index.html': '<script type="module" src="/src/main.tsx"></script>', 'src/main.tsx': 'export {};\n' });
    expect(await show(b)).toBeUndefined();
    expect(logs).toEqual(['no show: index.html does not stand alone: it loads /src/main.tsx from the top of a server']);
    expect(fs.existsSync(b.dest)).toBe(false);
  });

  it('a change left in the worktree is not shown: the show is of what is committed', async () => {
    const b = await built({ 'index.html': PAGE, 'app.js': '1;\n', 'css/site.css': 'a{}\n' });
    fs.writeFileSync(path.join(b.tree, 'app.js'), '2;\n');
    expect(await show(b)).toBeUndefined();
    expect(logs.at(-1)).toContain('not committed');
  });

  it('past the limits, of files or of bytes, gives none', async () => {
    const b = await built({ 'index.html': PAGE, 'app.js': 'x'.repeat(5000), 'css/site.css': 'a{}\n' });
    expect(await show(b, { ...SHOW_LIMITS, files: 2 })).toBeUndefined();
    expect(logs.at(-1)).toBe('no show: 3 files, more than 2');
    expect(await show(b, { ...SHOW_LIMITS, bytes: 4000 })).toBeUndefined();
    expect(logs.at(-1)).toBe('no show: more than 4000 bytes of files');
    expect(await show(b, { ...SHOW_LIMITS, pageBytes: 10 })).toBeUndefined();
    expect(await show(b)).toEqual({ dir: b.dest, page: 'index.html' });
    expect(SHOW_LIMITS).toMatchObject({ files: 2000, bytes: 50 * 1024 * 1024 });
  });
});

describe('the rules, as data', () => {
  it('a page stands alone when what it loads is the network\'s or a committed file beside it', () => {
    const files = new Set(['app.js', 'css/site.css', 'lib/x.mjs', 'src/a.ts']);
    const ok = (html: string) => notStandingAlone(html, files);
    expect(ok('<script src="app.js"></script><link href="css/site.css" rel="stylesheet">')).toBeUndefined();
    expect(ok('<script src=./lib/x.mjs?v=2#top></script>')).toBeUndefined();
    expect(ok('<script src="https://cdn.example.invalid/x.js"></script><script src="//cdn.example.invalid/y.js"></script><link rel="stylesheet" href="data:text/css,a{}">')).toBeUndefined();
    // Not a stylesheet, not a script source, or in a comment: not looked at.
    expect(ok('<link rel="icon" href="/favicon.ico"><script>import("/x.js")</script><!-- <script src="/old.js"></script> -->')).toBeUndefined();
    expect(ok('<script src="/app.js"></script>')).toContain('from the top of a server');
    expect(ok('<LINK REL="Stylesheet" HREF="/css/site.css">')).toContain('from the top of a server');
    expect(ok('<script src="src/a.ts"></script>')).toContain('needs a build step');
    expect(ok('<script src="App.JSX"></script>')).toContain('needs a build step');
    expect(ok('<script src="../app.js"></script>')).toContain('outside the board\'s folder');
    expect(ok('<script src="missing.js"></script>')).toContain('not a committed file');
  });

  it('the page is index.html, else the only page at the top', () => {
    expect(pickPage(['index.html', 'about.html'])).toBe('index.html');
    expect(pickPage(['about.HTM', 'site/index.html'])).toBe('about.HTM');
    expect(pickPage(['a.html', 'b.html'])).toBeUndefined();
    expect(pickPage(['site/index.html'])).toBeUndefined();
  });

  it('what a show may hold: no dot part, and nothing the secret-file list names', () => {
    for (const f of ['.env', 'a/.env.local', '.keel/board/x', 'lib/.git/config', 'certs/site.pem', 'KEY.PEM', 'deploy/id_rsa.pub', 'conf/credentials.json', 'prod.env', 'x/service-account-1.json']) expect(showable(f), f).toBe(false);
    for (const f of ['index.html', 'environment.js', 'app.env.js', 'keys/readme.md', 'credentials.md']) expect(showable(f), f).toBe(true);
  });
});
