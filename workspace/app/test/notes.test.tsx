import type { BoardEvent, MarkItem } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { LabelBoard, MarkLabels } from '../src/board/markLabel';
import { LABEL_BACK, MarkLabel, labelFull, pinDropped, useMarkLabel } from '../src/board/markLabel';
import { NOTE_BACK, NOTE_FULL, NOTE_GONE, changeClosed, noteClosed } from '../src/board/notes';
import { LABEL_MAX, NOTE_MAX, PIN_MAX, TAB_TEXT } from '../src/fieldText';
import { HAD_IT } from '../src/board/oneField';
import { DRAFT_PAUSE_MS, LABEL_MAX_WIDTH, LABEL_MIN_WIDTH, NOTE_HEIGHT_SLACK } from '../src/input/constants';
import { keyWords } from '../src/input/keytable';
import type { DraftKind } from '../src/noteDraft';
import { draftKey, draftKeys, oldDraftKey, readLabelDraft, readNoteDraft } from '../src/noteDraft';
import type { PostResult } from '../src/source';
import { localSource } from '../src/source';
import type { Label } from '../src/tools/types';
import { fakeBoard } from './fakeBoard';
import { Board, CH, note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, resetInput } from './pointer';

/**
 * Typing on the board: a note, and the few words on a mark. One test, at least, for each row of
 * the table in `src/field.ts`: every way a field can end, and what is posted and what is kept.
 */

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(document, 'elementsFromPoint');
  localStorage.clear();
});

const NAME = 'uLLM';
const AWAY: PostResult = { ok: false, rule: 'offline', reason: 'The board is away.' };

/** A board with one note of the owner's, `m1`. `remember` is how the owner's own board opens; a fixture opens without. */
function open(opts: { remember?: boolean; events?: readonly BoardEvent[]; role?: 'owner' | 'agent' } = {}) {
  let events = opts.events;
  if (!events) {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    events = b.events;
  }
  const src = localSource({ events, ...(opts.role ? { role: opts.role } : {}) });
  const view = render(<App source={src} remember={opts.remember ?? false} />);
  const n = src.events.length;
  return {
    src,
    container: view.container,
    /** What was posted since the board opened. */
    posted: (): BoardEvent[] => src.events.slice(n),
    board: screen.getByTestId('board'),
  };
}

const field = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Your note' });
const label = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'A few words' });
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
const tool = () => document.querySelector('.app')!.getAttribute('data-tool');
/** The mark that waits for its words, as it is drawn: a box by the field its words are typed in, an arrow in the live layer. */
const drawnMark = () => document.querySelector<HTMLElement>('.label-editor--box .drawn-box') ?? screen.getByTestId('live').querySelector<HTMLElement>('.live-box, .live-line');
/** The frame the open note is drawn in: where it is on the board. */
const place = () => {
  const el = document.querySelector<HTMLElement>('.item--editor');
  return el ? [el.style.left, el.style.top] : null;
};

/** Let what was posted land, and what React does after it. */
const settle = () => act(async () => {});
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

const take = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** Take the Note tool and click the board: a new note opens there. */
function newNote(at: readonly [number, number] = [900, 500]): HTMLTextAreaElement {
  take('Write a note');
  new Pointer().click(at);
  return field()!;
}

/** Draw a box with the Box tool: its label opens. */
function drawBox(): HTMLTextAreaElement {
  take('Draw a box');
  const mouse = new Pointer();
  mouse.down([900, 500]);
  mouse.move([1000, 560]);
  mouse.move([1100, 650]);
  mouse.up();
  return label()!;
}

/** Type into a field, as the owner's keys would: the field's value, then the event that says it changed. */
function type(el: HTMLTextAreaElement, text: string) {
  fireEvent.input(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
}

function paste(el: HTMLTextAreaElement, text: string): boolean {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  let open = true;
  act(() => {
    open = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  return open;
}

const undo = async () => {
  Keyboard.press('z', 'KeyZ', { meta: true });
  await settle();
};

const redo = async () => {
  Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
  await settle();
};

/** Close the line the board said, so the next line can be told from it. */
const hush = () => {
  const t = screen.queryByTestId('toast');
  if (t) fireEvent.click(within(t).getByRole('button', { name: 'Dismiss' }));
};

/** The paper of the open note says it is this tall: the test page has no layout to say it. */
function paperHeight(h: number) {
  Object.defineProperty(document.querySelector('.item--editor')!, 'offsetHeight', { configurable: true, get: () => h });
}

/**
 * The owner looks away: the window loses the focus. The field hears that it lost the focus, the
 * page says it no longer has it, and the field is still the one the page would come back to.
 */
function lookAway(el: HTMLElement) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  act(() => {
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    window.dispatchEvent(new Event('blur'));
  });
}

function comeBack() {
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

/** The tab is hidden, as the browser says it. */
function hideTab() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Say what is under every point of the page: a test page has no layout to find it by. */
function under(el: Element | null) {
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => (el ? [el] : []) });
}

/** Hold back what the page posts, to answer each post by hand: the board is slow, or away. */
function holdPosts(src: ReturnType<typeof localSource>) {
  const real = src.post;
  const held: Array<{ draft: Parameters<typeof real>[0]; answer: (r: PostResult) => void }> = [];
  src.post = (draft) => new Promise<PostResult>((answer) => held.push({ draft, answer }));
  return {
    held,
    /** Posts go through again from now on. */
    release: () => {
      src.post = real;
    },
    /** The board refuses everything it was holding. */
    refuseAll: async () => {
      for (const h of held.splice(0)) h.answer(AWAY);
      await settle();
    },
    /** The board takes everything it was holding. */
    acceptAll: async () => {
      for (const h of held.splice(0)) h.answer(await real(h.draft));
      await settle();
    },
  };
}

const notesOn = (src: ReturnType<typeof localSource>) =>
  Object.values(src.state.items)
    .filter((s) => !s.removed && s.item.kind === 'note')
    .map((s) => (s.item.kind === 'note' ? s.item.text : ''));

const boxesOn = (src: ReturnType<typeof localSource>) =>
  Object.values(src.state.items)
    .filter((s) => !s.removed && s.item.kind === 'box')
    .map((s) => (s.item.kind === 'box' ? (s.item.text ?? '') : ''));

/** The key a draft of this kind is kept under for the board. One page keeps it: never two keys at once. */
function keptKey(kind: DraftKind): string | undefined {
  const keys = draftKeys(kind, NAME);
  expect(keys.length).toBeLessThan(2);
  return keys[0];
}

/** The note kept in the browser for the board, if one is. */
const keptNote = () => {
  const key = keptKey('note');
  return key ? readNoteDraft(key) : undefined;
};

/** The label kept in the browser for the board, if one is. */
const keptLabel = () => {
  const key = keptKey('label');
  return key ? readLabelDraft(key) : undefined;
};

/* ------------------------------------------------------------------ Enter */

describe('Enter', () => {
  it('posts a new note once, with its words, and puts the Note tool down', async () => {
    const { posted } = open();
    const el = newNote();
    expect(document.activeElement).toBe(el);
    type(el, '  Can the engine stream to every client?  ');
    expect(Keyboard.press('Enter')).toBe(false);
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'Can the engine stream to every client?' } }]);
    expect(field()).toBeNull();
    expect(tool()).toBe('select');
  });

  it('with no words only closes the note: nothing is posted, and the Note tool stays in hand', async () => {
    const { posted } = open();
    type(newNote(), '   ');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBeNull();
    expect(tool()).toBe('note');
  });

  it('Shift+Enter starts a new line and posts nothing', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'one');
    expect(Keyboard.press('Enter', 'Enter', { shift: true })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
  });

  it('while an input method composes a letter, Enter is its key: nothing is posted and the note stays open', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'にほんご');
    // Chrome and Firefox say so on the event; Safari only by the key code.
    expect(fireEvent.keyDown(el, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 })).toBe(true);
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
    // Esc and Tab are its keys too, then.
    expect(fireEvent.keyDown(el, { key: 'Escape', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(el, { key: 'Tab', isComposing: true })).toBe(true);
    expect(field()?.value).toBe('にほんご');
    // With the letter composed, Enter is the owner's again.
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'にほんご' } }]);
  });

  it('on a note being changed posts the change; with no words, or nothing changed, the note stays as it was and nothing is posted', async () => {
    const { posted, src, container } = open();
    const m1 = () => container.querySelector('[data-item="m1"]');
    under(m1());
    new Pointer().doubleClick([10, 10]);
    // The note is not drawn under its own editor.
    expect(m1()).toBeNull();
    type(field()!, '   ');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(0);
    expect(notesOn(src)).toEqual(['note m1']);
    expect(field()).toBeNull();

    under(m1());
    new Pointer().doubleClick([10, 10]);
    expect(field()?.value).toBe('note m1');
    Keyboard.press('Enter');
    await settle();
    expect(posted().filter((e) => e.type === 'item.update' && e.patch.text !== undefined)).toHaveLength(0);

    under(m1());
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, changed');
    Keyboard.press('Enter');
    await settle();
    expect(notesOn(src)).toEqual(['note m1, changed']);
  });

  it('posts a new note at the height its paper has on screen', async () => {
    const { posted } = open();
    type(newNote(), 'three lines\nof words\nto fit');
    paperHeight(130);
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', box: [expect.any(Number), expect.any(Number), 320, 130] } }]);
  });

  it('posts a change of height only past a pixel or two: up to the allowance the note keeps its height', async () => {
    expect(NOTE_HEIGHT_SLACK).toBe(2);
    const { posted, container } = open();
    const change = async (h: number) => {
      under(container.querySelector('[data-item="m1"]'));
      new Pointer().doubleClick([10, 10]);
      paperHeight(h);
      Keyboard.press('Enter');
      await settle();
    };
    // m1 is 100 tall.
    await change(100 + NOTE_HEIGHT_SLACK);
    await change(100 - NOTE_HEIGHT_SLACK);
    expect(posted()).toEqual([]);
    await change(100 + NOTE_HEIGHT_SLACK + 1);
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { box: [0, 0, 320, 103] } }]);
    expect(posted()[0]).not.toHaveProperty('patch.text');
  });

  it('posts line ends as plain ones and tabs as spaces, however they got into the field', async () => {
    const { posted } = open();
    type(newNote(), 'one\r\ntwo\rthree\tfour');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ item: { text: `one\ntwo\nthree${TAB_TEXT}four` } }]);
  });
});

describe('a field ends once', () => {
  const key = (el: HTMLElement, name: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

  it('Enter and a blur in the same turn, before the field is gone, post the note once', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'once');
    act(() => {
      key(el, 'Enter');
      el.blur();
    });
    await frame();
    await settle();
    expect(posted()).toHaveLength(1);
  });

  it('a blur right after Esc posts nothing: the note was closed, not sent', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'closed, not sent');
    act(() => {
      key(el, 'Escape');
      el.blur();
    });
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBeNull();
  });

  it('Esc right after Enter does not take the note back: it is on its way', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'sent');
    act(() => {
      key(el, 'Enter');
      key(el, 'Escape');
    });
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'sent' } }]);
    expect(toast()).toBeNull();
  });
});

describe('the Note tool', () => {
  it('opens no note with a drag: only a click places one', async () => {
    const { posted } = open();
    take('Write a note');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([950, 530]);
    mouse.move([1000, 560]);
    mouse.up();
    await frame();
    await settle();
    expect(field()).toBeNull();
    expect(posted()).toHaveLength(0);
    expect(tool()).toBe('note');
  });
});

/* -------------------------------------------------------------------- Esc */

