import type { CanvasWork, ShowInfo } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SocketLike } from '../src/source';
import { localSource } from '../src/source';
import { lastLines, showPress, showWords, stripAnsi, tryableOf } from '../src/tryit';
import { Board, note, placeAt } from './helpers';

/**
 * The try room (record 0013, plan 5.3): the show at full size, what the blueprint promised,
 * what the app printed, Start, Stop and Start again, and Approve, which nothing hides. The
 * pictures and the terminal are test doubles: a fake xterm writes what it is given into its box.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state, children }: { state: string; children?: unknown }) => createElement('span', { className: `k-state k-state--${state}` }, (children as string) ?? state),
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id, style: { width: '300px', height: '200px' } }, item.id),
}));

const { terms, FakeTerminal } = vi.hoisted(() => {
  const terms: Array<InstanceType<typeof FakeTerminal>> = [];
  class FakeTerminal {
  written = '';
  cols: number;
  rows: number;
  el: HTMLElement | undefined;
  focused = 0;
  disposed = false;
  private data: ((d: string) => void) | undefined;
  constructor(opts: { cols: number; rows: number }) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    terms.push(this);
  }
  open(el: HTMLElement) {
    this.el = el;
  }
  write(d: string) {
    this.written += d;
    if (this.el) this.el.textContent = this.written;
  }
  reset() {
    this.written = '';
  }
  onData(cb: (d: string) => void) {
    this.data = cb;
    return { dispose: () => (this.data = undefined) };
  }
  type(d: string) {
    this.data?.(d);
  }
  resize(c: number, r: number) {
    this.cols = c;
    this.rows = r;
  }
  focus() {
    this.focused += 1;
  }
  dispose() {
    this.disposed = true;
  }
}
  return { terms, FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

afterEach(() => {
  cleanup();
  terms.length = 0;
});

/** A stream the test drives by hand. */
class FakeStream implements SocketLike {
  readyState = 1;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public chapter: string) {}
  say(msg: { t: 'out'; data: string } | { t: 'end'; code: number | null }) {
    act(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}

const HOME = { branch: 'main', commit: 'abc1234', upstream: 'origin/main', sync: 'level' as const };
const BRANCH = 'board/one-engine';

/** A board with one idea built, whose blueprint promised two things to check by hand. */
function built(extra: (b: Board) => void = () => undefined) {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
  b.must('owner', note('m1', [0, 0, 320, 100], {}, 'c1'));
  b.must('agent', { type: 'model.patch', chapter: 'c1', ops: [{ op: 'lane.set', lane: { id: 'api', name: 'API' } }, { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } }] });
  const s = b.must('owner', { type: 'solidify', chapter: 'c1', picks: ['m1'], parts: ['door'] });
  b.must('agent', {
    type: 'item.add',
    chapter: 'c1',
    item: { id: 'bp', kind: 'picture', answers: [s.id], picture: { kind: 'blueprint', title: 'The blueprint', picks: [{ text: 'one door' }], proof: ['Two requests share one engine', 'A third one waits its turn'], parts: ['door'], check: 'make check', show: { kind: 'app', run: 'npm start' } } },
  });
  b.must('owner', placeAt('bp', [400, 0, 300, 200]));
  b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door'], blueprint: 'bp', check: 'make check', show: { kind: 'app', run: 'npm start' } });
  b.must('system', { type: 'part.state', part: 'door', state: 'building' });
  b.must('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
  // Record 0013: an app is built once it started and answered in the build's copy.
  b.must('system', { type: 'build.proved', chapter: 'c1' });
  extra(b);
  return b;
}

/** Open the board on a built idea whose show is `show`, and open its try room. */
function room(show: ShowInfo | undefined, more: Partial<CanvasWork> = {}, b = built()) {
  const src = localSource({ events: b.events });
  const streams: FakeStream[] = [];
  src.stream = (chapter) => {
    const s = new FakeStream(chapter);
    streams.push(s);
    return s;
  };
  src.setWorks({ c1: { branch: BRANCH, ahead: 2, ...more } }, show ? { c1: show } : {}, HOME);
  render(<App source={src} />);
  openRoom();
  const set = (next: ShowInfo | undefined, extra: Partial<CanvasWork> = {}) => act(() => src.setWorks({ c1: { branch: BRANCH, ahead: 2, ...extra } }, next ? { c1: next } : {}, HOME));
  return { src, streams, set };
}

/** Press Try it as a person would: the button takes the focus first. */
function openRoom() {
  const tryIt = screen.getByTestId('watch-try');
  tryIt.focus();
  fireEvent.click(tryIt);
}

const inRoom = (id: string) => screen.getByTestId('try-room').querySelector(`[data-testid="${id}"]`);

const words = () => screen.getByTestId('try-words').textContent;
const press = () => screen.queryByTestId('try-press');

describe('the try room opens and closes', () => {
  it('names the idea and its branch, is a modal dialog, and puts the focus on Start', () => {
    room({ kind: 'app', run: 'npm start', state: 'off' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'One engine' })).toBeTruthy();
    expect(screen.getByTestId('try-branch').textContent).toBe(BRANCH);
    expect(document.activeElement).toBe(press());
    expect(press()!.textContent).toBe('Start');
  });

  it('Esc closes it and gives the focus back to Try it', () => {
    room({ kind: 'page', url: 'http://127.0.0.1:4791/k/' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'One engine' }));
    fireEvent.keyDown(screen.getByTestId('try-room'), { key: 'Escape' });
    expect(screen.queryByTestId('try-room')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('watch-try'));
  });

  it('"Back to the board" closes it too, and no key in it reaches the board', () => {
    room({ kind: 'app', run: 'npm start', state: 'off' });
    const before = screen.getByTestId('board').parentElement!.dataset.tool;
    // P is the pen's key on the board: in the room it does nothing there.
    fireEvent.keyDown(press()!, { key: 'p' });
    expect(screen.getByTestId('board').parentElement!.dataset.tool).toBe(before);
    fireEvent.click(screen.getByTestId('try-close'));
    expect(screen.queryByTestId('try-room')).toBeNull();
  });

  it('with the focus fallen out of it (a press that turns off, a click on its words), Esc still closes it and no key reaches the board', () => {
    room({ kind: 'app', run: 'npm start', state: 'off' });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const before = screen.getByTestId('board').parentElement!.dataset.tool;
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(screen.getByTestId('board').parentElement!.dataset.tool).toBe(before);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('try-room')).toBeNull();
  });

  it('the list from the blueprint can be ticked, and stays ticked when the room opens again', () => {
    room({ kind: 'page', url: 'http://127.0.0.1:4791/k/' });
    const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(screen.getByTestId('try-proof').textContent).toContain('Two requests share one engine');
    expect(screen.getByTestId('try-proof-count').textContent).toBe('0 of 2');
    fireEvent.click(boxes()[1]!);
    expect(screen.getByTestId('try-proof-count').textContent).toBe('1 of 2');
    fireEvent.click(screen.getByTestId('try-close'));
    openRoom();
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
  });
});

