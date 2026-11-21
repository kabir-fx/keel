import type { BoardEvent } from './events';
import { isAct } from './events';
import type { Actor, Id, Target } from './ids';
import { MAX_SEQ, seqOf } from './ids';
import { withAnchor, withArrowEnd } from './items';
import type { ModelOp } from './model';
import type { ActType } from './events';
import type { BoardState, Chapter, FeedEntry, ModelState, PartRecord } from './state';
import { dueParts, emptyState } from './state';
import { showRun } from './pictures';

/**
 * The reducer. It assumes the event passed the rules (see rules.ts), and it never throws:
 * an event that names something missing changes nothing.
 *
 * It only ever replaces an entry, and never changes one in place, so a state can be shared
 * with the state before it.
 */

const sameTarget = (a: Target | undefined, b: Target | undefined) => a?.item === b?.item && a?.sub === b?.sub;

/** The state after one more event. The state passed in is not changed. */
export function reduce(prev: BoardState, ev: BoardEvent): BoardState {
  const s = shallowCopy(prev);
  step(s, ev);
  return s;
}

/**
 * `seq` follows the event's own number, so a log with a skipped line never hands out an
 * id twice: the next event is always numbered after the highest one seen. A number beyond
 * what an id can carry is not followed, so one forged line cannot end the log.
 */
function nextSeq(seq: number, ev: BoardEvent): number {
  const n = seqOf(ev.id);
  return Number.isInteger(n) && n > seq && n <= MAX_SEQ ? n : seq + 1;
}

/** The state of a whole log. */
export function replay(events: Iterable<BoardEvent>): BoardState {
  const s = emptyState();
  for (const ev of events) step(s, ev);
  return s;
}

/**
 * Apply one event to a state in place. `reduce` copies the state's maps for every event,
 * which is right for an app that keeps the state before, and quadratic for a long log.
 * Use `step` to load a log, and only when nothing else holds the state.
 */
export function step(s: BoardState, ev: BoardEvent): void {
  const n = nextSeq(s.seq, ev);
  apply(s, ev, n);
  s.seq = n;
}

function shallowCopy(s: BoardState): BoardState {
  return {
    ...s,
    canvases: { ...s.canvases },
    canvasOrder: [...s.canvasOrder],
    chapters: { ...s.chapters },
    chapterOrder: [...s.chapterOrder],
    removedCanvases: { ...s.removedCanvases },
    removedChapters: { ...s.removedChapters },
    items: { ...s.items },
    itemOrder: [...s.itemOrder],
    model: copyModel(s.model),
    answered: { ...s.answered },
    edited: { ...s.edited },
    acts: { ...s.acts },
    feed: [...s.feed],
    moments: [...s.moments],
    reads: [...s.reads],
  };
}

export function copyModel(m: ModelState): ModelState {
  return {
    lanes: [...m.lanes],
    parts: { ...m.parts },
    partOrder: [...m.partOrder],
    edges: [...m.edges],
    walks: { ...m.walks },
    walkOrder: [...m.walkOrder],
  };
}

/** An event answered these for good. */
function markAnswered(s: BoardState, ids: readonly Id[] | undefined, by: string): void {
  if (!ids) return;
  for (const id of ids) {
    if (!Object.hasOwn(s.answered, id)) s.answered[id] = by;
  }
}