describe('Esc on a note', () => {
  it('on a new note with text posts nothing, and Undo opens it again with the text, in the same place', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'a long thought, nearly lost');
    const where = place();
    expect(Keyboard.press('Escape')).toBe(false);
    await settle();
    expect(field()).toBeNull();
    expect(posted()).toHaveLength(0);
    expect(tool()).toBe('select');
    expect(toast()).toBe(noteClosed());
    expect(noteClosed()).toContain(`Undo (${keyWords('undo')})`);
    await undo();
    expect(posted()).toHaveLength(0);
    expect(field()?.value).toBe('a long thought, nearly lost');
    expect(document.activeElement).toBe(field());
    expect(place()).toEqual(where);
    // It is a note like any other again: Enter posts it.
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'a long thought, nearly lost' } }]);
  });

  it('Undo brings it back on the thing it was on', async () => {
    const { posted, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    type(newNote(), 'about this note');
    Keyboard.press('Escape');
    await undo();
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'about this note', on: { item: 'm1' }, anchor: { item: 'm1' } } }]);
  });

  it('on a new note with no words just closes it: nothing for Undo, and nothing said', async () => {
    const { posted, src } = open();
    type(newNote(), '  ');
    Keyboard.press('Escape');
    await settle();
    expect(field()).toBeNull();
    expect(toast()).toBeNull();
    expect(tool()).toBe('select');
    await undo();
    expect(field()).toBeNull();
    // Whatever Undo did then, it brought no note back and posted none.
    expect(posted().filter((e) => e.type === 'item.add')).toHaveLength(0);
    expect(src.state.items.m1).toBeDefined();
  });

  it('two notes closed with Esc come back newest first', async () => {
    open();
    type(newNote([700, 400]), 'the first');
    Keyboard.press('Escape');
    type(newNote([900, 500]), 'the second');
    Keyboard.press('Escape');
    await undo();
    expect(field()?.value).toBe('the second');
    Keyboard.press('Escape');
    await settle();
    // Closed again as Undo brought it, it stays where Undo left it: the next Undo brings the one before.
    await undo();
    expect(field()?.value).toBe('the first');
  });

  it('on a note being changed closes it with the note as it was, and Undo opens it again with what was typed', async () => {
    const { posted, src, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const el = field()!;
    expect(el.value).toBe('note m1');
    type(el, 'note m1, and more');
    Keyboard.press('Escape');
    await settle();
    expect(field()).toBeNull();
    expect(posted()).toHaveLength(0);
    expect(notesOn(src)).toEqual(['note m1']);
    expect(toast()).toBe(changeClosed());
    await undo();
    expect(field()?.value).toBe('note m1, and more');
    expect(posted()).toHaveLength(0);
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { text: 'note m1, and more' } }]);
  });

  it('with another tool in hand when the note comes back, Esc and Enter leave that tool in hand: only the Note tool is put down', async () => {
    const { posted } = open();
    type(newNote(), 'closed, then back');
    Keyboard.press('Escape');
    take('Draw with the pen');
    await undo();
    expect(field()?.value).toBe('closed, then back');
    Keyboard.press('Escape');
    await settle();
    expect(tool()).toBe('pen');
    // Redo puts the step back on Undo's list, and Undo opens the note once more.
    await redo();
    await undo();
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'closed, then back' } }]);
    expect(tool()).toBe('pen');
  });

  it('a double click in an open note is the note’s own: it opens no other note over it, and the words stay', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [400, 0, 320, 100]));
    const { container } = open({ events: b.events });
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const el = field()!;
    type(el, 'note m1, half changed');
    // The pointer is over the owner's other note, as far as the page can tell.
    under(container.querySelector('[data-item="m2"]'));
    new Pointer().on(el).doubleClick([15, 15]);
    await frame();
    await settle();
    expect(field()).toBe(el);
    expect(el.value).toBe('note m1, half changed');
    expect(place()).toEqual(['0px', '0px']);
  });

  it('on a note opened and not changed leaves nothing for Undo', async () => {
    const { container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    expect(field()?.value).toBe('note m1');
    Keyboard.press('Escape');
    await settle();
    expect(field()).toBeNull();
    expect(toast()).toBeNull();
  });
});

/* ----------------------------------------------------------- a press outside */

describe('a press outside the field', () => {
  it('on the board saves the note one frame later, once, also when no blur comes, and does nothing else', async () => {
    const { posted } = open();
    type(newNote(), 'saved by a press');
    const mouse = new Pointer();
    // The press alone: this test page sends no blur with it.
    mouse.down([400, 300]);
    expect(posted()).toHaveLength(0);
    expect(field()).not.toBeNull();
    // A second press inside the same frame is the same save.
    new Pointer('mouse', 2).down([420, 320]);
    await frame();
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'saved by a press' } }]);
    expect(field()).toBeNull();
    mouse.up();
    await frame();
    await settle();
    // The press opened no second note, moved nothing, and posted nothing more.
    expect(posted()).toHaveLength(1);
    expect(field()).toBeNull();
  });

  it('with the blur that a browser sends, it is still one save', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'saved once');
    const mouse = new Pointer();
    mouse.down([400, 300]);
    act(() => el.blur());
    await frame();
    mouse.up();
    await frame();
    await settle();
    expect(posted()).toHaveLength(1);
  });

  it('on something of the page that stops the press on its way is still heard: the note is saved', async () => {
    const { posted } = open();
    type(newNote(), 'saved all the same');
    // As the file tile's "Open" button does: the press goes no further than the button.
    const stops = document.createElement('button');
    stops.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.append(stops);
    fireEvent.pointerDown(stops);
    await frame();
    await settle();
    stops.remove();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'saved all the same' } }]);
    expect(field()).toBeNull();
  });

  it('on a panel saves the note the same way', async () => {
    const { posted } = open();
    type(newNote(), 'saved by a press on a panel');
    new Pointer().on(screen.getByRole('toolbar', { name: 'Tools' })).down([700, 850]);
    expect(posted()).toHaveLength(0);
    await frame();
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'saved by a press on a panel' } }]);
  });

  it('on the note’s own paper is not outside: the note stays open, and the focus stays in it', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'still typing');
    const paper = el.parentElement!;
    const mouse = new Pointer().on(paper);
    mouse.down([905, 505]);
    // The press on the paper is stopped from moving the focus out of the field.
    expect(fireEvent.mouseDown(paper)).toBe(false);
    mouse.up();
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
    // A press in the words themselves is the browser's, to place the caret.
    expect(fireEvent.mouseDown(el)).toBe(true);
  });

  it('with no words closes the note and posts nothing', async () => {
    const { posted } = open();
    newNote();
    new Pointer().down([400, 300]);
    await frame();
    await settle();
    expect(field()).toBeNull();
    expect(posted()).toHaveLength(0);
  });

  it('saves a label the same way: the mark is posted with its words, once, a frame after the press', async () => {
    const { posted } = open();
    const el = drawBox();
    type(el, 'the slow part');
    // A press on the field's own paper is not outside it.
    const paper = el.closest('.label-editor')!;
    new Pointer().on(paper).click([905, 505]);
    expect(fireEvent.mouseDown(paper)).toBe(false);
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(label()).toBe(el);
    const mouse = new Pointer();
    mouse.down([400, 300]);
    expect(posted()).toHaveLength(0);
    await frame();
    await settle();
    mouse.up();
    await frame();
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'box', text: 'the slow part' } }]);
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
  });
});

/* ------------------------------------------------------------- the focus */

describe('the focus leaves the field', () => {
  it('for something else on the page: the note is saved, as before', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'saved on leaving');
    act(() => el.blur());
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'saved on leaving' } }]);
  });

  it('for something else on the page, from a label: the mark is saved with its words', async () => {
    const { posted } = open();
    const el = drawBox();
    type(el, 'saved on leaving');
    act(() => el.blur());
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'box', text: 'saved on leaving' } }]);
  });

  it('because the window lost it: nothing is posted, and the note is still open with its text', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'half a thought');
    lookAway(el);
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
    expect(el.value).toBe('half a thought');
    // Back again, it is the same note: more words, and Enter posts them all, once.
    comeBack();
    type(el, 'half a thought, finished');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { text: 'half a thought, finished' } }]);
    expect(posted()).toHaveLength(1);
  });

  it('because the tab was hidden: nothing is posted, and the note is still open with its text', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'half a thought');
    lookAway(el);
    hideTab();
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()?.value).toBe('half a thought');
  });

  it('a browser that still says the page has the focus: the field is still the focused one, so nothing is posted', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'half a thought');
    act(() => {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await settle();
    expect(document.activeElement).toBe(el);
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
  });

  it('a browser that drops the focused element as the window goes: the page says it has lost the focus, so nothing is posted', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'half a thought');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => el.blur());
    await settle();
    expect(document.activeElement).not.toBe(el);
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
  });

  it('the same for a label: the mark is not posted, and its field is still open with the words and the mark', async () => {
    const { posted } = open();
    const el = drawBox();
    type(el, 'the slow');
    lookAway(el);
    hideTab();
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(label()).toBe(el);
    expect(el.value).toBe('the slow');
    expect(drawnMark()).not.toBeNull();
    comeBack();
    type(el, 'the slow part');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'box', text: 'the slow part' } }]);
  });

  it('the same for a note being changed', async () => {
    const { posted, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const el = field()!;
    type(el, 'note m1, half changed');
    lookAway(el);
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()?.value).toBe('note m1, half changed');
  });
});

/* -------------------------------------------------------------------- Tab */

