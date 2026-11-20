import type { BoardEvent, Box, Id } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, PEN_PAUSE } from '../src/App';
import { postAsOneStep, postRecorded } from '../src/board/log';
import type { Draft } from '../src/drafts';
import { STEP_WAIT_MS } from '../src/input/constants';
import { keyWords } from '../src/input/keytable';
import type { PostResult } from '../src/source';
import { localSource } from '../src/source';
import type { BoardCtx, UndoStep } from '../src/tools/types';
import type { Undo } from '../src/undo';
import { createUndo } from '../src/undo';
import { fakeBoard } from './fakeBoard';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { Keyboard, Pointer, frame, resetInput } from './pointer';

/**
 * Undo and Redo (`src/undo.ts`, and the recording of steps in `src/board/log.ts`).
 *
 * The first half is the list of steps as plain logic: a board in memory whose answers a test
 * can hold back, refuse or let through, so the order of steps, a step still on its way and a
 * refusal can each be played exactly. The second half is Undo on the board itself, by the keys.
 */

// The pictures are a test double: Undo never reads what a picture draws.
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: () => null,
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id }, `picture ${item.id}`),
}));

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.dispatchEvent(new Event('pointerdown'));
});

const AWAY: PostResult = { ok: false, rule: 'offline', reason: 'The board is away.' };

/** Two notes of the owner's, a placed card of the agent's (`a1`) and one that has no place yet (`a2`). */
function events(): BoardEvent[] {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [600, 0, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 300, 380, 200]));
  b.must('agent', text('a2', { answers: ['m2'] }));
  return b.events;
}

const moveTo = (item: Id, box: Box): Draft => ({ type: 'item.update', item, patch: { box } });
const addNote = (id: Id, words = `note ${id}`): Draft => ({ type: 'item.add', chapter: CH, item: { id, kind: 'note', box: [0, 400, 320, 100], text: words } });
const takeOff = (item: Id): Draft => ({ type: 'item.remove', item });

/** Let every answer that has arrived be heard. */
const turn = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * One board's Undo with the log's recording round it, and nothing else of the app. The owner's
 * posts go through `postRecorded`, as on the board; Undo's own go straight to the source. With
 * `hold()` the board stops answering, and a test answers each post by hand, oldest first.
 */
function rig() {
  const src = localSource({ events: events() });
  const n = src.events.length;
  const real = src.post;
  const held: Array<{ draft: Draft; answer: (r: PostResult) => void }> = [];
  let holding = false;
  src.post = (draft) => (holding ? new Promise<PostResult>((answer) => held.push({ draft, answer })) : real(draft));

  const said: string[] = [];
  /** A stand-in for the Pen: a go with this many finished strokes. */
  const pen = {
    strokes: 0,
    dropStroke: () => {
      if (pen.strokes === 0) return false;
      pen.strokes -= 1;
      return true;
    },
  };
  let selection: readonly Id[] = [];
  // Undo is made with the board, and the board's `send` records through Undo: the one is asked for when the other posts.
  let made: Undo | undefined;
  const steps = (): Undo['steps'] => {
    if (!made) throw new Error('the rig posted before it was made');
    return made.steps;
  };
  const board: BoardCtx = {
    ...fakeBoard().board,
    state: () => src.state,
    say: (line) => said.push(line),
    selected: () => (selection.length === 1 ? selection[0] : undefined),
    selection: () => selection,
    select: (what) => {
      selection = what === undefined ? [] : typeof what === 'string' ? [what] : what;
    },
    send: (draft) => postRecorded(src, steps(), draft),
  };
  const undo = createUndo(board, pen, (draft) => src.post(draft));
  made = undo;

  return {
    src,
    board,
    undo,
    said,
    pen,
    held,
    select: board.select,
    selected: board.selected,
    /** The owner does something: the event is posted and recorded, as a tool would. */
    owner: (draft: Draft) => board.send(draft),
    /** The agent, or the owner in another tab, does something: it reaches the board at once, and no step is recorded here. */
    other: (by: 'agent' | 'owner' | 'system', draft: Draft) => src.postAs(by, draft),
    /** The board stops answering: each post waits for `land`, `refuse` or `away`. */
    hold: () => {
      holding = true;
    },
    /** The board answers again by itself. */
    release: () => {
      holding = false;
    },
    /** The board takes the oldest post it holds. */
    land: async () => {
      const h = held.shift();
      if (!h) throw new Error('no post is held');
      h.answer(await real(h.draft));
      await turn();
    },
    /** The board is away for the oldest post it holds. */
    away: async () => {
      held.shift()?.answer(AWAY);
      await turn();
    },
    /** What reached the log since the rig was made: `[type, item id]`, and the patch of a change. */
    log: () =>
      src.events.slice(n).map((e) => {
        if (e.type === 'item.add') return [e.type, e.item.id];
        if (e.type === 'item.update') return [e.type, e.item, e.patch];
        if (e.type === 'item.remove' || e.type === 'item.restore') return [e.type, e.item];
        return [e.type];
      }),
    box: (id: Id) => src.state.items[id]?.item.box,
    removed: (id: Id) => src.state.items[id]?.removed,
  };
}

/** Undo or Redo, and every answer it waits for when the board answers by itself. */
async function press(r: ReturnType<typeof rig>, what: 'undo' | 'redo' = 'undo') {
  r.undo[what]();
  await turn();
}

