import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { CH, lanes, note, openBoard, text } from './helpers';
import { Keyboard, Pointer, resetInput } from './pointer';

/**
 * Changing the words of a mark on the board: a double click with Select opens a box's label or
 * a note, and a change of words takes the agent's answers to the old words off (docs/adr/0020).
 */

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'elementsFromPoint');
  localStorage.clear();
});

const box = (id: string, at: [number, number, number, number], words: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'box', box: at, text: words } });

/**
 * Two boxes of the owner's and a note. The agent drew lanes for both boxes, a card that grew out
 * of the lanes, a card for the second box alone, and a card for the note.
 */
function open(role?: 'owner' | 'agent') {
  const b = openBoard();
  b.must('owner', box('b1', [0, 0, 200, 100], 'API'));
  b.must('owner', box('b2', [300, 0, 200, 100], 'Engine'));
  b.must('owner', note('n1', [0, 300, 320, 100]));
  b.must('agent', lanes('l1', { answers: ['b1', 'b2'] }));
  b.must('agent', text('c1', { from: ['l1'] }));
  b.must('agent', text('c2', { answers: ['b2'] }));
  b.must('agent', text('c3', { answers: ['n1'] }));
  const src = localSource({ events: b.events, ...(role ? { role } : {}) });
  const view = render(<App source={src} remember={false} />);
  const n = src.events.length;
  return {
    src,
    container: view.container,
    /** What was posted since the board opened, as drafts. */
    posted: () => src.events.slice(n).map(draftOf),
    on: () => Object.values(src.state.items).filter((s) => !s.removed).map((s) => s.item.id),
  };
}

const draftOf = (e: BoardEvent) => {
  const { id: _id, at: _at, by: _by, ...draft } = e;
  return draft;
};

const label = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'A few words' });
const noteField = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Your note' });
const settle = () => act(async () => {});
const take = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** Say what is under every point of the page: a test page has no layout to find it by. */
function under(el: Element | null) {
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => (el ? [el] : []) });
}

function type(el: HTMLTextAreaElement, words: string) {
  fireEvent.input(el, { target: { value: words } });
  el.setSelectionRange(words.length, words.length);
}

const item = (container: HTMLElement, id: string) => container.querySelector(`[data-item="${id}"]`);

/** Where a world point is on the page, by the camera now. A test page lays the board at the page's corner. */
function pageAt(wx: number, wy: number): [number, number] {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>('.world')!.style.transform)!;
  return [wx * Number(m[3]) + Number(m[1]), wy * Number(m[3]) + Number(m[2])];
}

/** Double-click a thing on the board, ten units in from its corner, with whatever tool is in hand. */
function doubleClick(container: HTMLElement, id: string) {
  const el = item(container, id) as HTMLElement | null;
  const [x, y] = (el?.dataset.box ?? '0,0').split(',').map(Number) as [number, number];
  under(el);
  new Pointer().doubleClick(pageAt(x + 10, y + 10));
}

const undo = async () => {
  Keyboard.press('z', 'KeyZ', { meta: true });
  await settle();
};

const redo = async () => {
  Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
  await settle();
};

const ALL = ['b1', 'b2', 'n1', 'l1', 'c1', 'c2', 'c3'];

describe('a double click on one of the owner\'s boxes', () => {
  it('opens its label in the box, with its words, and the box is not drawn under it', () => {
    const { container } = open();
    doubleClick(container, 'b1');
    expect(label()?.value).toBe('API');
    expect(document.querySelector<HTMLElement>('.label-editor--box')?.style).toMatchObject({ left: '0px', top: '0px', width: '200px', minHeight: '100px' });
    expect(item(container, 'b1')).toBeNull();
  });

  it('Enter with new words posts the change, then takes off the answers to the old words', async () => {
    const { container, posted, on } = open();
    doubleClick(container, 'b1');
    type(label()!, 'Gateway');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toEqual([
      { type: 'item.update', item: 'b1', patch: { text: 'Gateway' } },
      { type: 'item.remove', item: 'l1' },
      { type: 'item.remove', item: 'c1' },
    ]);
    expect(on()).toEqual(['b1', 'b2', 'n1', 'c2', 'c3']);
    expect(label()).toBeNull();
  });

  it('Enter with words that made the box grow posts its new height with them', async () => {
    const { container, posted } = open();
    doubleClick(container, 'b1');
    type(label()!, 'The gateway that takes every request first');
    Object.defineProperty(document.querySelector('.label-editor--box')!, 'offsetHeight', { configurable: true, get: () => 140 });
    Keyboard.press('Enter');
    await settle();
    expect(posted()[0]).toEqual({ type: 'item.update', item: 'b1', patch: { text: 'The gateway that takes every request first', box: [0, 0, 200, 140] } });
  });

  it('Enter with the label emptied posts the empty label, and takes the answers off too', async () => {
    const { container, posted } = open();
    doubleClick(container, 'b1');
    type(label()!, '   ');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toEqual([
      { type: 'item.update', item: 'b1', patch: { text: '' } },
      { type: 'item.remove', item: 'l1' },
      { type: 'item.remove', item: 'c1' },
    ]);
  });

  it('Enter with the words as they were, or Esc, posts nothing', async () => {
    const { container, posted } = open();
    doubleClick(container, 'b1');
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    doubleClick(container, 'b1');
    type(label()!, 'Gateway');
    Keyboard.press('Escape');
    await settle();
    expect(label()).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('does nothing on a viewer\'s page, with another tool in hand, on an agent\'s picture, or while a field is open', async () => {
    const viewer = open('agent');
    doubleClick(viewer.container, 'b1');
    expect(label()).toBeNull();
    cleanup();

    const { container, posted } = open();
    take('Draw a box');
    doubleClick(container, 'b1');
    expect(label()).toBeNull();
    take('Select');

    doubleClick(container, 'l1');
    expect(label()).toBeNull();
    expect(noteField()).toBeNull();

    doubleClick(container, 'n1');
    const field = noteField()!;
    under(item(container, 'b1'));
    new Pointer().on(field).doubleClick([15, 15]);
    await settle();
    expect(label()).toBeNull();
    expect(noteField()).toBe(field);
    expect(posted()).toEqual([]);
  });
});

describe('a change to the words of a note', () => {
  it('takes off the answers to its old words', async () => {
    const { container, posted, on } = open();
    doubleClick(container, 'n1');
    expect(noteField()?.value).toBe('note n1');
    type(noteField()!, 'note n1, changed');
    // The note's paper keeps its height: a test page has no layout to measure it by.
    Object.defineProperty(document.querySelector('.item--editor')!, 'offsetHeight', { configurable: true, get: () => 100 });
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toEqual([
      { type: 'item.update', item: 'n1', patch: { text: 'note n1, changed' } },
      { type: 'item.remove', item: 'c3' },
    ]);
    expect(on()).toEqual(['b1', 'b2', 'n1', 'l1', 'c1', 'c2']);
  });
});

describe('Undo after a change of words', () => {
  it('brings back the old words and the answers in one press, and Redo does it all again', async () => {
    const { container, src, on } = open();
    const words = () => (src.state.items.b1!.item as { text?: string }).text;
    doubleClick(container, 'b1');
    type(label()!, 'Gateway');
    Keyboard.press('Enter');
    await settle();
    expect(on()).toEqual(['b1', 'b2', 'n1', 'c2', 'c3']);

    await undo();
    expect(words()).toBe('API');
    expect(on()).toEqual(ALL);

    await redo();
    expect(words()).toBe('Gateway');
    expect(on()).toEqual(['b1', 'b2', 'n1', 'c2', 'c3']);
  });
});