/** `n` is the event's number: what `seq` becomes once it is applied. */
function apply(s: BoardState, ev: BoardEvent, n: number): void {
  if (isAct(ev)) {
    s.acts[ev.id] = { id: ev.id, type: ev.type as ActType, chapter: ev.chapter, at: ev.at, event: ev };
  }

  switch (ev.type) {
    case 'board.open': {
      s.name = ev.name;
      return;
    }

    case 'canvas.open': {
      openCanvas(s, ev.canvas, ev.at, ev.title);
      return;
    }

    case 'chapter.open': {
      if (s.chapters[ev.chapter] || s.removedChapters[ev.chapter]) return;
      // With no canvas named: the board's first canvas, made now when the board has none.
      const canvas = ev.canvas ?? s.canvasOrder[0] ?? ev.chapter;
      if (s.removedCanvases[canvas]) return;
      openCanvas(s, canvas, ev.at);
      s.chapters[ev.chapter] = {
        id: ev.chapter,
        canvas,
        title: ev.title,
        state: 'idea',
        paused: false,
        picks: [],
        track: [],
        openedAt: ev.at,
      };
      s.chapterOrder.push(ev.chapter);
      return;
    }

    case 'chapter.rename': {
      const c = s.chapters[ev.chapter];
      if (c) s.chapters[ev.chapter] = { ...c, title: ev.title };
      return;
    }

    case 'item.add': {
      const id = ev.item.id;
      if (s.items[id]) return;
      s.items[id] = { item: ev.item, by: ev.by, chapter: ev.chapter, event: ev.id, at: ev.at, removed: false, touched: n };
      s.itemOrder.push(id);
      if (ev.item.kind === 'picture' && ev.item.picture.kind === 'choice') {
        s.items[id] = { ...s.items[id]!, chosen: ev.item.picture.chosen, chosenBy: ev.by };
      }
      return;
    }

    case 'item.update': {
      const cur = s.items[ev.item];
      if (!cur) return;
      const p = ev.patch;
      let item = cur.item;
      let next = { ...cur };
      if (p.box !== undefined) item = { ...item, box: p.box };
      if (p.rot !== undefined && item.kind !== 'picture') item = { ...item, rot: p.rot };
      if (p.text !== undefined) {
        const before = 'text' in item ? item.text : undefined;
        if (item.kind === 'note' || item.kind === 'voice') {
          if (p.text.length > 0) item = { ...item, text: p.text };
        } else if (item.kind === 'box' || item.kind === 'arrow' || item.kind === 'pin') {
          item = { ...item, text: p.text };
        }
        // The owner changed what a mark says: it is a new remark. Whatever answered the old
        // words no longer answers it.
        const after = 'text' in item ? item.text : undefined;
        if (ev.by === 'owner' && cur.by === 'owner' && after !== before) {
          delete s.answered[ev.item];
          s.edited[ev.item] = n;
        }
      }
      if (item.kind === 'arrow') {
        const before = item;
        if (p.arrowFrom !== undefined) item = withArrowEnd(item, 'from', p.arrowFrom);
        if (p.arrowTo !== undefined) item = withArrowEnd(item, 'to', p.arrowTo);
        if (p.labelAt !== undefined) item = { ...item, labelAt: p.labelAt };
        if (p.anchor !== undefined) item = withAnchor(item, p.anchor);
        // The owner pointed their arrow at something else: it is a new remark, as changed
        // words are. Holding the same things at another spot is not.
        const repointed = !sameTarget(before.fromTarget, item.fromTarget) || !sameTarget(before.toTarget, item.toTarget);
        if (ev.by === 'owner' && cur.by === 'owner' && repointed) {
          delete s.answered[ev.item];
          s.edited[ev.item] = n;
        }
      }
      if (item.kind === 'picture') {
        if (p.picture !== undefined) item = { ...item, picture: p.picture };
        if (p.status !== undefined) item = { ...item, status: p.status };
        if (p.answers !== undefined) item = { ...item, answers: p.answers };
        if (p.from !== undefined) item = { ...item, from: p.from };
        // Drawn again, or finished: from now on it answers what it names. A move does not count.
        if (p.picture !== undefined || p.status !== undefined || p.answers !== undefined) next = { ...next, touched: n };
        if (p.picture?.kind === 'choice') {
          const spec = p.picture;
          const keep = cur.chosenBy === 'owner' && spec.options.some((o) => o.id === cur.chosen);
          if (!keep) next = { ...next, chosen: spec.chosen, chosenBy: ev.by };
        }
      }
      s.items[ev.item] = { ...next, item };
      return;
    }

    case 'item.place': {
      const cur = s.items[ev.item];
      if (cur && cur.item.kind === 'picture') s.items[ev.item] = { ...cur, item: { ...cur.item, box: ev.box } };
      return;
    }

    case 'item.remove': {
      const cur = s.items[ev.item];
      if (cur) s.items[ev.item] = { ...cur, removed: true };
      return;
    }

    case 'item.restore': {
      const cur = s.items[ev.item];
      if (cur) s.items[ev.item] = { ...cur, removed: false };
      return;
    }

    case 'answer': {
      markAnswered(s, ev.answers, ev.id);
      s.reads.push({ id: ev.id, at: ev.at, answers: [...ev.answers], read: ev.read });
      return;
    }

    case 'model.patch': {
      for (const op of ev.ops) applyModelOp(s.model, op, ev.chapter);
      return;
    }

    case 'part.state': {
      const part = s.model.parts[ev.part];
      if (!part) return;
      const next: PartRecord = { ...part, state: ev.state };
      if (ev.state === 'built') {
        if (ev.commit !== undefined) next.commit = ev.commit;
        if (ev.check !== undefined) next.check = ev.check;
      } else if (ev.state === 'idea' || ev.state === 'later') {
        // Reopened or put off: the old evidence no longer stands for the part.
        delete next.commit;
        delete next.check;
      }
      settleLook(next, part.state, ev.by, n);
      s.model.parts[ev.part] = next;
      settleChaptersOf(s, ev.part, ev.at);
      const chapter = chapterOfPart(s, ev.part, ev.chapter);
      if (chapter) {
        s.feed.push({
          id: ev.id,
          at: ev.at,
          by: ev.by,
          chapter,
          kind: 'state',
          text: stateSentence(next, part.state),
          part: ev.part,
          ...(ev.commit !== undefined ? { commit: ev.commit } : {}),
          ...(ev.check !== undefined ? { check: ev.check } : {}),
          ...(ev.because !== undefined ? { because: [...ev.because] } : {}),
        });
      }
      return;
    }

    case 'solidify': {
      const c = s.chapters[ev.chapter];
      if (!c) return;
      const picks = [...c.picks];
      for (const p of ev.picks) if (!picks.includes(p)) picks.push(p);
      const next: Chapter = { ...c, picks };
      if (c.state === 'idea') {
        next.state = 'solid';
        next.solidAt = ev.at;
        next.solidSeq = n;
      }
      s.chapters[ev.chapter] = next;
      for (const id of ev.parts) {
        const p = s.model.parts[id];
        if (!p || p.dropped || p.external) continue;
        if (p.state !== 'idea' && p.state !== 'later') continue;
        const solid: PartRecord = { ...p, state: 'solid' };
        settleLook(solid, p.state, ev.by, n);
        s.model.parts[id] = solid;
        settleChaptersOf(s, id, ev.at);
      }
      // The lasso was the owner's way to say "these": the solidify that uses it closes it.
      if (ev.lasso !== undefined) markAnswered(s, [ev.lasso], ev.id);
      return;
    }

    case 'build.start': {
      const was = s.chapters[ev.chapter];
      if (!was) return;
      const { proved: _proved, ...c } = was;
      s.chapters[ev.chapter] = {
        ...c,
        state: 'building',
        paused: false,
        track: [...ev.track],
        check: ev.check,
        ...(ev.setup !== undefined ? { setup: ev.setup } : {}),
        ...(ev.show !== undefined ? { show: ev.show } : {}),
        ...(ev.blueprint !== undefined ? { blueprint: ev.blueprint } : {}),
      };
      settleChapter(s, ev.chapter, ev.at);
      pushStateFeed(s, ev, `Build started: ${ev.track.length} ${ev.track.length === 1 ? 'part' : 'parts'}.`);
      return;
    }

    case 'build.pause': {
      const c = s.chapters[ev.chapter];
      if (!c) return;
      s.chapters[ev.chapter] = { ...c, paused: true };
      pushStateFeed(s, ev, 'Paused by the owner.');
      return;
    }

    case 'build.resume': {
      const c = s.chapters[ev.chapter];
      if (!c) return;
      s.chapters[ev.chapter] = { ...c, paused: false };
      pushStateFeed(s, ev, 'Resumed by the owner.');
      return;
    }

    case 'build.proved': {
      const c = s.chapters[ev.chapter];
      if (!c) return;
      s.chapters[ev.chapter] = { ...c, proved: true };
      const run = showRun(c.show);
      s.feed.push({ id: ev.id, at: ev.at, by: ev.by, chapter: ev.chapter, kind: 'state', text: run ? `The app started and answered, as you will try it: \`${run}\`.` : 'The app started and answered.' });
      settleChapter(s, ev.chapter, ev.at);
      return;
    }

    case 'canvas.approve': {
      for (const id of unmergedOn(s, ev.canvas)) s.feed.push({ id: ev.id, at: ev.at, by: ev.by, chapter: id, kind: 'state', text: 'Approved by the owner.' });
      return;
    }

    case 'canvas.merged': {
      for (const id of unmergedOn(s, ev.canvas)) {
        s.chapters[id] = { ...s.chapters[id]!, merged: { commit: ev.commit, into: ev.into, at: ev.at } };
        s.feed.push({ id: ev.id, at: ev.at, by: ev.by, chapter: id, kind: 'state', text: `Merged into ${ev.into}.`, commit: ev.commit });
      }
      return;
    }

    case 'canvas.remove': {
      const canvas = s.canvases[ev.canvas];
      if (!canvas) return;
      for (const id of [...s.chapterOrder]) if (s.chapters[id]?.canvas === ev.canvas) removeChapter(s, id, ev.at);
      const { [ev.canvas]: _gone, ...rest } = s.canvases;
      s.canvases = rest;
      s.canvasOrder = s.canvasOrder.filter((id) => id !== ev.canvas);
      s.removedCanvases[ev.canvas] = { ...canvas, removedAt: ev.at };
      return;
    }

    case 'feed.add': {
      const entry: FeedEntry = {
        id: ev.id,
        at: ev.at,
        by: ev.by,
        chapter: ev.chapter,
        kind: ev.kind ?? 'update',
        text: ev.text,
      };
      if (ev.part !== undefined) entry.part = ev.part;
      if (ev.commit !== undefined) entry.commit = ev.commit;
      if (ev.check !== undefined) entry.check = ev.check;
      s.feed.push(entry);
      markAnswered(s, ev.answers, ev.id);
      return;
    }

    case 'choice.pick': {
      const cur = s.items[ev.item];
      if (cur) s.items[ev.item] = { ...cur, chosen: ev.option, chosenBy: ev.by };
      return;
    }

    case 'ask': {
      return;
    }

    case 'moment.add': {
      s.moments.push({ id: ev.id, at: ev.at, chapter: ev.chapter, title: ev.title, items: [...ev.items] });
      return;
    }
  }
}