describe('a step, and its way back', () => {
  it('a move: Undo changes the box back, Redo changes it again, and nothing else is touched', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    await press(r, 'redo');
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    expect(r.log()).toEqual([
      ['item.update', 'm1', { box: [50, 60, 320, 100] }],
      ['item.update', 'm1', { box: [0, 0, 320, 100] }],
      ['item.update', 'm1', { box: [50, 60, 320, 100] }],
    ]);
    expect(r.said).toEqual([]);
  });

  it('a mark added: Undo takes it off, Redo puts it back', async () => {
    const r = rig();
    await r.owner(addNote('m9'));
    await press(r);
    expect(r.removed('m9')).toBe(true);
    await press(r, 'redo');
    expect(r.removed('m9')).toBe(false);
    expect(r.log()).toEqual([['item.add', 'm9'], ['item.remove', 'm9'], ['item.restore', 'm9']]);
  });

  it('a thing taken off: Undo puts it back, Redo takes it off again, an agent’s picture too', async () => {
    const r = rig();
    await r.owner(takeOff('a1'));
    await press(r);
    expect(r.removed('a1')).toBe(false);
    await press(r, 'redo');
    expect(r.removed('a1')).toBe(true);
    expect(r.log()).toEqual([['item.remove', 'a1'], ['item.restore', 'a1'], ['item.remove', 'a1']]);
  });

  it('a change of words records the words it replaced, and of a change with two fields both', async () => {
    const r = rig();
    await r.owner({ type: 'item.update', item: 'm1', patch: { text: 'new words', box: [0, 0, 320, 160] } });
    await press(r);
    expect(r.src.state.items.m1!.item).toMatchObject({ text: 'note m1', box: [0, 0, 320, 100] });
    expect(r.log()[1]).toEqual(['item.update', 'm1', { text: 'note m1', box: [0, 0, 320, 100] }]);
    await press(r, 'redo');
    expect(r.src.state.items.m1!.item).toMatchObject({ text: 'new words', box: [0, 0, 320, 160] });
  });

  it('a label given to a box that had none is taken back as no label, and the box is then as it was added', async () => {
    const r = rig();
    await r.owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [10, 10, 100, 80] } });
    await r.owner({ type: 'item.update', item: 'b1', patch: { text: 'why' } });
    await press(r);
    expect(r.log()[2]).toEqual(['item.update', 'b1', { text: '' }]);
    // The box holds an empty label now where it had none: that is the same box, so the step before can still be taken back.
    await press(r);
    expect(r.removed('b1')).toBe(true);
    expect(r.said).toEqual([]);
    await press(r, 'redo');
    await press(r, 'redo');
    expect(r.src.state.items.b1).toMatchObject({ removed: false, item: { text: 'why' } });
  });

  it('an arrow’s end set again is put back whole: its point, its target and its tie', async () => {
    const r = rig();
    await r.owner({
      type: 'item.add',
      chapter: CH,
      item: { id: 'ar', kind: 'arrow', box: [0, 0, 100, 100], from: [0, 0], to: [100, 100], toTarget: { item: 'm2' }, toTie: { at: [0.5, 0.5], mode: 'outline' } },
    });
    await r.owner({ type: 'item.update', item: 'ar', patch: { arrowTo: { at: [80, 20] }, labelAt: 0.25 } });
    expect(r.src.state.items.ar!.item).toMatchObject({ to: [80, 20], labelAt: 0.25 });
    expect(r.src.state.items.ar!.item).not.toHaveProperty('toTarget');
    await press(r);
    expect(r.src.state.items.ar!.item).toMatchObject({ to: [100, 100], toTarget: { item: 'm2' }, toTie: { at: [0.5, 0.5], mode: 'outline' } });
    // The label had no place of its own: it is back in the middle, which is the same thing.
    await press(r);
    expect(r.removed('ar')).toBe(true);
    expect(r.said).toEqual([]);
  });

  it('what has no way back says so: a picture that had no place before it was moved', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('a2', [900, 900, 300, 200]));
    await press(r);
    expect(r.said).toEqual(['Undo cannot take back the picture you moved.']);
    expect(r.box('a2')).toEqual([900, 900, 300, 200]);
    // The step is gone from the list, and the one before it is the next.
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('placing a picture, solidify, "Build this", a choice, an ask and a new chapter are not steps', async () => {
    const r = rig();
    const notSteps: Draft[] = [
      { type: 'item.place', item: 'a2', box: [900, 900, 300, 200] },
      { type: 'solidify', chapter: CH, picks: ['a1'], parts: [] },
      { type: 'build.start', chapter: CH, track: ['queue'], check: 'make check' },
      { type: 'choice.pick', item: 'a1', option: 'b' },
      { type: 'ask', what: 'focus', part: 'queue' },
      { type: 'chapter.open', chapter: 'next', title: 'The next idea' },
    ];
    for (const draft of notSteps) expect(r.undo.steps.begin(draft, r.src.state), draft.type).toBeUndefined();
    // And posted through the log, such an event leaves Undo with nothing to take back.
    expect((await r.owner({ type: 'chapter.rename', chapter: CH, title: 'Another name' })).ok).toBe(true);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
    expect(r.log()).toEqual([['chapter.rename']]);
  });

  it('Undo is always told how its own events are posted: by default they would go through `send`, and be recorded as new steps', () => {
    const r = rig();
    // @ts-expect-error `post` has no default: the typecheck fails if one comes back.
    const made = () => createUndo(r.board, r.pen);
    expect(made).not.toThrow();
  });

  it('with no step made on this page, Undo and Redo say there is nothing to do, and post nothing', async () => {
    const r = rig();
    await press(r);
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to undo.', 'There is nothing to redo.']);
    expect(r.log()).toEqual([]);
  });

  it('Undo of a mark that is selected takes the selection off it first', async () => {
    const r = rig();
    await r.owner(addNote('m9'));
    r.select('m9');
    await press(r);
    expect(r.selected()).toBeUndefined();
  });
});

