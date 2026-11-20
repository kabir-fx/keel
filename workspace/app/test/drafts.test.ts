import { describe, expect, it } from 'vitest';
import { chapterId, chapterInWork, nextMarkId, noteDrafts, titleFromText } from '../src/drafts';
import { localSource } from '../src/source';
import { Board, note, openBoard } from './helpers';

describe('a new note', () => {
  it('opens a chapter first when none is in work, titled with its first six words', async () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'uLLM' });
    const drafts = noteDrafts(b.state, { id: 'm1', text: 'I want one engine that takes many requests at once', box: [10.4, 20.6, 320, 58] });
    expect(drafts).toEqual([
      { type: 'chapter.open', chapter: 'i-want-one-engine-that-takes', title: 'I want one engine that takes' },
      { type: 'item.add', chapter: 'i-want-one-engine-that-takes', item: { id: 'm1', kind: 'note', box: [10, 21, 320, 58], text: 'I want one engine that takes many requests at once' } },
    ]);
    // The drafts are legal: the board admits both.
    const src = localSource({ events: b.events });
    for (const d of drafts) expect((await src.post(d)).ok).toBe(true);
    expect(src.state.chapters['i-want-one-engine-that-takes']?.title).toBe('I want one engine that takes');
  });

  it('joins the chapter in work, and opens a new one once that chapter is built', () => {
    const b = openBoard();
    expect(chapterInWork(b.state)).toBe('engine-loop');
    expect(noteDrafts(b.state, { id: 'm1', text: 'more', box: [0, 0, 320, 58] }).map((d) => d.type)).toEqual(['item.add']);
    const built = { ...b.state, chapters: { 'engine-loop': { ...b.state.chapters['engine-loop']!, state: 'built' as const } } };
    expect(chapterInWork(built)).toBeUndefined();
    expect(noteDrafts(built, { id: 'm1', text: 'next idea', box: [0, 0, 320, 58] })[0]).toEqual({ type: 'chapter.open', chapter: 'next-idea', title: 'next idea' });
  });

  it('carries what it is stuck to, and its anchor', () => {
    const b = openBoard();
    const [d] = noteDrafts(b.state, { id: 'm1', text: 'this one', box: [0, 0, 320, 58], on: { item: 'a1', sub: 'q:1' }, anchor: { item: 'a1', sub: 'q:1', box: [1, 2, 3, 4] } });
    expect(d).toMatchObject({ item: { on: { item: 'a1', sub: 'q:1' }, anchor: { item: 'a1', sub: 'q:1', box: [1, 2, 3, 4] } } });
  });

  it('makes titles and ids the contract accepts', () => {
    expect(titleFromText('  Stream,   the text back.  ')).toBe('Stream, the text back');
    expect(titleFromText('')).toBe('A new idea');
    const b = openBoard();
    expect(chapterId('One engine, many requests!', b.state)).toBe('one-engine-many-requests');
    expect(chapterId('Engine loop', b.state)).toBe('engine-loop-2');
    expect(chapterId('???', b.state)).toBe('idea');
    expect(chapterId('Ünïcode cafés', b.state)).toBe('unicode-cafes');
  });

  it('numbers marks after the highest in use, skipping ids already sent', () => {
    const b = openBoard();
    expect(nextMarkId(b.state)).toBe('m1');
    b.must('owner', note('m7', [0, 0, 1, 1]));
    b.must('owner', note('label-x', [0, 0, 1, 1]));
    expect(nextMarkId(b.state)).toBe('m8');
    expect(nextMarkId(b.state, new Set(['m8']))).toBe('m9');
  });
});
