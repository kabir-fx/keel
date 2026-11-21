import { describe, expect, it } from 'vitest';
import type { Board } from '../src/board/context';
import type { KeyContext, KeyEntry } from '../src/input/keytable';
import { applies, entryFor, KEY_TABLE, keyCaps, keyWords, KNOWN_KEYS } from '../src/input/keytable';
import type { KeyInput, KeyPress } from '../src/input/match';
import { keyOf, pressOf } from '../src/input/match';

/**
 * The keys as plain logic: which key a keyboard event is for on any layout (`match.ts`), and
 * the one table of shortcuts (`keytable.ts`). What the keys do on the board is in
 * `keysOnBoard.test.tsx`.
 */

/** What a layout types at a place: `[key, code]`, the code named for a US keyboard. */
type Typed = readonly [key: string, code: string];

/** The keys the board binds, as each layout types them: the key the board must read, and the event. */
const LAYOUTS: Record<string, Record<string, Typed>> = {
  US: {
    z: ['z', 'KeyZ'], y: ['y', 'KeyY'], h: ['h', 'KeyH'], p: ['p', 'KeyP'], b: ['b', 'KeyB'], a: ['a', 'KeyA'],
    n: ['n', 'KeyN'], i: ['i', 'KeyI'], l: ['l', 'KeyL'], d: ['d', 'KeyD'], t: ['t', 'KeyT'], s: ['s', 'KeyS'],
    0: ['0', 'Digit0'], 1: ['1', 'Digit1'], 2: ['2', 'Digit2'], '-': ['-', 'Minus'], '=': ['=', 'Equal'], '+': ['+', 'Equal'],
  },
  // AZERTY: A and Q have changed places, and so have Z and W. The digits need Shift: bare, the
  // key in the 1 place types "&". Minus is on the key in the 6 place.
  French: {
    z: ['z', 'KeyW'], y: ['y', 'KeyY'], h: ['h', 'KeyH'], p: ['p', 'KeyP'], b: ['b', 'KeyB'], a: ['a', 'KeyQ'],
    n: ['n', 'KeyN'], i: ['i', 'KeyI'], l: ['l', 'KeyL'], d: ['d', 'KeyD'], t: ['t', 'KeyT'], s: ['s', 'KeyS'],
    0: ['à', 'Digit0'], 1: ['&', 'Digit1'], 2: ['é', 'Digit2'], '-': ['-', 'Digit6'], '=': ['=', 'Equal'], '+': ['+', 'Equal'],
  },
  Russian: {
    z: ['я', 'KeyZ'], y: ['н', 'KeyY'], h: ['р', 'KeyH'], p: ['з', 'KeyP'], b: ['и', 'KeyB'], a: ['ф', 'KeyA'],
    n: ['т', 'KeyN'], i: ['ш', 'KeyI'], l: ['д', 'KeyL'], d: ['в', 'KeyD'], t: ['е', 'KeyT'], s: ['ы', 'KeyS'],
    0: ['0', 'Digit0'], 1: ['1', 'Digit1'], 2: ['2', 'Digit2'], '-': ['-', 'Minus'], '=': ['=', 'Equal'], '+': ['+', 'Equal'],
  },
  Greek: {
    z: ['ζ', 'KeyZ'], y: ['υ', 'KeyY'], h: ['η', 'KeyH'], p: ['π', 'KeyP'], b: ['β', 'KeyB'], a: ['α', 'KeyA'],
    n: ['ν', 'KeyN'], i: ['ι', 'KeyI'], l: ['λ', 'KeyL'], d: ['δ', 'KeyD'], t: ['τ', 'KeyT'], s: ['σ', 'KeyS'],
    0: ['0', 'Digit0'], 1: ['1', 'Digit1'], 2: ['2', 'Digit2'], '-': ['-', 'Minus'], '=': ['=', 'Equal'], '+': ['+', 'Equal'],
  },
};

const input = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...mods,
});

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, shift: false, alt: false, ctrl: false, meta: false, repeat: false, ...mods });

/** On the Board, a hand on the keys and nothing else going on. */
const IDLE: KeyContext = { mode: 'board', typing: false, pressOpen: false, noteWaits: false, control: false, mac: true };

const nameFor = (p: KeyPress, ctx: Partial<KeyContext> = {}) => entryFor(p, { ...IDLE, ...ctx })?.name;