describe('the order of steps', () => {
  it('Undo goes back through the steps newest first, and Redo comes forward again', async () => {
    const r = rig();
    await r.owner(addNote('m9'));
    await r.owner(moveTo('m9', [10, 500, 320, 100]));
    await r.owner(takeOff('m9'));
    await press(r);
    await press(r);
    await press(r);
    expect(r.log().slice(3)).toEqual([['item.restore', 'm9'], ['item.update', 'm9', { box: [0, 400, 320, 100] }], ['item.remove', 'm9']]);
    await press(r, 'redo');
    await press(r, 'redo');
    await press(r, 'redo');
    expect(r.log().slice(6)).toEqual([['item.restore', 'm9'], ['item.update', 'm9', { box: [10, 500, 320, 100] }], ['item.remove', 'm9']]);
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
  });

  it('a new step empties the redo list; a step the board refused does not', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    // Refused: `m7` is not on the board. Nothing was done, so the move can still be redone.
    expect((await r.owner(moveTo('m7', [1, 1, 1, 1]))).ok).toBe(false);
    await press(r, 'redo');
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r);
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('a step keeps the place its gesture took, however late the board answers: ink that waits for its snapshot, then a move', async () => {
    const r = rig();
    // The pen rests: its marks are one step, from now.
    r.undo.steps.together(['m8', 'm9']);
    // The owner moves a note while the ink is still on its way. The move reaches the board first.
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    await press(r);
    // The move was made last: it is the first to go back.
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    await press(r);
    expect(r.log().slice(4)).toEqual([['item.remove', 'm9'], ['item.remove', 'm8']]);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });

  it('a step made while an earlier one is still on its way comes after it', async () => {
    const r = rig();
    r.hold();
    void r.owner(moveTo('m1', [50, 60, 320, 100]));
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.land();
    await r.land();
    r.release();
    await press(r);
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
  });

  it('a go of the pen that became several marks is one step: Undo takes them off together, Redo puts them back', async () => {
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    await press(r);
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    await press(r, 'redo');
    expect([r.removed('m8'), r.removed('m9')]).toEqual([false, false]);
    expect(r.log().slice(2)).toEqual([['item.remove', 'm9'], ['item.remove', 'm8'], ['item.restore', 'm8'], ['item.restore', 'm9']]);
  });

  it('a step recorded by hand is one step like any other, in the order it happened', async () => {
    const r = rig();
    const back: string[] = [];
    const closed: UndoStep = { what: 'the note you closed', undo: () => (back.push('undo'), true), redo: () => (back.push('redo'), true) };
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.undo.record(closed);
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await press(r);
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
    expect(back).toEqual([]);
    await press(r);
    expect(back).toEqual(['undo']);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    await press(r, 'redo');
    await press(r, 'redo');
    expect(back).toEqual(['undo', 'redo']);
    await press(r, 'redo');
    expect(r.box('m2')).toEqual([700, 0, 320, 100]);
    expect(r.said).toEqual([]);
  });

  it('a step recorded by hand with no way to do it again is not redone, and one that fails says so and is dropped', async () => {
    const r = rig();
    r.undo.record({ what: 'the note you closed', undo: () => true });
    await press(r);
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
    r.undo.record({ what: 'the pin you dropped', undo: async () => false });
    await press(r);
    expect(r.said[1]).toBe('Undo could not bring back the pin you dropped.');
    r.undo.record({ what: 'the note you closed', undo: () => true, redo: () => false });
    await press(r);
    await press(r, 'redo');
    expect(r.said[2]).toBe('Redo could not take the note you closed away again.');
    await press(r);
    expect(r.said[3]).toBe('There is nothing to undo.');
  });

  it('a step recorded by hand can be taken out of the list again: it costs no press, from the undo list or the redo list', async () => {
    const r = rig();
    const back: string[] = [];
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    const forget = r.undo.record({ what: 'the words on your box', undo: () => (back.push('undo'), true) });
    forget();
    // One press goes straight to the step before.
    await press(r);
    expect(back).toEqual([]);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);

    // Taken back, a step waits in the redo list: out of there too.
    const again = r.undo.record({ what: 'the note you closed', undo: () => true, redo: () => (back.push('redo'), true) });
    await press(r);
    again();
    await press(r, 'redo');
    expect(back).toEqual([]);
    expect(r.said).toEqual(['There is nothing to redo.']);
    // Taking it out twice is nothing.
    again();
  });

  it('recording a step by hand empties the redo list too', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    r.undo.record({ what: 'the note you closed', undo: () => true });
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
  });

  it('a step recorded by hand is undone, redone and undone again, and each crossing calls its own way once', async () => {
    const r = rig();
    const back: string[] = [];
    r.undo.record({ what: 'the note you closed', undo: () => (back.push('undo'), true), redo: () => (back.push('redo'), true) });
    await press(r);
    expect(back).toEqual(['undo']);
    await press(r, 'redo');
    expect(back).toEqual(['undo', 'redo']);
    await press(r);
    expect(back).toEqual(['undo', 'redo', 'undo']);
    expect(r.said).toEqual([]);
  });

  it('a step recorded by hand whose way to do it again fails leaves both lists, and the board says so', async () => {
    const r = rig();
    r.undo.record({ what: 'the note you closed', undo: () => true, redo: async () => false });
    await press(r);
    await press(r, 'redo');
    await press(r, 'redo');
    await press(r);
    expect(r.said).toEqual(['Redo could not take the note you closed away again.', 'There is nothing to redo.', 'There is nothing to undo.']);
  });

  it('a step recorded by hand whose own way back makes a new step is not put on the redo list', async () => {
    const r = rig();
    const back: string[] = [];
    const undo = async () => {
      await r.owner(moveTo('m1', [50, 60, 320, 100]));
      return true;
    };
    r.undo.record({ what: 'the note you closed', undo, redo: () => (back.push('redo'), true) });
    await press(r);
    await turn();
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r, 'redo');
    expect(back).toEqual([]);
    expect(r.said).toEqual(['There is nothing to redo.']);
    // The move it made is the newest step.
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });
});

