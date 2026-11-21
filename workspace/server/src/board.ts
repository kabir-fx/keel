import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Actor, BoardEvent, BoardState, EventDraft, LogProblem, PrivateBoardFile, RuleId, Verdict } from '@keel/protocol';
import { ASSETS_DIR, BOARD_DIR, EventId, LOG_FILE, admitAll, check, emptyState, formatEvent, parseEvent, step } from '@keel/protocol';
import { NOFOLLOW, readNoFollow, realFolder, refuseLinkedFile, writeAll } from './files';
import type { CommitCheck } from './git';
import { gitCommitCheck } from './git';

/**
 * One board on disk: `.keel/board/log.jsonl` in a repository, and the state it reduces to.
 * The log is only ever appended to. A line that cannot be read, or that breaks a rule, is
 * reported and left out, never rewritten.
 */

export type PostResult =
  | { ok: true; events: BoardEvent[] }
  | { ok: false; rule: RuleId; reason: string; index: number };

export type BoardListener = (events: readonly BoardEvent[], state: BoardState) => void;

/** The log's size and the SHA-256 of its bytes: what tells the log this server wrote from any other. */
export type LogSeal = NonNullable<PrivateBoardFile['log']>;

export interface BoardOpenOptions {
  /** Append `board.open` when the log is new. Default true. */
  create?: boolean;
  /** The board's name when it is new. Default: the folder's name. */
  name?: string;
  /** The clock that dates events. */
  now?: () => Date;
  /**
   * Check with git that the commit of a `built` part exists. Default true. Turn it off only
   * for tests and for replaying a fixture whose commits are in no repository.
   */
  checkCommits?: boolean | CommitCheck;
  /**
   * Check `canvas.merged` before it is admitted: its commit is in the repository, and the
   * home branch, by the name it gives, holds it. Left out: no `canvas.merged` is admitted.
   */
  checkMerged?: (commit: string, into: string) => Verdict;
  /**
   * The server's say on an event the rules admit, from what it does on this machine now: a
   * build that has not ended, a merge under way. Left out: the rules alone decide.
   */
  machine?: (event: BoardEvent) => Verdict;
  /** The seal of the log as this machine's server last wrote it, when it has one on file. */
  sealed?: LogSeal;
  /** Told once, when the log on disk is found to be no longer the file this board writes. */
  log?: (message: string) => void;
}

/** What a post is told once the log's file was replaced under the running board. */
export const LOG_REPLACED =
  'The board\'s log file was replaced on disk while the board runs: a pull, a checkout or a stash can do that. Nothing more is saved, because it would go to a file that is no longer there. Stop the board and open it again: keel-board stop, then keel-board open.';
/** What a post is told once the log's file was written by something else under the running board. */
export const LOG_CHANGED =
  'The board\'s log file was changed on disk while the board runs, by something other than the board. Nothing more is saved, so that the two do not mix. Stop the board and open it again: keel-board stop, then keel-board open.';

export class Board {
  readonly repoDir: string;
  /** `.keel/board` inside the repository. */
  readonly dir: string;
  readonly logPath: string;
  readonly assetsDir: string;
  /** The real path of `assets/`, as it was when the board opened. Asset reads and writes stay inside it. */
  readonly realAssetsDir: string;
  /** Lines of the log that were left out when the board was opened: unreadable, out of order, or against a rule. */
  readonly problems: LogProblem[];
  /**
   * Lines of the log, kept, that say a part was built at a commit this repository does not
   * have. A log read from disk can say anything: these are reported when the board opens.
   */
  readonly unproven: Array<LogProblem & { part: string; commit: string }>;
  /** The log as it was read from disk when the board opened, before this server wrote a line. */
  readonly loaded: LogSeal;
  /**
   * The number of the last event in the part of the log this machine's server wrote: the log
   * still starts with the sealed bytes. Events after it came from outside. 0 when no seal was
   * given, or when the log no longer starts with what was sealed: then every line is from outside.
   */
  readonly ownSeq: number;

  private readonly hash = crypto.createHash('sha256');
  private bytes = 0;
  private current: BoardState;
  private all: BoardEvent[];
  private fd: number | undefined;
  /** The file did not end with a newline: the next append starts a new line first. */
  private needsNewline: boolean;
  private readonly listeners = new Set<BoardListener>();
  private readonly now: () => Date;
  private readonly commitCheck: CommitCheck | undefined;
  private readonly mergedCheck: ((commit: string, into: string) => Verdict) | undefined;
  private readonly machine: ((event: BoardEvent) => Verdict) | undefined;
  private readonly warn: (message: string) => void;
  /** Why this board no longer writes: its log on disk is not the file it holds. Set once, and kept. */
  private apart: string | undefined;