describe('Tab', () => {
  it('types spaces and keeps the focus in the note; Shift+Tab keeps it too and types nothing', async () => {
    const { posted } = open();
    const el = newNote();
    type(el, 'one');
    expect(Keyboard.press('Tab')).toBe(false);
    expect(el.value).toBe(`one${TAB_TEXT}`);
    expect(document.activeElement).toBe(el);
    expect(Keyboard.press('Tab', 'Tab', { shift: true })).toBe(false);
    expect(el.value).toBe(`one${TAB_TEXT}`);
    expect(document.activeElement).toBe(el);
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()).toBe(el);
  });

  it('with Ctrl, Cmd or Alt is the browser’s own key', () => {
    open();
    const el = newNote();
    type(el, 'one');
    expect(Keyboard.press('Tab', 'Tab', { ctrl: true })).toBe(true);
    expect(Keyboard.press('Tab', 'Tab', { meta: true })).toBe(true);
    expect(Keyboard.press('Tab', 'Tab', { alt: true })).toBe(true);
    expect(el.value).toBe('one');
  });

  it('never types past what the note holds', () => {
    open();
    const el = newNote();
    type(el, 'x'.repeat(NOTE_MAX - 1));
    Keyboard.press('Tab');
    expect(el.value).toHaveLength(NOTE_MAX);
    Keyboard.press('Tab');
    expect(el.value).toHaveLength(NOTE_MAX);
  });

  it('in a label types spaces and keeps the focus too, so it cannot post the mark', async () => {
    const { posted } = open();
    const el = drawBox();
    type(el, 'one');
    expect(Keyboard.press('Tab')).toBe(false);
    expect(el.value).toBe(`one${TAB_TEXT}`);
    expect(document.activeElement).toBe(el);
    await settle();
    expect(posted()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ paste */

describe('a paste', () => {
  it('with Windows line ends and tabs gives plain lines and spaces', () => {
    open();
    const el = newNote();
    expect(paste(el, 'one\r\ntwo\rthree\tfour')).toBe(false);
    expect(el.value).toBe(`one\ntwo\nthree${TAB_TEXT}four`);
    expect(toast()).toBeNull();
  });

  it('goes in at the caret, over what is selected', () => {
    open();
    const el = newNote();
    type(el, 'one three');
    el.setSelectionRange(4, 4);
    paste(el, 'two ');
    expect(el.value).toBe('one two three');
    el.setSelectionRange(0, 3);
    paste(el, 'ONE');
    expect(el.value).toBe('ONE two three');
  });

  it('cannot be typed past what a note holds: the field itself holds no more', () => {
    open();
    expect(newNote().maxLength).toBe(NOTE_MAX);
  });

  it('is cut to what a note holds, and the board says so', () => {
    open();
    const el = newNote();
    type(el, 'x'.repeat(NOTE_MAX - 5));
    paste(el, 'abcdefgh');
    expect(el.value).toHaveLength(NOTE_MAX);
    expect(el.value.endsWith('xabcde')).toBe(true);
    expect(toast()).toBe(NOTE_FULL);
    expect(NOTE_FULL).toContain('2,000');
  });

  it('counts what is selected as room: a paste over the last letters of a full note fits', () => {
    open();
    const el = newNote();
    type(el, 'x'.repeat(NOTE_MAX));
    el.setSelectionRange(NOTE_MAX - 5, NOTE_MAX);
    paste(el, 'abcde');
    expect(el.value).toHaveLength(NOTE_MAX);
    expect(el.value.endsWith('xabcde')).toBe(true);
    expect(toast()).toBeNull();
  });

  it('that fits exactly is not cut, and nothing is said', () => {
    open();
    const el = newNote();
    type(el, 'x'.repeat(NOTE_MAX - 5));
    paste(el, 'abcde');
    expect(el.value).toHaveLength(NOTE_MAX);
    expect(toast()).toBeNull();
  });

  it('of text is the field’s alone: the board does not hear it, so it cannot also become a note of its own', () => {
    open();
    const el = newNote();
    const heard = vi.fn();
    window.addEventListener('paste', heard);
    try {
      paste(el, 'words');
      expect(el.value).toBe('words');
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('paste', heard);
    }
  });

  it('of something that is not text is left to the browser', () => {
    open();
    const el = newNote();
    type(el, 'one');
    const data = new DataTransfer();
    let open_ = true;
    act(() => {
      open_ = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    expect(open_).toBe(true);
    expect(el.value).toBe('one');
  });

  it('into a label is one line, cut to what the mark holds', () => {
    open();
    const el = drawBox();
    paste(el, 'one\r\ntwo\n\nthree');
    expect(el.value).toBe('one two three');
    paste(el, 'y'.repeat(LABEL_MAX));
    expect(el.value).toHaveLength(LABEL_MAX);
    expect(toast()).toBe(labelFull(LABEL_MAX));
  });
});

/* ------------------------------------------------------------- other keys */

describe('keys typed in a field', () => {
  it('are letters for it, not keys for the board: the tool in hand stays, and nothing is taken off', async () => {
    const { posted, src } = open();
    const el = newNote();
    type(el, 'pvb');
    for (const key of ['p', 's', 'b', 'a', 'l', ' ', 'Delete', 'Backspace', '1', '0']) expect(Keyboard.press(key), key).toBe(true);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(field()).toBe(el);
    expect(posted()).toHaveLength(0);
    expect(src.state.items.m1?.removed).toBe(false);
  });
});

/* ------------------------------------------------------- the board refuses */

describe('the board refuses', () => {
  it('a new note: it comes back with its text, in the same place, and the board says why', async () => {
    const { src, posted } = open();
    const el = newNote();
    type(el, 'refused once');
    const where = place();
    src.post = async () => AWAY;
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()?.value).toBe('refused once');
    expect(field()).not.toBe(el);
    expect(place()).toEqual(where);
    expect(document.activeElement).toBe(field());
    expect(toast()).toContain('The board is away.');
  });

  it('a change to a note: it comes back with what was typed', async () => {
    const { src, posted, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, changed');
    src.post = async () => AWAY;
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(0);
    expect(field()?.value).toBe('note m1, changed');
  });

  it('two notes at once: each comes back with its own words, one after the other', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(newNote([700, 400]), 'the first');
    const first = place();
    Keyboard.press('Enter');
    type(newNote([900, 500]), 'the second');
    const second = place();
    Keyboard.press('Enter');
    await settle();
    expect(board.held).toHaveLength(2);
    await board.refuseAll();
    expect(field()?.value).toBe('the first');
    expect(place()).toEqual(first);
    // The first one done, the second comes back: its own words, in its own place.
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('the second');
    expect(place()).toEqual(second);
    Keyboard.press('Enter');
    await settle();
    expect(posted().map((e) => (e.type === 'item.add' && e.item.kind === 'note' ? e.item.text : e.type))).toEqual(['the first', 'the second']);
    expect(field()).toBeNull();
  });

  it('a note while the owner types in another: the one being typed is left alone, and the refused one comes back after it', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(newNote([700, 400]), 'sent, then refused');
    Keyboard.press('Enter');
    const el = newNote([900, 500]);
    type(el, 'being typed');
    await board.refuseAll();
    expect(field()).toBe(el);
    expect(el.value).toBe('being typed');
    expect(document.activeElement).toBe(el);
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('sent, then refused');
    expect(posted()).toMatchObject([{ item: { text: 'being typed' } }]);
  });

  it('a note while a label is open: it waits for the label, and takes neither its focus nor its words', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(newNote([700, 400]), 'sent, then refused');
    Keyboard.press('Enter');
    const el = drawBox();
    type(el, 'a label');
    await board.refuseAll();
    expect(field()).toBeNull();
    expect(label()).toBe(el);
    expect(document.activeElement).toBe(el);
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ item: { kind: 'box', text: 'a label' } }]);
    expect(label()).toBeNull();
    expect(field()?.value).toBe('sent, then refused');
  });

  it('a new note leaves no ghost behind: none once it has landed, and none under its field once it is refused', async () => {
    const { src } = open();
    const ghost = () => document.querySelectorAll('.item--note.item--ghost');
    const board = holdPosts(src);
    type(newNote(), 'landed');
    Keyboard.press('Enter');
    await settle();
    // On its way, the note is drawn where it will be.
    expect(ghost()).toHaveLength(1);
    await board.acceptAll();
    expect(notesOn(src)).toContain('landed');
    expect(ghost()).toHaveLength(0);
    type(newNote([700, 300]), 'refused');
    Keyboard.press('Enter');
    await settle();
    expect(ghost()).toHaveLength(1);
    await board.refuseAll();
    expect(field()?.value).toBe('refused');
    expect(ghost()).toHaveLength(0);
  });

  it('a new note whose id another page’s mark took meanwhile gives it up: Enter posts the note under a new id', async () => {
    const { src } = open();
    const real = src.post;
    const ids: string[] = [];
    let away = true;
    src.post = async (d) => {
      if (d.type === 'item.add') ids.push(d.item.id);
      return away ? AWAY : real(d);
    };
    type(newNote(), 'refused, then posted');
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('refused, then posted');
    away = false;
    const [first] = ids;
    await act(async () => {
      await src.postAs('owner', { type: 'item.add', chapter: CH, item: { id: first!, kind: 'box', box: [0, 300, 100, 100] } });
    });
    Keyboard.press('Enter');
    await settle();
    expect(field()).toBeNull();
    expect(notesOn(src)).toEqual(['note m1', 'refused, then posted']);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(first);
    expect(src.state.items[first!]?.item.kind).toBe('box');
  });

  it('a mark: it is drawn again, and its field opens again with the words', async () => {
    const { src, posted } = open();
    const el = drawBox();
    type(el, 'kept through a refusal');
    src.post = async () => AWAY;
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(0);
    expect(label()?.value).toBe('kept through a refusal');
    expect(label()).not.toBe(el);
    expect(drawnMark()).not.toBeNull();
    expect(toast()).toContain('The board is away.');
  });

  it('a mark while a note is open: it waits for the note', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(drawBox(), 'a label');
    Keyboard.press('Enter');
    const el = newNote([700, 400]);
    type(el, 'being typed');
    await board.refuseAll();
    expect(label()).toBeNull();
    expect(field()).toBe(el);
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ item: { kind: 'note', text: 'being typed' } }]);
    expect(label()?.value).toBe('a label');
    expect(drawnMark()).not.toBeNull();
  });

  it('two marks, the Box tool still in hand: the second waits for the first, and comes back drawn too', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(drawBox(), 'the first');
    Keyboard.press('Enter');
    type(drawBox(), 'the second');
    await board.refuseAll();
    // The first is back in line; the second is still the open one.
    expect(label()?.value).toBe('the second');
    expect(tool()).toBe('box');
    Keyboard.press('Enter');
    await settle();
    await board.refuseAll();
    expect(label()?.value).toBe('the first');
    expect(drawnMark()).not.toBeNull();
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('the second');
    expect(drawnMark()).not.toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(posted().map((e) => (e.type === 'item.add' && e.item.kind === 'box' ? e.item.text : e.type))).toEqual(['the first', 'the second']);
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
  });

  it('a note while the owner types in some other field of the page: it opens with its words and leaves the focus where it is', async () => {
    const { src } = open();
    const board = holdPosts(src);
    type(newNote(), 'sent, then refused');
    Keyboard.press('Enter');
    const other = document.createElement('textarea');
    document.body.append(other);
    try {
      other.focus();
      await board.refuseAll();
      expect(field()?.value).toBe('sent, then refused');
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });
});

/* -------------------------------------------- taken off while it is typed */

describe('the note being changed is taken off the board', () => {
  it('the field stays as it is and the board says so; Enter posts the words as a new note in its place', async () => {
    const { src, posted, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const el = field()!;
    type(el, 'note m1, and more');
    // From another page of the owner's: the agent may not take the owner's note off.
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    expect(field()).toBe(el);
    expect(el.value).toBe('note m1, and more');
    expect(document.activeElement).toBe(el);
    expect(toast()).toBe(NOTE_GONE);
    Keyboard.press('Enter');
    await settle();
    const after = posted().slice(1);
    expect(after).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'note m1, and more', box: [0, 0, 320, 48] } }]);
    expect(notesOn(src)).toEqual(['note m1, and more']);
    expect(field()).toBeNull();
  });

  it('Esc closes the words with nothing posted, and Undo brings them back as a new note there', async () => {
    const { src, posted, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, and more');
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    Keyboard.press('Escape');
    await settle();
    expect(posted()).toHaveLength(1);
    await undo();
    expect(field()?.value).toBe('note m1, and more');
    expect(place()).toEqual(['0px', '0px']);
    // Brought back, it is still a change to a note that has left: the board says so again.
    expect(toast()).toBe(NOTE_GONE);
    Keyboard.press('Enter');
    await settle();
    expect(notesOn(src)).toEqual(['note m1, and more']);
  });

  it('a note that moved while its change was closed is changed where it is now', async () => {
    const { src, container } = open();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, and more');
    expect(place()).toEqual(['0px', '0px']);
    Keyboard.press('Escape');
    await act(async () => {
      await src.postAs('owner', { type: 'item.update', item: 'm1', patch: { box: [640, 200, 320, 100] } });
    });
    await undo();
    expect(field()?.value).toBe('note m1, and more');
    expect(place()).toEqual(['640px', '200px']);
  });
});

describe('the thing a new note is on is taken off the board', () => {
  it('nothing changes under the hand, and Enter posts the note', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [400, 0, 320, 100]));
    const { src, posted, container } = open({ events: b.events });
    under(container.querySelector('[data-item="m2"]'));
    const el = newNote();
    type(el, 'about that note');
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm2' });
    });
    expect(field()).toBe(el);
    expect(el.value).toBe('about that note');
    Keyboard.press('Enter');
    await settle();
    expect(posted().slice(1)).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'about that note', on: { item: 'm2' } } }]);
  });
});