describe('a step that is still on its way to the log', () => {
  it('Undo waits for it, and takes that step back: never the one before', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    r.undo.undo();
    await turn();
    // Nothing has been taken back while the move of m2 is on its way.
    expect(r.held.map((h) => h.draft)).toEqual([moveTo('m2', [700, 0, 320, 100])]);
    r.release();
    await r.land();
    await turn();
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
  });

  it('when the board refuses the step, that Undo takes nothing back: what the owner meant to undo never happened', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    r.undo.undo();
    await r.away();
    r.release();
    await turn();
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    expect(r.log()).toHaveLength(1);
    // The next Undo is for the step before, as it should be.
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('Undo waits for ink whose marks are still to be posted, and then takes all of it back', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    r.undo.undo();
    await turn();
    expect(r.removed('m8')).toBe(false);
    await r.owner(addNote('m9'));
    await turn();
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
  });

  it('a mark that will not be posted after all no longer keeps Undo waiting', async () => {
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    r.undo.undo();
    await turn();
    expect(r.removed('m8')).toBe(false);
    r.undo.steps.notComing('m9');
    await turn();
    expect(r.removed('m8')).toBe(true);
  });

  it(`a wait that ended well says nothing later: once the step has landed, ${STEP_WAIT_MS} ms on, the board has said nothing about waiting`, async () => {
    vi.useFakeTimers();
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    r.undo.undo();
    await vi.advanceTimersByTimeAsync(10);
    await r.owner(addNote('m9'));
    await vi.advanceTimersByTimeAsync(0);
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(STEP_WAIT_MS * 2);
    expect(r.said).toEqual([]);
  });

  it(`a mark that never comes holds Undo up for ${STEP_WAIT_MS} ms and no longer, and the board says Undo stopped waiting`, async () => {
    vi.useFakeTimers();
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    r.undo.undo();
    await vi.advanceTimersByTimeAsync(STEP_WAIT_MS - 1);
    expect(r.removed('m8')).toBe(false);
    expect(r.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.removed('m8')).toBe(true);
    expect(r.said).toEqual(['Undo stopped waiting for the rest of the note you added: it has not reached the board.']);
    // If the mark does come in the end, it is a step of its own.
    await r.owner(addNote('m9'));
    r.undo.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.removed('m9')).toBe(true);
  });

  it(`a step of which nothing reaches the board in ${STEP_WAIT_MS} ms: Undo stops waiting, says so, and takes nothing back`, async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.undo.steps.together(['m8']);
    r.undo.undo();
    await vi.advanceTimersByTimeAsync(STEP_WAIT_MS);
    expect(r.said).toEqual(['Undo stopped waiting: your last step has not reached the board.']);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    // The next Undo is for the step before.
    r.undo.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('two moves of one note, the second made before the first is answered: Undo puts it back at the first move’s place, then at the start', async () => {
    const r = rig();
    r.hold();
    void r.owner(moveTo('m1', [50, 60, 320, 100]));
    void r.owner(moveTo('m1', [90, 90, 320, 100]));
    await r.land();
    await r.land();
    r.release();
    expect(r.box('m1')).toEqual([90, 90, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    expect(r.said).toEqual([]);
  });

  it('two moves of one note, and the board refuses the first for now: the second replaced the start, and Undo puts the note back there', async () => {
    const r = rig();
    r.hold();
    void r.owner(moveTo('m1', [50, 60, 320, 100]));
    void r.owner(moveTo('m1', [90, 90, 320, 100]));
    await r.away();
    await r.land();
    r.release();
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });

  it('a move made while Undo of the same note is on its way replaced where Undo put it: Undo of that move goes back there', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    r.undo.undo();
    await turn();
    void r.owner(moveTo('m1', [90, 90, 320, 100]));
    await r.land();
    await r.land();
    r.release();
    expect(r.box('m1')).toEqual([90, 90, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    expect(r.said).toEqual([]);
  });

  it('a new mark whose chapter is opened first takes its place as its gesture ends, not once the chapter is answered', async () => {
    const r = rig();
    r.hold();
    const chapter: Draft = { type: 'chapter.open', chapter: 'next', title: 'The next idea' };
    const posted = postAsOneStep(r.board.send, r.undo.steps, 'm9', [chapter, { ...addNote('m9'), chapter: 'next' }]);
    // While the chapter is on its way, the owner moves a note: that move is the newer step.
    void r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.land();
    await r.land();
    await r.land();
    r.release();
    expect(await posted).toBe(true);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    expect(r.removed('m9')).toBe(false);
    await press(r);
    expect(r.removed('m9')).toBe(true);
  });

  it('a new mark whose chapter the board refuses leaves no step behind, and Undo does not wait for it', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    const posted = postAsOneStep(r.board.send, r.undo.steps, 'm9', [{ type: 'chapter.open', chapter: 'next', title: 'The next idea' }, { ...addNote('m9'), chapter: 'next' }]);
    await r.away();
    r.release();
    expect(await posted).toBe(false);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('ink of which nothing reached the board is no step', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.undo.steps.together(['m8']);
    r.undo.steps.notComing('m8');
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('Redo waits for a step that is on its way, and finds nothing to redo once it has landed', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    r.hold();
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    r.undo.redo();
    await turn();
    expect(r.held).toHaveLength(1);
    r.release();
    await r.land();
    await turn();
    expect(r.said).toEqual(['There is nothing to redo.']);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('a post that throws still tells Undo, so nothing waits for it', async () => {
    const r = rig();
    r.src.post = () => Promise.reject(new Error('the socket broke'));
    await expect(r.owner(moveTo('m1', [50, 60, 320, 100]))).rejects.toThrow('the socket broke');
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });
});

describe('Undo and Redo, one at a time', () => {
  it('three Undos asked for at once run in order, each after the one before has reached the board', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.owner(addNote('m9'));
    r.hold();
    r.undo.undo();
    r.undo.undo();
    r.undo.undo();
    await turn();
    // Only the first is on its way.
    expect(r.held.map((h) => h.draft)).toEqual([takeOff('m9')]);
    await r.land();
    expect(r.held.map((h) => h.draft)).toEqual([moveTo('m2', [600, 0, 320, 100])]);
    await r.land();
    expect(r.held.map((h) => h.draft)).toEqual([moveTo('m1', [0, 0, 320, 100])]);
    await r.land();
    expect(r.held).toEqual([]);
  });

  it('Undo then Redo asked for at once: the Redo is for the step that Undo is taking back', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    r.undo.undo();
    r.undo.redo();
    await r.land();
    await r.land();
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    expect(r.log()).toHaveLength(3);
  });

  it('an Undo that waits its turn is dropped when the owner makes a new step: it was asked for before that step', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    r.hold();
    r.undo.undo();
    r.undo.undo();
    await turn();
    // The second Undo still waits. The owner makes a new step.
    void r.owner(addNote('m9'));
    await r.land();
    await r.land();
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
    // Neither the new note nor the first move was taken back, and nothing more is on its way.
    expect(r.held).toEqual([]);
    expect(r.removed('m9')).toBe(false);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
  });

  it('a step made while an Undo is on its way empties the redo list: what Undo took back is not redone over it', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    r.undo.undo();
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.land();
    await r.land();
    r.release();
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
    // The new step is still the newest: Undo takes it back.
    await press(r);
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
  });

  it('a step that reaches the board before a long Undo has finished empties the redo list for good: the Undo does not fill it again', async () => {
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    r.hold();
    // Undo takes the ink off mark by mark. Between the two, the owner moves a note.
    r.undo.undo();
    await turn();
    void r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.land();
    await r.land();
    await r.land();
    r.release();
    expect([r.removed('m8'), r.removed('m9'), r.box('m1')]).toEqual([true, true, [50, 60, 320, 100]]);
    await press(r, 'redo');
    expect(r.said).toEqual(['There is nothing to redo.']);
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    // The move is the newest step.
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('a step made while a Redo is on its way comes after the step that is redone', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    r.hold();
    r.undo.redo();
    void r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.land();
    await r.land();
    r.release();
    await press(r);
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });
});

describe('one step for several things (`together`)', () => {
  it('three moves posted together are one step: Undo puts all three back, and Redo moves them again', async () => {
    const r = rig();
    r.undo.steps.together(['m1', 'm2', 'a1']);
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.owner(moveTo('a1', [500, 400, 380, 200]));
    await press(r);
    expect([r.box('m1'), r.box('m2'), r.box('a1')]).toEqual([
      [0, 0, 320, 100],
      [600, 0, 320, 100],
      [400, 300, 380, 200],
    ]);
    await press(r, 'redo');
    expect([r.box('m1'), r.box('m2'), r.box('a1')]).toEqual([
      [50, 60, 320, 100],
      [700, 0, 320, 100],
      [500, 400, 380, 200],
    ]);
    await press(r);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });

  it('three things taken off together are one step: Undo puts all three back, and Redo takes them off again', async () => {
    const r = rig();
    r.undo.steps.together(['m1', 'm2', 'a1']);
    await r.owner(takeOff('m1'));
    await r.owner(takeOff('m2'));
    await r.owner(takeOff('a1'));
    await press(r);
    expect([r.removed('m1'), r.removed('m2'), r.removed('a1')]).toEqual([false, false, false]);
    expect(r.log().slice(3)).toEqual([['item.restore', 'a1'], ['item.restore', 'm2'], ['item.restore', 'm1']]);
    await press(r, 'redo');
    expect([r.removed('m1'), r.removed('m2'), r.removed('a1')]).toEqual([true, true, true]);
    await press(r);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });

  it('a group in which the board refuses one event is still one step of the others', async () => {
    const r = rig();
    r.undo.steps.together(['m1', 'm7', 'm2']);
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    // `m7` is not on the board.
    expect((await r.owner(moveTo('m7', [1, 1, 1, 1]))).ok).toBe(false);
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await press(r);
    expect([r.box('m1'), r.box('m2')]).toEqual([
      [0, 0, 320, 100],
      [600, 0, 320, 100],
    ]);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });

  it('a group in which the agent changed one thing meanwhile: Undo takes back the rest, and says the line for the one it left', async () => {
    const r = rig();
    r.undo.steps.together(['m1', 'a1']);
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('a1', [500, 400, 380, 200]));
    await r.other('agent', takeOff('a1'));
    await press(r);
    expect(r.said).toEqual(['Undo skipped the picture you moved: it has changed since.']);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
    expect(r.removed('a1')).toBe(true);
    // Redo moves again what Undo took back, and only that.
    const n = r.log().length;
    await press(r, 'redo');
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    expect(r.log()).toHaveLength(n + 1);
  });

  it('a thing an earlier gesture still waits for stays with that gesture', async () => {
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    r.undo.steps.together(['m9']);
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    await press(r);
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    await press(r);
    expect(r.said).toEqual(['There is nothing to undo.']);
  });
});

describe('a thing that has changed since the step', () => {
  it('a move of a picture the agent has taken off since is skipped, with one line', async () => {
    const r = rig();
    await r.owner(moveTo('a1', [500, 400, 380, 200]));
    await r.other('agent', takeOff('a1'));
    const n = r.log().length;
    await press(r);
    expect(r.said).toEqual(['Undo skipped the picture you moved: it has changed since.']);
    expect(r.log()).toHaveLength(n);
    // The step is gone: there is nothing more to undo, and nothing to redo.
    await press(r);
    await press(r, 'redo');
    expect(r.said.slice(1)).toEqual(['There is nothing to undo.', 'There is nothing to redo.']);
  });

  it('a move of a note the owner has moved again in another tab is skipped: that move is not written over', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.other('owner', moveTo('m1', [200, 200, 320, 100]));
    await press(r);
    expect(r.said).toEqual(['Undo skipped the note you moved: it has changed since.']);
    expect(r.box('m1')).toEqual([200, 200, 320, 100]);
  });

  it('a move is still taken back when the agent has drawn the picture again: Undo writes the box only, and the new drawing stays', async () => {
    const r = rig();
    await r.owner(moveTo('a1', [500, 400, 380, 200]));
    await r.other('agent', { type: 'item.update', item: 'a1', patch: { picture: { kind: 'text', title: 'drawn again' } } });
    await press(r);
    expect(r.said).toEqual([]);
    expect(r.src.state.items.a1!.item).toMatchObject({ box: [400, 300, 380, 200], picture: { title: 'drawn again' } });
    expect(r.log().at(-1)).toEqual(['item.update', 'a1', { box: [400, 300, 380, 200] }]);
  });

  it('a mark added here and changed in another tab is not taken off', async () => {
    const r = rig();
    await r.owner(addNote('m9'));
    await r.other('owner', { type: 'item.update', item: 'm9', patch: { text: 'said better' } });
    await press(r);
    expect(r.said).toEqual(['Undo skipped the note you added: it has changed since.']);
    expect(r.removed('m9')).toBe(false);
  });

  it('a picture taken off here and put back by the agent is left where it is', async () => {
    const r = rig();
    await r.owner(takeOff('a1'));
    await r.other('agent', { type: 'item.restore', item: 'a1' });
    await press(r);
    expect(r.said).toEqual(['Undo skipped the picture you took off: it has changed since.']);
  });

  it('Redo checks too: a note moved elsewhere after Undo is not moved over', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    await r.other('owner', moveTo('m1', [200, 200, 320, 100]));
    await press(r, 'redo');
    expect(r.said).toEqual(['Redo skipped the note you moved: it has changed since.']);
    expect(r.box('m1')).toEqual([200, 200, 320, 100]);
  });

  it('a Redo that skips its whole step takes it off the redo list: the next Redo reaches the step under it', async () => {
    const r = rig();
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    await press(r);
    // The redo list holds the move of m1, and on top of it the move of m2, which has changed since.
    await r.other('owner', moveTo('m2', [200, 200, 320, 100]));
    await press(r, 'redo');
    expect(r.said).toEqual(['Redo skipped the note you moved: it has changed since.']);
    await press(r, 'redo');
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    expect(r.box('m2')).toEqual([200, 200, 320, 100]);
    expect(r.said).toHaveLength(1);
  });

  it('Redo of a mark added here, which someone has put back since Undo, is skipped: nothing is posted, with one line', async () => {
    const r = rig();
    await r.owner(addNote('m9'));
    await press(r);
    await r.other('owner', { type: 'item.restore', item: 'm9' });
    const n = r.log().length;
    await press(r, 'redo');
    expect(r.log()).toHaveLength(n);
    expect(r.said).toEqual(['Redo skipped the note you added: it has changed since.']);
  });

  it('Redo of a picture taken off here, which the agent has drawn again since Undo, is skipped: it stays on the board', async () => {
    const r = rig();
    await r.owner(takeOff('a1'));
    await press(r);
    await r.other('agent', { type: 'item.update', item: 'a1', patch: { picture: { kind: 'text', title: 'drawn again' } } });
    const n = r.log().length;
    await press(r, 'redo');
    expect(r.removed('a1')).toBe(false);
    expect(r.log()).toHaveLength(n);
    expect(r.said).toEqual(['Redo skipped the picture you took off: it has changed since.']);
  });

  it('a skipped step lets the steps before it be tried: each is checked by itself', async () => {
    const r = rig();
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.other('owner', moveTo('m1', [200, 200, 320, 100]));
    await press(r);
    await press(r);
    expect(r.said).toHaveLength(1);
    expect(r.box('m2')).toEqual([600, 0, 320, 100]);
  });

  it('the names of the steps: drawn, added, a remark, taken off, changed, and ink of several marks', async () => {
    const r = rig();
    const spoil = (id: Id) => r.other('owner', moveTo(id, [9, 9, 9, 9]));
    await r.owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [10, 10, 100, 80] } });
    await spoil('b1');
    await press(r);
    await r.owner({ type: 'item.add', chapter: CH, item: { id: 'v1', kind: 'voice', box: [0, 700, 320, 64], text: 'said aloud' } });
    await spoil('v1');
    await press(r);
    await r.owner({ type: 'item.update', item: 'm1', patch: { text: 'other words' } });
    await r.other('owner', { type: 'item.update', item: 'm1', patch: { text: 'and others' } });
    await press(r);
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    await spoil('m8');
    await spoil('m9');
    await press(r);
    const ink = (id: Id): Draft => ({ type: 'item.add', chapter: CH, item: { id, kind: 'ink', box: [0, 600, 40, 40], strokes: [{ pts: [0, 0, 40, 40] }], targets: [], hint: 'none' } });
    r.undo.steps.together(['m10', 'm11']);
    await r.owner(ink('m10'));
    await r.owner(ink('m11'));
    await spoil('m10');
    await spoil('m11');
    await press(r);
    r.undo.steps.together(['m1', 'm2']);
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await r.owner(moveTo('m2', [700, 0, 320, 100]));
    await spoil('m1');
    await spoil('m2');
    await press(r);
    r.undo.steps.together(['m10', 'm11']);
    await r.owner(takeOff('m10'));
    await r.owner(takeOff('m11'));
    await r.other('owner', { type: 'item.restore', item: 'm10' });
    await r.other('owner', { type: 'item.restore', item: 'm11' });
    await press(r);
    expect(r.said).toEqual([
      'Undo skipped the box you drew: it has changed since.',
      'Undo skipped the remark you added: it has changed since.',
      'Undo skipped the note you changed: it has changed since.',
      'Undo skipped the 2 marks you added: it has changed since.',
      'Undo skipped the 2 marks you drew: it has changed since.',
      'Undo skipped the 2 things you moved: it has changed since.',
      'Undo skipped the 2 things you took off: it has changed since.',
    ]);
  });
});