describe('which key was pressed, on any keyboard', () => {
  for (const [layout, keys] of Object.entries(LAYOUTS)) {
    for (const capsLock of [false, true]) {
      it(`${layout}, Caps Lock ${capsLock ? 'on' : 'off'}: every key the board binds is read as that key`, () => {
        for (const [want, [key, code]] of Object.entries(keys)) {
          // Caps Lock types the capital of a letter, and leaves a digit or a sign as it is.
          const typed = capsLock ? key.toUpperCase() : key;
          expect(keyOf({ key: typed, code }, KNOWN_KEYS), `${layout}: "${typed}" at ${code}`).toBe(want);
        }
      });
    }
  }

  it('the typed letter wins over the place: on a French keyboard the key in the A place types Q, and is Q', () => {
    expect(keyOf({ key: 'q', code: 'KeyA' }, KNOWN_KEYS)).toBe('q');
    expect(keyOf({ key: 'w', code: 'KeyZ' }, KNOWN_KEYS)).toBe('w');
    // And the key that types M there sits where a US keyboard has a semicolon.
    expect(keyOf({ key: 'm', code: 'Semicolon' }, KNOWN_KEYS)).toBe('m');
  });

  it('a sign the board binds is read as typed, wherever it sits: plus on a German keyboard', () => {
    expect(keyOf({ key: '+', code: 'BracketRight' }, KNOWN_KEYS)).toBe('+');
    expect(keyOf({ key: '-', code: 'Slash' }, KNOWN_KEYS)).toBe('-');
    expect(keyOf({ key: '+', code: 'NumpadAdd' }, KNOWN_KEYS)).toBe('+');
  });

  it('a sign the board does not bind is read by its place, when the place is a letter or a digit', () => {
    // Shift and 1 on a US keyboard types "!": the key is still 1.
    expect(keyOf({ key: '!', code: 'Digit1' }, KNOWN_KEYS)).toBe('1');
    // The Greek keyboard types ";" in the Q place.
    expect(keyOf({ key: ';', code: 'KeyQ' }, KNOWN_KEYS)).toBe('q');
    // With no letter or digit at the place, the key is what it types.
    expect(keyOf({ key: '?', code: 'Slash' }, KNOWN_KEYS)).toBe('?');
  });

  it('a key that types nothing keeps its name, and a key the keyboard is still composing is read by its place', () => {
    expect(keyOf({ key: 'Escape', code: 'Escape' }, KNOWN_KEYS)).toBe('Escape');
    expect(keyOf({ key: ' ', code: 'Space' }, KNOWN_KEYS)).toBe(' ');
    expect(keyOf({ key: 'Process', code: 'KeyZ' }, KNOWN_KEYS)).toBe('z');
    expect(keyOf({ key: 'Dead', code: 'KeyN' }, KNOWN_KEYS)).toBe('n');
  });

  it('a key event with no place (a test, an old browser) is read by what it types', () => {
    expect(keyOf({ key: 'Z', code: '' }, KNOWN_KEYS)).toBe('z');
    expect(keyOf({ key: 'я', code: '' }, KNOWN_KEYS)).toBe('я');
  });

  it('Caps Lock on a Turkish keyboard types İ, whose lower case is two characters: the key is I', () => {
    expect(keyOf({ key: 'İ', code: 'Quote' }, KNOWN_KEYS)).toBe('i');
  });

  it('Shift is read from the event, never from the case of the letter', () => {
    // Caps Lock on, Shift held: the letter comes out small, and Shift is still held.
    expect(pressOf(input('s', 'KeyS', { shiftKey: true }), KNOWN_KEYS)).toMatchObject({ key: 's', shift: true });
    // Caps Lock on, no Shift: a capital, and Shift is not held.
    expect(pressOf(input('S', 'KeyS'), KNOWN_KEYS)).toMatchObject({ key: 's', shift: false });
  });
});