describe('a thing is taken off the board while a mark is labelled', () => {
  it('nothing changes under the hand, and Enter posts the mark', async () => {
    const { src, posted } = open();
    const el = drawBox();
    type(el, 'round that note');
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    expect(label()).toBe(el);
    expect(el.value).toBe('round that note');
    expect(document.activeElement).toBe(el);
    expect(drawnMark()).not.toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(posted().slice(1)).toMatchObject([{ type: 'item.add', item: { kind: 'box', text: 'round that note' } }]);
  });

  it('a pin on a thing that left is posted as it was placed: the board takes a mark on a thing that has left', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const pin = { id: 'm2', kind: 'pin', box: [40, 50, 0, 0], at: [0, 0], on: { item: 'm1' }, anchor: { item: 'm1', box: [0, 0, 320, 100] } };
    localStorage.setItem(oldDraftKey('label', NAME), JSON.stringify({ label: { kind: 'pin', pin, at: [54, 16] }, text: 'this one' }));
    const { src, posted } = open({ remember: true, events: b.events });
    await settle();
    const el = label()!;
    expect(el.value).toBe('this one');
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    expect(label()).toBe(el);
    Keyboard.press('Enter');
    await settle();
    expect(posted().slice(1)).toMatchObject([{ type: 'item.add', item: { kind: 'pin', text: 'this one', on: { item: 'm1' } } }]);
    expect(label()).toBeNull();
  });
});

/* -------------------------------------------------------- the page goes */

describe('the board leaves the page with a field open', () => {
  it('posts nothing: not the note, not the mark', async () => {
    const { posted } = open();
    type(newNote(), 'never sent by the page closing');
    cleanup();
    await settle();
    expect(posted()).toHaveLength(0);

    const again = open();
    type(drawBox(), 'nor this');
    cleanup();
    await settle();
    expect(again.posted()).toHaveLength(0);
  });

  it('nor does a press made just before the board goes: its frame comes too late to post', async () => {
    const { posted } = open();
    type(drawBox(), 'not sent');
    new Pointer().down([400, 300]);
    cleanup();
    await frame();
    await settle();
    expect(posted()).toHaveLength(0);

    const again = open();
    type(newNote(), 'nor this');
    new Pointer().down([400, 300]);
    cleanup();
    await frame();
    await settle();
    expect(again.posted()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ the draft */

describe('a draft survives a reload', () => {
  const kept = keptNote;

  /** The page is loaded again: the board is torn down, and opened from the same log. */
  function reload(src: ReturnType<typeof localSource>) {
    cleanup();
    return open({ remember: true, events: src.events });
  }

  it('the words are written a pause after a key, not on it, with where the note is', async () => {
    open({ remember: true });
    const el = newNote();
    type(el, 'half a thought');
    expect(kept()).toBeUndefined();
    await wait(DRAFT_PAUSE_MS + 60);
    expect(kept()).toMatchObject({ text: 'half a thought' });
    expect(place()).toEqual(kept()!.at.map((n) => `${n}px`));
  });

  it('and at once when the window loses focus, the tab is hidden, or the page is left', () => {
    open({ remember: true });
    const el = newNote();
    for (const [words, leave] of [
      ['one', () => lookAway(el)],
      ['one, two', () => hideTab()],
      ['one, two, three', () => act(() => void window.dispatchEvent(new Event('pagehide')))],
    ] as const) {
      type(el, words);
      leave();
      expect(kept()?.text).toBe(words);
    }
  });

  it('a reload while typing brings the note back with the text, at the same place, on the same thing; nothing was posted by the page going', async () => {
    const first = open({ remember: true });
    under(first.container.querySelector('[data-item="m1"]'));
    type(newNote(), 'typed before the reload');
    const where = place();
    const second = reload(first.src);
    await settle();
    expect(first.posted()).toHaveLength(0);
    expect(field()?.value).toBe('typed before the reload');
    expect(document.activeElement).toBe(field());
    expect(place()).toEqual(where);
    // The owner did not open this note just now: the board says why it is there.
    expect(toast()).toBe(NOTE_BACK);
    Keyboard.press('Enter');
    await settle();
    expect(second.posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'typed before the reload', on: { item: 'm1' }, anchor: { item: 'm1' } } }]);
  });

  it('after Enter, a reload brings nothing back', async () => {
    const first = open({ remember: true });
    type(newNote(), 'posted');
    lookAway(field()!);
    comeBack();
    expect(kept()).toBeDefined();
    Keyboard.press('Enter');
    await settle();
    expect(first.posted()).toHaveLength(1);
    expect(kept()).toBeUndefined();
    reload(first.src);
    await settle();
    expect(field()).toBeNull();
  });

  it('after Esc, a reload brings nothing back', async () => {
    const first = open({ remember: true });
    type(newNote(), 'closed');
    await wait(DRAFT_PAUSE_MS + 60);
    expect(kept()).toBeDefined();
    Keyboard.press('Escape');
    expect(kept()).toBeUndefined();
    reload(first.src);
    await settle();
    expect(field()).toBeNull();
  });

  it('a note with its words deleted keeps no draft', async () => {
    open({ remember: true });
    const el = newNote();
    type(el, 'words');
    await wait(DRAFT_PAUSE_MS + 60);
    expect(kept()).toBeDefined();
    type(el, '  ');
    expect(kept()).toBeUndefined();
  });

  it('the draft is let go only once the board has the note: on its way it is kept, refused it is kept', async () => {
    const { src } = open({ remember: true });
    const board = holdPosts(src);
    type(newNote(), 'on its way');
    Keyboard.press('Enter');
    await settle();
    expect(field()).toBeNull();
    expect(kept()?.text).toBe('on its way');
    await board.refuseAll();
    expect(field()?.value).toBe('on its way');
    expect(kept()?.text).toBe('on its way');
    Keyboard.press('Enter');
    await settle();
    await board.acceptAll();
    expect(kept()).toBeUndefined();
  });

  it('a change on its way is kept the same way', async () => {
    const { src, container } = open({ remember: true });
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const board = holdPosts(src);
    type(field()!, 'note m1, on its way');
    Keyboard.press('Enter');
    await settle();
    expect(kept()).toMatchObject({ text: 'note m1, on its way', edit: 'm1' });
    await board.acceptAll();
    expect(kept()).toBeUndefined();
  });

  it('a later note’s draft is not let go when an earlier note lands', async () => {
    const { src } = open({ remember: true });
    const board = holdPosts(src);
    type(newNote([700, 400]), 'the earlier');
    Keyboard.press('Enter');
    const el = newNote([900, 500]);
    type(el, 'the later');
    lookAway(el);
    comeBack();
    expect(kept()?.text).toBe('the later');
    await board.acceptAll();
    expect(kept()?.text).toBe('the later');
  });

  it('a fixture keeps no draft, and opens none that is there', async () => {
    const first = open();
    const el = newNote();
    type(el, 'not kept');
    lookAway(el);
    await wait(DRAFT_PAUSE_MS + 60);
    expect(kept()).toBeUndefined();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('keel.draft'))).toEqual([]);
    Keyboard.press('Escape');
    const words = drawBox();
    type(words, 'not kept either');
    lookAway(words);
    await wait(DRAFT_PAUSE_MS + 60);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('keel.draft'))).toEqual([]);
    cleanup();
    localStorage.setItem(oldDraftKey('note', NAME), JSON.stringify({ text: 'left by the owner’s board', at: [10, 10] }));
    localStorage.setItem(oldDraftKey('label', NAME), JSON.stringify({ label: { kind: 'box', box: [400, 0, 200, 100], at: [408, 32] }, text: 'left there too' }));
    open({ events: first.src.events });
    await settle();
    expect(field()).toBeNull();
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
  });

  it('a page that is not the owner’s opens no draft', async () => {
    const b = openBoard();
    localStorage.setItem(oldDraftKey('note', NAME), JSON.stringify({ text: 'the owner’s words', at: [10, 10] }));
    open({ remember: true, events: b.events, role: 'agent' });
    await settle();
    expect(field()).toBeNull();
  });

  it('a note being changed comes back as a change to that note, with what was typed; untouched, it keeps no draft', async () => {
    const first = open({ remember: true });
    under(first.container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    const el = field()!;
    lookAway(el);
    comeBack();
    expect(kept()).toBeUndefined();
    type(el, 'note m1, changed');
    const second = reload(first.src);
    await settle();
    expect(field()?.value).toBe('note m1, changed');
    // The note itself is not drawn under its editor.
    expect(second.container.querySelector('[data-item="m1"]')).toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(second.posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { text: 'note m1, changed' } }]);
    expect(kept()).toBeUndefined();
  });

  it('a change to a note that has left the board since comes back as a new note in its place', async () => {
    const first = open({ remember: true });
    under(first.container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, changed');
    cleanup();
    await first.src.postAs('owner', { type: 'item.remove', item: 'm1' });
    const second = open({ remember: true, events: first.src.events });
    await settle();
    expect(field()?.value).toBe('note m1, changed');
    expect(toast()).toBe(NOTE_GONE);
    Keyboard.press('Enter');
    await settle();
    expect(second.posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'note m1, changed' } }]);
  });

  it('a label comes back with its mark and its words; one with no words keeps nothing', async () => {
    const first = open({ remember: true });
    const el = drawBox();
    lookAway(el);
    comeBack();
    // Not even the mark alone is written.
    expect(keptKey('label')).toBeUndefined();
    type(el, 'the slow part');
    cleanup();
    expect(keptLabel()).toMatchObject({ label: { kind: 'box' }, text: 'the slow part' });
    const second = open({ remember: true, events: first.src.events });
    await settle();
    expect(first.posted()).toHaveLength(0);
    expect(label()?.value).toBe('the slow part');
    expect(drawnMark()).not.toBeNull();
    expect(toast()).toBe(LABEL_BACK);
    Keyboard.press('Enter');
    await settle();
    expect(second.posted()).toMatchObject([{ type: 'item.add', item: { kind: 'box', text: 'the slow part' } }]);
    expect(keptLabel()).toBeUndefined();
  });

  it('a mark on its way keeps its words in the browser until the board has it; refused, it keeps them', async () => {
    const { src } = open({ remember: true });
    const board = holdPosts(src);
    type(drawBox(), 'on its way');
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(keptLabel()?.text).toBe('on its way');
    await board.refuseAll();
    expect(label()?.value).toBe('on its way');
    expect(keptLabel()?.text).toBe('on its way');
    Keyboard.press('Enter');
    await settle();
    await board.acceptAll();
    expect(keptKey('label')).toBeUndefined();
  });

  it('a pin dropped with Esc keeps nothing: after a reload it does not come back', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const pin = { id: 'm2', kind: 'pin', box: [40, 50, 0, 0], at: [0, 0], on: { item: 'm1' } };
    localStorage.setItem(oldDraftKey('label', NAME), JSON.stringify({ label: { kind: 'pin', pin, at: [54, 16] }, text: 'this one' }));
    open({ remember: true, events: b.events });
    await settle();
    expect(label()?.value).toBe('this one');
    Keyboard.press('Escape');
    await settle();
    expect(label()).toBeNull();
    expect(keptKey('label')).toBeUndefined();
    cleanup();
    open({ remember: true, events: b.events });
    await settle();
    expect(label()).toBeNull();
  });

  it('a note and a label both kept come back one at a time: the note first', async () => {
    const b = openBoard();
    localStorage.setItem(oldDraftKey('note', NAME), JSON.stringify({ text: 'the note', at: [10, 10] }));
    localStorage.setItem(oldDraftKey('label', NAME), JSON.stringify({ label: { kind: 'box', box: [400, 0, 200, 100], at: [408, 32] }, text: 'the label' }));
    open({ remember: true, events: b.events });
    await settle();
    expect(field()?.value).toBe('the note');
    expect(label()).toBeNull();
    expect(toast()).toBe(NOTE_BACK);
    Keyboard.press('Enter');
    await settle();
    expect(field()).toBeNull();
    expect(label()?.value).toBe('the label');
    expect(document.activeElement).toBe(label());
    expect(drawnMark()).not.toBeNull();
    expect(toast()).toBe(LABEL_BACK);
  });
});