describe('a refusal while a step is taken back', () => {
  it('the board is away: the step stays, the board says so, and Undo works once it is back', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.hold();
    r.undo.undo();
    await r.away();
    r.release();
    expect(r.said).toEqual(['Not undone: The board is away.']);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });

  it('the board is away for a Redo: the step can still be redone', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    await press(r);
    r.hold();
    r.undo.redo();
    await r.away();
    r.release();
    expect(r.said).toEqual(['Not redone: The board is away.']);
    // It is not counted as done: Undo has nothing to take back.
    await press(r);
    expect(r.said[1]).toBe('There is nothing to undo.');
    await press(r, 'redo');
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
  });

  it('the board refuses for good (the thing left the board while Undo was on its way): the step is dropped, with one line', async () => {
    const r = rig();
    await r.owner(moveTo('a1', [500, 400, 380, 200]));
    r.hold();
    r.undo.undo();
    await turn();
    await r.other('agent', takeOff('a1'));
    await r.land();
    r.release();
    expect(r.said).toEqual(['Undo skipped the picture you moved: That is not on the board any more, so this was not saved.']);
    await press(r);
    expect(r.said[1]).toBe('There is nothing to undo.');
  });

  it('ink of two marks, and the board goes away after the first is taken off: what was taken off can be redone, the rest undone later', async () => {
    const r = rig();
    r.undo.steps.together(['m8', 'm9']);
    await r.owner(addNote('m8'));
    await r.owner(addNote('m9'));
    r.hold();
    r.undo.undo();
    await turn();
    await r.land();
    await r.away();
    r.release();
    expect([r.removed('m8'), r.removed('m9')]).toEqual([false, true]);
    expect(r.said).toEqual(['Not undone: The board is away.']);
    // Undo again finishes the step.
    await press(r);
    expect([r.removed('m8'), r.removed('m9')]).toEqual([true, true]);
    // Redo brings back the two halves, the last one taken back first.
    await press(r, 'redo');
    expect([r.removed('m8'), r.removed('m9')]).toEqual([false, true]);
    await press(r, 'redo');
    expect([r.removed('m8'), r.removed('m9')]).toEqual([false, false]);
  });
});