  private constructor(repoDir: string, text: string, opts: BoardOpenOptions) {
    this.repoDir = repoDir;
    this.dir = path.join(repoDir, BOARD_DIR);
    this.logPath = path.join(this.dir, LOG_FILE);
    this.assetsDir = path.join(this.dir, ASSETS_DIR);
    this.realAssetsDir = fs.realpathSync(this.assetsDir);
    this.now = opts.now ?? (() => new Date());
    this.warn = opts.log ?? (() => {});
    const cc = opts.checkCommits ?? true;
    this.commitCheck = cc === true ? gitCommitCheck(repoDir) : cc === false ? undefined : cc;
    this.mergedCheck = opts.checkMerged;
    this.machine = opts.machine;

    const read = Buffer.from(text, 'utf8');
    this.took(read);
    this.loaded = this.seal();
    const loaded = loadLog(text);
    this.ownSeq = sealedSeq(read, opts.sealed, loaded.state.seq);
    this.problems = loaded.problems;
    this.all = loaded.events;
    this.current = loaded.state;
    this.unproven = [];
    if (this.commitCheck) {
      const seen = new Map<string, boolean>();
      for (const b of loaded.built) {
        let ok = seen.get(b.commit);
        if (ok === undefined) {
          ok = this.commitCheck(b.commit).ok;
          seen.set(b.commit, ok);
        }
        if (!ok) this.unproven.push({ line: b.line, part: b.part, commit: b.commit, reason: `part "${b.part}" is marked built at commit ${b.commit}, which this repository does not have` });
      }
    }
    this.needsNewline = text.length > 0 && !text.endsWith('\n');
    this.fd = fs.openSync(this.logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o644);
  }

  /**
   * Make the board's folders, as real folders, and refuse a board whose folders or files are
   * links. Writes nothing else. Returns `.keel/board`.
   */
  static prepare(repoDir: string): string {
    const repo = path.resolve(repoDir);
    if (!fs.statSync(repo).isDirectory()) throw new Error(`${repo} is not a folder.`);
    realFolder(repo, '.keel');
    realFolder(repo, BOARD_DIR);
    realFolder(repo, `${BOARD_DIR}/${ASSETS_DIR}`);
    refuseLinkedFile(repo, `${BOARD_DIR}/${LOG_FILE}`);
    refuseLinkedFile(repo, `${BOARD_DIR}/.gitignore`);
    return path.join(repo, BOARD_DIR);
  }

  /** Open the board of a repository folder, or create it. Refuses a board whose folders or files are links. */
  static open(repoDir: string, opts: BoardOpenOptions = {}): Board {
    const repo = path.resolve(repoDir);
    Board.prepare(repo);

    const text = readNoFollow(path.join(repo, BOARD_DIR, LOG_FILE)) ?? '';
    const board = new Board(repo, text, opts);

    if ((opts.create ?? true) && board.all.length === 0 && board.problems.length === 0) {
      const name = (opts.name ?? (path.basename(repo) || 'board')).slice(0, 80);
      const r = board.post([{ type: 'board.open', name }], 'system');
      if (!r.ok) throw new Error(`Could not open the board: ${r.rule} ${r.reason}`);
    }
    return board;
  }

  get state(): BoardState {
    return this.current;
  }

  get events(): readonly BoardEvent[] {
    return this.all;
  }

  /** The events numbered after `seq`. */
  eventsAfter(seq: number): BoardEvent[] {
    return this.all.filter((ev) => Number(ev.id.slice(1)) > seq);
  }

  /**
   * Admit drafts as one actor, all or none. On success the events are appended to the log
   * and flushed before the state changes and the listeners hear of them.
   */
  post(drafts: readonly unknown[], by: Actor): PostResult {
    if (this.fd === undefined) throw new Error('The board is closed.');
    const r = admitAll(this.current, drafts, by, this.now().toISOString());
    if (!r.ok) return r;
    if (r.events.length === 0) return { ok: true, events: [] };
    // Before a byte is written: is the file this board holds still the log at its path, with nothing added by another hand?
    const apart = this.checkOnDisk();
    if (apart !== undefined) return { ok: false, rule: 'shape', reason: apart, index: 0 };

    for (let i = 0; i < r.events.length; i++) {
      const ev = r.events[i]!;
      if (!EventId.safeParse(ev.id).success) {
        return { ok: false, rule: 'shape', reason: `The log is full: the next event would be ${ev.id}, which is not a valid event id. Nothing was written.`, index: i };
      }
      if (ev.type === 'part.state' && ev.state === 'built' && ev.commit !== undefined && this.commitCheck) {
        const v = this.commitCheck(ev.commit);
        if (!v.ok) return { ...v, index: i };
      }
      if (ev.type === 'canvas.merged') {
        const v = this.mergedCheck?.(ev.commit, ev.into) ?? { ok: false, rule: 'R2', reason: 'Only the board server says an idea is merged, after it checked the home branch.' };
        if (!v.ok) return { ...v, index: i };
      }
      const v = this.machine?.(ev);
      if (v && !v.ok) return { ...v, index: i };
    }

    const bytes = Buffer.from(`${this.needsNewline ? '\n' : ''}${r.events.map(formatEvent).join('\n')}\n`, 'utf8');
    writeAll(this.fd, bytes);
    fs.fsyncSync(this.fd);
    this.took(bytes);
    this.needsNewline = false;

    this.current = r.state;
    this.all.push(...r.events);
    for (const listener of this.listeners) {
      try {
        listener(r.events, r.state);
      } catch {
        // A listener's failure never undoes an event that is already in the log.
      }
    }
    return { ok: true, events: r.events };
  }