/* ----------------------------------------------------------- the labels */

describe('Esc on a label', () => {
  it('on a box’s label keeps the box, with no words', async () => {
    const { posted, src } = open();
    const el = drawBox();
    type(el, '   ');
    Keyboard.press('Escape');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'box' } }]);
    expect(boxesOn(src)).toEqual(['']);
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
    expect(toast()).toBeNull();
  });

  it('on a box’s label with words keeps the box with no words, and Undo brings the words back onto one box', async () => {
    const { src } = open();
    type(drawBox(), 'the slow part');
    Keyboard.press('Escape');
    await settle();
    expect(boxesOn(src)).toEqual(['']);
    // The box is the newer step: the first Undo takes it off, and the second brings the words back.
    await undo();
    expect(boxesOn(src)).toEqual([]);
    expect(label()).toBeNull();
    await undo();
    expect(label()?.value).toBe('the slow part');
    expect(drawnMark()).not.toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(boxesOn(src)).toEqual(['the slow part']);
  });

  it('on an arrow’s label keeps the arrow', async () => {
    const { posted } = open();
    take('Draw an arrow');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([1000, 560]);
    mouse.move([1100, 650]);
    mouse.up();
    type(label()!, 'why?');
    Keyboard.press('Escape');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { kind: 'arrow' } }]);
    const [arrow] = posted();
    expect(arrow?.type === 'item.add' && arrow.item.kind === 'arrow' ? arrow.item.text : 'no arrow').toBeUndefined();
  });
});

describe('a label, with the board’s tools alone', () => {
  const pin: Label = { kind: 'pin', pin: { id: 'm9', kind: 'pin', box: [40, 50, 0, 0], at: [0, 0], on: { item: 'm1' } }, at: [54, 16] };
  const box: Label = { kind: 'box', box: [10, 20, 200, 100], at: [18, 52] };

  /** The labels of a board that writes down what is done to it. */
  function labels(over: Partial<LabelBoard> = {}) {
    const fake = fakeBoard();
    const board: LabelBoard = { ...fake.board, pressOpen: () => false, ...over };
    const hold: { labels?: MarkLabels } = {};
    function Labels() {
      const l = useMarkLabel(board);
      hold.labels = l;
      return <MarkLabel labels={l} />;
    }
    const view = render(<Labels />);
    return { ...fake, board, container: view.container, open: (l: Label) => act(() => hold.labels!.open(l)) };
  }

  it('Esc on a pin’s label drops the pin: nothing is posted', async () => {
    const { did, open: openLabel } = labels();
    openLabel(pin);
    Keyboard.press('Escape');
    await settle();
    expect(label()).toBeNull();
    expect(did.marks).toEqual([]);
    expect(did.sent).toEqual([]);
    expect(did.steps).toEqual([]);
    expect(did.said).toEqual([]);
  });

  it('Esc on a pin’s label with words drops the pin, and Undo brings it back with the words', async () => {
    const { did, open: openLabel } = labels();
    openLabel(pin);
    type(label()!, 'this one');
    Keyboard.press('Escape');
    await settle();
    expect(label()).toBeNull();
    expect(did.marks).toEqual([]);
    expect(did.said).toEqual([pinDropped()]);
    expect(did.steps.map((s) => s.what)).toEqual(['the pin you dropped']);
    await act(async () => {
      expect(await did.steps[0]!.undo()).toBe(true);
    });
    expect(label()?.value).toBe('this one');
    Keyboard.press('Enter');
    await settle();
    expect(did.marks).toMatchObject([{ kind: 'pin', text: 'this one', on: { item: 'm1' }, box: [40, 50, 0, 0] }]);
  });

  it('the pin that waits for its words is drawn where it was clicked', () => {
    const { container, open: openLabel } = labels();
    openLabel(pin);
    const ghost = container.querySelector<HTMLElement>('.item--pin.item--ghost')!;
    expect([ghost.style.left, ghost.style.top]).toEqual(['40px', '50px']);
  });

  it('Enter posts the mark with its words, cut to what the mark holds', async () => {
    const { did, open: openLabel } = labels();
    openLabel(pin);
    expect(label()!.maxLength).toBe(PIN_MAX);
    type(label()!, '  this one  ');
    Keyboard.press('Enter', 'Enter', { shift: true });
    await settle();
    expect(did.marks).toMatchObject([{ kind: 'pin', text: 'this one' }]);
    openLabel(box);
    expect(label()!.maxLength).toBe(LABEL_MAX);
    type(label()!, 'where it starts');
    Keyboard.press('Enter');
    await settle();
    expect(did.marks[1]).toMatchObject({ kind: 'box', text: 'where it starts', box: [10, 20, 200, 100] });
  });

  it('Esc on a box with words records the words for Undo before the box is posted, so the box is the newer step', async () => {
    const order: string[] = [];
    const { did, open: openLabel } = labels({
      recordStep: (step) => {
        order.push(`step: ${step.what}`);
        return () => {};
      },
      postMark: async (item) => {
        order.push(`post: ${item.kind}${'text' in item && item.text ? ' with words' : ''}`);
        return true;
      },
    });
    openLabel(box);
    type(label()!, 'the slow part');
    Keyboard.press('Escape');
    await settle();
    expect(order).toEqual(['step: the words on your box', 'post: box']);
    expect(did.said).toEqual([]);
  });

  /**
   * A board in memory that takes the marks posted to it, the first as `m2`: the box Esc posted is
   * there, for words to go onto. `answer` says what the page hears back: that it was taken, that
   * the answer was lost after it was, or that the board was away.
   */
  function takingBoard() {
    const log = openBoard();
    log.must('owner', note('m1', [0, 0, 320, 100]));
    const marks: MarkItem[] = [];
    const ctl = { answer: 'taken' as 'taken' | 'lost' | 'away' };
    let ids = 1;
    const over: Partial<LabelBoard> = {
      state: () => log.state,
      newId: () => `m${++ids}`,
      postMark: async (item) => {
        if (ctl.answer === 'away') return false;
        log.must('owner', { type: 'item.add', chapter: CH, item });
        marks.push(item);
        return ctl.answer === 'taken';
      },
    };
    return { log, marks, ctl, over };
  }

  it('the board takes a pin and its answer is lost: the pin is on the board once, and its field does not come back', async () => {
    const taking = takingBoard();
    taking.ctl.answer = 'lost';
    const { did, open: openLabel } = labels(taking.over);
    openLabel(pin);
    type(label()!, 'this one');
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(taking.marks).toMatchObject([{ kind: 'pin', text: 'this one' }]);
    expect(did.said).toEqual([HAD_IT]);
  });

  it('a refused pin keeps its id: posted again, it goes with the same one', async () => {
    const taking = takingBoard();
    taking.ctl.answer = 'away';
    const { open: openLabel } = labels(taking.over);
    openLabel(pin);
    type(label()!, 'this one');
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('this one');
    taking.ctl.answer = 'taken';
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(taking.marks).toMatchObject([{ kind: 'pin', id: 'm2', text: 'this one' }]);
  });

  it('words brought back by Undo while the box Esc posted is still on the board go onto that box: no second box', async () => {
    const steps: Array<{ undo(): boolean | Promise<boolean> }> = [];
    const taking = takingBoard();
    const sent: unknown[] = [];
    const { open: openLabel } = labels({
      ...taking.over,
      recordStep: (step) => {
        steps.push(step);
        return () => {};
      },
      send: async (draft) => {
        sent.push(draft);
        return { ok: true, event: taking.log.events.at(-1) as never };
      },
    });
    openLabel(box);
    type(label()!, 'the slow part');
    Keyboard.press('Escape');
    await settle();
    expect(taking.marks).toHaveLength(1);
    await act(async () => {
      await steps[0]!.undo();
    });
    expect(label()?.value).toBe('the slow part');
    Keyboard.press('Enter');
    await settle();
    expect(taking.marks).toHaveLength(1);
    expect(sent).toEqual([{ type: 'item.update', item: 'm2', patch: { text: 'the slow part' } }]);
  });

  it('words brought back onto a box the board then refuses to change come back again, still for that box', async () => {
    const steps: Array<{ undo(): boolean | Promise<boolean> }> = [];
    const taking = takingBoard();
    const sent: unknown[] = [];
    let ok = false;
    const { open: openLabel } = labels({
      ...taking.over,
      recordStep: (step) => {
        steps.push(step);
        return () => {};
      },
      send: async (draft) => {
        sent.push(draft);
        return ok ? { ok: true, event: taking.log.events.at(-1) as never } : { ok: false, rule: 'offline', reason: 'away' };
      },
    });
    openLabel(box);
    type(label()!, 'the slow part');
    Keyboard.press('Escape');
    await settle();
    await act(async () => {
      await steps[0]!.undo();
    });
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('the slow part');
    ok = true;
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(taking.marks).toHaveLength(1);
    expect(sent).toEqual([
      { type: 'item.update', item: 'm2', patch: { text: 'the slow part' } },
      { type: 'item.update', item: 'm2', patch: { text: 'the slow part' } },
    ]);
  });

  it('a refused box that Esc sent with no words comes back with the words, and Undo then has nothing more to bring', async () => {
    const steps: Array<{ undo(): boolean | Promise<boolean> }> = [];
    const posted: string[] = [];
    let ok = false;
    const { container, hand, open: openLabel } = labels({
      recordStep: (step) => {
        steps.push(step);
        return () => void steps.splice(steps.indexOf(step), 1);
      },
      postMark: async (item) => {
        if (ok) posted.push('text' in item && item.text ? item.text : '');
        return ok;
      },
    });
    openLabel(box);
    type(label()!, 'the slow part');
    Keyboard.press('Escape');
    // The words are a step from the moment of Esc, before the board has answered.
    expect(steps).toHaveLength(1);
    await settle();
    expect(label()?.value).toBe('the slow part');
    // The box is drawn again, by its field.
    expect(container.querySelector('.label-editor--box .drawn-box')).not.toBeNull();
    // Refused: the words are in the field again, so their step is out of Undo's list and costs no press.
    expect(steps).toHaveLength(0);
    // The words are in the field that came back: once it is posted, no second field follows it.
    ok = true;
    Keyboard.press('Enter');
    await settle();
    expect(posted).toEqual(['the slow part']);
    expect(label()).toBeNull();
    expect(hand.get().shape).toBeUndefined();
  });

  it('a refused pin comes back with its words', async () => {
    let ok = false;
    const { did, open: openLabel } = labels({ postMark: async () => ok });
    openLabel(pin);
    type(label()!, 'this one');
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('this one');
    ok = true;
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(did.steps).toEqual([]);
  });

  it('a pin Undo brought back that a tool sends back in line is no longer Undo’s: Esc on it records its step again', async () => {
    const { did, open: openLabel } = labels();
    openLabel(pin);
    type(label()!, 'this one');
    Keyboard.press('Escape');
    await settle();
    await act(async () => {
      await did.steps[0]!.undo();
    });
    expect(label()?.value).toBe('this one');
    openLabel(box);
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('this one');
    Keyboard.press('Escape');
    await settle();
    expect(did.steps.map((s) => s.what)).toEqual(['the pin you dropped', 'the pin you dropped']);
    expect(did.said).toEqual([pinDropped(), pinDropped()]);
  });

  it('Esc on a box whose field holds only spaces leaves nothing for Undo', async () => {
    const { did, open: openLabel } = labels();
    openLabel(box);
    type(label()!, '   ');
    Keyboard.press('Escape');
    await settle();
    expect(did.marks).toMatchObject([{ kind: 'box' }]);
    expect(did.steps).toEqual([]);
  });

  const arrow: Label = { kind: 'arrow', from: [10, 20], to: [200, 120], at: [100, 60] };

  it.each([
    ['a box', box],
    ['an arrow', arrow],
    ['a pin', pin],
  ])('%s whose field came back, and which the board turns out to hold with those words: Enter posts nothing more', async (_kind, l) => {
    const taking = takingBoard();
    const tried: MarkItem[] = [];
    const { did, open: openLabel } = labels({
      ...taking.over,
      postMark: async (item) => {
        tried.push(item);
        return false;
      },
    });
    openLabel(l);
    type(label()!, 'these words');
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('these words');
    // The board took it after all: the page hears of it only now, with the field back.
    taking.log.must('owner', { type: 'item.add', chapter: CH, item: tried[0]! });
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(tried).toHaveLength(1);
    expect(did.sent).toEqual([]);
  });

  it('a box’s words are typed in the box itself, drawn as the posted box is drawn', () => {
    const { container, hand, open: openLabel } = labels();
    openLabel(box);
    const paper = container.querySelector<HTMLElement>('.label-editor--box')!;
    // The field is the box: where it was drawn, as wide, and at least as tall.
    expect([paper.style.left, paper.style.top, paper.style.width, paper.style.minHeight]).toEqual(['10px', '20px', '200px', '100px']);
    // With the posted box's frame and words, so the words land where they were typed.
    expect(paper.querySelector('.drawn-box > textarea.drawn-box__words')).toBe(label());
    expect(container.querySelector('.label-editor__fit')).toBeNull();
    // The field draws the box: nothing is left in the live layer to draw it twice.
    expect(hand.get().shape).toBeUndefined();
  });

  it.each([
    ['grew with its words: it is posted at the height it grew to', 164, [10, 20, 200, 164]],
    ['kept within its box: it is posted as it was dragged', 100, [10, 20, 200, 100]],
  ] as const)('a box whose field %s', async (_name, height, want) => {
    const { did, container, open: openLabel } = labels();
    openLabel(box);
    Object.defineProperty(container.querySelector('.label-editor--box')!, 'offsetHeight', { configurable: true, get: () => height });
    type(label()!, 'the part that waits on the queue');
    Keyboard.press('Enter');
    await settle();
    expect(did.marks).toMatchObject([{ kind: 'box', box: want, text: 'the part that waits on the queue' }]);
  });

  it('an arrow’s field starts at the width it always had and may grow to a set width', () => {
    const { container, open: openLabel } = labels();
    openLabel(arrow);
    const fit = container.querySelector<HTMLElement>('.label-editor__fit')!;
    expect([fit.style.minWidth, fit.style.maxWidth]).toEqual([`${LABEL_MIN_WIDTH}px`, `${LABEL_MAX_WIDTH}px`]);
    expect(LABEL_MIN_WIDTH).toBe(240);
    // The page fits the field to the words it is given, straight on the element.
    type(label()!, 'a few words');
    expect(fit.dataset.words).toBe('a few words');
  });
});

