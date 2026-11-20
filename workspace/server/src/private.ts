import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Id } from '@keel/protocol';
import { MAX_FOREIGN_RANGES, PRIVATE_BOARD_FILE, PrivateBoardFile, STATE_DIR_ENV, privateBoardKey } from '@keel/protocol';
import { NOFOLLOW, errCode, lstatOf, readNoFollow, replaceFile, writeAll } from './files';

/**
 * The board's private folder, outside the repository:
 *
 *   <root>/boards/<privateBoardKey(dev, ino)>/   0700
 *     board.json      0600  `PrivateBoardFile`: the owner's token, the port, the running server's
 *                           tokens, the builds the owner agreed to on this machine, and the
 *                           seal of the log as this machine's server last wrote it
 *     server.lock     0600  held while a server runs, so two servers never write one log
 *     link/           0700  the agent link's own files (`LinkContext.stateDir`)
 *     builder/        0700  the builder's own files (`BuilderContext.stateDir`)
 *
 * `<root>` is `$KEEL_STATE_DIR`, else `~/.keel`. The key comes from the board folder's device
 * and inode, so two spellings of one folder (on a disk that ignores case) find one private
 * folder, one token and one lock. Nothing a repository ships can write here: this is what the
 * machine trusts. A log read from disk grants nothing.
 */

export const LINK_DIR = 'link';
export const BUILDER_DIR = 'builder';
export const LOCK_FILE = 'server.lock';
/** The consents kept for one board. The oldest go first. */
export const MAX_CONSENTS = 100;

export type Consent = NonNullable<PrivateBoardFile['consents']>[number];
export type Running = NonNullable<PrivateBoardFile['running']>;
export type LogSeal = NonNullable<PrivateBoardFile['log']>;
export type ForeignRange = NonNullable<PrivateBoardFile['foreign']>[number];

export interface PrivatePlace {
  /** `<root>/boards/<key>` */
  dir: string;
  /** `<dir>/board.json` */
  file: string;
  lockFile: string;
  linkDir: string;
  builderDir: string;
  /** The board folder's real path. */
  boardDir: string;
  dev: bigint;
  ino: bigint;
}

/** `~/.keel`, or `KEEL_STATE_DIR`, or what the caller gives. */
export function stateRoot(override?: string): string {
  return path.resolve(override ?? process.env[STATE_DIR_ENV] ?? path.join(os.homedir(), '.keel'));
}

/** Where a board's private folder is. Undefined when the board folder does not exist. */
export function privatePlace(boardDir: string, root?: string): PrivatePlace | undefined {
  let st: fs.BigIntStats;
  let real: string;
  try {
    st = fs.statSync(boardDir, { bigint: true });
    if (!st.isDirectory()) return undefined;
    real = fs.realpathSync.native(boardDir);
  } catch {
    return undefined;
  }
  const dir = path.join(stateRoot(root), 'boards', privateBoardKey(st.dev, st.ino));
  return {
    dir,
    file: path.join(dir, PRIVATE_BOARD_FILE),
    lockFile: path.join(dir, LOCK_FILE),
    linkDir: path.join(dir, LINK_DIR),
    builderDir: path.join(dir, BUILDER_DIR),
    boardDir: real,
    dev: st.dev,
    ino: st.ino,
  };
}

/**
 * The private file of a board, when there is one and it belongs to this board folder. A file
 * left by a folder that was deleted, whose inode a new folder now has, is not this board's.
 */
export function readPrivate(boardDir: string, root?: string): PrivateBoardFile | undefined {
  const place = privatePlace(boardDir, root);
  return place ? readFile(place) : undefined;
}

