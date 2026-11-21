import fs from 'node:fs';
import path from 'node:path';
import type { BoardState } from '@keel/protocol';
import { describeTarget, findBlueprint, oneLine } from '@keel/protocol';

/**
 * The records the builder writes before it writes code, in keel's own formats: the brief
 * (skills/keel/brief.md), from `renderBrief` in the contract, and a short decision record
 * (skills/keel/adr.md) from the owner's picks and what was left out.
 *
 * Where they go: the repository's convention first (the `## Keel` block of CLAUDE.md names
 * `Briefs:` and `Decisions:`), then a decisions folder that exists, then keel's defaults.
 * A path from the repository is used only when it stays inside it with no link on the way.
 */

export interface RecordPlaces {
  /** Relative to the repository's folder in the worktree. */
  briefs: string;
  decisions: string;
}

const DECISION_DIRS = ['docs/adr', 'docs/decisions', 'doc/adr', 'docs/architecture/decisions', 'adr'];

/** A relative path inside `root` that crosses no link. Undefined when the path is not one. */
export function safeRelative(root: string, rel: string): string | undefined {
  const clean = rel.trim().replace(/\/+$/, '');
  if (!clean || path.isAbsolute(clean) || /[\0\n\r]/.test(clean)) return undefined;
  const parts = clean.split(/[\\/]+/).filter((p) => p !== '.' && p !== '');
  if (parts.length === 0 || parts.some((p) => p === '..')) return undefined;
  let at = root;
  for (const p of parts) {
    at = path.join(at, p);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return undefined;
    } catch {
      break; // the rest does not exist yet, so it is no link
    }
  }
  return parts.join('/');
}

/** `Briefs:` and `Decisions:` from the `## Keel` block of CLAUDE.md, if it names them. */
export function keelBlock(text: string): { briefs?: string; decisions?: string } {
  const start = text.search(/^## Keel[ \t]*$/m);
  if (start < 0) return {};
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  const block = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const pick = (key: string) => new RegExp(`${key}:\\s*\`([^\`]+)\``).exec(block)?.[1];
  const out: { briefs?: string; decisions?: string } = {};
  const b = pick('Briefs');
  const d = pick('Decisions');
  if (b) out.briefs = b;
  if (d) out.decisions = d;
  return out;
}

export function recordPlaces(root: string): RecordPlaces {
  let named: { briefs?: string; decisions?: string } = {};
  try {
    const file = path.join(root, 'CLAUDE.md');
    if (fs.lstatSync(file).isFile()) named = keelBlock(fs.readFileSync(file, 'utf8'));
  } catch {
    // No CLAUDE.md: keel's defaults.
  }
  const briefs = (named.briefs && safeRelative(root, named.briefs)) || 'docs/briefs';
  const existing = DECISION_DIRS.find((d) => {
    try {
      return fs.lstatSync(path.join(root, d)).isDirectory() && safeRelative(root, d) !== undefined;
    } catch {
      return false;
    }
  });
  const decisions = (named.decisions && safeRelative(root, named.decisions)) || existing || 'docs/adr';
  return { briefs, decisions };
}

/** The next record number in a decisions folder: `0001` in an empty one. */
export function nextRecordNumber(dir: string): string {
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{3,5})[-_]/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    // No folder yet.
  }
  return String(max + 1).padStart(4, '0');
}

const RECORD = /^\d{3,5}[-_](.+)\.md$/;