/* --------------------------------------------------------------- no jump */

describe('the field under the hand', () => {
  /** Give the field a text height, as a browser would measure it. */
  function textHeight(el: HTMLTextAreaElement, px: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => px });
  }

  it('opens fitted to the words it opens with, with the caret after them', () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 60 });
    try {
      const { container } = open();
      under(container.querySelector('[data-item="m1"]'));
      new Pointer().doubleClick([10, 10]);
      const el = field()!;
      expect(el.value).toBe('note m1');
      expect(el.style.height).toBe('63px');
      expect([el.selectionStart, el.selectionEnd]).toEqual([7, 7]);
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    }
  });

  it('once it has ended it listens for no more presses', async () => {
    const listening = new Set<unknown>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, handler: unknown, options?: unknown) => {
      if (type === 'pointerdown') listening.add(handler);
      add(type, handler as EventListener, options as AddEventListenerOptions);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, handler: unknown, options?: unknown) => {
      if (type === 'pointerdown') listening.delete(handler);
      remove(type, handler as EventListener, options as EventListenerOptions);
    });
    open();
    const before = listening.size;
    type(newNote(), 'done');
    expect(listening.size).toBeGreaterThan(before);
    Keyboard.press('Enter');
    await settle();
    expect(field()).toBeNull();
    expect(listening.size).toBe(before);
  });

  it('is 5% taller than its text, and takes the room back from the paper round it', () => {
    open();
    const el = newNote();
    textHeight(el, 60);
    type(el, 'two lines\nof words');
    expect(el.style.height).toBe('63px');
    expect(el.style.marginBottom).toBe('-3px');
  });

  it('grows and is set back to the top when the browser scrolls it', () => {
    open();
    const el = newNote();
    textHeight(el, 30);
    type(el, 'one line');
    expect(el.style.height).toBe('32px');
    // The words got taller with no key (a font arrived), and the browser scrolled to the caret.
    textHeight(el, 90);
    el.scrollTop = 28;
    el.scrollLeft = 3;
    fireEvent.scroll(el);
    expect(el.style.height).toBe('95px');
    expect([el.scrollTop, el.scrollLeft]).toEqual([0, 0]);
  });

  it('the board itself never stays scrolled', () => {
    const { board } = open();
    newNote();
    board.scrollTop = 40;
    board.scrollLeft = 12;
    fireEvent.scroll(board);
    expect([board.scrollTop, board.scrollLeft]).toEqual([0, 0]);
  });
});

/* ------------------------------------------------- one note, one id */

/** A draft the page sends, as the board's source is given it. */
type Sent = Parameters<ReturnType<typeof localSource>['post']>[0];

describe('a note or a mark keeps the id of its first post', () => {
  it('the board takes the note and its answer is lost: the note is on the board once, and the field does not come back (R1)', async () => {
    const { src } = open();
    const real = src.post;
    // The board applies the event, then the socket drops before the answer: the page hears "offline".
    src.post = async (d) => {
      await real(d);
      return AWAY;
    };
    type(newNote(), 'only once please');
    Keyboard.press('Enter');
    await settle();
    src.post = real;
    expect(field()).toBeNull();
    expect(toast()).toBe(HAD_IT);
    Keyboard.press('Enter');
    await settle();
    expect(notesOn(src).filter((t) => t === 'only once please')).toHaveLength(1);
  });

  it('the board took the note, and the page hears of it only once the field is back: Enter posts nothing more', async () => {
    const { src } = open();
    const real = src.post;
    const unheard: Sent[] = [];
    src.post = async (d) => {
      unheard.push(d);
      return AWAY;
    };
    type(newNote(), 'only once please');
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('only once please');
    // The socket is back, and the page hears what the board had taken.
    src.post = real;
    for (const d of unheard.splice(0)) await act(async () => void (await real(d)));
    const n = src.events.length;
    Keyboard.press('Enter');
    await settle();
    expect(src.events.length).toBe(n);
    expect(notesOn(src).filter((t) => t === 'only once please')).toHaveLength(1);
    expect(field()).toBeNull();
  });

  it('words added to the note once it is back go onto the note the board took, as a change', async () => {
    const { src } = open();
    const real = src.post;
    const unheard: Sent[] = [];
    src.post = async (d) => {
      unheard.push(d);
      return AWAY;
    };
    type(newNote(), 'only once');
    Keyboard.press('Enter');
    await settle();
    src.post = real;
    for (const d of unheard.splice(0)) await act(async () => void (await real(d)));
    const n = src.events.length;
    type(field()!, 'only once, and more');
    Keyboard.press('Enter');
    await settle();
    expect(src.events.slice(n)).toMatchObject([{ type: 'item.update', patch: { text: 'only once, and more' } }]);
    expect(notesOn(src).filter((t) => t.startsWith('only once'))).toEqual(['only once, and more']);
  });

  it('a refusal that is a real one still brings the field back, and the next Enter posts the note with the same id', async () => {
    const { src, posted } = open();
    const real = src.post;
    const tried: string[] = [];
    src.post = async (d) => {
      if (d.type === 'item.add') tried.push(d.item.id);
      return { ok: false, rule: 'R7', reason: 'There is no chapter "x".' };
    };
    type(newNote(), 'refused for real');
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('refused for real');
    src.post = real;
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.add', item: { id: tried[0], text: 'refused for real' } }]);
  });

  it('a refused note keeps its id held: a mark posted before it comes back takes another', async () => {
    const { src, posted } = open();
    const board = holdPosts(src);
    type(newNote([700, 400]), 'the note');
    Keyboard.press('Enter');
    await settle();
    const first = board.held[0]?.draft;
    const noteId = first?.type === 'item.add' ? first.item.id : 'none';
    type(drawBox(), 'the box');
    await board.refuseAll();
    board.release();
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('the note');
    Keyboard.press('Enter');
    await settle();
    const ids = posted().map((e) => (e.type === 'item.add' ? `${e.item.kind} ${e.item.id}` : e.type));
    expect(ids).toHaveLength(2);
    expect(ids).toContain(`note ${noteId}`);
    expect(ids.filter((s) => s.endsWith(` ${noteId}`))).toHaveLength(1);
  });

  it('the board takes a box and its answer is lost: the box is on the board once, with its words', async () => {
    const { src } = open();
    const real = src.post;
    src.post = async (d) => {
      await real(d);
      return AWAY;
    };
    type(drawBox(), 'the slow part');
    Keyboard.press('Enter');
    await settle();
    src.post = real;
    expect(label()).toBeNull();
    expect(boxesOn(src)).toEqual(['the slow part']);
    expect(toast()).toBe(HAD_IT);
  });
});

/* ------------------------------------------------- a reload while it is on its way */

describe('a reload while a note or a mark is on its way', () => {
  /** The board takes what is posted, and the page goes before the answer comes. */
  function goneBeforeTheAnswer(src: ReturnType<typeof localSource>) {
    const real = src.post;
    src.post = (d) => {
      void real(d);
      return new Promise<PostResult>(() => {});
    };
    return () => {
      src.post = real;
    };
  }

  it('the board has the note: the reload does not bring it back (R2)', async () => {
    const first = open({ remember: true });
    const restore = goneBeforeTheAnswer(first.src);
    type(newNote(), 'sent just before reload');
    Keyboard.press('Enter');
    await settle();
    restore();
    expect(notesOn(first.src)).toContain('sent just before reload');
    cleanup();
    open({ remember: true, events: first.src.events });
    await settle();
    expect(field()).toBeNull();
    expect(keptKey('note')).toBeUndefined();
  });

  it('the board has the mark: the reload does not bring its label back', async () => {
    const first = open({ remember: true });
    const restore = goneBeforeTheAnswer(first.src);
    type(drawBox(), 'sent just before reload');
    Keyboard.press('Enter');
    await settle();
    restore();
    expect(boxesOn(first.src)).toEqual(['sent just before reload']);
    cleanup();
    open({ remember: true, events: first.src.events });
    await settle();
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
    expect(keptKey('label')).toBeUndefined();
  });

  it('a box Esc posted with no words: the reload brings neither the box nor the words back', async () => {
    const first = open({ remember: true });
    const restore = goneBeforeTheAnswer(first.src);
    type(drawBox(), 'not these words');
    await wait(DRAFT_PAUSE_MS + 60);
    Keyboard.press('Escape');
    await settle();
    restore();
    expect(boxesOn(first.src)).toEqual(['']);
    cleanup();
    open({ remember: true, events: first.src.events });
    await settle();
    expect(label()).toBeNull();
    expect(keptKey('label')).toBeUndefined();
  });

  it('the board does not have the note: it comes back, and Enter posts it once', async () => {
    const first = open({ remember: true });
    first.src.post = () => new Promise<PostResult>(() => {});
    type(newNote(), 'lost on the way');
    Keyboard.press('Enter');
    await settle();
    cleanup();
    const second = open({ remember: true, events: first.src.events });
    await settle();
    expect(field()?.value).toBe('lost on the way');
    Keyboard.press('Enter');
    await settle();
    expect(second.posted()).toMatchObject([{ type: 'item.add', item: { kind: 'note', text: 'lost on the way' } }]);
  });
});