function readFile(place: PrivatePlace): PrivateBoardFile | undefined {
  let text: string | undefined;
  try {
    text = readNoFollow(place.file);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  let parsed: PrivateBoardFile;
  try {
    const r = PrivateBoardFile.safeParse(JSON.parse(text));
    if (!r.success) return undefined;
    parsed = r.data;
  } catch {
    return undefined;
  }
  return sameFolder(parsed.boardDir, place) ? parsed : undefined;
}

/** The folder the file names is this one: the same path, or a path to the same device and inode. */
function sameFolder(named: string, place: PrivatePlace): boolean {
  if (named === place.boardDir) return true;
  try {
    const st = fs.statSync(named, { bigint: true });
    return st.dev === place.dev && st.ino === place.ino;
  } catch {
    return false;
  }
}

/** A board's private file, open for the server that runs it. */
export class PrivateBoard {
  /** True when this machine had no private file for this board: a board opened here for the first time. */
  readonly firstOpen: boolean;
  private data: PrivateBoardFile;

  private constructor(
    readonly place: PrivatePlace,
    data: PrivateBoardFile,
    firstOpen: boolean,
  ) {
    this.data = data;
    this.firstOpen = firstOpen;
  }

  /** Create the folders (0700) and read the file, or start a new one with a new owner's token. Writes nothing yet. */
  static open(boardDir: string, root?: string, newToken: () => string = defaultToken): PrivateBoard {
    const place = privatePlace(boardDir, root);
    if (!place) throw new Error(`${boardDir} is not a folder.`);
    ownFolder(path.dirname(place.dir));
    ownFolder(place.dir);
    ownFolder(place.linkDir);
    ownFolder(place.builderDir);
    const found = readFile(place);
    if (found) return new PrivateBoard(place, { ...found, boardDir: place.boardDir }, false);
    // The port is set when the server listens, before the file is first written.
    return new PrivateBoard(place, { boardDir: place.boardDir, boardKey: newToken(), port: 1 }, true);
  }

  /** The board's own secret on this machine: what a server proves itself with. Not a token. */
  get boardKey(): string {
    return this.data.boardKey;
  }

  /** The port the board had last time it ran here. */
  get savedPort(): number | undefined {
    return this.firstOpen ? undefined : this.data.port;
  }

  get consents(): readonly Consent[] {
    return this.data.consents ?? [];
  }

  /** The server listens on `port` with these tokens. With `seal`, the log's seal is kept in the same write. */
  setRunning(port: number, running: Running, seal?: LogSeal): void {
    this.data = { ...this.data, port, running, ...(seal ? { log: seal } : {}) };
    this.save();
  }

  /** The server stopped. Its tokens are worth nothing now. With `seal`, the log's seal is kept in the same write. */
  clearRunning(seal?: LogSeal): void {
    const sealed = seal === undefined || sameSeal(this.data.log, seal);
    if (!this.data.running && sealed) return;
    const { running: _gone, ...rest } = this.data;
    this.data = seal ? { ...rest, log: seal } : rest;
    this.save();
  }

  /** The seal on file: the log as this machine's server last wrote it. */
  get logSeal(): LogSeal | undefined {
    return this.firstOpen ? undefined : this.data.log;
  }

  /** The events that came with a log from outside and that the owner has not kept. */
  get foreign(): readonly ForeignRange[] | undefined {
    return this.data.foreign && this.data.foreign.length > 0 ? this.data.foreign : undefined;
  }

  /**
   * These events came with a log from outside. They join the ones not kept yet: runs that
   * touch or overlap become one, so the owner's own events between two runs stay the owner's.
   * Nothing is written here: the next write of the file keeps it, and a start that fails
   * finds them again.
   */
  addForeign(range: ForeignRange): void {
    const all = [...(this.data.foreign ?? []), range].sort((a, b) => a.from - b.from);
    const out: ForeignRange[] = [];
    for (const r of all) {
      const last = out.at(-1);
      if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
      else out.push({ ...r });
    }
    // Too many runs to keep apart: join the two oldest. What lies between them is tagged too, which errs on the careful side.
    while (out.length > MAX_FOREIGN_RANGES) out.splice(0, 2, { from: out[0]!.from, to: out[1]!.to });
    this.data = { ...this.data, foreign: out };
  }

  /** The owner keeps what came from outside: it is the board's own now. Returns false when there was nothing to keep. */
  keepForeign(): boolean {
    if (!this.foreign) return false;
    const { foreign: _kept, ...rest } = this.data;
    this.data = rest;
    this.save();
    return true;
  }

  /** Is this the log this machine's server last wrote for this board? */
  wrote(log: LogSeal): boolean {
    return !this.firstOpen && sameSeal(this.data.log, log);
  }

  /** The log stands like this now, as this server wrote it. */
  setLogSeal(seal: LogSeal): void {
    if (sameSeal(this.data.log, seal)) return;
    this.data = { ...this.data, log: seal };
    this.save();
  }

  /** The log is not the one the owner agreed on: no agreement holds. Returns how many there were. */
  dropConsents(): number {
    const n = this.consents.length;
    if (n === 0) return 0;
    const { consents: _gone, ...rest } = this.data;
    this.data = rest;
    this.save();
    return n;
  }

  /** The owner agreed, live, to build a chapter with this check and track. */
  addConsent(c: Consent): void {
    const same = (x: Consent) => x.chapter === c.chapter && x.check === c.check && sameList(x.track, c.track);
    const kept = this.consents.filter((x) => !same(x));
    this.data = { ...this.data, consents: [...kept, c].slice(-MAX_CONSENTS) };
    this.save();
  }

  /** A consent for this chapter whose check is exactly `check` and whose track holds every part of `track`. */
  consentFor(chapter: Id, check: string | undefined, track: readonly Id[]): Consent | undefined {
    if (check === undefined) return undefined;
    for (let i = this.consents.length - 1; i >= 0; i--) {
      const c = this.consents[i]!;
      if (c.chapter === chapter && c.check === check && track.every((p) => c.track.includes(p))) return c;
    }
    return undefined;
  }

  private save(): void {
    replaceFile(this.place.file, `${JSON.stringify(PrivateBoardFile.parse(this.data), null, 2)}\n`, 0o600);
  }
}

/* -------------------------------------------------------------------- lock */

/** A server already holds this board. */
export class BoardBusyError extends Error {
  constructor(
    readonly port: number | undefined,
    readonly pid: number,
  ) {
    super(port ? `A board server already runs for this board, at http://127.0.0.1:${port}/.` : `A board server (pid ${pid}) is starting for this board.`);
    this.name = 'BoardBusyError';
  }
}

interface LockBody {
  pid: number;
  /** When the machine booted, so a lock left before the machine restarted is seen as stale. */
  bootAt: number;
  /**
   * When the holder's process started, as `ps` tells it. A process number is used again
   * after its process ends, and a clock can be set while a server runs. The start time of a
   * process changes with neither, so it is what tells the holder from any other process.
   */
  started?: string;
  at: string;
}

/**
 * When the process with this number started, in `ps`'s own words, or undefined when there is
 * no such process or `ps` cannot say (it is not there on Windows).
 */
export function startOf(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const text = r.status === 0 ? r.stdout.trim() : '';
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Locks this process holds, so a second server in the same process is refused too. */
const held = new Set<string>();

function bootAt(): number {
  return Date.now() - Math.round(os.uptime() * 1000);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

/** The pid of the server that holds the lock, if it may still run. The lock is in the private folder, so its pid is trusted. */
export function lockHolder(place: PrivatePlace): number | undefined {
  let body: LockBody;
  try {
    const text = readNoFollow(place.lockFile);
    if (text === undefined) return undefined;
    body = JSON.parse(text) as LockBody;
  } catch {
    return undefined;
  }
  if (typeof body.pid !== 'number') return undefined;
  if (body.pid === process.pid) return held.has(place.lockFile) ? body.pid : undefined;
  if (!alive(body.pid)) return undefined;
  // The same process number, alive: is it the same process? Its start time says, when the
  // lock holds one and `ps` gives one now.
  const now = typeof body.started === 'string' ? startOf(body.pid) : undefined;
  if (typeof body.started === 'string' && now !== undefined) return now === body.started ? body.pid : undefined;
  // With no start time to go by: a lock from before the machine last started is stale.
  if (typeof body.bootAt === 'number' && Math.abs(body.bootAt - bootAt()) > 60_000) return undefined;
  return body.pid;
}

/**
 * Put the lock file in place, whole, or say that one is there. The words are written to a
 * file of this process's own first, and that file is then given the lock's name with a hard
 * link, which fails when the name is taken. So the lock is never there half-written: a
 * second server that looks at it in that moment cannot take an empty file for a leftover.
 */
function placeLock(lockFile: string, body: LockBody): boolean {
  const mine = `${lockFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(mine, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(fd, Buffer.from(JSON.stringify(body)));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(mine, lockFile);
    return true;
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/**
 * Take the board's lock, or throw `BoardBusyError`. The lock appears whole or not at all:
 * two servers starting at once cannot both win, however each spelled the path. A lock whose
 * process is gone is stale.
 */
export function takeLock(place: PrivatePlace, port: () => number | undefined): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = startOf(process.pid);
    const body: LockBody = { pid: process.pid, bootAt: bootAt(), ...(started !== undefined ? { started } : {}), at: new Date().toISOString() };
    if (!placeLock(place.lockFile, body)) {
      const pid = lockHolder(place);
      if (pid !== undefined) throw new BoardBusyError(port(), pid);
      fs.rmSync(place.lockFile, { force: true });
      continue;
    }
    held.add(place.lockFile);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.delete(place.lockFile);
      try {
        const text = readNoFollow(place.lockFile);
        if (text && (JSON.parse(text) as LockBody).pid === process.pid) fs.rmSync(place.lockFile, { force: true });
      } catch {
        // Gone already.
      }
    };
  }
  throw new Error(`Could not take the lock ${place.lockFile}.`);
}

/* ----------------------------------------------------------------- helpers */

function sameSeal(a: LogSeal | undefined, b: LogSeal): boolean {
  return a !== undefined && a.bytes === b.bytes && a.sha256 === b.sha256;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A folder only this user can enter: created 0700, and refused when it is a link or someone else's. */
function ownFolder(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  const st = lstatOf(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${dir} must be a real folder: it holds the owner's token.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} belongs to another user. It holds the owner's token, so the board will not use it.`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

function defaultToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