describe('a page', () => {
  it('is framed at full size, with a link that opens a tab, and nothing to start', () => {
    room({ kind: 'page', url: 'http://127.0.0.1:4791/k/' });
    const frame = screen.getByTestId('try-frame');
    expect(frame.getAttribute('src')).toBe('http://127.0.0.1:4791/k/');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    const tab = screen.getByTestId('try-tab');
    expect(tab.getAttribute('href')).toBe('http://127.0.0.1:4791/k/');
    expect(tab.getAttribute('target')).toBe('_blank');
    expect(tab.getAttribute('rel')).toBe('noopener noreferrer');
    expect(press()).toBeNull();
    expect(words()).toBe('The page this build made, served from an address of its own. Nothing runs.');
  });
});

describe('an app', () => {
  it('off: Start sends the command as shown, and nothing runs before it', async () => {
    const { src } = room({ kind: 'app', run: 'npm start', state: 'off' });
    expect(src.asked).toEqual([]);
    expect(screen.getByTestId('try-off').textContent).toContain('Press Start to run npm start. Nothing runs before you do.');
    await act(async () => {
      fireEvent.click(press()!);
    });
    expect(src.asked).toEqual([{ route: 'show', body: { action: 'start', chapter: 'c1', run: 'npm start' } }]);
  });

  it('starting: says it waits, shows what it prints as it comes, and offers Stop', () => {
    const { set, streams } = room({ kind: 'app', run: 'npm start', state: 'off' });
    set({ kind: 'app', run: 'npm start', state: 'starting' });
    expect(words()).toBe('Starting. The app shows here once it answers on its port. The board waits up to a minute.');
    expect(press()!.textContent).toBe('Stop');
    expect(streams).toHaveLength(1);
    streams[0]!.say({ t: 'out', data: '> vite\n\u001b[32mready\u001b[0m in 300 ms\n' });
    expect(screen.getByTestId('try-starting').textContent).toContain('ready in 300 ms');
    expect(screen.getByTestId('try-printed').textContent).toContain('> vite');
  });

  it('on: framed, with the link, a word on apps that refuse a frame, and Stop asks the server to stop it', async () => {
    const { src, set } = room({ kind: 'app', run: 'npm start', state: 'starting' });
    set({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' });
    expect(screen.getByTestId('try-frame').getAttribute('src')).toBe('http://127.0.0.1:5173/');
    expect(screen.getByTestId('try-tab').getAttribute('href')).toBe('http://127.0.0.1:5173/');
    expect(screen.getByTestId('try-room').textContent).toContain('Nothing in the frame? Some apps refuse to be shown inside another page. Open it in a new tab instead.');
    expect(words()).toBe('Running at http://127.0.0.1:5173/');
    await act(async () => {
      fireEvent.click(press()!);
    });
    expect(src.asked).toEqual([{ route: 'show', body: { action: 'stop', chapter: 'c1' } }]);
  });

  it('failed: the reason once, the last lines it printed, Start again, and Approve still there', () => {
    const { set, streams } = room({ kind: 'app', run: 'npm start', state: 'starting' });
    set({ kind: 'app', run: 'npm start', state: 'failed', note: 'port 3000 is in use by another program.' });
    expect(words()).toBe('It did not start.');
    expect(press()!.textContent).toBe('Start again');
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    streams[0]!.say({ t: 'out', data: `${lines}\n` });
    streams[0]!.say({ t: 'end', code: 1 });
    const last = screen.getByTestId('try-last').textContent!.split('\n');
    expect(last).toHaveLength(12);
    expect(last.at(-1)).toBe('line 20');
    expect(screen.getByTestId('try-room').textContent!.split('port 3000 is in use by another program.')).toHaveLength(2);
    // It answered once when it was built (record 0013): a failed start now is new, not a choice to approve anyway.
    expect(screen.getByTestId('try-failed').textContent).not.toContain('You can still approve it');
    expect(screen.getByTestId('try-failed').textContent).toContain('It started and answered when it was built, so this is new. Start again runs it once more.');
    expect(inRoom('approve-press')!.textContent).toBe('Approve: merge into main');
  });

  it('a start the server refuses, which leaves the app failed, says the server’s reason once', async () => {
    const reason = 'The builder is working on this canvas now. Try it when that is done.';
    const { src, set } = room({ kind: 'app', run: 'npm start', state: 'off' });
    src.answer = () => ({ ok: false, reason });
    await act(async () => {
      fireEvent.click(press()!);
    });
    set({ kind: 'app', run: 'npm start', state: 'failed', note: reason });
    expect(screen.getByTestId('try-room').textContent!.split(reason)).toHaveLength(2);
    expect(screen.queryByTestId('try-refused')).toBeNull();
    expect(words()).toBe('It did not start.');
    // The server did not run it: nothing to say about what it printed, or about the build's own start.
    expect(screen.getByTestId('try-failed').textContent).toBe(`The app did not start${reason}`);
  });

  it('a start the server refuses says why, and starts nothing', async () => {
    const { src } = room({ kind: 'app', run: 'npm start', state: 'off' });
    src.answer = () => ({ ok: false, reason: 'That is not the command this idea agreed to.' });
    await act(async () => {
      fireEvent.click(press()!);
    });
    expect(screen.getByTestId('try-refused').textContent).toBe('That is not the command this idea agreed to.');
  });

  it('while the builder finishes, nothing starts: the room says why where Start was, and Try it in the panel is off', () => {
    const { set } = room({ kind: 'app', run: 'npm start', state: 'off' });
    set({ kind: 'app', run: 'npm start', state: 'off' }, { busy: 'building' });
    expect(press()).toBeNull();
    expect(inRoom('try-held')!.textContent).toBe('The builder is finishing: its last commit is not in yet.');
    expect(inRoom('approve-busy')!.textContent).toBe('The builder is finishing: its last commit is not in yet.');
    expect((inRoom('approve-press') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('try-close'));
    const tryIt = screen.getByTestId('watch-try') as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    expect(tryIt.dataset.tip).toBe('The builder is finishing: its last commit is not in yet.');
  });

  it('an app that runs: Try it in the panel says so, and opens the room', () => {
    const { set } = room({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' });
    fireEvent.click(screen.getByTestId('try-close'));
    expect(screen.getByTestId('watch-try').textContent).toBe('Open the running app');
    set({ kind: 'app', run: 'npm start', state: 'off' });
    expect(screen.getByTestId('watch-try').textContent).toBe('Try it');
    set({ kind: 'app', run: 'npm start', state: 'starting' });
    fireEvent.click(screen.getByTestId('watch-try'));
    expect(screen.getByTestId('try-room')).toBeTruthy();
  });

  it('while the server merges it, the room cannot start or stop it, and Try it in the panel is off', () => {
    const { set } = room({ kind: 'app', run: 'npm start', state: 'off' });
    set({ kind: 'app', run: 'npm start', state: 'off' }, { busy: 'merging' });
    expect((screen.getByTestId('watch-try') as HTMLButtonElement).disabled).toBe(true);
    expect(press()).toBeNull();
    expect(inRoom('approve-busy')!.textContent).toBe(`Merging ${BRANCH} into main.`);
  });
});

describe('a terminal', () => {
  it('off: Start sends the command and the size the room has room for', async () => {
    const { src } = room({ kind: 'terminal', run: 'node calc.js', state: 'off' });
    expect(words()).toBe('Start opens a terminal in the build’s own copy, boxed in, and types this command for you. You go on from there.');
    await act(async () => {
      fireEvent.click(press()!);
    });
    const body = src.asked[0]!.body as { cols: number; rows: number; run: string };
    expect(body.run).toBe('node calc.js');
    expect(body.cols).toBeGreaterThanOrEqual(20);
    expect(body.rows).toBeGreaterThanOrEqual(5);
  });

  it('on: the kept output first, then what comes; keys go back; Esc stays in the terminal', () => {
    const { streams } = room({ kind: 'terminal', run: 'node calc.js', state: 'on' });
    expect(streams).toHaveLength(1);
    streams[0]!.say({ t: 'out', data: '$ node calc.js\r\n> ' });
    streams[0]!.say({ t: 'out', data: '2+2\r\n4\r\n' });
    expect(terms[0]!.written).toBe('$ node calc.js\r\n> 2+2\r\n4\r\n');
    terms[0]!.type('q');
    expect(streams[0]!.sent).toEqual([{ t: 'in', data: 'q' }]);
    fireEvent.keyDown(screen.getByTestId('try-terminal'), { key: 'Escape' });
    expect(screen.getByTestId('try-room')).toBeTruthy();
  });

  it('a stream that joins again starts from what the server kept, not after it', () => {
    const { streams, set } = room({ kind: 'terminal', run: 'node calc.js', state: 'on' });
    streams[0]!.say({ t: 'out', data: 'one\r\n' });
    set({ kind: 'terminal', run: 'node calc.js', state: 'on' }, { ahead: 3 });
    expect(streams).toHaveLength(1);
  });

  it('a start the server refuses says the reason once, and never that a terminal was stopped', async () => {
    const reason = 'The builder is working on this canvas now. Try it when that is done.';
    const { src, set } = room({ kind: 'terminal', run: 'node calc.js', state: 'off' });
    src.answer = () => ({ ok: false, reason });
    await act(async () => {
      fireEvent.click(press()!);
    });
    set({ kind: 'terminal', run: 'node calc.js', state: 'ended', code: null });
    const text = screen.getByTestId('try-room').textContent!;
    expect(text.split(reason)).toHaveLength(2);
    expect(text).not.toContain('stopped');
    expect(screen.getByTestId('try-failed').textContent).toBe(`The terminal did not start${reason}`);
    expect(screen.queryByTestId('try-terminal')).toBeNull();
    expect(words()).toBe('It did not start.');
    expect(press()!.textContent).toBe('Start again');
  });

  it('ended: says its code, keeps what it printed, and offers Start again', () => {
    const { streams, set } = room({ kind: 'terminal', run: 'node calc.js', state: 'on' });
    streams[0]!.say({ t: 'out', data: 'bye\r\n' });
    streams[0]!.say({ t: 'end', code: 2 });
    set({ kind: 'terminal', run: 'node calc.js', state: 'ended', code: 2 });
    expect(words()).toBe('The terminal ended with code 2.');
    expect(screen.getByTestId('try-terminal').textContent).toBe('bye\r\n');
    expect(press()!.textContent).toBe('Start again');
  });
});

describe('a machine with no sandbox', () => {
  it('says so in one calm line where it says how the command runs, and says nothing when the show is boxed', () => {
    const { set } = room({ kind: 'terminal', run: 'node calc.js', state: 'off', boxed: false });
    expect(inRoom('try-unboxed')!.textContent).toBe('This machine has no sandbox, so the command runs with a short environment and can read and write what you can.');
    set({ kind: 'app', run: 'npm start', state: 'off', boxed: false });
    expect(inRoom('try-unboxed')).toBeTruthy();
    set({ kind: 'app', run: 'npm start', state: 'off' });
    expect(inRoom('try-unboxed')).toBeNull();
  });
});

describe('nothing to try', () => {
  it('no copy on this machine: says so, and Approve is still there', () => {
    const src = localSource({ events: built().events });
    src.setWorks({}, {}, HOME);
    render(<App source={src} />);
    openRoom();
    expect(screen.getByTestId('try-room').dataset.state).toBe('no-copy');
    expect(words()).toBe('This machine has no copy of this build, so there is nothing to run here. It was built on another machine, or its branch is gone.');
    expect(inRoom('approve-press')).toBeTruthy();
  });

  it('a branch and nothing that can run it: says so, and that it can still be approved', () => {
    room(undefined);
    expect(screen.getByTestId('try-room').dataset.state).toBe('nothing');
    expect(words()).toBe('The builder on this machine cannot run what it built, and the build made no page. There is nothing to try here.');
    expect(screen.getByTestId('try-none').textContent).toContain('You can still approve it: you decide.');
  });

  it('merged while the room is open: says where it went, and never that it can still be approved', async () => {
    const { src, set } = room({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' });
    await act(async () => {
      await src.postAs('system', { type: 'canvas.merged', canvas: 'c1', commit: 'def5678', into: 'main' });
    });
    set(undefined);
    expect(screen.getByTestId('try-room').dataset.state).toBe('merged');
    expect(words()).toBe('This idea is in main now. Its copy is gone.');
    expect(screen.getByTestId('try-room').textContent).not.toContain('approve it');
    expect(inRoom('merged-line')!.textContent).toContain('Merged into main at def5678');
  });
});

describe('what the builder said', () => {
  it('a problem it said once every part was built shows beside the show', () => {
    const b = built((x) => x.must('agent', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The app needs a .env file with an API key to send mail.' }));
    room({ kind: 'app', run: 'npm start', state: 'off' }, {}, b);
    expect(screen.getByTestId('try-caveat').textContent).toBe('The builder saidThe app needs a .env file with an API key to send mail.');
  });

  it('none when it said none', () => {
    room({ kind: 'app', run: 'npm start', state: 'off' });
    expect(screen.queryByTestId('try-caveat')).toBeNull();
  });
});

describe('the words of the try room, as data', () => {
  it('each state of a show has its words and its press', () => {
    const c = built().state.chapters.c1!;
    const t = (show: ShowInfo) => tryableOf(c, show, undefined);
    expect(showPress(t({ kind: 'app', run: 'x', state: 'off' }))).toBe('Start');
    expect(showPress(t({ kind: 'app', run: 'x', state: 'starting' }))).toBe('Stop');
    expect(showPress(t({ kind: 'app', run: 'x', state: 'failed' }))).toBe('Start again');
    expect(showPress(t({ kind: 'terminal', run: 'x', state: 'ended', code: 0 }))).toBe('Start again');
    expect(showPress(t({ kind: 'page', url: 'http://127.0.0.1:1/' }))).toBeUndefined();
    expect(showWords(t({ kind: 'terminal', run: 'x', state: 'ended', code: null }), HOME)).toBe('The terminal is closed.');
    expect(showWords(t({ kind: 'app', run: 'x', state: 'failed' }), HOME)).toBe('It did not start.');
    expect(tryableOf({ ...c, merged: { commit: 'a', into: 'main', at: '' } }, { kind: 'app', run: 'x', state: 'on' }, undefined)).toEqual({ kind: 'none', why: 'merged' });
  });

  it('the last lines, without colour codes or a trailing blank', () => {
    expect(stripAnsi('\u001b[1;31merror\u001b[0m')).toBe('error');
    expect(lastLines('a\r\nb\n\n\n', 5)).toEqual(['a', 'b']);
  });
});

