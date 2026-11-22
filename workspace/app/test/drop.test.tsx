import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { dragDepth } from '../src/board/drop';
import { NOTE_FULL } from '../src/board/notes';
import { NOTE_MAX, TAB_TEXT } from '../src/fieldText';
import type { PostResult } from '../src/source';
import { localSource, MAX_UPLOAD } from '../src/source';
import { Board, note, openBoard } from './helpers';
import { Keyboard, Pointer, resetInput } from './pointer';

/**
 * Dropping things in (`src/board/drop.ts`): the "drop here" overlay that counts its enters and
 * leaves, and the page that refuses every drag the board does not take, so a drop never opens
 * a file in the tab in place of the board.
 */

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
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
    noteEl: container.querySelector<HTMLElement>('[data-item="m1"]')!,
    posted: (): BoardEvent[] => src.events.slice(n),
  };
}

type DragType = 'dragenter' | 'dragover' | 'dragleave' | 'drop';

/** What a drag carries: its types, as a browser lists them while it is over the page, and what it holds once dropped. */
interface Carried {
  types: string[];
  files?: File[];
  text?: string;
}

const FILE: Carried = { types: ['Files'], files: [new File(['a,b\n1,2\n'], 'depth.csv', { type: 'text/csv' })] };
const WORDS: Carried = { types: ['text/plain'], text: 'a dragged thought' };

/** What the page did with a drag event: whether it took it from the browser, and the effect it showed at the pointer. */
interface Answer {
  defaultPrevented: boolean;
  dropEffect: string;
}

/**
 * Send one drag event to an element, built as a browser builds it: a mouse event that carries
 * the dragged data. It answers with what the page did with it.
 */
function drag(type: DragType, el: Element, carried: Carried = FILE, at: readonly [number, number] = [700, 400]): Answer {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at[0], clientY: at[1] });
  const data = { types: carried.types, files: carried.files ?? [], getData: (t: string) => (t === 'text/plain' ? (carried.text ?? '') : ''), dropEffect: 'unset' };
  Object.defineProperty(e, 'dataTransfer', { value: data });
  act(() => {
    el.dispatchEvent(e);
  });
  return { defaultPrevented: e.defaultPrevented, dropEffect: data.dropEffect };
}

/** The world point under a page point, and the zoom, by the camera on the page. */
function worldAt(container: HTMLElement, [px, py]: readonly [number, number]): { x: number; y: number; z: number } {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  const z = Number(m[3]);
  return { x: (px - Number(m[1])) / z, y: (py - Number(m[2])) / z, z };
}

const overlay = () => screen.queryByTestId('drop-hint');
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
const settle = () => act(async () => {});
const tool = () => document.querySelector('.app')!.getAttribute('data-tool');
const adds = (events: BoardEvent[]) => events.filter((e): e is Extract<BoardEvent, { type: 'item.add' }> => e.type === 'item.add').map((e) => e.item);

describe('how deep a drag is inside the board', () => {
  it('counts enters up and leaves down, never below nothing, and a drag over the board is at least one deep', () => {
    expect(dragDepth(0, 'enter')).toBe(1);
    expect(dragDepth(1, 'enter')).toBe(2);
    expect(dragDepth(2, 'leave')).toBe(1);
    expect(dragDepth(1, 'leave')).toBe(0);
    expect(dragDepth(0, 'leave')).toBe(0);
    expect(dragDepth(0, 'over')).toBe(1);
    expect(dragDepth(3, 'over')).toBe(3);
  });
});