/** The names records already have in the repository: each brief's, and each decision record's after its number. Lower case. */
function namesInTree(root: string): Set<string> {
  const places = recordPlaces(root);
  const out = new Set<string>();
  const list = (rel: string) => {
    try {
      return fs.readdirSync(path.join(root, rel));
    } catch {
      return [];
    }
  };
  for (const f of list(places.briefs)) if (f.endsWith('.md')) out.add(f.slice(0, -3).toLowerCase());
  for (const f of list(places.decisions)) {
    const m = RECORD.exec(f);
    if (m) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/**
 * A name for new records: `stem`, else `stem-2`, `stem-3`, and on, the first that is not in
 * `taken` and that no brief or decision record in the repository has. A record already there
 * is someone else's, so it is never taken for this build's own.
 */
export function freeRecordName(root: string, stem: string, taken: ReadonlySet<string>): string {
  const there = namesInTree(root);
  const free = (n: string) => !taken.has(n) && !there.has(n.toLowerCase());
  let name = stem;
  for (let n = 2; !free(name); n++) name = `${stem}-${n}`;
  return name;
}

/** The decision record of a chapter, in keel's format, from the board. Adds no decision. */
export function renderDecision(state: BoardState, chapter: string, o: { date: string; track: readonly string[]; check?: string; branch: string; brief?: string; home?: string }): string {
  const c = state.chapters[chapter];
  const bp = findBlueprint(state, chapter);
  // Every piece of board text goes in on one line: a line break in it must not stand as a line of its own.
  const title = oneLine(c?.title ?? chapter, 90);
  const names = o.track.map((id) => oneLine(state.model.parts[id]?.name ?? id, 40));
  const lines: string[] = [`# ${title}`, ''];
  const lead = [
    bp?.summary ? oneLine(bp.summary, 320) : undefined,
    `The owner worked this idea out on the board, solidified it, and pressed "Build this" on ${o.date}.`,
    `We decided to build it as ${names.length} ${names.length === 1 ? 'part' : 'parts'}, in this order, one commit each: ${names.join(', ')}.`,
    o.check ? `A part counts as built only when \`${oneLine(o.check, 300)}\` passes after its commit.` : undefined,
  ].filter(Boolean);
  lines.push(lead.join(' '), '', '**Status:** accepted', '');
  if (bp?.picks.length) {
    lines.push('**What the owner picked**', '');
    for (const p of bp.picks) lines.push(`- ${oneLine(p.text, 160)}${p.from ? ` (from ${oneLine(describeTarget(state, p.from).label, 120)})` : ''}`);
    lines.push('');
  }
  if (bp?.leftOut?.length) {
    lines.push('**Left out on purpose**', '');
    for (const l of bp.leftOut) lines.push(`- ${oneLine(l.text, 160)}${l.why ? ` ${oneLine(l.why, 160)}` : ''}`);
    lines.push('');
  }
  if (bp?.assumed?.length) {
    lines.push('**What the agent assumed**', '', 'The owner did not say these. Each one can be wrong.', '');
    for (const a of bp.assumed) lines.push(`- ${oneLine(a, 200)}`);
    lines.push('');
  }
  if (bp?.proof.length) {
    lines.push('**How you will know it works**', '');
    for (const p of bp.proof) lines.push(`- ${oneLine(p, 200)}`);
    lines.push('');
  }
  lines.push('**Consequences**', '');
  if (o.brief) lines.push(`- The brief, \`${o.brief}\`, is the same idea in plain words.`);
  lines.push(`- The code is built on the branch \`${o.branch}\`, in its own copy. It goes into ${o.home ? `\`${o.home}\`` : 'the main branch'} when you approve it on the board, after you try it.`);
  lines.push(`- The board is where this was decided: chapter \`${chapter}\`.`);
  return `${lines.join('\n').trimEnd()}\n`;
}

export interface WrittenRecords {
  brief: string;
  decision: string;
  /** False when the brief was there already: a resumed build writes nothing. */
  written: boolean;
}

export class RecordPathError extends Error {
  override name = 'RecordPathError';
}

/**
 * Make the folder `rel` inside `root`, one part at a time, and return it. Every part that is
 * there already must be a real folder, not a link, and the folder's real path must stay inside
 * the root's: a repository can ship `docs/briefs` as a link to anywhere.
 */
export function safeDir(root: string, rel: string): string {
  const clean = safeRelative(root, rel);
  if (!clean) throw new RecordPathError(`"${rel}" leaves the repository or passes through a link, so the builder writes no record there.`);
  let at = root;
  for (const part of clean.split('/')) {
    at = path.join(at, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(at);
    } catch {
      st = undefined;
    }
    if (st === undefined) fs.mkdirSync(at);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new RecordPathError(`"${clean}" passes through a link or a file at "${path.relative(root, at)}", so the builder writes no record there.`);
  }
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(at);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new RecordPathError(`"${clean}" leads outside the repository, so the builder writes no record there.`);
  return at;
}

/** Write a new file, never through a link and never over one: it fails if anything is there. */
export function writeNew(file: string, text: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/** Replace a file that is ours, in a folder checked again: through a new file and a rename, so a link at the path is replaced, not followed. */
export function replaceFile(root: string, rel: string, text: string): void {
  const dir = safeDir(root, path.posix.dirname(rel));
  const file = path.join(dir, path.posix.basename(rel));
  const tmp = path.join(dir, `.${path.posix.basename(rel)}.${process.pid}.tmp`);
  writeNew(tmp, text);
  fs.renameSync(tmp, file);
}

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Write the brief and the decision record into the repository's folder in the worktree,
 * unless the brief is there already. `chapter` is a name this build chose with
 * `freeRecordName`, so a brief of that name is its own. Returns their paths, relative to that
 * folder. Throws `RecordPathError` when a records folder leaves the worktree or passes through
 * a link.
 */
export function writeRecords(root: string, chapter: string, brief: string, decision: (briefPath: string) => string): WrittenRecords {
  const places = recordPlaces(root);
  const briefRel = `${places.briefs}/${chapter}.md`;
  const briefsDir = safeDir(root, places.briefs);
  const decisionsDir = safeDir(root, places.decisions);
  const briefAbs = path.join(briefsDir, `${chapter}.md`);
  if (exists(briefAbs)) {
    const prior = fs.readdirSync(decisionsDir).find((f) => RECORD.exec(f)?.[1] === chapter);
    return { brief: briefRel, decision: prior ? `${places.decisions}/${prior}` : '', written: false };
  }
  const name = `${nextRecordNumber(decisionsDir)}-${chapter}.md`;
  writeNew(briefAbs, brief.endsWith('\n') ? brief : `${brief}\n`);
  writeNew(path.join(decisionsDir, name), decision(briefRel));
  return { brief: briefRel, decision: `${places.decisions}/${name}`, written: true };
}
