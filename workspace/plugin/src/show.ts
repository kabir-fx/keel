import fs from 'node:fs';
import path from 'node:path';
import type { BuildShow } from '@keel/protocol';
import { git, gitOk } from './git';
import { DENIED_FILES } from './hosted-link';
import { safeRelative } from './records';

/**
 * What a finished build has to show the owner: a page a browser opens by itself, and a copy of
 * the built files beside it. The copy is taken from the worktree before it goes, into the
 * builder's private folder, so nothing in the repository can change what is shown later.
 *
 * Only what stands alone is shown: a page whose scripts and stylesheets are committed files
 * beside it, or the network's. A page that needs a build step or a server of its own is not,
 * and the build is no less done for it.
 */

export interface ShowLimits {
  files: number;
  bytes: number;
  /** The page is read to check what it loads, and no more than this of it. */
  pageBytes: number;
}

export const SHOW_LIMITS: ShowLimits = { files: 2000, bytes: 50 * 1024 * 1024, pageBytes: 1024 * 1024 };

/** A pattern of the secret-file list as a test on a path: `**` is any folders, `*` any name or part of one. */
function globRegex(glob: string): RegExp {
  const parts = glob.split('/').map((p) => (p === '**' ? '**' : p.replace(/[.+?^$|()[\]{}\\]/g, '\\$&').replace(/\*/g, '[^/]*')));
  let out = '';
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p === '**') out += last ? '(?:/.*)?' : i === 0 ? '(?:.*/)?' : '(?:/.*)?/';
    else out += `${p}${last || parts[i + 1] === '**' ? '' : '/'}`;
  });
  // Case does not matter: a Mac's disk does not mind it either.
  return new RegExp(`^${out}$`, 'i');
}

// Made on first use: hosted-link loads this module through the builder, before its list is set.
let secret: RegExp[] | undefined;

/** A file the show may hold: no part that starts with a dot (`.keel`, `.git`, `.env`), and nothing the secret-file list names. */
export function showable(rel: string): boolean {
  if (rel.split('/').some((p) => p.startsWith('.'))) return false;
  secret ??= DENIED_FILES.map(globRegex);
  return !secret.some((r) => r.test(rel));
}

/** The committed regular files in the board's folder, by their path inside it. Not a link, not a submodule. */
async function committedFiles(workdir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await gitOk(workdir, ['ls-files', '-s', '-z'], env);
  const files: string[] = [];
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, 6);
    if (mode === '100644' || mode === '100755') files.push(entry.slice(tab + 1));
  }
  return files;
}

/** The page to open: `index.html` at the top of the board's folder, else the only page there. */
export function pickPage(files: readonly string[]): string | undefined {
  const top = files.filter((f) => !f.includes('/'));
  if (top.includes('index.html')) return 'index.html';
  const pages = top.filter((f) => /\.html?$/i.test(f));
  return pages.length === 1 ? pages[0] : undefined;
}

/** The value of each `<script src>` and stylesheet `<link href>` in a page, outside comments. */
export function pageRefs(html: string): Array<{ tag: 'script' | 'link'; ref: string }> {
  const out: Array<{ tag: 'script' | 'link'; ref: string }> = [];
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of text.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase() as 'script' | 'link';
    const attrs = new Map<string, string>();
    for (const a of m[2]!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = a[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, a[2] ?? a[3] ?? a[4] ?? '');
    }
    if (tag === 'script' && attrs.has('src')) out.push({ tag, ref: attrs.get('src')!.trim() });
    if (tag === 'link' && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet') && attrs.has('href')) out.push({ tag, ref: attrs.get('href')!.trim() });
  }
  return out;
}

/**
 * Why a page does not stand alone, or undefined when it does: every local script and stylesheet
 * it loads is a relative path to a file that will be in the show. A reference with a scheme or
 * `//` is the network's. One that starts with `/` is not: the show is served under a path of
 * its own. Nor is a script a browser cannot run as it is.
 */