/** Keep the record of who decided a part and who put it off in step with its state. */
function settleLook(next: PartRecord, before: string, by: Actor, n: number): void {
  if (next.state === 'solid' && before !== 'building') {
    next.decided = true;
    next.decidedSeq = n;
  }
  if (next.state === 'later') next.putOffBy = by;
  else delete next.putOffBy;
}

function pushStateFeed(s: BoardState, ev: BoardEvent & { chapter: Id }, text: string): void {
  s.feed.push({ id: ev.id, at: ev.at, by: ev.by, chapter: ev.chapter, kind: 'state', text });
}

function stateSentence(part: PartRecord, before: string): string {
  // The name the owner knows it by, then what it does.
  const name = part.plain ? `${part.name} (${part.plain})` : part.name;
  switch (part.state) {
    case 'building':
      return `Building: ${name}.`;
    case 'built':
      return `Built: ${name}.`;
    case 'solid':
      return before === 'building' ? `Set down, still decided: ${name}.` : `Decided: ${name}.`;
    case 'idea':
      return before === 'later' ? `Back in: ${name}.` : `Reopened: ${name}.`;
    case 'later':
      return `Put off: ${name}.`;
  }
}

/**
 * The chapter a part's news is filed under: the newest one that has it on its track, else
 * the one that added it, else the one the event names.
 */
