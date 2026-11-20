import type { Box, Id } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { chapterInView } from '../src/inview';
import { note, openBoard } from './helpers';

/** A board with a big picture-sized note of one chapter, and a small note of another sitting inside its area. */
function board() {
  const b = openBoard();
  b.must('owner', note('big', [0, 0, 2000, 1500]));
  b.must('owner', { type: 'chapter.open', chapter: 'next', title: 'Next' });
  b.must('owner', note('small', [900, 300, 320, 100], {}, 'next'));
  b.must('owner', note('far', [6000, 0, 320, 100], {}, 'next'));
  return b.state;
}
const boxOf = (s: ReturnType<typeof board>) => (id: Id): Box | undefined => s.items[id]?.item.box;
const room: Box = [0, 0, 1000, 600];
/** The camera that puts world point (x, y) at the middle of the room, at zoom z. */
const at = (x: number, y: number, z = 1) => ({ x: 500 - x * z, y: 300 - y * z, z });

describe('the chapter in view', () => {
  it('is the chapter of the item at the middle of the screen, the smallest when items lie on one another', () => {
    const s = board();
    expect(chapterInView(s, boxOf(s), at(1000, 350), room)).toBe('next');
    expect(chapterInView(s, boxOf(s), at(400, 1000), room)).toBe('engine-loop');
  });

  it('with nothing under the middle, the nearest item on screen; with nothing on screen, the chapter in work', () => {
    const s = board();
    expect(chapterInView(s, boxOf(s), at(6000 + 160, -150), room)).toBe('next');
    expect(chapterInView(s, boxOf(s), at(2300, 700), room)).toBe('engine-loop');
    expect(chapterInView(s, boxOf(s), at(40000, 40000), room)).toBe('next');
  });
});
