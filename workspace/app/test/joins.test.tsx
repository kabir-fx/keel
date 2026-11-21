import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { CH, note, openBoard } from './helpers';
import { Keyboard, frame, frames, resetInput } from './pointer';
import { reduceMotion } from './reducedMotion';

/** Where two packages meet: rules that no one package's own tests can hold. */

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  resetInput();
  localStorage.clear();
});

describe('a glide and the chapter in view', () => {
  // Time is the test's own: a frame is 16 ms, so a glide of 500 ms lands on its 32nd frame.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An old chapter with most of the board's items, and a new one in work with one note far away. */
  function twoChapters() {
    const b = openBoard();
    for (let i = 0; i < 6; i++) b.must('owner', note(`m${i}`, [i * 360, 0, 320, 400], {}, CH));
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
    b.must('owner', note('n1', [6000, 0, 320, 100], {}, 'c2'));
    return localSource({ events: b.events });
  }

  it('a fit that glides keeps the chapter the owner works in, all the way there', async () => {
    render(<App source={twoChapters()} remember />);
    // The first view is the chapter in work.
    expect(screen.getByTestId('board-name').textContent).toBe('uLLM · One engine, many requests · The next idea');
    reduceMotion(false);
    Keyboard.press('1');
    await frame();
    await frame();
    // On the way: the camera is not where it is going yet, and the chapter is still theirs.
    expect(screen.getByTestId('board-name').textContent).toBe('uLLM · One engine, many requests · The next idea');
    await frames(40);
    // Arrived at the whole board, most of it the old chapter's: a fit is a look round, so the
    // chapter is still theirs.
    expect(screen.getByTestId('board-name').textContent).toBe('uLLM · One engine, many requests · The next idea');
  });

  it('with reduced motion the same fit keeps it too', () => {
    render(<App source={twoChapters()} remember />);
    Keyboard.press('1');
    expect(screen.getByTestId('board-name').textContent).toBe('uLLM · One engine, many requests · The next idea');
  });
});

describe('a step recorded by hand', () => {
  it('is what Undo takes back first, newest first, and a step that cannot be taken back says so', async () => {
    const { createUndo } = await import('../src/undo');
    const { fakeBoard } = await import('./fakeBoard');
    const { createTools } = await import('../src/tools');
    const { board, did } = fakeBoard();
    // Undo posts through the fake board's `send`, which records no step: it only notes what was sent.
    const undo = createUndo(board, createTools().pen, board.send);
    const back: string[] = [];
    undo.record({ what: 'the first note', undo: () => (back.push('first'), true) });
    undo.record({ what: 'the second note', undo: () => (back.push('second'), false) });
    undo.undo();
    await Promise.resolve();
    expect(back).toEqual(['second']);
    expect(did.said).toEqual(['Undo could not bring back the second note.']);
    undo.undo();
    expect(back).toEqual(['second', 'first']);
    // Nothing was posted: these steps are not in the log.
    expect(did.sent).toEqual([]);
  });
});