function chapterOfPart(s: BoardState, part: Id, named: Id | undefined): Id | undefined {
  for (let i = s.chapterOrder.length - 1; i >= 0; i--) {
    const id = s.chapterOrder[i];
    if (id && s.chapters[id]?.track.includes(part)) return id;
  }
  const own = s.model.parts[part]?.chapter;
  if (own && s.chapters[own]) return own;
  return named && s.chapters[named] ? named : undefined;
}

/** Every chapter with this part on its track may have become built, or stopped being built. */
function settleChaptersOf(s: BoardState, part: Id, at: string): void {
  for (const id of s.chapterOrder) {
    if (s.chapters[id]?.track.includes(part)) settleChapter(s, id, at);
  }
}

/**
 * A building chapter is built when every part on its track is built, and building again
 * when one is not. A part the owner put off counts as off the track.
 */
function settleChapter(s: BoardState, chapter: Id, at: string): void {
  let c = s.chapters[chapter];
  if (!c || (c.state !== 'building' && c.state !== 'built') || c.track.length === 0) return;
  const due = dueParts(s, c);
  const parts = due.length > 0 && due.every((id) => s.model.parts[id]?.state === 'built');
  if (!parts && c.proved) {
    // What answered was the parts as they were.
    const { proved: _proved, ...rest } = c;
    c = rest;
    s.chapters[chapter] = c;
  }
  // An app is built when it has answered once (record 0013), not when its last part is.
  const done = parts && (c.show?.kind !== 'app' || c.proved === true);
  if (done && c.state !== 'built') s.chapters[chapter] = { ...c, state: 'built', builtAt: at };
  else if (!done && c.state === 'built') {
    // What is built again is not what the home branch has.
    const { builtAt: _dropped, merged: _merged, ...rest } = c;
    s.chapters[chapter] = { ...rest, state: 'building' };
  }
}