export function notStandingAlone(html: string, files: ReadonlySet<string>): string | undefined {
  for (const { tag, ref } of pageRefs(html)) {
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
    if (ref.startsWith('/') || ref.startsWith('\\')) return `it loads ${ref} from the top of a server`;
    let clean = ref.replace(/[?#].*$/, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {
      return `it loads ${ref}, which is no path`;
    }
    const rel = path.posix.normalize(clean);
    if (rel === '..' || rel.startsWith('../')) return `it loads ${ref}, outside the board's folder`;
    if (tag === 'script' && /\.(ts|tsx|jsx)$/i.test(rel)) return `it loads ${ref}, which needs a build step`;
    if (!files.has(rel)) return `it loads ${ref}, which is not a committed file in the show`;
  }
  return undefined;
}

/** Read a regular file inside `root` by a path that passes through no link, or undefined. */
function openPlain(root: string, rel: string): number | undefined {
  if (safeRelative(root, rel) !== rel) return undefined;
  let fd: number;
  try {
    fd = fs.openSync(path.join(root, rel), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    return undefined;
  }
  return fd;
}

function readPlain(root: string, rel: string, max: number): Buffer | undefined {
  const fd = openPlain(root, rel);
  if (fd === undefined) return undefined;
  try {
    if (fs.fstatSync(fd).size > max) return undefined;
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make the show of a finished build, from its worktree: `workdir` is the board's folder in it,
 * `env` pins git to the worktree. The copy goes to `dest`, through a temporary folder beside
 * it, and replaces an older show. Undefined, with the reason logged in one line, when the build
 * has nothing a browser can open by itself.
 */
export async function makeShow(o: { workdir: string; env: NodeJS.ProcessEnv; dest: string; log: (m: string) => void; limits?: ShowLimits }): Promise<BuildShow | undefined> {
  const limits = o.limits ?? SHOW_LIMITS;
  // An older show is of an older build: it goes, whether or not this one has a show.
  fs.rmSync(o.dest, { recursive: true, force: true });
  const none = (why: string) => {
    o.log(`no show: ${why}`);
    return undefined;
  };

  // The copy is of what is committed. A change left in the worktree is not on the branch.
  const changed = await git(o.workdir, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.'], o.env);
  if (changed.code !== 0) return none(changed.code === 1 ? 'the worktree has changes that are not committed' : `git diff failed: ${changed.stderr.trim().slice(0, 200)}`);

  const files = (await committedFiles(o.workdir, o.env)).filter(showable);
  const page = pickPage(files);
  if (!page) return none('no index.html, and not one page alone, at the top of the board\'s folder');
  if (files.length > limits.files) return none(`${files.length} files, more than ${limits.files}`);

  const html = readPlain(o.workdir, page, limits.pageBytes);
  if (!html) return none(`${page} is no regular file of at most ${limits.pageBytes} bytes`);

  // Every file is looked at before one is copied: the limits hold for the whole show.
  let bytes = 0;
  const plain: string[] = [];
  for (const rel of files) {
    const fd = openPlain(o.workdir, rel);
    if (fd === undefined) continue;
    try {
      bytes += fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
    if (bytes > limits.bytes) return none(`more than ${limits.bytes} bytes of files`);
    plain.push(rel);
  }
  if (!plain.includes(page)) return none(`${page} is no regular file`);
  const why = notStandingAlone(html.toString('utf8'), new Set(plain));
  if (why) return none(`${page} does not stand alone: ${why}`);

  const parent = path.dirname(o.dest);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(parent, `${path.basename(o.dest)}-`));
  try {
    for (const rel of plain) {
      const fd = openPlain(o.workdir, rel);
      if (fd === undefined) continue;
      try {
        const to = path.join(tmp, ...rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.writeFileSync(to, fs.readFileSync(fd), { mode: 0o600, flag: 'wx' });
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmp, o.dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  o.log(`a show of ${plain.length} files, opening ${page}`);
  return { dir: o.dest, page };
}
