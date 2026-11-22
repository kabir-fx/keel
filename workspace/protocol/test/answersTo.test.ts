import { describe, expect, it } from 'vitest';
import { answersTo, openThings } from '../src';
import { CH, CHECK, blueprint, ideaBoard, note, openBoard, picture, solidify } from './helpers';

const text = (title: string) => ({ kind: 'text', title, body: 'x' });
const box = (id: string, label: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'box', box: [0, 0, 100, 60], text: label } });

describe('the answers to a mark', () => {
  it('are the pictures that answer it, and those that grew out of them, all the way down', () => {
    const b = ideaBoard();
    b.must('agent', picture('a4', text('From the pick'), { from: ['a2'] }));
    b.must('owner', note('m2', 'and a queue'));
    b.must('agent', picture('a5', text('Elsewhere'), { answers: ['m2'] }));
    expect(answersTo(b.state, 'm1')).toEqual(['a1', 'a2', 'a4']);
  });

  it('are the pictures that grew out of the mark itself', () => {
    const b = openBoard();
    b.must('owner', note('m1', 'one engine'));
    b.must('agent', picture('r1', text('My read'), { from: ['m1'] }));
    expect(answersTo(b.state, 'm1')).toEqual(['r1']);
  });

  it('take a picture that answers several marks, whichever of them changed', () => {
    const b = openBoard();
    b.must('owner', box('m1', 'API'));
    b.must('owner', box('m2', 'Engine'));
    b.must('agent', picture('l1', text('Lanes'), { answers: ['m1', 'm2'] }));
    expect(answersTo(b.state, 'm1')).toEqual(['l1']);
    expect(answersTo(b.state, 'm2')).toEqual(['l1']);
  });

  it('leave the owner\'s pick on the board, and do not go on through it', () => {
    const b = ideaBoard();
    b.must('agent', picture('a4', text('From the pick'), { from: ['a2'] }));
    b.must('owner', solidify(['door', 'scheduler'], ['a2']));
    expect(answersTo(b.state, 'm1')).toEqual(['a1']);
  });

  it('leave the blueprint the owner pressed "Build this" on, and do not go on through it', () => {
    const b = ideaBoard();
    const solid = b.must('owner', solidify(['door', 'scheduler']));
    b.must('agent', picture('a3', blueprint(['door', 'scheduler']), { answers: [solid.id], from: ['a1'] }));
    b.must('agent', picture('a4', text('From the blueprint'), { from: ['a3'] }));
    b.must('owner', { type: 'build.start', chapter: CH, track: ['door', 'scheduler'], blueprint: 'a3', check: CHECK });
    expect(answersTo(b.state, 'm1')).toEqual(['a1', 'a2']);
  });

  it('leave out a picture that is off the board already', () => {
    const b = ideaBoard();
    b.must('owner', { type: 'item.remove', item: 'a1' });
    expect(answersTo(b.state, 'm1')).toEqual([]);
  });

  it('are none for a mark nothing answers', () => {
    const b = ideaBoard();
    b.must('owner', note('m2', 'and a queue'));
    expect(answersTo(b.state, 'm2')).toEqual([]);
    expect(answersTo(b.state, 'nowhere')).toEqual([]);
  });

  it('once taken off with the change of words, leave open the changed mark and every mark only they answered', () => {
    const b = openBoard();
    b.must('owner', box('m1', 'API'));
    b.must('owner', box('m2', 'Engine'));
    b.must('owner', box('m3', 'Queue'));
    b.must('agent', picture('l1', text('Lanes'), { answers: ['m1', 'm2'] }));
    b.must('agent', picture('q1', text('The queue'), { answers: ['m3'] }));
    expect(openThings(b.state)).toEqual([]);
    const off = answersTo(b.state, 'm1');
    b.must('owner', { type: 'item.update', item: 'm1', patch: { text: 'Gateway' } });
    for (const id of off) b.must('owner', { type: 'item.remove', item: id });
    // Oldest first: m2 as it was drawn, then m1 as it was changed.
    expect(openThings(b.state).map((t) => t.id)).toEqual(['m2', 'm1']);

    // Undo puts the pictures back, then the old words: that too is a change of words, so the mark stays open.
    for (const id of off) b.must('owner', { type: 'item.restore', item: id });
    b.must('owner', { type: 'item.update', item: 'm1', patch: { text: 'API' } });
    expect(openThings(b.state).map((t) => t.id)).toEqual(['m1']);
  });
});