/** Make a canvas, unless it is there already or was deleted. */
function openCanvas(s: BoardState, canvas: Id, at: string, title?: string): void {
  if (s.canvases[canvas] || s.removedCanvases[canvas]) return;
  s.canvases[canvas] = { id: canvas, openedAt: at, ...(title !== undefined ? { title } : {}) };
  s.canvasOrder.push(canvas);
}

/** The built chapters on a canvas that the home branch does not have yet, oldest first. */
function unmergedOn(s: BoardState, canvas: Id): Id[] {
  return s.chapterOrder.filter((id) => {
    const c = s.chapters[id];
    return c !== undefined && c.canvas === canvas && c.state === 'built' && !c.merged;
  });
}

/**
 * An idea goes with its canvas. The chapter leaves `chapters` for `removedChapters`, its items
 * go off the board, and what waited on it waits no more. The parts it added go with it,
 * unless the home branch has its work or another idea builds them: a part that was never
 * merged is not part of the project. A part of another idea's that it was building is set
 * down, still decided.
 */
function removeChapter(s: BoardState, chapter: Id, at: string): void {
  const c = s.chapters[chapter];
  if (!c) return;
  const { [chapter]: _gone, ...rest } = s.chapters;
  s.chapters = rest;
  s.chapterOrder = s.chapterOrder.filter((id) => id !== chapter);
  s.removedChapters[chapter] = { ...c, removedAt: at };

  for (const id of s.itemOrder) {
    const it = s.items[id];
    if (it && it.chapter === chapter && !it.removed) s.items[id] = { ...it, removed: true };
  }
  for (const act of Object.values(s.acts)) {
    if (act.chapter !== chapter) continue;
    const { [act.id]: _act, ...others } = s.acts;
    s.acts = others;
  }
  s.feed = s.feed.filter((f) => f.chapter !== chapter);
  s.moments = s.moments.filter((m) => m.chapter !== chapter);

  const onAnotherTrack = (part: Id) => s.chapterOrder.some((id) => s.chapters[id]?.track.includes(part));
  for (const id of s.model.partOrder) {
    const p = s.model.parts[id];
    if (!p || p.dropped) continue;
    if (p.chapter === chapter && !c.merged && !p.shelf && !p.external && !onAnotherTrack(id)) {
      applyModelOp(s.model, { op: 'part.drop', id }, undefined);
    } else if (p.state === 'building' && c.track.includes(id) && !onAnotherTrack(id)) {
      s.model.parts[id] = { ...p, state: 'solid' };
    }
  }
}