describe('the key table', () => {
  it('Cmd+Z on a Russian keyboard is Undo, with Caps Lock on too, and so is Ctrl+Z on a Greek one', () => {
    expect(nameFor(pressOf(input('я', 'KeyZ', { metaKey: true }), KNOWN_KEYS))).toBe('undo');
    expect(nameFor(pressOf(input('Я', 'KeyZ', { metaKey: true }), KNOWN_KEYS))).toBe('undo');
    expect(nameFor(pressOf(input('ζ', 'KeyZ', { ctrlKey: true }), KNOWN_KEYS), { mac: false })).toBe('undo');
    expect(nameFor(pressOf(input('я', 'KeyZ', { metaKey: true, shiftKey: true }), KNOWN_KEYS))).toBe('redo');
  });

  it('a tool key on a Russian or a Greek keyboard takes its tool: the Pen is the key in the P place', () => {
    expect(nameFor(pressOf(input('з', 'KeyP'), KNOWN_KEYS))).toBe('tool.pen');
    expect(nameFor(pressOf(input('π', 'KeyP'), KNOWN_KEYS))).toBe('tool.pen');
    // On a French keyboard the Arrow is the key that types A, in the Q place.
    expect(nameFor(pressOf(input('a', 'KeyQ'), KNOWN_KEYS))).toBe('tool.arrow');
  });

  /** Every key press there is, of the keys the table names and a few it does not, in every place and time. */
  function* everyPress(): Generator<[KeyPress, KeyContext]> {
    const flags = [false, true];
    for (const key of [...KNOWN_KEYS, 'x', '?', 'Enter', 'Tab'])
      for (const shift of flags)
        for (const alt of flags)
          for (const ctrl of flags)
            for (const meta of flags)
              for (const mode of ['board', 'story'] as const)
                for (const typing of flags)
                  for (const pressOpen of flags)
                    for (const noteWaits of flags)
                      for (const control of flags)
                        for (const mac of flags) yield [press(key, { shift, alt, ctrl, meta }), { mode, typing, pressOpen, noteWaits, control, mac }];
  }

  /** The presses more than one entry of a table would take, each with the names of the entries. */
  function clashes(table: readonly KeyEntry[]): string[] {
    const out: string[] = [];
    for (const [p, ctx] of everyPress()) {
      const taking = table.filter((entry) => applies(entry, p, ctx));
      if (taking.length > 1) out.push(`${JSON.stringify(p)} ${JSON.stringify(ctx)}: ${taking.map((e) => e.name).join(', ')}`);
    }
    return out;
  }

  it('no two entries take the same key press', () => {
    expect(clashes(KEY_TABLE)).toEqual([]);
  });

  it('the check finds a clash when there is one, and then neither entry runs', () => {
    const twice: KeyEntry[] = [...KEY_TABLE, { name: 'again', keys: ['s'], run: () => {} }];
    expect(clashes(twice).length).toBeGreaterThan(0);
    expect(clashes(twice).every((line) => line.includes('tool.select, again'))).toBe(true);
    expect(entryFor(press('s'), IDLE, twice)).toBeUndefined();
    // The table as it is still knows the key.
    expect(entryFor(press('s'), IDLE)?.name).toBe('tool.select');
  });

  it('every name is used once', () => {
    const names = KEY_TABLE.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no arrow key is a key while a press is open, with Shift or without: a run begun under a drag would put the thing back once the keys rested', () => {
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      expect(nameFor(press(key), { pressOpen: true }), key).toBeUndefined();
      expect(nameFor(press(key, { shift: true }), { pressOpen: true }), `Shift and ${key}`).toBeUndefined();
      // With no press open each is a key.
      expect(nameFor(press(key), { pressOpen: false }), key).toMatch(/^walk\.(on|back)$/);
      expect(nameFor(press(key, { shift: true }), { pressOpen: false }), `Shift and ${key}`).toBe('nudge.far');
    }
  });

  it('a tool key is no key while a press is open; Space, Undo, Redo, Delete and Solidify are still taken from the browser, and do nothing', () => {
    for (const key of ['s', 'h', 'p', 'b', 'a', 'n', 'i', 'l', 'e']) expect(nameFor(press(key), { pressOpen: true }), key).toBeUndefined();
    expect(nameFor(press(' '), { pressOpen: true })).toBe('pan.hold');
    expect(nameFor(press('z', { meta: true }), { pressOpen: true })).toBe('undo');
    expect(nameFor(press('z', { meta: true, shift: true }), { pressOpen: true })).toBe('redo');
    expect(nameFor(press('Delete'), { pressOpen: true })).toBe('remove');
    expect(nameFor(press('Backspace'), { pressOpen: true })).toBe('remove');
    expect(nameFor(press('s', { shift: true }), { pressOpen: true })).toBe('solidify');
    // What each of them does with a press open: nothing. The board here is only what they ask of it.
    const did: string[] = [];
    const doing = (open: boolean) =>
      ({
        pressOpen: () => open,
        holdSpace: () => did.push('pan'),
        undo: () => did.push('undo'),
        redo: () => did.push('redo'),
        removeSelected: () => did.push('remove'),
        solidify: () => did.push('solidify'),
      }) as unknown as Board;
    const presses = [press(' '), press('z', { meta: true }), press('z', { meta: true, shift: true }), press('Delete'), press('Backspace'), press('s', { shift: true })];
    for (const p of presses) entryFor(p, { ...IDLE, pressOpen: true })?.run(doing(true), p);
    expect(did).toEqual([]);
    // And with no press open, each does its own.
    for (const p of presses) entryFor(p, IDLE)?.run(doing(false), p);
    expect(did).toEqual(['pan', 'undo', 'redo', 'remove', 'remove', 'solidify']);
  });

  it('while the owner types, a key is a letter: only Cmd or Ctrl with plus, equals, minus and 0 are still the board’s', () => {
    for (const key of ['s', 'p', ' ', 'Delete', 'Backspace', 'Escape', '1', '=', '-', 'ArrowLeft', 'PageDown']) expect(nameFor(press(key), { typing: true }), key).toBeUndefined();
    expect(nameFor(press('z', { meta: true }), { typing: true })).toBeUndefined();
    expect(nameFor(press('=', { meta: true }), { typing: true })).toBe('zoom.in.main');
    expect(nameFor(press('+', { ctrl: true, shift: true }), { typing: true, mac: false })).toBe('zoom.in.main');
    expect(nameFor(press('-', { meta: true }), { typing: true })).toBe('zoom.out.main');
    expect(nameFor(press('0', { ctrl: true }), { typing: true })).toBe('zoom.actual.main');
  });

  it('Cmd or Ctrl with a digit other than 0 stays the browser’s: it changes tabs', () => {
    expect(nameFor(press('1', { meta: true }))).toBeUndefined();
    expect(nameFor(press('2', { ctrl: true }))).toBeUndefined();
  });

  it('Redo is Cmd or Ctrl with Shift and Z everywhere, and Ctrl+Y off the Mac only', () => {
    expect(nameFor(press('z', { ctrl: true, shift: true }), { mac: false })).toBe('redo');
    expect(nameFor(press('y', { ctrl: true }), { mac: false })).toBe('redo.y');
    expect(nameFor(press('y', { ctrl: true }), { mac: true })).toBeUndefined();
    // Cmd+Y is the browser's history on a Mac.
    expect(nameFor(press('y', { meta: true }), { mac: true })).toBeUndefined();
  });

  it('the Note tool waits for its click: a typed character says where to click, and the other keys still work', () => {
    const waits = { noteWaits: true };
    for (const key of ['h', 'p', 'x', '1', '=', '?']) expect(nameFor(press(key), waits), key).toBe('note.where');
    expect(nameFor(press('s', { shift: true }), waits)).toBe('note.where');
    expect(nameFor(press('Escape'), waits)).toBe('escape');
    expect(nameFor(press(' '), waits)).toBe('pan.hold');
    expect(nameFor(press('Delete'), waits)).toBe('remove');
    expect(nameFor(press('z', { meta: true }), waits)).toBe('undo');
    expect(nameFor(press('=', { meta: true }), waits)).toBe('zoom.in.main');
    // With the Note tool put down, a character is no start of a note.
    expect(nameFor(press('x'))).toBeUndefined();
  });

  it('in the Story only Esc does something; Cmd or Ctrl with plus, minus and 0 are taken from the browser there too, and do nothing', () => {
    expect(nameFor(press('Escape'), { mode: 'story' })).toBe('story.leave');
    for (const key of ['s', ' ', 'Delete', '1']) expect(nameFor(press(key), { mode: 'story' }), key).toBeUndefined();
    expect(nameFor(press('z', { meta: true }), { mode: 'story' })).toBeUndefined();
    expect(nameFor(press('1', { meta: true }), { mode: 'story' })).toBeUndefined();
    expect(nameFor(press('=', { meta: true }))).toBe('zoom.in.main');
    for (const [p, ctx] of [
      [press('=', { meta: true }), {}],
      [press('+', { ctrl: true, shift: true }), { mac: false }],
      [press('-', { meta: true }), { typing: true }],
      [press('0', { meta: true }), {}],
    ] as const) {
      expect(nameFor(p, { mode: 'story', ...ctx }), p.key).toBe('story.zoom');
      // What it does: nothing. The board here is nothing at all, so any call would throw.
      expect(entryFor(p, { ...IDLE, mode: 'story', ...ctx })?.run({} as Board, p)).toBeUndefined();
    }
  });

  it('Space is the button’s while a control has the focus by the keyboard; the zoom keys and Undo are still the board’s', () => {
    expect(nameFor(press(' '), { control: true })).toBeUndefined();
    expect(nameFor(press(' '))).toBe('pan.hold');
    expect(nameFor(press('=', { meta: true }), { control: true })).toBe('zoom.in.main');
    expect(nameFor(press('z', { meta: true }), { control: true })).toBe('undo');
  });

  it('no entry uses Alt, and a plain key is not taken with Cmd or Ctrl held', () => {
    expect(nameFor(press('z', { meta: true, alt: true }))).toBeUndefined();
    expect(nameFor(press('s', { alt: true }))).toBeUndefined();
    expect(nameFor(press('s', { meta: true }))).toBeUndefined();
    expect(nameFor(press('s', { ctrl: true, shift: true }))).toBeUndefined();
    expect(nameFor(press('s'))).toBe('tool.select');
    expect(nameFor(press('s', { shift: true }))).toBe('solidify');
  });

  it('the zoom keys take Shift or leave it, as the keyboard needs: plus is Shift and equals on a US keyboard', () => {
    expect(nameFor(press('+', { shift: true }))).toBe('zoom.in');
    expect(nameFor(press('='))).toBe('zoom.in');
    expect(nameFor(press('-'))).toBe('zoom.out');
    expect(nameFor(press('0'))).toBe('zoom.actual');
    expect(nameFor(press('2'))).toBe('fit.selection');
    // On a French keyboard a digit is typed with Shift: 0, 1 and 2 all take it.
    expect(nameFor(press('0', { shift: true }))).toBe('zoom.actual');
    expect(nameFor(press('1', { shift: true }))).toBe('fit.all');
    expect(nameFor(press('2', { shift: true }))).toBe('fit.selection');
    // Minus with Shift types an underscore on a US keyboard: it is still minus.
    expect(nameFor(press('_', { shift: true }))).toBe('zoom.out');
    expect(nameFor(press('_', { meta: true, shift: true }))).toBe('zoom.out.main');
    expect(nameFor(press('PageUp'))).toBe('page.up');
    expect(nameFor(press('PageDown'))).toBe('page.down');
  });

  it('Delete and Backspace, the Mac’s delete key, each take the selected thing off; each arrow steps a walk', () => {
    expect(nameFor(press('Delete'))).toBe('remove');
    expect(nameFor(press('Backspace'))).toBe('remove');
    expect(nameFor(press('ArrowRight'))).toBe('walk.on');
    expect(nameFor(press('ArrowDown'))).toBe('walk.on');
    expect(nameFor(press('ArrowLeft'))).toBe('walk.back');
    expect(nameFor(press('ArrowUp'))).toBe('walk.back');
  });

  it('says each key as the owner’s keyboard writes it', () => {
    expect(keyWords('undo', true)).toBe('Cmd+Z');
    expect(keyWords('undo', false)).toBe('Ctrl+Z');
    expect(keyWords('redo', true)).toBe('Cmd+Shift+Z');
    expect(keyWords('redo.y', false)).toBe('Ctrl+Y');
    expect(keyWords('tool.pen')).toBe('P');
    expect(keyWords('solidify')).toBe('Shift+S');
    expect(keyWords('talk')).toBe('hold T');
    // The keys alone, for where the words round them say how the key is used.
    expect(keyCaps('talk')).toBe('T');
    expect(keyCaps('undo', true)).toBe('Cmd+Z');
    expect(keyWords('pan.hold')).toBe('hold Space');
    expect(keyWords('escape')).toBe('Esc');
    expect(keyWords('remove')).toBe('Delete');
    expect(keyWords('page.down')).toBe('Page Down');
    expect(keyWords('walk.on')).toBe('Right arrow');
    expect(keyWords('note.where')).toBe('');
  });
});
