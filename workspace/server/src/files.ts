import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Files a repository could aim elsewhere. A board opens nothing through a symbolic link: a
 * repository could ship `.keel/board/assets` as a link to the owner's home folder, and the
 * board would then read and write there.
 */

/** Open flag that refuses a link as the last part of a path. 0 on a platform that has none. */
export const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** A part of the board is a symbolic link, so the board does not open. */
export class LinkRefusedError extends Error {
  override name = 'LinkRefusedError';
}

export function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** `lstat`, or undefined when nothing is there. */
export function lstatOf(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return undefined;
    throw e;
  }
}

function linkSentence(rel: string, kind: 'folder' | 'file'): string {
  return `${rel} is a symbolic link, so the board will not open: a link could point it at files outside the repository. Replace it with a real ${kind}.`;
}

/** Make `rel` under `root` a real folder: create it when it is missing, refuse a link or a file. */
export function realFolder(root: string, rel: string, mode = 0o755): string {
  const full = path.join(root, rel);
  let st = lstatOf(full);
  if (!st) {
    try {
      fs.mkdirSync(full, { mode });
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
    st = lstatOf(full);
  }
  if (st?.isSymbolicLink()) throw new LinkRefusedError(linkSentence(rel, 'folder'));
  if (!st?.isDirectory()) throw new Error(`${rel} is not a folder. The board needs a folder there.`);
  return full;
}

/** Refuse `rel` under `root` when it is a link, or something other than a plain file. Missing is fine. */
export function refuseLinkedFile(root: string, rel: string): void {
  const st = lstatOf(path.join(root, rel));
  if (!st) return;
  if (st.isSymbolicLink()) throw new LinkRefusedError(linkSentence(rel, 'file'));
  if (!st.isFile()) throw new Error(`${rel} is not a plain file. The board needs a file there.`);
}

/** Read a whole file without following a link. Undefined when it is missing, a link, or not a plain file. */
export function readNoFollow(file: string): string | undefined {
  const st = lstatOf(file);
  // Checked before the open: opening a named pipe would wait for a writer.
  if (!st?.isFile()) return undefined;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ELOOP') return undefined;
    throw e;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Append to a file, creating it, without following a link. */
export function appendNoFollow(file: string, text: string, mode = 0o644): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, mode);
  try {
    writeAll(fd, Buffer.from(text, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write a file through a new file and a rename: a link at the path is replaced, never followed,
 * and a reader never sees half a file.
 */
export function replaceFile(file: string, text: string, mode = 0o600): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode);
  try {
    writeAll(fd, Buffer.from(text, 'utf8'));
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function writeAll(fd: number, buf: Uint8Array): void {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}
