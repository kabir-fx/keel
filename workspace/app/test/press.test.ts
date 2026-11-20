import { describe, expect, it } from 'vitest';
import type { ToolId } from '../src/chrome';
import { CLICK_SLOP, CONTROL_SLOP } from '../src/input/constants';
import type { Landing } from '../src/input/press';
import { CONTROL, follow, holdsBack, startsPress } from '../src/input/press';
import { sampleAt } from './fakeBoard';

/**
 * The rules of a press (`src/input/press.ts`), with no page under them: which buttons start
 * one, when one is held back on a control, and how its samples wait for the tool.
 */

describe('which buttons start a press', () => {
  it('the main button and the middle button do, on any machine', () => {
    for (const mac of [true, false]) {
      expect(startsPress(0, false, mac)).toBe(true);
      expect(startsPress(1, false, mac)).toBe(true);
    }
  });

  it('the right button starts nothing, and neither does any further button', () => {
    for (const mac of [true, false]) {
      for (const button of [2, 3, 4, 5]) expect(startsPress(button, false, mac)).toBe(false);
    }
  });

  it('on a Mac, Ctrl with the main button is a right-click and starts nothing; elsewhere it is a press with Ctrl held', () => {
    expect(startsPress(0, true, true)).toBe(false);
    expect(startsPress(0, true, false)).toBe(true);
    // The middle button pans with Ctrl held too: only the main button turns into a right-click.
    expect(startsPress(1, true, true)).toBe(true);
  });
});

describe('which presses are held back', () => {
  const landing = (over: Partial<Landing> = {}): Landing => ({ tool: 'pen', isOwner: true, button: 0, spaceHeld: false, onControl: true, ...over });

  it('a press on a control, with a drawing tool in the owner’s hand', () => {
    for (const tool of ['pen', 'box', 'arrow', 'lasso'] as const) expect(holdsBack(landing({ tool }))).toBe(true);
  });

  it('not with any other tool: Select leaves a control alone by itself, and with Note and Pin a click is the tool’s', () => {
    const others: ToolId[] = ['select', 'pan', 'note', 'pin'];
    for (const tool of others) expect(holdsBack(landing({ tool }))).toBe(false);
  });

  it('not a press anywhere else, not in another hand, not a pan by Space or the middle button', () => {
    expect(holdsBack(landing({ onControl: false }))).toBe(false);
    expect(holdsBack(landing({ isOwner: false }))).toBe(false);
    expect(holdsBack(landing({ spaceHeld: true }))).toBe(false);
    expect(holdsBack(landing({ button: 1 }))).toBe(false);
  });

  it('a control is a button, a link, a field, or what says it is a button', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button><b>x</b></button><a href="#">x</a><input><textarea></textarea><select></select><span role="button">x</span><p>x</p>';
    const inControl = [...host.querySelectorAll('*')].filter((el) => el.closest(CONTROL)).map((el) => el.tagName.toLowerCase());
    expect(inControl).toEqual(['button', 'b', 'a', 'input', 'textarea', 'select', 'span']);
  });
});

describe('the samples of a press, on their way to the tool', () => {
  const down = sampleAt(100, 100);
  const right = (dx: number) => sampleAt(100 + dx, 100);

  it('a press is a click up to 4 pixels from where it went down, and a drag from 5', () => {
    expect(CLICK_SLOP).toBe(4);
    const press = follow(down, false);
    press.add([right(4)]);
    expect(press.moved()).toBe(false);
    press.add([right(5)]);
    expect(press.moved()).toBe(true);
  });

  it('the distance is measured straight, not along each axis', () => {
    const press = follow(down, false);
    // 3 right and 3 down is 4.2 away.
    press.add([sampleAt(103, 103)]);
    expect(press.moved()).toBe(true);
  });

  it('a press that left and came back is still a drag, also when it did both between two frames', () => {
    const press = follow(down, false);
    press.add([right(2), right(30), right(1)]);
    expect(press.moved()).toBe(true);
    press.add([right(0)]);
    expect(press.moved()).toBe(true);
  });

  it('hands over every sample that came, in order, once', () => {
    const press = follow(down, false);
    expect(press.stage()).toBe('open');
    expect(press.take()).toEqual([]);
    press.add([right(1), right(2)]);
    press.add([right(3)]);
    expect(press.take().map((s) => s.x)).toEqual([101, 102, 103]);
    expect(press.take()).toEqual([]);
    press.add([right(4)]);
    expect(press.take().map((s) => s.x)).toEqual([104]);
  });

  it('a held-back press stays held up to 10 pixels, and hands over nothing', () => {
    expect(CONTROL_SLOP).toBe(10);
    const press = follow(down, true);
    expect(press.stage()).toBe('held');
    expect(press.add([right(5), right(10)])).toBe('held');
    // 6 right and 8 down is 10 away: still on the control.
    expect(press.add([sampleAt(106, 108)])).toBe('held');
    expect(press.take()).toEqual([]);
    // It is past the click slop all the same.
    expect(press.moved()).toBe(true);
  });

  it('at 11 pixels it becomes the tool’s, and hands over every sample since it went down', () => {
    const press = follow(down, true);
    press.add([right(3)]);
    press.add([right(10)]);
    expect(press.add([right(11)])).toBe('open');
    expect(press.take().map((s) => s.x)).toEqual([103, 110, 111]);
    expect(press.moved()).toBe(true);
  });

  it('one sample past 10 pixels is enough, also in the middle of a frame’s samples; then it stays the tool’s', () => {
    const press = follow(down, true);
    expect(press.add([right(4), right(12), right(2)])).toBe('open');
    expect(press.add([right(0)])).toBe('open');
    expect(press.take().map((s) => s.x)).toEqual([104, 112, 102, 100]);
  });

  it('there is no time limit: a held-back press that waits is still held', () => {
    const press = follow(down, true);
    const later = { ...right(3), t: 60_000 };
    expect(press.add([later])).toBe('held');
  });
});
