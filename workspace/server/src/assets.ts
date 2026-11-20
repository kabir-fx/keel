import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from '@keel/protocol';
import { NOFOLLOW, errCode, lstatOf, writeAll } from './files';

/**
 * Snapshots and dropped files live in `.keel/board/assets/`. A name is cleaned to the
 * characters an `AssetPath` allows, and never names anything outside that folder.
 */

/** The file-name part of an `AssetPath`. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An `AssetPath` is at most 160 characters, "assets/" included. */
export const MAX_ASSET_NAME = 160 - `${ASSETS_DIR}/`.length;
/** Leave room for "-123" before the extension when the name is taken. */
const CLEAN_MAX = MAX_ASSET_NAME - 8;

/** A safe file name for what the sender called the file. */
export function cleanAssetName(raw: string): string {
  let name = raw.split(/[\\/]/).pop() ?? '';
  name = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-*\.-*/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[.-]+$/, '');
  if (name.length > CLEAN_MAX) {
    const ext = path.extname(name).slice(0, 12);
    name = `${name.slice(0, CLEAN_MAX - ext.length).replace(/[.-]+$/, '')}${ext}`;
  }
  return ASSET_NAME.test(name) ? name : 'file';
}

/**
 * The assets folder is still the real one the board opened with. A repository, or anything
 * else, could swap it for a link while the server runs: then nothing is read or written.
 */
function sameFolder(assetsDir: string, realAssetsDir: string): boolean {
  const st = lstatOf(assetsDir);
  if (!st?.isDirectory() || st.isSymbolicLink()) return false;
  try {
    return fs.realpathSync(assetsDir) === realAssetsDir;
  } catch {
    return false;
  }
}

/** Save bytes under a cleaned name that no other asset has. Returns the name used. */
export function saveAsset(assetsDir: string, rawName: string, bytes: Uint8Array, realAssetsDir = realOf(assetsDir)): string {
  if (!sameFolder(assetsDir, realAssetsDir)) throw new AssetPlaceError();
  const name = cleanAssetName(rawName);
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    let fd: number;
    try {
      // Exclusive and no-follow: a name already taken, or a link planted at it, is skipped.
      fd = fs.openSync(path.join(realAssetsDir, candidate), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o644);
    } catch (e) {
      if (errCode(e) === 'EEXIST' || errCode(e) === 'ELOOP') continue;
      throw e;
    }
    try {
      writeAll(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    return candidate;
  }
  throw new Error('Too many files with this name.');
}

/** The assets folder moved or became a link after the board opened. */
export class AssetPlaceError extends Error {
  constructor() {
    super('The assets folder is not the one the board opened with. Restart the board with "keel-board open".');
    this.name = 'AssetPlaceError';
  }
}

/** The file for an asset name, or undefined when the name would leave `assets/`. */
export function assetFile(assetsDir: string, name: string): string | undefined {
  if (name.length > MAX_ASSET_NAME || !ASSET_NAME.test(name)) return undefined;
  const root = path.resolve(assetsDir);
  const file = path.resolve(root, name);
  return path.dirname(file) === root ? file : undefined;
}

/**
 * Open an asset to read it: a plain file directly inside the real assets folder, opened
 * without following a link. Undefined when there is no such file.
 */
export function openAsset(assetsDir: string, realAssetsDir: string, name: string): { fd: number; size: number } | undefined {
  const file = assetFile(realAssetsDir, name);
  if (!file || !sameFolder(assetsDir, realAssetsDir)) return undefined;
  const st = lstatOf(file);
  if (!st?.isFile()) return undefined;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return undefined;
  }
  const fst = fs.fstatSync(fd);
  // A hard link could make a file elsewhere look as if it lived here.
  if (!fst.isFile() || fst.nlink > 1) {
    fs.closeSync(fd);
    return undefined;
  }
  return { fd, size: fst.size };
}

/** How many files the assets folder holds, and their bytes together. Links and folders count as files of no size. */
export function assetsUsage(realAssetsDir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const e of fs.readdirSync(realAssetsDir, { withFileTypes: true })) {
    count += 1;
    if (!e.isFile()) continue;
    try {
      bytes += fs.lstatSync(path.join(realAssetsDir, e.name)).size;
    } catch {
      // Gone since the listing.
    }
  }
  return { count, bytes };
}

function realOf(dir: string): string {
  return fs.realpathSync(dir);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
};

export function contentTypeOf(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
