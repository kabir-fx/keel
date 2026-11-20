import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { NOTE_FULL } from '../src/board/notes';
import { NOTE_MAX, TAB_TEXT } from '../src/fieldText';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, resetInput } from './pointer';

/**
 * Paste (`src/board/paste.ts`): what is on the clipboard lands on the board at the pointer, and
 * is left to the browser when the owner types or the pointer is over a panel.
 */

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'elementFromPoint');
  window.dispatchEvent(new Event('pointerdown'));
});

function open(role: 'owner' | 'agent' = 'owner') {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  const src = localSource({ events: b.events, role });
  const { container } = render(<App source={src} />);
  const n = src.events.length;
  return {
    src,
    container,
    board: screen.getByTestId('board'),
    posted: (): BoardEvent[] => src.events.slice(n),
  };
}

/** Say what is under every point of the page: a test page has no layout to find it by. */
function under(el: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => el });
}

/** The world point under a page point, by the camera on the page. */
function worldAt(container: HTMLElement, [x, y]: readonly [number, number]): [number, number] {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return [Math.round((x - Number(m[1])) / Number(m[3])), Math.round((y - Number(m[2])) / Number(m[3]))];
}

/** What a clipboard holds, as a paste event carries it. */
interface Clip {
  text?: string;
  link?: string;
  files?: File[];
}

/** Paste into what has the focus, as Cmd+V does. False when the page took the paste from the browser. */
function paste(clip: Clip, on: EventTarget = document.activeElement ?? document.body): boolean {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  const data = {
    files: clip.files ?? [],
    getData: (type: string) => (type === 'text/plain' ? (clip.text ?? '') : type === 'text/uri-list' ? (clip.link ?? '') : ''),
  };
  Object.defineProperty(e, 'clipboardData', { value: data });
  let open = true;
  act(() => {
    open = on.dispatchEvent(e);
  });
  return open;
}

const settle = () => act(async () => {});
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
const noteField = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Your note' });
const adds = (events: BoardEvent[]) => events.filter((e): e is Extract<BoardEvent, { type: 'item.add' }> => e.type === 'item.add').map((e) => e.item);

describe('paste', () => {
  it('over the board, text becomes a note at the pointer, and the paste is taken from the browser', async () => {
    const { container, board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    expect(paste({ text: '  what about retries?  ' })).toBe(false);
    await settle();
    const [x, y] = worldAt(container, [700, 400]);
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'what about retries?', box: [x, y, 320, 60] }]);
  });

  it('a link is pasted as its address, and a file goes the way a dropped file goes: a file mark at the pointer', async () => {
    const { container, board, posted, src } = open();
    under(board);
    new Pointer().move([640, 360]);
    expect(paste({ link: 'https://example.com/spec', text: 'the spec' })).toBe(false);
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'https://example.com/spec' }]);

    new Pointer().move([500, 300]);
    expect(paste({ files: [new File(['a,b\n1,2\n'], 'depth.csv', { type: 'text/csv' })], text: 'depth.csv' })).toBe(false);
    await settle();
    const [x, y] = worldAt(container, [500, 300]);
    expect(adds(posted())[1]).toMatchObject({ kind: 'file', name: 'depth.csv', asset: 'assets/depth.csv', box: [x, y, 340, 60] });
    expect(src.assets.has('assets/depth.csv')).toBe(true);
  });

  it('the place is where the pointer is now, not where it last was over the board', async () => {
    const { board, posted } = open();
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' });
    // The toolbar lies along the bottom of the page, below 800; the board is everything above.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (_x: number, y: number) => (y > 800 ? toolbar : board) });
    // The pointer was on the board, and has gone onto the toolbar.
    new Pointer().move([700, 400]);
    new Pointer().on(toolbar).move([700, 860]);
    expect(paste({ text: 'not here' })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
    // Back over the board, the same paste lands.
    new Pointer().move([700, 400]);
    expect(paste({ text: 'here' })).toBe(false);
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'here' }]);
  });

  it('with the pointer over a panel, a paste makes no item and is left to the browser', async () => {
    const { posted } = open();
    const presence = screen.getByTestId('presence');
    new Pointer().on(presence).move([1200, 30]);
    under(presence);
    expect(paste({ text: 'into a panel' })).toBe(true);
    expect(paste({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('while the owner types a note, a paste makes no item: the words are the note’s', async () => {
    const { board, posted } = open();
    under(board);
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    const field = noteField()!;
    expect(document.activeElement).toBe(field);
    paste({ text: 'pasted into the note' }, field);
    await settle();
    expect(posted()).toHaveLength(0);
    expect(noteField()).not.toBeNull();
  });

  it('a paste that was aimed at the page while a field has the focus is left alone too', async () => {
    const { board, posted } = open();
    under(board);
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    expect(paste({ text: 'stray' }, document.body)).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('only the owner’s page pastes', async () => {
    const { board, posted } = open('agent');
    under(board);
    new Pointer().move([700, 400]);
    expect(paste({ text: 'from a viewer' })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('in the Story a paste is not for the board', async () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    expect(paste({ text: 'in the story' })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('an empty clipboard is left to the browser', () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    expect(paste({ text: '   ' })).toBe(true);
    expect(posted()).toHaveLength(0);
  });

  it('before the pointer has been on the page, a paste lands in the middle of the board', async () => {
    // The board fills a page of 1200 by 800: its middle is (600, 400).
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'board' ? new DOMRect(0, 0, 1200, 800) : real.call(this);
    });
    const { container, board, posted } = open();
    under(board);
    expect(paste({ text: 'first thing' })).toBe(false);
    await settle();
    const [x, y] = worldAt(container, [600, 400]);
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'first thing', box: [x, y, 320, 60] }]);
  });

  it('a paste is one step: Undo takes the note off again', async () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    paste({ text: 'a thought' });
    await settle();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.add', 'item.remove']);
  });

  it('pasted text is made plain, as in a note’s field: every line end is a plain one, and a tab is spaces', async () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    paste({ text: 'one\r\ntwo\tthree\rfour' });
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: `one\ntwo${TAB_TEXT}three\nfour` }]);
  });

  it(`a paste longer than a note holds is cut to ${NOTE_MAX} letters, and the board says so; one of just ${NOTE_MAX} says nothing`, async () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    paste({ text: 'a'.repeat(NOTE_MAX) });
    await settle();
    expect(adds(posted())[0]).toMatchObject({ kind: 'note', text: 'a'.repeat(NOTE_MAX) });
    expect(toast()).toBeNull();
    paste({ text: 'b'.repeat(NOTE_MAX + 1) });
    await settle();
    expect(adds(posted())[1]).toMatchObject({ kind: 'note', text: 'b'.repeat(NOTE_MAX) });
    expect(toast()).toBe(NOTE_FULL);
  });

  it('a cut that would fall in the middle of an emoji leaves the whole emoji out', async () => {
    const { board, posted } = open();
    under(board);
    new Pointer().move([700, 400]);
    // The emoji takes two units, the last letter's place and the one past the end.
    paste({ text: `${'a'.repeat(NOTE_MAX - 1)}😀` });
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'a'.repeat(NOTE_MAX - 1) }]);
    expect(toast()).toBe(NOTE_FULL);
  });
});
