import { describe, expect, it } from 'vitest';
import { foreignWords, notMadeHere } from '../src/foreign';
import { note, openBoard, text } from './helpers';

describe('what came with the log from outside', () => {
  it('tags the items an event in a run added; an item the owner rewrote here is theirs again', () => {
    const b = openBoard(); // e1 board.open, e2 chapter.open
    b.must('owner', note('n1', [0, 0, 300, 80])); // e3
    b.must('owner', note('n2', [0, 100, 300, 80])); // e4
    b.must('agent', text('a1', { answers: ['n1'] })); // e5
    // The run e3..e5 came from outside. The owner rewrites n2 here: e6.
    b.must('owner', { type: 'item.update', item: 'n2', patch: { text: 'my own words now' } });
    expect(b.state.edited.n2).toBe(6);
    expect(notMadeHere(b.state, [{ from: 3, to: 5 }])).toEqual(['n1', 'a1']);
    // A move is not an edit of the words: a moved item stays tagged.
    b.must('owner', { type: 'item.update', item: 'n1', patch: { box: [400, 0, 300, 80] } });
    expect(notMadeHere(b.state, [{ from: 3, to: 5 }])).toEqual(['n1', 'a1']);
  });

  it('two runs with the owner’s own events between them: only what the runs made', () => {
    const b = openBoard();
    b.must('owner', note('n1', [0, 0, 300, 80])); // e3: outside
    b.must('owner', note('n2', [0, 100, 300, 80])); // e4: here
    b.must('owner', note('n3', [0, 200, 300, 80])); // e5: here
    b.must('owner', note('n4', [0, 300, 300, 80])); // e6: outside
    b.must('agent', text('a1', { answers: ['n2'] })); // e7: outside
    const runs = [
      { from: 1, to: 3 },
      { from: 6, to: 7 },
    ];
    expect(notMadeHere(b.state, runs)).toEqual(['n1', 'n4', 'a1']);
    // An item taken off the board is not on it to tag.
    b.must('owner', { type: 'item.remove', item: 'a1' });
    expect(notMadeHere(b.state, runs)).toEqual(['n1', 'n4']);
  });

  it('with nothing from outside, nothing is tagged', () => {
    const b = openBoard();
    b.must('owner', note('n1', [0, 0, 300, 80]));
    expect(notMadeHere(b.state, undefined)).toEqual([]);
    expect(notMadeHere(b.state, [])).toEqual([]);
  });

  it('the banner says how many, where they came from, and what the agent does', () => {
    expect(foreignWords(3)).toBe('3 items on this board were not made on this machine. They came with the log: a clone, a pull, or a change to the file outside the board. The agent leaves them alone until you keep them.');
    expect(foreignWords(1)).toMatch(/^1 item on this board was not made on this machine\. It came with the log/);
  });
});