describe('the "drop here" overlay', () => {
  it('shows once for an enter into a thing on the board and a leave back out, and goes when the drag leaves the board', () => {
    const { board, noteEl } = open();
    expect(overlay()).toBeNull();
    drag('dragenter', board);
    const shown = overlay();
    expect(shown).not.toBeNull();
    // Onto the note: the browser enters the note, then leaves the ground the pointer was on.
    drag('dragenter', noteEl);
    expect(overlay()).toBe(shown);
    drag('dragleave', board);
    expect(overlay()).toBe(shown);
    // And back out onto the ground.
    drag('dragenter', board);
    drag('dragleave', noteEl);
    expect(overlay()).toBe(shown);
    expect(screen.getAllByTestId('drop-hint')).toHaveLength(1);
    // Off the board: the last leave.
    drag('dragleave', board);
    expect(overlay()).toBeNull();
  });

  it('a drag that is over the board shows it, whatever enter was missed', () => {
    const { board } = open();
    const over = drag('dragover', board);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dropEffect).toBe('copy');
    expect(overlay()).not.toBeNull();
  });

  it('clears on Esc, which then does nothing else; the next Esc puts the tool back', () => {
    const { board } = open();
    Keyboard.press('p');
    drag('dragenter', board);
    drag('dragenter', board);
    expect(overlay()).not.toBeNull();
    Keyboard.press('Escape');
    expect(overlay()).toBeNull();
    expect(tool()).toBe('pen');
    Keyboard.press('Escape');
    expect(tool()).toBe('select');
  });

  it('clears when the window loses focus, and when the drag ends somewhere else', () => {
    const { board } = open();
    drag('dragenter', board);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(overlay()).toBeNull();
    drag('dragenter', board);
    expect(overlay()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(overlay()).toBeNull();
    // After a clear the count starts again: one enter, one leave.
    drag('dragenter', board);
    drag('dragleave', board);
    expect(overlay()).toBeNull();
  });

  it('clears on the drop, and the file lands where it was dropped', async () => {
    const { board, posted } = open();
    drag('dragenter', board);
    drag('dragover', board);
    const dropped = drag('drop', board);
    expect(dropped.defaultPrevented).toBe(true);
    expect(overlay()).toBeNull();
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'file', name: 'depth.csv' }]);
  });

  it('words dropped on the board become a note', async () => {
    const { board, posted } = open();
    drag('dragover', board, WORDS);
    drag('drop', board, WORDS);
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: 'a dragged thought' }]);
  });

  it('dropped words are made plain and cut to what a note holds, as a paste into a note is, and the board says what was left out', async () => {
    const { board, posted } = open();
    drag('drop', board, { types: ['text/plain'], text: 'one\r\ntwo\tthree' });
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'note', text: `one\ntwo${TAB_TEXT}three` }]);
    expect(toast()).toBeNull();
    drag('drop', board, { types: ['text/plain'], text: 'w'.repeat(NOTE_MAX + 1) });
    await settle();
    expect(adds(posted())[1]).toMatchObject({ kind: 'note', text: 'w'.repeat(NOTE_MAX) });
    expect(toast()).toBe(NOTE_FULL);
  });

  it('words dropped where no chapter is in work open one, and the note is one step from the start: an Undo pressed before the chapter is answered waits, and takes the note off', async () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'uLLM' });
    const src = localSource({ events: b.events });
    render(<App source={src} />);
    const n = src.events.length;
    const real = src.post;
    let answer = () => {};
    src.post = (draft) => (draft.type === 'chapter.open' ? new Promise<PostResult>((done) => (answer = () => done(real(draft)))) : real(draft));
    drag('drop', screen.getByTestId('board'), WORDS);
    await settle();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    answer();
    await settle();
    expect(src.events.slice(n).map((e) => e.type)).toEqual(['chapter.open', 'item.add', 'item.remove']);
    expect(toast()).toBeNull();
  });

  it('the files of one drop are one step: Undo takes them off together, and Redo puts them back', async () => {
    const { board, posted } = open();
    const two: Carried = { types: ['Files'], files: [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.txt', { type: 'text/plain' })] };
    drag('drop', board, two);
    await settle();
    const files = adds(posted());
    const ids = files.map((item) => item.id);
    expect(ids).toHaveLength(2);
    // They land one under the other, 76 apart.
    const [upper, lower] = files.map((item) => item.box);
    expect(lower).toEqual([upper![0], upper![1] + 76, upper![2], upper![3]]);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted().slice(2).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([['item.remove', ids[1]], ['item.remove', ids[0]]]);
    Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
    await settle();
    expect(posted().slice(4).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([['item.restore', ids[0]], ['item.restore', ids[1]]]);
  });

  it('a dropped picture lands as itself, centred where it was dropped; with a file that is not a picture, the two sit side by side on a grid round the point, 50 screen pixels apart, the file as its tile', async () => {
    const { container, board, posted } = open();
    // A test page decodes no picture: this is the size Chrome would read.
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(200);
    const png = () => new File(['png'], 'sketch.png', { type: 'image/png' });
    drag('drop', board, { types: ['Files'], files: [png()] }, [700, 400]);
    await settle();
    const { x, y, z } = worldAt(container, [700, 400]);
    expect(adds(posted())).toMatchObject([{ kind: 'file', name: 'sketch.png', box: [Math.round(x - 150), Math.round(y - 100), 300, 200] }]);
    drag('drop', board, { types: ['Files'], files: [png(), new File(['a'], 'notes.txt', { type: 'text/plain' })] }, [700, 400]);
    await settle();
    const gap = 50 / z;
    const left = x - (300 + gap + 340) / 2;
    expect(adds(posted()).slice(1).map((f) => f.box)).toEqual([
      [Math.round(left), Math.round(y - 100), 300, 200],
      [Math.round(left + 300 + gap), Math.round(y - 100), 340, 60],
    ]);
  });

  it('a picture the page cannot decode lands as a tile with its corner where it was dropped', async () => {
    const { container, board, posted } = open();
    drag('drop', board, { types: ['Files'], files: [new File(['not a png'], 'broken.png', { type: 'image/png' })] }, [700, 400]);
    await settle();
    const { x, y } = worldAt(container, [700, 400]);
    expect(adds(posted())).toMatchObject([{ kind: 'file', name: 'broken.png', box: [Math.round(x), Math.round(y), 340, 60] }]);
  });

  it('Undo while a dropped file is still going up takes back the step before at once: it never waits for an upload', async () => {
    const { src, board, noteEl, posted } = open();
    // The owner takes the note off, then drops a file that takes long to go up.
    new Pointer().on(noteEl).click([10, 10]);
    Keyboard.press('Delete');
    await settle();
    const real = src.upload;
    let upload = () => {};
    src.upload = (name, body) => new Promise((done) => (upload = () => done(real(name, body))));
    drag('drop', board);
    await settle();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.remove', 'item.restore']);
    // The file is up: it lands, and is the newest step.
    upload();
    await settle();
    const file = adds(posted())[0];
    expect(file).toMatchObject({ kind: 'file', name: 'depth.csv' });
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted().slice(2).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.add', file],
      ['item.remove', file!.id],
    ]);
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('a file that is not dropped in', () => {
  /** A file that says it is this large: what is in it is not read before its size. */
  const sized = (name: string, size: number) => {
    const file = new File(['x'], name, { type: 'text/plain' });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it(`one of just ${MAX_UPLOAD / 1024 / 1024} MB goes up; one a byte larger is not sent, and the board says why`, async () => {
    const { src, board, posted } = open();
    const sent: string[] = [];
    const real = src.upload;
    src.upload = (name, body) => (sent.push(name), real(name, body));
    drag('drop', board, { types: ['Files'], files: [sized('full.txt', MAX_UPLOAD)] });
    await settle();
    expect(adds(posted())).toMatchObject([{ kind: 'file', name: 'full.txt' }]);
    expect(toast()).toBeNull();
    drag('drop', board, { types: ['Files'], files: [sized('over.txt', MAX_UPLOAD + 1)] });
    await settle();
    expect(sent).toEqual(['full.txt']);
    expect(adds(posted())).toHaveLength(1);
    expect(toast()).toBe(`"over.txt" is larger than ${MAX_UPLOAD / 1024 / 1024} MB, so it was not dropped in.`);
  });

  it('an upload the board refuses: nothing is posted, and the board says why', async () => {
    const { src, board, posted } = open();
    src.upload = async () => ({ ok: false, reason: 'The board is away.' });
    drag('drop', board);
    await settle();
    expect(posted()).toHaveLength(0);
    expect(toast()).toBe('"depth.csv" was not saved: The board is away.');
  });
});

describe('a drop never makes the tab leave the board', () => {
  it('a file dropped on a viewer’s page: the page refuses the drag, takes the drop from the browser, and posts nothing', async () => {
    const { board, posted } = open('agent');
    drag('dragenter', board);
    const over = drag('dragover', board);
    // Refused: the pointer shows "not here", and the browser does not open the file.
    expect(over.defaultPrevented).toBe(true);
    expect(over.dropEffect).toBe('none');
    expect(overlay()).toBeNull();
    expect(drag('drop', board).defaultPrevented).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('a file dropped on a panel of the owner’s page is refused the same way', async () => {
    const { posted } = open();
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' });
    const over = drag('dragover', toolbar);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dropEffect).toBe('none');
    expect(overlay()).toBeNull();
    expect(drag('drop', toolbar).defaultPrevented).toBe(true);
    // A link dropped on the page itself would open in the tab too.
    expect(drag('drop', document.body, { types: ['text/uri-list'] }).defaultPrevented).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('something the board cannot take in is refused, on the board too', () => {
    const { board } = open();
    const over = drag('dragover', board, { types: ['application/x-unknown'] });
    expect(over.defaultPrevented).toBe(true);
    expect(over.dropEffect).toBe('none');
    expect(overlay()).toBeNull();
  });

  it('words dragged over a note being typed are the note’s: the board does not take them, and the browser puts them in', async () => {
    const { posted } = open();
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    const field = screen.getByRole('textbox', { name: 'Your note' });
    expect(drag('dragenter', field, WORDS).defaultPrevented).toBe(false);
    expect(drag('dragover', field, WORDS).defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    expect(drag('drop', field, WORDS).defaultPrevented).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
    // A file over the field is still the board's: a field cannot hold it, and the browser would open it.
    expect(drag('dragover', field).defaultPrevented).toBe(true);
    expect(overlay()).not.toBeNull();
    fireEvent.keyDown(field, { key: 'Escape' });
  });
});
