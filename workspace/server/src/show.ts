import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { NOFOLLOW, lstatOf } from './files';
import { sameSecret } from './serverfile';

/**
 * What a finished build shows the owner, served from a port of its own. The page is code a
 * model wrote, so it must never be in the board's origin: the owner's token lives there, in
 * the page's storage. This listener knows no token, and its origin is never one the board
 * allows, so the board refuses anything the shown page sends it.
 *
 *   http://127.0.0.1:<port>/<key>/<chapter>/<path>
 *
 * The key is made new for each start of the server. Without it every address is a 404, so a
 * page elsewhere cannot guess its way in. Only plain files inside the show's folder are
 * served, by real path, and never through a link. The only content security policy is who may
 * frame it: the board's own page, and nothing else. Otherwise it is the owner's own app, and it
 * runs as it would when opened by hand.
 */

/** The most a show's folder path and its page may be, as the private file keeps them. */
const MAX_DIR = 4096;
const MAX_PAGE = 300;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/** The type a shown file is served with. Anything not listed is bytes to save, never sniffed. */
export function showTypeOf(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** On every response, an error too. */
const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** Who may frame what is shown: these origins, the board's own, or no one. */
export function showPolicy(ancestors: readonly string[]): string {
  return `frame-ancestors ${ancestors.length > 0 ? ancestors.join(' ') : "'none'"}`;
}

/**
 * One part of a path, as decoded: never empty, never hidden or a step up (a dot first), and
 * never holding a NUL, a slash or a backslash. An encoded form of these is decoded first, so
 * it is refused the same way.
 */
export function safePart(part: string): boolean {
  return part.length > 0 && !part.startsWith('.') && !part.includes('\0') && !part.includes('/') && !part.includes('\\');
}

/** A show the server took: the real path of its folder, and its page as parts. */
export interface CheckedShow {
  dir: string;
  page: string;
}

/**
 * Check what a builder gave to show. `dir` must be a real folder inside the builder's private
 * folder, by real path, and `page` a plain `.html` or `.htm` file inside it, reached through
 * no link. The builder is a module the owner loaded, but what it hands over is still checked:
 * the files came from a build a model ran. Returns the reason when it is refused.
 */
export function checkShow(builderDir: string, dir: unknown, page: unknown): CheckedShow | { refused: string } {
  if (typeof dir !== 'string' || typeof page !== 'string') return { refused: 'the folder and the page must be text' };
  if (!path.isAbsolute(dir)) return { refused: 'the folder is not an absolute path' };
  let realDir: string;
  let realBuilder: string;
  try {
    realBuilder = fs.realpathSync(builderDir);
    realDir = fs.realpathSync(dir);
  } catch {
    return { refused: 'the folder is not there' };
  }
  if (!realDir.startsWith(realBuilder + path.sep)) return { refused: "the folder is not inside the builder's private folder" };
  if (realDir.length > MAX_DIR) return { refused: 'the folder path is too long' };
  if (!lstatSafe(realDir)?.isDirectory()) return { refused: 'the folder is not a folder' };
  if (page.length === 0 || page.length > MAX_PAGE) return { refused: 'the page path is empty or too long' };
  const parts = page.split('/');
  if (!parts.every(safePart)) return { refused: 'the page path has a part that is empty, hidden, a step up, or holds a backslash or a NUL' };
  if (!/\.html?$/i.test(page)) return { refused: 'the page is not an .html or .htm file' };
  const opened = openInside(realDir, parts, false);
  if (!opened || 'redirect' in opened) return { refused: 'the page is not a plain file inside the folder' };
  fs.closeSync(opened.fd);
  return { dir: realDir, page: parts.join('/') };
}

/** `lstat`, or undefined for anything that cannot be looked at. */
function lstatSafe(p: string): fs.Stats | undefined {
  try {
    return lstatOf(p);
  } catch {
    return undefined;
  }
}

type Opened = { fd: number; size: number; name: string } | { redirect: true };

/**
 * Open a file inside `root` by its parts, through no link at any step. Every folder on the
 * way is looked at without following a link, and the file is opened so that a link put there
 * since is refused. A folder serves its `index.html`; asked for without its last slash, it is
 * sent there first, so the page's own relative addresses work. Undefined when nothing fits.
 */
export function openInside(root: string, parts: readonly string[], folder: boolean): Opened | undefined {
  const rootSt = lstatSafe(root);
  if (!rootSt?.isDirectory()) return undefined;
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    if (!lstatSafe(at)?.isDirectory()) return undefined;
  }
  const last = parts.at(-1);
  if (last !== undefined) at = path.join(at, last);
  let st = lstatSafe(at);
  if (st?.isDirectory()) {
    if (!folder && last !== undefined) return { redirect: true };
    at = path.join(at, 'index.html');
    st = lstatSafe(at);
  } else if (folder) {
    return undefined;
  }
  // Looked at before the open: opening a named pipe would wait for a writer.
  if (!st?.isFile()) return undefined;
  let fd: number;
  try {
    fd = fs.openSync(at, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return undefined;
  }
  const fst = fs.fstatSync(fd);
  // A hard link could make a file elsewhere look as if it lived here. And what was opened is
  // what was looked at: nothing was swapped in between.
  if (!fst.isFile() || fst.nlink > 1 || fst.ino !== st.ino || fst.dev !== st.dev) {
    fs.closeSync(fd);
    return undefined;
  }
  return { fd, size: fst.size, name: at };
}

export interface ShowServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  /** Serve this folder for this chapter, in place of what was there. */
  put(chapter: string, show: CheckedShow): void;
  /** Serve only these chapters. */
  retain(chapters: ReadonlySet<string>): void;
  /** The address of a chapter's page, when it is served. */
  url(chapter: string): string | undefined;
  close(): Promise<void>;
}