/** The most columns a lane holds. */
export const MAX_COL = 16;

/** One model change. Used by the reducer, and by the rules to try a patch before it is admitted. */
export function applyModelOp(m: ModelState, op: ModelOp, chapter: Id | undefined): void {
  switch (op.op) {
    case 'lane.set': {
      const i = m.lanes.findIndex((l) => l.id === op.lane.id);
      if (i >= 0) {
        m.lanes[i] = op.lane;
        // `at` on a lane that is there already moves it.
        if (op.at !== undefined && op.at !== i) {
          m.lanes.splice(i, 1);
          m.lanes.splice(Math.min(op.at, m.lanes.length), 0, op.lane);
        }
      } else if (op.at !== undefined && op.at < m.lanes.length) m.lanes.splice(op.at, 0, op.lane);
      else m.lanes.push(op.lane);
      return;
    }

    case 'part.set': {
      const cur = m.parts[op.part.id];
      if (cur) {
        // What a part is (its state, its evidence, whether the repository had it, whether it is
        // outside the system) is set when it is added or by a `part.state` event, never here.
        const { state: _state, commit: _commit, external: _external, shelf: _shelf, ...rest } = op.part;
        const next: PartRecord = { ...cur, ...rest };
        // A part moved into a lane takes the next free column there.
        if (rest.lane !== undefined && rest.col === undefined && rest.lane !== cur.lane) next.col = nextCol(m, rest.lane);
        m.parts[op.part.id] = next;
        return;
      }
      const part: PartRecord = {
        id: op.part.id,
        name: op.part.name ?? op.part.id,
        state: op.part.external ? 'built' : (op.part.state ?? 'idea'),
      };
      if (op.part.lane !== undefined) {
        part.lane = op.part.lane;
        part.col = op.part.col ?? nextCol(m, op.part.lane);
      }
      if (op.part.external) part.external = true;
      if (op.part.plain !== undefined) part.plain = op.part.plain;
      if (op.part.commit !== undefined) part.commit = op.part.commit;
      if (op.part.shelf !== undefined) part.shelf = op.part.shelf;
      if (op.part.files !== undefined) part.files = op.part.files;
      if (op.part.note !== undefined) part.note = op.part.note;
      if (chapter !== undefined) part.chapter = chapter;
      m.parts[part.id] = part;
      m.partOrder.push(part.id);
      return;
    }

    case 'part.drop': {
      const cur = m.parts[op.id];
      if (!cur) return;
      m.parts[op.id] = { ...cur, dropped: true };
      m.edges = m.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      return;
    }

    case 'edge.set': {
      const i = m.edges.findIndex((e) => e.from === op.edge.from && e.to === op.edge.to);
      if (i >= 0) m.edges[i] = op.edge;
      else m.edges.push(op.edge);
      return;
    }

    case 'edge.drop': {
      m.edges = m.edges.filter((e) => !(e.from === op.from && e.to === op.to));
      return;
    }

    case 'walk.set': {
      if (!m.walks[op.walk.id]) m.walkOrder.push(op.walk.id);
      m.walks[op.walk.id] = op.walk;
      return;
    }

    case 'walk.drop': {
      if (!m.walks[op.id]) return;
      const { [op.id]: _gone, ...rest } = m.walks;
      m.walks = rest;
      m.walkOrder = m.walkOrder.filter((id) => id !== op.id);
      return;
    }
  }
}

/** The next free column of a lane. It can be one past the last column: the rules refuse a part that would land there. */
export function nextCol(m: ModelState, lane: Id): number {
  let max = 0;
  for (const id of m.partOrder) {
    const p = m.parts[id];
    if (p && !p.dropped && p.lane === lane && p.col !== undefined && p.col > max) max = p.col;
  }
  return max + 1;
}