describe('Undo inside a go of the pen', () => {
  it('takes back the last stroke and no step, for as long as the go has strokes', async () => {
    const r = rig();
    await r.owner(moveTo('m1', [50, 60, 320, 100]));
    r.pen.strokes = 2;
    r.undo.undo();
    r.undo.undo();
    expect(r.pen.strokes).toBe(0);
    expect(r.box('m1')).toEqual([50, 60, 320, 100]);
    await press(r);
    expect(r.box('m1')).toEqual([0, 0, 320, 100]);
  });
});

describe('Delete', () => {
  it('takes what is selected off, and tells the owner how a picture comes back', async () => {
    const r = rig();
    r.select('a1');
    r.undo.removeSelected();
    await turn();
    expect(r.removed('a1')).toBe(true);
    expect(r.selected()).toBeUndefined();
    expect(r.said).toEqual([`Taken off the board. Undo (${keyWords('undo')}) puts it back.`]);
    await press(r);
    expect(r.removed('a1')).toBe(false);
  });
});

/* ------------------------------------------------------------------ Undo on the board itself */

/** The board of the rig, opened in the app. */
function open() {
  const src = localSource({ events: events() });
  const { container } = render(<App source={src} />);
  const n = src.events.length;
  return {
    src,
    container,
    posted: (): BoardEvent[] => src.events.slice(n),
    note: container.querySelector<HTMLElement>('[data-item="m1"]')!,
    card: container.querySelector<HTMLElement>('[data-item="a1"]')!,
  };
}