/**
 * Start the listener for shows, on a free port of 127.0.0.1, with a key of its own. What it
 * serves may be framed by `ancestors` only: the board's own origins.
 */
export async function startShowServer(log: (message: string) => void = () => {}, ancestors: readonly string[] = []): Promise<ShowServer> {
  const key = crypto.randomBytes(24).toString('base64url');
  const policy = showPolicy(ancestors);
  const shows = new Map<string, CheckedShow>();
  let port = 0;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
    res.setHeader('content-security-policy', policy);
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.setHeader('connection', 'close');
      return text(res, 403, 'Forbidden.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return text(res, 405, 'Use GET.');
    }
    // The path as it came, not as a URL parser would tidy it: "%2e%2e" must be seen and refused.
    const raw = (req.url ?? '').split(/[?#]/, 1)[0]!;
    if (!raw.startsWith('/')) return notFound(res);
    const [given, chapter, ...rest] = raw.slice(1).split('/');
    // Compared in a way that takes the same time whether or not it matches.
    if (given === undefined || !sameSecret(given, key)) return notFound(res);
    const show = chapter === undefined ? undefined : shows.get(chapter);
    if (!show) return notFound(res);
    // The chapter's own address, with no slash: its folder.
    if (rest.length === 0) return redirect(res, `${raw}/`);
    const folder = rest.at(-1) === '';
    const parts: string[] = [];
    for (const part of folder ? rest.slice(0, -1) : rest) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return notFound(res);
      }
      if (!safePart(decoded)) return notFound(res);
      parts.push(decoded);
    }
    const opened = openInside(show.dir, parts, folder);
    if (!opened) return notFound(res);
    if ('redirect' in opened) return redirect(res, `${raw}/`);
    sendFd(req, res, opened);
  };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      log(`show: error on ${req.method}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) text(res, 500, 'The board server failed on this request.');
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;

  return {
    port,
    origin,
    put: (chapter, show) => {
      shows.set(chapter, show);
    },
    retain: (chapters) => {
      for (const c of [...shows.keys()]) if (!chapters.has(c)) shows.delete(c);
    },
    url: (chapter) => {
      const show = shows.get(chapter);
      if (!show) return undefined;
      return `${origin}/${key}/${chapter}/${show.page.split('/').map(encodeURIComponent).join('/')}`;
    },
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })),
  };
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  text(res, 404, 'Not found.');
}

function redirect(res: http.ServerResponse, location: string): void {
  res.setHeader('location', location);
  text(res, 301, 'Moved.');
}

/** Send a file that is already open. The descriptor is closed when the send ends. */
function sendFd(req: http.IncomingMessage, res: http.ServerResponse, f: { fd: number; size: number; name: string }): void {
  res.writeHead(200, { 'content-type': showTypeOf(f.name), 'content-length': f.size });
  if (req.method === 'HEAD') {
    fs.closeSync(f.fd);
    res.end();
    return;
  }
  const stream = fs.createReadStream('', { fd: f.fd, autoClose: true });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