/* ------------------------------------------------- one draft per tab */

/**
 * The browser's locks, for the pages of one test: a lock is held until its holder lets go, as
 * a page holds one while it lives. Answers the names held.
 */
function fakeLocks(): Set<string> {
  const held = new Set<string>();
  const locks = {
    request: (name: string, _options: LockOptions, granted: LockGrantedCallback<unknown>): Promise<unknown> => {
      if (held.has(name)) return Promise.resolve(granted(null));
      held.add(name);
      return Promise.resolve(granted({ name, mode: 'exclusive' })).finally(() => held.delete(name));
    },
    query: async (): Promise<LockManagerSnapshot> => ({ held: [...held].map((name) => ({ name, mode: 'exclusive' as const })), pending: [] }),
  };
  Object.defineProperty(navigator, 'locks', { configurable: true, get: () => locks });
  return held;
}

describe('two tabs on one board', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  /** Let the pages take their locks and read what is kept. */
  const settleLocks = async () => {
    for (let i = 0; i < 3; i++) await settle();
  };

  it('a second tab does not open the note the first is typing (R3)', async () => {
    fakeLocks();
    const first = open({ remember: true });
    await settleLocks();
    type(newNote(), 'typed in tab one');
    await wait(DRAFT_PAUSE_MS + 60);
    render(<App source={localSource({ events: first.src.events })} remember />);
    await settleLocks();
    expect(screen.queryAllByRole('textbox', { name: 'Your note' })).toHaveLength(1);
    expect(field()?.value).toBe('typed in tab one');
  });

  it('a tab that posts a note does not take away the draft another tab keeps', async () => {
    fakeLocks();
    const first = open({ remember: true });
    await settleLocks();
    first.src.post = () => new Promise<PostResult>(() => {});
    type(newNote(), 'tab one, on its way');
    Keyboard.press('Enter');
    await settle();
    const two = render(<App source={localSource({ events: first.src.events })} remember />);
    await settleLocks();
    expect(field()).toBeNull();
    fireEvent.click(within(two.container).getByRole('button', { name: 'Write a note' }));
    new Pointer().on(within(two.container).getByTestId('board')).click([900, 500]);
    type(field()!, 'tab two');
    Keyboard.press('Enter');
    await settle();
    expect(field()).toBeNull();
    expect(draftKeys('note', NAME).map((k) => readNoteDraft(k)?.text)).toEqual(['tab one, on its way']);
  });

  it('a draft whose tab is gone comes back in the next page, and is kept there from then on', async () => {
    fakeLocks();
    const gone = draftKey('note', NAME, 'closedtab');
    localStorage.setItem(gone, JSON.stringify({ text: 'left by a closed tab', at: [10, 10] }));
    open({ remember: true });
    await settleLocks();
    expect(field()?.value).toBe('left by a closed tab');
    expect(toast()).toBe(NOTE_BACK);
    expect(localStorage.getItem(gone)).toBeNull();
    expect(keptNote()?.text).toBe('left by a closed tab');
  });

  it('a draft kept the old way, one for the board, comes back once and is cleared from where it was', async () => {
    localStorage.setItem(oldDraftKey('note', NAME), JSON.stringify({ text: 'kept before tabs had their own', at: [10, 10] }));
    open({ remember: true });
    await settle();
    expect(field()?.value).toBe('kept before tabs had their own');
    expect(localStorage.getItem(oldDraftKey('note', NAME))).toBeNull();
    expect(keptNote()?.text).toBe('kept before tabs had their own');
  });
});

/* ------------------------------------------------- a field on its way back and a press */

describe('a field on its way back while a press is under way', () => {
  it('a refused label waits for the drag of the next box to end and for its field to close, then opens with its words (R4)', async () => {
    const { src } = open();
    const board = holdPosts(src);
    type(drawBox(), 'first box words');
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    // The owner draws a second box while the first is on its way; the board refuses the first mid-drag.
    take('Draw a box');
    const mouse = new Pointer();
    mouse.down([300, 300]);
    mouse.move([400, 360]);
    await board.refuseAll();
    expect(label()).toBeNull();
    mouse.move([500, 450]);
    mouse.up();
    await settle();
    board.release();
    expect(screen.queryAllByRole('textbox', { name: 'A few words' })).toHaveLength(1);
    type(label()!, 'second box words');
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('first box words');
    expect(drawnMark()).not.toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(boxesOn(src)).toEqual(['second box words', 'first box words']);
  });

  it('a refused note that comes back during a box drag never opens beside the box’s label: it opens after it (R5)', async () => {
    const { src } = open();
    const board = holdPosts(src);
    type(newNote(), 'note words');
    Keyboard.press('Enter');
    await settle();
    take('Draw a box');
    const mouse = new Pointer();
    mouse.down([300, 300]);
    mouse.move([400, 360]);
    await board.refuseAll();
    expect(field()).toBeNull();
    mouse.move([500, 450]);
    mouse.up();
    await settle();
    board.release();
    expect(field()).toBeNull();
    expect(label()).not.toBeNull();
    Keyboard.press('Enter');
    await settle();
    expect(label()).toBeNull();
    expect(field()?.value).toBe('note words');
  });

  it('opens on the frame after the press ends, though nothing else draws the page again', async () => {
    const { src } = open();
    const board = holdPosts(src);
    type(newNote(), 'note words');
    Keyboard.press('Enter');
    await settle();
    take('Pan');
    const mouse = new Pointer();
    mouse.down([300, 300]);
    mouse.move([400, 360]);
    await board.refuseAll();
    expect(field()).toBeNull();
    mouse.up();
    await frame();
    await frame();
    expect(field()?.value).toBe('note words');
  });
});

/* ------------------------------------------------- Undo after a refused Esc */

describe('Undo after Esc on a box the board refused', () => {
  it('the words came back in the field already, so their step costs no press: the next Undo takes back the step before', async () => {
    const { src } = open();
    type(drawBox(), 'kept');
    Keyboard.press('Enter');
    await settle();
    const el = drawBox();
    type(el, 'dropped words');
    const real = src.post;
    src.post = async () => AWAY;
    Keyboard.press('Escape');
    await settle();
    expect(label()?.value).toBe('dropped words');
    src.post = real;
    Keyboard.press('Enter');
    await settle();
    expect(boxesOn(src)).toEqual(['kept', 'dropped words']);
    await undo();
    expect(boxesOn(src)).toEqual(['kept']);
    await undo();
    await settle();
    expect(boxesOn(src)).toEqual([]);
  });
});

/* ------------------------------------------------- a draft on a thing that is gone */

describe('a draft of a new note on a thing this board does not have', () => {
  it('comes back as a note on the ground in the same place, and Enter posts it', async () => {
    localStorage.setItem(
      oldDraftKey('note', NAME),
      JSON.stringify({ text: 'on a card of the old board', at: [40, 60], on: { item: 'm77' }, anchor: { item: 'm77', box: [0, 0, 300, 200] } }),
    );
    const { posted } = open({ remember: true });
    await settle();
    expect(field()?.value).toBe('on a card of the old board');
    Keyboard.press('Enter');
    await settle();
    expect(posted()).toHaveLength(1);
    const [add] = posted();
    expect(add).toMatchObject({ type: 'item.add', item: { kind: 'note', text: 'on a card of the old board', box: [40, 60, 320, expect.any(Number)] } });
    expect(add?.type === 'item.add' && add.item.kind === 'note' ? [add.item.on, add.item.anchor] : 'no note').toEqual([undefined, undefined]);
  });
});

/* ------------------------------------------------- a button in a picture */

describe('a click on a button inside a picture while a note is open', () => {
  it('posts the note once and presses the button once: the owner pressed it on purpose', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('agent', {
      type: 'item.add',
      chapter: CH,
      item: { id: 'c1', kind: 'picture', picture: { kind: 'choice', title: 'Cap the door', options: [{ id: 'a', label: 'Cap it' }, { id: 'b', label: 'Leave it' }], chosen: 'a' }, answers: ['m1'] },
    });
    b.must('owner', { type: 'item.update', item: 'c1', patch: { box: [1000, 600, 440, 200] } });
    const { posted } = open({ events: b.events });
    type(newNote(), 'and the door?');
    new Pointer().on(screen.getByRole('button', { name: 'Use this instead' })).click();
    await frame();
    await settle();
    expect(posted().filter((e) => e.type === 'item.add' && e.item.kind === 'note')).toMatchObject([{ item: { text: 'and the door?' } }]);
    expect(posted().filter((e) => e.type === 'choice.pick')).toEqual([expect.objectContaining({ item: 'c1', option: 'b' })]);
    expect(field()).toBeNull();
  });
});

/* ------------------------------------------------- a field put back in line */

describe('a tool that opens a field while one is open', () => {
  it('puts the open one back in line with its words: it opens again once the new one closes', async () => {
    const fake = fakeBoard();
    const board: LabelBoard = { ...fake.board, pressOpen: () => false };
    const hold: { labels?: MarkLabels } = {};
    function Labels() {
      const l = useMarkLabel(board);
      hold.labels = l;
      return <MarkLabel labels={l} />;
    }
    render(<Labels />);
    act(() => hold.labels!.open({ kind: 'box', box: [10, 20, 200, 100], at: [18, 52] }));
    type(label()!, 'first words');
    act(() => hold.labels!.open({ kind: 'pin', pin: { id: 'm9', kind: 'pin', box: [40, 50, 0, 0], at: [0, 0], on: { item: 'm1' } }, at: [54, 16] }));
    expect(label()?.value).toBe('');
    type(label()!, 'the pin');
    Keyboard.press('Enter');
    await settle();
    expect(label()?.value).toBe('first words');
    Keyboard.press('Enter');
    await settle();
    expect(fake.did.marks).toMatchObject([{ kind: 'pin', text: 'the pin' }, { kind: 'box', text: 'first words' }]);
  });
});

describe('two fields sent back in line by a tool', () => {
  it('the one sent back last is first in line: each opens again in the order the owner left them, newest first', async () => {
    const fake = fakeBoard();
    const board: LabelBoard = { ...fake.board, pressOpen: () => false };
    const hold: { labels?: MarkLabels } = {};
    function Labels() {
      const l = useMarkLabel(board);
      hold.labels = l;
      return <MarkLabel labels={l} />;
    }
    render(<Labels />);
    const openLabel = (l: Label) => act(() => hold.labels!.open(l));
    openLabel({ kind: 'box', box: [10, 20, 200, 100], at: [18, 52] });
    type(label()!, 'the first box');
    openLabel({ kind: 'box', box: [300, 20, 200, 100], at: [308, 52] });
    type(label()!, 'the second box');
    openLabel({ kind: 'box', box: [600, 20, 200, 100], at: [608, 52] });
    type(label()!, 'the third box');
    for (const words of ['the third box', 'the second box', 'the first box']) {
      expect(label()?.value).toBe(words);
      Keyboard.press('Enter');
      await settle();
    }
    expect(fake.did.marks.map((m) => ('text' in m ? m.text : ''))).toEqual(['the third box', 'the second box', 'the first box']);
  });
});