const settle = () => act(async () => {});
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
const tool = () => document.querySelector('.app')!.getAttribute('data-tool');
const label = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'A few words' });

/** Undo and Redo by the keys of a Mac, and what they post. False when the key was taken from the browser. */
async function key(what: 'undo' | 'redo'): Promise<boolean> {
  const open = Keyboard.press('z', 'KeyZ', { meta: true, shift: what === 'redo' });
  await settle();
  return open;
}

/** Drag an item by its own element: the test page has no layout, so the events are sent to it. */
async function drag(el: HTMLElement, by: readonly [number, number]) {
  const mouse = new Pointer().on(el);
  mouse.down([10, 10]);
  mouse.move([10 + by[0] / 2, 10 + by[1] / 2]);
  mouse.move([10 + by[0], 10 + by[1]]);
  await frame();
  mouse.up();
  await settle();
}

describe('Undo on the board', () => {
  it('move a note, then Undo: it is back where it was and no other mark is touched; Redo moves it again', async () => {
    const { src, posted, note: el } = open();
    const z = Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>('.world')!.style.transform)![1]);
    await drag(el, [100 * z, 50 * z]);
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { box: [100, 50, 320, 100] } }]);
    expect(await key('undo')).toBe(false);
    expect(posted()).toHaveLength(2);
    expect(posted()[1]).toMatchObject({ type: 'item.update', item: 'm1', by: 'owner', patch: { box: [0, 0, 320, 100] } });
    // Before, Undo took off the owner's newest mark here, and left the move as it was.
    expect(src.state.items.m2!.removed).toBe(false);
    expect(src.state.items.m1).toMatchObject({ removed: false, item: { box: [0, 0, 320, 100] } });
    expect(await key('redo')).toBe(false);
    expect(posted()[2]).toMatchObject({ type: 'item.update', item: 'm1', patch: { box: [100, 50, 320, 100] } });
    expect(posted()).toHaveLength(3);
    expect(toast()).toBeNull();
  });

  it('add a mark, take it off, Undo, Undo, Redo, Redo: the log shows the right event each time', async () => {
    const { posted } = open();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([700, 500]);
    mouse.move([760, 540]);
    mouse.move([900, 620]);
    mouse.up();
    fireEvent.input(label()!, { target: { value: 'this part' } });
    Keyboard.press('Enter');
    await settle();
    const added = posted()[0];
    expect(added).toMatchObject({ type: 'item.add', item: { kind: 'box', text: 'this part' } });
    const id = added!.type === 'item.add' ? added!.item.id : '';
    // The new box is selected: Delete takes it off.
    Keyboard.press('Delete');
    await settle();
    await key('undo');
    await key('undo');
    await key('redo');
    await key('redo');
    expect(posted().slice(1).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.remove', id],
      ['item.restore', id],
      ['item.remove', id],
      ['item.restore', id],
      ['item.remove', id],
    ]);
    await key('redo');
    expect(toast()).toBe('There is nothing to redo.');
    expect(posted()).toHaveLength(6);
  });

  it('Undo during a drag does nothing, and the key is taken from the browser', async () => {
    const { posted, note: el } = open();
    await drag(el, [60, 40]);
    const mouse = new Pointer().on(el);
    mouse.down([10, 10]);
    mouse.move([80, 60]);
    await frame();
    expect(await key('undo')).toBe(false);
    expect(await key('redo')).toBe(false);
    expect(posted()).toHaveLength(1);
    expect(toast()).toBeNull();
    // The drag goes on, and its lift is one more move.
    expect(el.style.translate).not.toBe('');
    mouse.up();
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.update', 'item.update']);
    // With the press over, Undo takes back the last move.
    await key('undo');
    expect(posted()).toHaveLength(3);
  });

  it('a step the agent has changed since is skipped, and the board says so in one line', async () => {
    const { src, posted, card } = open();
    await drag(card, [80, 40]);
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'a1' }]);
    await act(async () => {
      await src.postAs('agent', takeOff('a1'));
    });
    const n = posted().length;
    await key('undo');
    expect(toast()).toBe('Undo skipped the picture you moved: it has changed since.');
    expect(posted()).toHaveLength(n);
  });

  it('Undo inside a go of the pen takes back one stroke, and posts nothing', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    Keyboard.press('p');
    const stroke = (y: number) => {
      const mouse = new Pointer();
      mouse.down([900, y]);
      mouse.move([1000, y + 4]);
      mouse.move([1100, y + 8]);
      mouse.up();
    };
    stroke(500);
    stroke(560);
    stroke(620);
    expect(Keyboard.press('z', 'KeyZ', { meta: true })).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEN_PAUSE + 50);
    });
    // Two strokes of the three became the mark.
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'ink' } }]);
    const ink = posted()[0]!;
    expect(ink.type === 'item.add' && ink.item.kind === 'ink' ? ink.item.strokes : []).toHaveLength(2);
    expect(tool()).toBe('pen');
  });

  it('Undo of every stroke of a go leaves nothing to become a mark, and takes back no earlier step', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    Keyboard.press('p');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([1000, 504]);
    mouse.move([1100, 508]);
    mouse.up();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEN_PAUSE + 50);
    });
    expect(posted()).toHaveLength(0);
    expect(toast()).toBeNull();
  });

  it('a go of the pen that has become a mark is one step: Undo takes the mark off', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    Keyboard.press('p');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([1000, 504]);
    mouse.move([1100, 508]);
    mouse.up();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEN_PAUSE + 50);
    });
    Keyboard.press('z', 'KeyZ', { meta: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posted().map((e) => e.type)).toEqual(['item.add', 'item.remove']);
  });

  it('Cmd+Z on a Russian keyboard is Undo; on a Greek one Ctrl with the key in the Z place is Undo, and with Shift too it is Redo', async () => {
    const { posted, note: el } = open();
    await drag(el, [60, 40]);
    await drag(el, [60, 40]);
    // Two moves, to two places.
    const [first, second] = posted().map((e) => (e.type === 'item.update' ? e.patch.box : undefined));
    expect(second).not.toEqual(first);
    expect(Keyboard.press('я', 'KeyZ', { meta: true })).toBe(false);
    await settle();
    expect(posted()[2]).toMatchObject({ type: 'item.update', item: 'm1', patch: { box: first } });
    expect(Keyboard.press('ζ', 'KeyZ', { ctrl: true })).toBe(false);
    await settle();
    expect(posted()[3]).toMatchObject({ type: 'item.update', item: 'm1', patch: { box: [0, 0, 320, 100] } });
    expect(Keyboard.press('Ζ', 'KeyZ', { ctrl: true, shift: true })).toBe(false);
    await settle();
    expect(posted()[4]).toMatchObject({ type: 'item.update', item: 'm1', patch: { box: first } });
    expect(posted()).toHaveLength(5);
  });

  it('after a reload the list is empty: Undo says there is nothing to undo, and takes nothing off', async () => {
    const first = open();
    await drag(first.note, [60, 40]);
    cleanup();
    const src = localSource({ events: first.src.events });
    render(<App source={src} />);
    const n = src.events.length;
    await key('undo');
    expect(toast()).toBe('There is nothing to undo.');
    expect(src.events).toHaveLength(n);
  });

  it('while the owner types in a note, Cmd+Z is the note’s own', async () => {
    const { posted, note: el } = open();
    await drag(el, [60, 40]);
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    expect(Keyboard.press('z', 'KeyZ', { meta: true })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(1);
  });
});
