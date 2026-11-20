import { describe, expect, it } from 'vitest';
import { openQuestions } from '../src';
import { CH, ink, note, openBoard, picture } from './helpers';

const card = (questions: string[] | null, extra: Record<string, unknown> = {}) =>
  picture('a1', { kind: 'text', title: 'My read, and some questions', ...(questions ? { questions } : {}) }, { answers: ['m1'], ...extra });

/** A board with the owner's first note and the agent's card that answers it. `null` is a card with no list of questions at all. */
function asked(questions: string[] | null = ['Cap the door?', 'Stream tokens?'], extra: Record<string, unknown> = {}) {
  const b = openBoard();
  b.must('owner', note('m1', 'make it take many requests'));
  b.must('agent', card(questions, extra));
  return b;
}

const subs = (b: ReturnType<typeof asked>) => openQuestions(b.state).map((q) => `${q.item}/${q.sub}`);

describe('the questions the owner has not answered', () => {
  it('lists each question of a card with its place on the card, its words and its chapter', () => {
    expect(openQuestions(asked().state)).toEqual([
      { item: 'a1', sub: 'q:1', text: 'Cap the door?', chapter: CH },
      { item: 'a1', sub: 'q:2', text: 'Stream tokens?', chapter: CH },
    ]);
  });

  it('a card with no questions asks nothing', () => {
    expect(openQuestions(asked(null).state)).toEqual([]);
    expect(openQuestions(asked([]).state)).toEqual([]);
  });

  it('a note on a question answers that question and no other', () => {
    const b = asked();
    b.must('owner', note('m2', 'yes, at 64', { on: { item: 'a1', sub: 'q:1' } }));
    expect(subs(b)).toEqual(['a1/q:2']);
  });

  it('a mark on the card as a whole answers every question on it', () => {
    const b = asked();
    b.must('owner', note('m2', 'cap at 64, and yes to streaming', { on: { item: 'a1' } }));
    expect(subs(b)).toEqual([]);
  });

  it('ink on a question answers it: a circle is a yes', () => {
    const b = asked();
    b.must('owner', ink('m2', 'circle', 'a1', 'q:2'));
    expect(subs(b)).toEqual(['a1/q:1']);
  });

  it('a mark on another part of the card answers no question', () => {
    const b = asked();
    b.must('owner', ink('m2', 'circle', 'a1', 'part:door'));
    expect(subs(b)).toEqual(['a1/q:1', 'a1/q:2']);
  });

  it('a lasso holds the card and answers nothing', () => {
    const b = asked();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'm2', kind: 'lasso', box: [0, 0, 9, 9], path: [0, 0, 9, 0, 9, 9], targets: [{ item: 'a1' }] } });
    expect(subs(b)).toEqual(['a1/q:1', 'a1/q:2']);
  });

  it('an answer taken off the board no longer answers, and comes back when the mark does', () => {
    const b = asked();
    b.must('owner', note('m2', 'yes', { on: { item: 'a1', sub: 'q:1' } }));
    b.must('owner', { type: 'item.remove', item: 'm2' });
    expect(subs(b)).toEqual(['a1/q:1', 'a1/q:2']);
    b.must('owner', { type: 'item.restore', item: 'm2' });
    expect(subs(b)).toEqual(['a1/q:2']);
  });

  it('a placeholder asks nothing until it is finished, and a card off the board asks nothing', () => {
    const b = asked(['Cap the door?'], { status: 'drawing' });
    expect(subs(b)).toEqual([]);
    b.must('agent', { type: 'item.update', item: 'a1', patch: { status: 'done' } });
    expect(subs(b)).toEqual(['a1/q:1']);
    b.must('agent', { type: 'item.remove', item: 'a1' });
    expect(subs(b)).toEqual([]);
  });

  it('lists the cards oldest first', () => {
    const b = asked(['First?']);
    b.must('agent', picture('a2', { kind: 'text', title: 'One more', questions: ['Second?'] }, { from: ['a1'] }));
    expect(subs(b)).toEqual(['a1/q:1', 'a2/q:1']);
  });
});