/* ------------------------------------------------- a note that opens its chapter first */

describe('a new note on a board with no chapter in work', () => {
  it('is one step from the moment of Enter: Undo pressed before the chapter is answered waits, and takes the note off', async () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: NAME });
    const { src } = open({ events: b.events });
    const board = holdPosts(src);
    type(newNote(), 'the first idea');
    Keyboard.press('Enter');
    await settle();
    // The chapter is on its way and not answered; the note has not left yet.
    expect(board.held.map((h) => h.draft.type)).toEqual(['chapter.open']);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(toast()).toBeNull();
    await board.acceptAll();
    await board.acceptAll();
    await board.acceptAll();
    board.release();
    await settle();
    // The note went up, and the Undo that was waiting for it took it off again.
    expect(Object.values(src.state.items).map((s) => [s.item.kind, s.removed])).toEqual([['note', true]]);
    expect(notesOn(src)).toEqual([]);
  });
});

/* ------------------------------------------------- Esc on a field Undo opened */

/**
 * Undo opens a field that Esc closed. Esc on it again, with the words as Undo brought them, only
 * puts it away: the step stays on the redo list, so the next Undo goes on to the step before,
 * and Redo gets everything back.
 */
describe('Esc on the field Undo opened', () => {
  const HOME = [0, 0, 320, 100];
  const boxOf = (src: ReturnType<typeof localSource>, id: string) => {
    const s = src.state.items[id];
    return s && 'box' in s.item ? s.item.box : undefined;
  };

  /** Move the owner's note `m1` by its own element: a step for Undo before the field's. */
  async function moveM1(container: HTMLElement) {
    const mouse = new Pointer().on(container.querySelector('[data-item="m1"]')!);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    mouse.move([110, 70]);
    await frame();
    mouse.up();
    await settle();
  }

  /** Every line the board says, read after each step: Undo must never say it failed. */
  function listen() {
    const said: string[] = [];
    return { said, hear: () => void said.push(toast() ?? '') };
  }

  /** A note is moved, then a new note is written and closed with Esc, Undo opens it, and Esc puts it away again. */
  async function closedTwice() {
    const opened = open();
    const { src, container } = opened;
    await moveM1(container);
    const moved = boxOf(src, 'm1');
    expect(moved).not.toEqual(HOME);
    const ear = listen();
    type(newNote(), 'a thought, put away');
    Keyboard.press('Escape');
    await settle();
    ear.hear();
    await undo();
    ear.hear();
    expect(field()?.value).toBe('a thought, put away');
    Keyboard.press('Escape');
    await settle();
    ear.hear();
    expect(field()).toBeNull();
    return { ...opened, moved, ...ear };
  }

  /** What was posted, by the thing it is on: an added thing by its kind. */
  const on = (events: BoardEvent[]) => events.map((e) => (e.type === 'item.add' ? `add ${e.item.kind}` : 'item' in e ? `${e.type} ${e.item}` : e.type));

  it('a new note: the next Undo takes back the move before it; nothing is posted for the note, and Undo never says it failed', async () => {
    const { src, posted, said, hear } = await closedTwice();
    await undo();
    hear();
    expect(field()).toBeNull();
    expect(boxOf(src, 'm1')).toEqual(HOME);
    expect(on(posted())).toEqual(['item.update m1', 'item.update m1']);
    expect(said.join('\n')).not.toContain('could not');
  });

  it('a new note: from there Redo, Redo, Undo moves the note again, says Undo opens the closed note, and Undo opens it with its words', async () => {
    const { src, posted, moved } = await closedTwice();
    await undo();
    expect(boxOf(src, 'm1')).toEqual(HOME);
    await redo();
    expect(boxOf(src, 'm1')).toEqual(moved);
    hush();
    await redo();
    expect(field()).toBeNull();
    expect(toast()).toBe(noteClosed());
    await undo();
    expect(field()?.value).toBe('a thought, put away');
    expect(on(posted())).toEqual(['item.update m1', 'item.update m1', 'item.update m1']);
  });

  it('a change to a note on the board: Esc, Undo, Esc, Undo goes on to the step before, and the note is as it was throughout', async () => {
    const { src, posted, container } = open();
    await moveM1(container);
    const { said, hear } = listen();
    under(container.querySelector('[data-item="m1"]'));
    new Pointer().doubleClick([10, 10]);
    type(field()!, 'note m1, and more');
    Keyboard.press('Escape');
    await settle();
    hear();
    expect(notesOn(src)).toEqual(['note m1']);
    await undo();
    hear();
    expect(field()?.value).toBe('note m1, and more');
    Keyboard.press('Escape');
    await settle();
    hear();
    expect(notesOn(src)).toEqual(['note m1']);
    await undo();
    hear();
    expect(field()).toBeNull();
    expect(boxOf(src, 'm1')).toEqual(HOME);
    expect(notesOn(src)).toEqual(['note m1']);
    expect(on(posted())).toEqual(['item.update m1', 'item.update m1']);
    expect(said.join('\n')).not.toContain('could not');
    // Redo of the move, then of the change closed: it says what Undo does, and Undo opens the change again.
    await redo();
    hush();
    await redo();
    expect(toast()).toBe(changeClosed());
    await undo();
    expect(field()?.value).toBe('note m1, and more');
  });

  it('a box: Esc on its words that Undo brought back posts no second box; Undo then takes back the move, and Redo puts back the one box Esc made', async () => {
    const { src, posted, container } = open();
    await moveM1(container);
    const { said, hear } = listen();
    type(drawBox(), 'the slow part');
    Keyboard.press('Escape');
    await settle();
    expect(boxesOn(src)).toEqual(['']);
    const [add] = posted().filter((e) => e.type === 'item.add');
    const id = add?.type === 'item.add' ? add.item.id : '';
    await undo();
    hear();
    expect(boxesOn(src)).toEqual([]);
    expect(label()).toBeNull();
    await undo();
    hear();
    expect(label()?.value).toBe('the slow part');
    Keyboard.press('Escape');
    await settle();
    hear();
    expect(label()).toBeNull();
    expect(drawnMark()).toBeNull();
    expect(boxesOn(src)).toEqual([]);
    await undo();
    hear();
    expect(boxOf(src, 'm1')).toEqual(HOME);
    expect(label()).toBeNull();
    expect(said.join('\n')).not.toContain('could not');
    // Redo: the move, then the words (nothing changes on the board), then the box.
    await redo();
    await redo();
    expect(boxesOn(src)).toEqual([]);
    expect(label()).toBeNull();
    await redo();
    expect(boxesOn(src)).toEqual(['']);
    expect(src.state.items[id]?.removed).toBe(false);
    // One box was ever added, under one id.
    expect(on(posted()).filter((e) => e.startsWith('add'))).toEqual(['add box']);
    expect(on(posted()).filter((e) => !e.endsWith('m1'))).toEqual(['add box', `item.remove ${id}`, `item.restore ${id}`]);
  });

  it('a pin: Esc on the pin Undo brought back puts it away, and the next Undo takes back the move before it; nothing is posted for the pin', async () => {
    const { src, posted, container } = open();
    await moveM1(container);
    // The test page has no layout: m1 is said to cover the board, so the pin goes on it.
    vi.spyOn(container.querySelector('[data-item="m1"]')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(-5000, -5000, 10000, 10000));
    const { said, hear } = listen();
    take('Pin a place inside an item');
    new Pointer().click([900, 500]);
    type(label()!, 'this one');
    Keyboard.press('Escape');
    await settle();
    hear();
    expect(toast()).toBe(pinDropped());
    await undo();
    hear();
    expect(label()?.value).toBe('this one');
    Keyboard.press('Escape');
    await settle();
    hear();
    expect(label()).toBeNull();
    await undo();
    hear();
    expect(label()).toBeNull();
    expect(boxOf(src, 'm1')).toEqual(HOME);
    expect(on(posted())).toEqual(['item.update m1', 'item.update m1']);
    expect(said.join('\n')).not.toContain('could not');
    // Redo of the move, then of the pin dropped: it says what Undo does, and Undo brings the pin back.
    await redo();
    hush();
    await redo();
    expect(toast()).toBe(pinDropped());
    await undo();
    expect(label()?.value).toBe('this one');
  });

  it('words changed in the field Undo opened, then Esc: a step with the new words, and Undo brings those', async () => {
    const { posted } = open();
    type(newNote(), 'the first words');
    Keyboard.press('Escape');
    await undo();
    expect(field()?.value).toBe('the first words');
    type(field()!, 'the first words, and more');
    hush();
    Keyboard.press('Escape');
    await settle();
    expect(toast()).toBe(noteClosed());
    await undo();
    expect(field()?.value).toBe('the first words, and more');
    expect(posted()).toHaveLength(0);
  });

  it('a note the board refused is not Undo’s: Esc on it, with its words as it came back, still keeps them for Undo', async () => {
    const { src, posted } = open();
    type(newNote(), 'refused once');
    src.post = async () => AWAY;
    Keyboard.press('Enter');
    await settle();
    expect(field()?.value).toBe('refused once');
    hush();
    Keyboard.press('Escape');
    await settle();
    expect(field()).toBeNull();
    expect(toast()).toBe(noteClosed());
    await undo();
    expect(field()?.value).toBe('refused once');
    expect(posted()).toHaveLength(0);
  });

  it('a note that came back after a reload is not Undo’s: Esc on it, with its words as it came back, still keeps them for Undo', async () => {
    const { src } = open({ remember: true });
    type(newNote(), 'typed before the reload');
    await wait(DRAFT_PAUSE_MS + 60);
    cleanup();
    open({ remember: true, events: src.events });
    await settle();
    expect(field()?.value).toBe('typed before the reload');
    hush();
    Keyboard.press('Escape');
    await settle();
    expect(field()).toBeNull();
    expect(toast()).toBe(noteClosed());
    await undo();
    expect(field()?.value).toBe('typed before the reload');
  });

  it('a note Undo opened and Esc put away leaves no words in the browser: a reload brings nothing back', async () => {
    const { src } = open({ remember: true });
    type(newNote(), 'a thought, put away');
    Keyboard.press('Escape');
    await undo();
    expect(field()?.value).toBe('a thought, put away');
    // An open field keeps its words in the browser, also one that Undo opened.
    await wait(DRAFT_PAUSE_MS + 60);
    expect(keptNote()).toMatchObject({ text: 'a thought, put away' });
    Keyboard.press('Escape');
    await settle();
    expect(keptNote()).toBeUndefined();
    cleanup();
    open({ remember: true, events: src.events });
    await settle();
    expect(field()).toBeNull();
  });

  it('a box’s words Undo brought back and Esc put away leave nothing in the browser: a reload brings no field and no box', async () => {
    const { src } = open({ remember: true });
    type(drawBox(), 'the slow part');
    Keyboard.press('Escape');
    await settle();
    await undo();
    await undo();
    expect(label()?.value).toBe('the slow part');
    await wait(DRAFT_PAUSE_MS + 60);
    expect(keptLabel()).toMatchObject({ text: 'the slow part' });
    Keyboard.press('Escape');
    await settle();
    expect(keptLabel()).toBeUndefined();
    cleanup();
    open({ remember: true, events: src.events });
    await settle();
    expect(label()).toBeNull();
    expect(boxesOn(src)).toEqual([]);
  });
});