  subscribe(listener: BoardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Why the log on disk is no longer this board's own file, or undefined when it is. Git
   * replaces a file when it checks one out, so a pull or a checkout while the board runs
   * leaves the board holding a file that is no longer at the path: what it wrote there would
   * be lost. And a line added by another hand would sit in the middle of what the board writes.
   */
  private checkOnDisk(): string | undefined {
    if (this.apart !== undefined || this.fd === undefined) return this.apart;
    let why: string | undefined;
    try {
      const mine = fs.fstatSync(this.fd, { bigint: true });
      const there = fs.lstatSync(this.logPath, { bigint: true });
      if (there.dev !== mine.dev || there.ino !== mine.ino) why = LOG_REPLACED;
      else if (mine.size !== BigInt(this.bytes)) why = LOG_CHANGED;
    } catch {
      why = LOG_REPLACED;
    }
    if (why !== undefined) {
      this.apart = why;
      this.warn(why);
    }
    return why;
  }

  /** The log as it stands now: what was read, and every line this board appended. It still answers after `close`. */
  seal(): LogSeal {
    return { bytes: this.bytes, sha256: this.hash.copy().digest('hex') };
  }

  private took(bytes: Uint8Array): void {
    this.hash.update(bytes);
    this.bytes += bytes.length;
  }

  close(): void {
    if (this.fd === undefined) return;
    fs.closeSync(this.fd);
    this.fd = undefined;
    this.listeners.clear();
  }
}

/**
 * Read a log as if each event were arriving now. Each event goes through the rules in order,
 * as `audit` does. A line is left out, and reported, when it is not JSON, not an event, not
 * numbered after the event before it, numbered further on than the lines left out so far
 * allow, or against a rule. So a repository cannot ship a log in which the agent decided, and
 * one huge id cannot push every later id out of range.
 */
export function loadLog(text: string): {
  events: BoardEvent[];
  problems: LogProblem[];
  state: BoardState;
  /** The `built` events taken, with their lines, so their commits can be checked. */
  built: Array<{ line: number; part: string; commit: string }>;
} {
  const events: BoardEvent[] = [];
  const problems: LogProblem[] = [];
  const built: Array<{ line: number; part: string; commit: string }> = [];
  let state = emptyState();
  /** Lines left out since the last event that was taken. Each may have used one id. */
  let gap = 0;
  /** The highest id a left-out line may have used. The next id comes after it, so none is used twice. */
  let reserved = 0;
  const lines = text.split('\n');

  const leaveOut = (line: number, reason: string, id?: number) => {
    problems.push({ line, reason });
    gap += 1;
    if (id !== undefined && id > state.seq && id <= state.seq + gap) reserved = Math.max(reserved, id);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    const line = i + 1;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      leaveOut(line, 'not JSON', idOnLine(raw));
      continue;
    }
    const parsed = parseEvent(value);
    if (!parsed.ok) {
      leaveOut(line, parsed.reason, idOnLine(raw));
      continue;
    }
    const ev = parsed.value;
    const n = Number(ev.id.slice(1));
    if (n <= state.seq) {
      leaveOut(line, `${ev.id} is not after e${state.seq}, the event before it`);
      continue;
    }
    if (n > state.seq + 1 + gap) {
      const allowed = gap === 0 ? `e${state.seq + 1}` : `e${state.seq + 1} to e${state.seq + 1 + gap}`;
      leaveOut(line, `${ev.id} jumps ahead: after e${state.seq} the next event is ${allowed}`);
      continue;
    }
    const { id: _id, at: _at, ...draft } = ev;
    const verdict = check(state, draft as EventDraft);
    if (!verdict.ok) {
      leaveOut(line, `${ev.id} breaks ${verdict.rule}: ${verdict.reason}`, n);
      continue;
    }
    // In place: only this loop holds the state. A copy of the state per event would make a long log quadratic.
    step(state, ev);
    events.push(ev);
    if (ev.type === 'part.state' && ev.state === 'built' && ev.commit !== undefined) built.push({ line, part: ev.part, commit: ev.commit });
    gap = 0;
  }
  if (reserved > state.seq) state = { ...state, seq: reserved };
  return { events, problems, state, built };
}

/** The number of the last event inside the sealed start of a log, or 0 when the log does not start with the sealed bytes. */
function sealedSeq(read: Buffer, sealed: LogSeal | undefined, whole: number): number {
  if (!sealed || sealed.bytes === 0 || sealed.bytes > read.length) return 0;
  const head = read.subarray(0, sealed.bytes);
  if (crypto.createHash('sha256').update(head).digest('hex') !== sealed.sha256) return 0;
  return sealed.bytes === read.length ? whole : loadLog(head.toString('utf8')).state.seq;
}

/** The event number a line that could not be read seems to carry, if any. */
function idOnLine(raw: string): number | undefined {
  const m = /"id"\s*:\s*"e([1-9][0-9]{0,9})"/.exec(raw);
  return m ? Number(m[1]) : undefined;
}
