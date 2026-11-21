import type { BoardEvent, ServerMessage } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { SocketLike } from '../src/source';
import { forgetTold } from '../src/notify';
import { localSource, serverSource } from '../src/source';
import { Board, note, placeAt } from './helpers';

/**
 * Watching a build and the Story, in the app: the panel, Pause, a reopened part, the desktop
 * notification, the tab's title, the pill that follows the chapter in view, the Story switch,
 * and the next idea. The pictures are a test double: a blueprint draws "Build this".
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state, children }: { state: string; children?: unknown }) => createElement('span', { className: `k-state k-state--${state}` }, (children as string) ?? state),
  Picture: ({ item, onAct }: { item: { id: string; picture: { kind: string; parts?: string[] } }; onAct?: (a: unknown) => void }) =>
    createElement(
      'div',
      { 'data-double': item.id, 'data-kind': item.picture.kind, style: { width: '300px', height: '200px' } },
      item.picture.kind === 'blueprint'
        ? createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'build.start', chapter: 'c1', track: item.picture.parts, blueprint: item.id, check: 'make check' }) }, 'Build this')
        : item.id,
    ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A board with one idea, solid, and its blueprint: ready for "Build this". */
function solid() {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
  b.must('owner', note('m1', [0, 0, 320, 100], {}, 'c1'));
  b.must('agent', {
    type: 'model.patch',
    chapter: 'c1',
    ops: [
      { op: 'lane.set', lane: { id: 'api', name: 'API' } },
      { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } },
      { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'api' } },
      { op: 'part.set', part: { id: 'loop', name: 'The loop', lane: 'api' } },
    ],
  });
  const s = b.must('owner', { type: 'solidify', chapter: 'c1', picks: ['m1'], parts: ['door', 'queue', 'loop'] });
  b.must('agent', {
    type: 'item.add',
    chapter: 'c1',
    item: { id: 'bp', kind: 'picture', answers: [s.id], picture: { kind: 'blueprint', title: 'The blueprint', picks: [{ text: 'one door' }], proof: ['it runs'], parts: ['door', 'queue', 'loop'], check: 'make check' } },
  });
  b.must('owner', placeAt('bp', [400, 0, 300, 200]));
  return b;
}

/** The same board, building: the door built, the queue in work. */
function building() {
  const b = solid();
  b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door', 'queue', 'loop'], blueprint: 'bp', check: 'make check' });
  return b;
}

const posted = (src: { events: BoardEvent[] }, from: number) => src.events.slice(from);

describe('the build panel', () => {
  it('shows while the chapter in view builds: the track, part 1 of 3, Pause, and the line that says you can leave', () => {
    const src = localSource({ events: building().events });
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('running');
    expect(screen.getByTestId('watch-where').textContent).toBe('part 1 of 3');
    expect(screen.getByTestId('watch-leave').textContent).toContain('You can leave.');
    expect([...screen.getByTestId('track').querySelectorAll('li')].map((li) => li.dataset.state)).toEqual(['solid', 'solid', 'solid']);
    expect(screen.getByTestId('feed').textContent).toContain('Build started: 3 parts.');
  });

  it('is not there before "Build this"', () => {
    render(<App source={localSource({ events: solid().events })} />);
    expect(screen.queryByTestId('watch')).toBeNull();
  });

  it('fills in as the parts are built, and a problem stands out', async () => {
    const src = localSource({ events: building().events });
    render(<App source={src} />);
    await act(async () => {
      await src.postAs('system', { type: 'part.state', part: 'door', state: 'building' } as never);
      await src.postAs('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } } as never);
      await src.postAs('system', { type: 'feed.add', chapter: 'c1', kind: 'commit', part: 'door', commit: 'abc1234', check: { cmd: 'make check', passed: true }, text: 'The door is built.' } as never);
      await src.postAs('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The check failed after The queue.' } as never);
    });
    expect(screen.getByTestId('watch-where').textContent).toBe('part 2 of 3');
    const lines = [...screen.getByTestId('feed').querySelectorAll<HTMLElement>('li')];
    expect(lines.map((l) => l.dataset.kind)).toEqual(['state', 'state', 'state', 'commit', 'problem']);
    expect(lines[3]!.querySelector('.feed__commit')!.textContent).toBe('abc1234');
    expect(lines[3]!.querySelector('.feed__check')!.textContent).toBe('make check · passed');
    expect(lines[4]!.className).toContain('feed__line--problem');
  });

  it('Pause posts build.pause, the panel says paused, and Resume posts build.resume', async () => {
    const src = localSource({ events: building().events });
    render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    expect(posted(src, n).map((e) => [e.type, e.by])).toEqual([['build.pause', 'owner']]);
    expect(screen.getByTestId('watch').dataset.state).toBe('paused');
    expect(screen.getByTestId('watch-status').textContent).toBe('Paused. Nothing is built while it is paused.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    });
    expect(posted(src, n).map((e) => e.type)).toEqual(['build.pause', 'build.resume']);
    expect(screen.getByTestId('watch').dataset.state).toBe('running');
  });

  it('a reopened part: the build waits for the owner, and "Solidify this part" posts it solid as the owner', async () => {
    const b = building();
    b.must('owner', { type: 'part.state', part: 'queue', state: 'idea' });
    const src = localSource({ events: b.events });
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('waiting');
    expect(screen.getByTestId('watch-reopened').textContent).toContain('The build waits for you.');
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Solidify this part: The queue' }));
    });
    expect(posted(src, n)).toMatchObject([{ type: 'part.state', part: 'queue', state: 'solid', by: 'owner' }]);
    expect(screen.queryByTestId('watch-reopened')).toBeNull();
    expect(screen.getByTestId('watch').dataset.state).toBe('running');
  });

  it('folds to one line while the focus view is open, and comes back after', () => {
    const b = building();
    const ask = b.must('owner', { type: 'ask', what: 'focus', part: 'queue' });
    b.must('agent', { type: 'item.add', chapter: 'c1', item: { id: 'f1', kind: 'picture', answers: [ask.id], picture: { kind: 'focus', part: 'queue', title: 'The queue' } } });
    b.must('owner', placeAt('f1', [0, 400, 300, 200]));
    render(<App source={localSource({ events: b.events })} focus="f1" />);
    expect(screen.getByTestId('watch-where').textContent).toBe('part 1 of 3');
    expect(screen.queryByTestId('feed')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('feed')).toBeTruthy();
  });

  it('says what the server says: stopped points at the feed’s last problem', async () => {
    const b = building();
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The builder failed: no disk.' });
    const src = localSource({ events: b.events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'stopped', built: 0, total: 3 });
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('stopped');
    expect(screen.getByTestId('watch-status').textContent).toContain('Stopped before it finished.');
    expect(screen.getByTestId('watch').textContent).not.toContain('Pause and resume');
    expect(screen.getByRole('button', { name: 'See why in the feed' })).toBeTruthy();
    act(() => src.setBuild({ chapter: 'c1', title: 'One engine', state: 'queued', built: 0, total: 3 }));
    expect(screen.getByTestId('watch').dataset.state).toBe('queued');
    expect(screen.queryByTestId('watch-again')).toBeNull();
  });

  it('stopped: one press tries again, as pause then resume', async () => {
    const b = building();
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The builder failed: no disk.' });
    const src = localSource({ events: b.events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'stopped', built: 0, total: 3 });
    render(<App source={src} />);
    // One button: a build that stopped has nothing to pause.
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('watch-again'));
    });
    expect(screen.getByTestId('watch-again').textContent).toBe('Try again');
    expect(posted(src, n).map((e) => [e.type, e.by])).toEqual([
      ['build.pause', 'owner'],
      ['build.resume', 'owner'],
    ]);
  });

  it('unagreed: says nothing is built here, shows the check, and one Resume posts pause then resume', async () => {
    const src = localSource({ events: building().events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'unagreed', built: 0, total: 3, check: 'make check' });
    render(<App source={src} />);
    const watch = screen.getByTestId('watch');
    expect(watch.dataset.state).toBe('unagreed');
    expect(screen.getByTestId('watch-status').textContent).toContain('you have not pressed "Build this" or Resume for the board as it is now, on this machine');
    expect(screen.getByTestId('watch-agree').querySelector('code')!.textContent).toBe('make check');
    // One button: no Pause beside it, and no line that says the owner can leave.
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByTestId('watch-leave')).toBeNull();
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    });
    expect(posted(src, n).map((e) => [e.type, e.by])).toEqual([
      ['build.pause', 'owner'],
      ['build.resume', 'owner'],
    ]);
  });

  it('unagreed: lists the remarks the builder will follow, at most five, then how many more', () => {
    const b = building();
    const start = b.events[b.events.length - 1]!.id;
    b.must('agent', { type: 'item.add', chapter: 'c1', item: { id: 'pipe', kind: 'picture', picture: { kind: 'pipeline', title: 'The model' }, answers: [start] } });
    b.must('owner', placeAt('pipe', [0, 300, 300, 200]));
    for (let i = 1; i <= 7; i++) {
      b.must('owner', note(`r${i}`, [400, 300 + i * 90, 300, 80], { text: `remark ${i}`, on: { item: 'pipe', sub: `part:${i % 2 ? 'queue' : 'loop'}` } }, 'c1'));
    }
    const src = localSource({ events: b.events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'unagreed', built: 0, total: 3, check: 'make check' });
    render(<App source={src} />);
    const box = screen.getByTestId('watch-remarks');
    expect(box.querySelector('p')!.textContent).toBe('The builder will also follow these remarks on the parts:');
    const items = [...box.querySelectorAll('li')].map((li) => li.textContent);
    // The track's order: the queue's remarks, then the loop's.
    expect(items).toEqual(['The queue: remark 1', 'The queue: remark 3', 'The queue: remark 5', 'The queue: remark 7', 'The loop: remark 2']);
    expect(box.querySelector('.watch__more')!.textContent).toBe('and 2 more, on the board');
    expect(screen.getByTestId('watch-status').textContent).toContain('and the remarks on them listed here');
  });

  it('unagreed with no remarks: the check and Resume, nothing more', () => {
    const src = localSource({ events: building().events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'unagreed', built: 0, total: 3, check: 'make check' });
    render(<App source={src} />);
    expect(screen.queryByTestId('watch-remarks')).toBeNull();
  });

  it('unagreed and paused already: Resume posts only the resume', async () => {
    const b = building();
    b.must('owner', { type: 'build.pause', chapter: 'c1' });
    const src = localSource({ events: b.events });
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'unagreed', built: 0, total: 3, check: 'make check' });
    render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    });
    expect(posted(src, n).map((e) => e.type)).toEqual(['build.resume']);
  });

  it('says the owner can leave only while the build goes on by itself', async () => {
    const b = building();
    const src = localSource({ events: b.events });
    render(<App source={src} />);
    expect(screen.getByTestId('watch-leave')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    });
    expect(screen.queryByTestId('watch-leave')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await src.post({ type: 'part.state', part: 'queue', state: 'idea' });
    });
    expect(screen.getByTestId('watch').dataset.state).toBe('waiting');
    expect(screen.queryByTestId('watch-leave')).toBeNull();
    act(() => src.setBuild({ chapter: 'c1', title: 'One engine', state: 'stopped', built: 0, total: 3 }));
    expect(screen.queryByTestId('watch-leave')).toBeNull();
  });

  it('the tab’s title shows the progress', async () => {
    document.title = 'Keel board';
    const src = localSource({ events: building().events });
    const { unmount } = render(<App source={src} />);
    expect(document.title).toBe('Building 0/3 · One engine · Keel board');
    await act(async () => {
      await src.postAs('system', { type: 'part.state', part: 'door', state: 'building' } as never);
      await src.postAs('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } } as never);
    });
    expect(document.title).toBe('Building 1/3 · One engine · Keel board');
    unmount();
    expect(document.title).toBe('Keel board');
  });
});

/** The same board, built: every part on the track built by the system, so the chapter is built. */
function built() {
  const b = building();
  for (const part of ['door', 'queue', 'loop']) {
    b.must('system', { type: 'part.state', part, state: 'building' } as never);
    b.must('system', { type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } } as never);
  }
  return b;
}

const SHOW = 'http://127.0.0.1:4791/?key=k1';
const HOME = { branch: 'main', commit: 'abc1234', upstream: 'origin/main', sync: 'level' as const };

describe('trying what was built, from the panel', () => {
  it('a built chapter: "Try it" in the head, then "Approve: merge into main" in the body', () => {
    const src = localSource({ events: built().events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 4 } }, { c1: { kind: 'page', url: SHOW } }, HOME);
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('built');
    const tryIt = screen.getByTestId('watch-try');
    expect(tryIt.tagName).toBe('BUTTON');
    expect(tryIt.textContent).toBe('Try it');
    expect(tryIt.closest('.watch__head')).toBeTruthy();
    const approve = screen.getByTestId('approve-press');
    expect(approve.textContent).toBe('Approve: merge into main');
    expect(screen.getByTestId('approve').textContent).toContain('Approve merges board/one-engine into main on this machine. Pushing it is a second press.');
    // Try it comes first in the order of the page.
    expect(tryIt.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Try it is there when the panel is folded too, and opens the try room', () => {
    const src = localSource({ events: built().events });
    src.setWorks({ c1: { branch: 'board/one-engine' } }, { c1: { kind: 'page', url: SHOW } }, HOME);
    render(<App source={src} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fold the build away' }));
    fireEvent.click(screen.getByTestId('watch-try'));
    expect(screen.getByTestId('try-room').dataset.chapter).toBe('c1');
  });

  it('none while the chapter builds: Pause stays as it was', () => {
    const src = localSource({ events: building().events });
    src.setWorks({ c1: { branch: 'board/one-engine' } }, {}, HOME);
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('running');
    expect(screen.queryByTestId('watch-try')).toBeNull();
    expect(screen.queryByTestId('approve')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('Approve posts canvas.approve as the owner, and while the server works the panel says what it does', async () => {
    const src = localSource({ events: built().events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 4, behind: 2 } }, {}, HOME);
    render(<App source={src} />);
    expect(screen.getByTestId('approve').textContent).toContain('main has 2 commits this build does not: they are joined in first, and the checks run again.');
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('approve-press'));
    });
    expect(posted(src, n).map((e) => [e.type, (e as { canvas?: string }).canvas, e.by])).toEqual([['canvas.approve', 'c1', 'owner']]);
    act(() => src.setWorks({ c1: { branch: 'board/one-engine', ahead: 4, behind: 2, busy: 'joining' } }, {}, HOME));
    expect(screen.getByTestId('approve-busy').textContent).toBe('main has moved since this build began. Joining its new commits into board/one-engine and running the check again.');
    expect((screen.getByTestId('approve-press') as HTMLButtonElement).disabled).toBe(true);
    act(() => src.setWorks({ c1: { branch: 'board/one-engine', ahead: 4, busy: 'merging' } }, {}, HOME));
    expect(screen.getByTestId('approve-busy').textContent).toBe('Merging board/one-engine into main.');
  });

  it('merged: where it went and when, and Push when main is ahead of origin', async () => {
    const b = built();
    b.must('owner', { type: 'canvas.approve', canvas: 'c1' });
    // The server says the whole commit; the owner reads it short, as everywhere else.
    b.must('system', { type: 'canvas.merged', canvas: 'c1', commit: 'abc1234ffeeddccbbaa998877665544332211000', into: 'main' });
    const src = localSource({ events: b.events });
    src.setWorks({}, {}, { ...HOME, sync: 'ahead', ahead: 1 });
    src.answer = () => ({ ok: true, note: 'main is level with origin.' });
    render(<App source={src} />);
    expect(screen.getByTestId('merged-line').textContent).toMatch(/^Merged into main at abc1234 · \d+ Nov \d\d:\d\d$/);
    expect(screen.queryByTestId('watch-try')).toBeNull();
    expect(screen.queryByTestId('approve-press')).toBeNull();
    const push = screen.getByTestId('push');
    expect(push.textContent).toBe('Push main to origin');
    expect(screen.getByTestId('approve').textContent).toContain('main has 1 commit that origin does not have. A push cannot be taken back.');
    await act(async () => {
      fireEvent.click(push);
    });
    expect(src.asked).toEqual([{ route: 'push' }]);
    expect(screen.getByTestId('approve-said').textContent).toBe('Pushed. main is level with origin.');
  });

  it('merged and level with origin: no Push', () => {
    const b = built();
    b.must('owner', { type: 'canvas.approve', canvas: 'c1' });
    b.must('system', { type: 'canvas.merged', canvas: 'c1', commit: 'abc1234', into: 'main' });
    const src = localSource({ events: b.events });
    src.setWorks({}, {}, HOME);
    render(<App source={src} />);
    expect(screen.getByTestId('approve').dataset.state).toBe('merged');
    expect(screen.queryByTestId('push')).toBeNull();
  });

  it('main had changed the same lines: the panel says plainly to try it again and approve again', () => {
    const b = built();
    b.must('owner', { type: 'canvas.approve', canvas: 'c1' });
    b.must('system', {
      type: 'feed.add',
      chapter: 'c1',
      kind: 'problem',
      text: 'main had changed the same places. The builder joined them and the check passed. Try it again, then approve it again.',
    } as never);
    const src = localSource({ events: b.events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 5 } }, {}, HOME);
    render(<App source={src} />);
    expect(screen.getByTestId('approve').dataset.state).toBe('again');
    expect(screen.getByTestId('approve-again').textContent).toBe(
      'Not merged. main had changed the same places. The builder joined them and the check passed. Try it again, then approve it again.',
    );
    expect(screen.getByTestId('approve-press').textContent).toBe('Approve: merge into main');
  });

  it('opens nothing by itself', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const src = localSource({ events: built().events });
    src.setWorks({ c1: { branch: 'board/one-engine' } }, { c1: { kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' } }, HOME);
    render(<App source={src} />);
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
    expect(src.asked).toEqual([]);
  });

  it('a build not agreed here shows every command it would run before Resume', () => {
    const b = solid();
    b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door', 'queue', 'loop'], blueprint: 'bp', check: 'make check' });
    const src = localSource({ events: b.events });
    // The same chapter, as a log from elsewhere could hold it: with a setup and a show.
    src.state = { ...src.state, chapters: { ...src.state.chapters, c1: { ...src.state.chapters.c1!, setup: 'npm ci', show: { kind: 'app', run: 'npm start' } } } };
    src.setBuild({ chapter: 'c1', title: 'One engine', state: 'unagreed', built: 0, total: 3, check: 'make check' });
    render(<App source={src} />);
    expect([...screen.getByTestId('watch-agree').querySelectorAll('code')].map((c) => c.textContent)).toEqual(['make check', 'npm ci', 'npm start']);
    expect(screen.getByTestId('watch-commands').textContent).toContain('and, when you press Try it, this command to run the app:');
  });
});

describe('the desktop notification', () => {
  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static sent: Array<{ title: string; body?: string }> = [];
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    constructor(title: string, opts?: { body?: string }) {
      FakeNotification.sent.push({ title, ...(opts?.body ? { body: opts.body } : {}) });
    }
  }
  let hidden = false;
  beforeEach(() => {
    FakeNotification.sent = [];
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission.mockClear();
    hidden = false;
    forgetTold();
    vi.stubGlobal('Notification', FakeNotification);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  });

  it('is asked for when the owner presses "Build this"', async () => {
    FakeNotification.permission = 'default';
    const src = localSource({ events: solid().events });
    render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build this' }));
    });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(posted(src, n).map((e) => e.type)).toEqual(['build.start']);
  });

  it('is sent only while the tab is hidden: a problem, a choice, a reopened part, the chapter built', async () => {
    const src = localSource({ events: building().events });
    render(<App source={src} />);
    await act(async () => {
      await src.postAs('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'Seen while you look.' } as never);
    });
    expect(FakeNotification.sent).toEqual([]);
    hidden = true;
    await act(async () => {
      await src.postAs('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The check failed.' } as never);
      await src.postAs('system', { type: 'feed.add', chapter: 'c1', text: 'Only an update.' } as never);
      await src.postAs('agent', {
        type: 'item.add',
        chapter: 'c1',
        item: { id: 'ch1', kind: 'picture', from: ['bp'], picture: { kind: 'choice', title: 'One wake-up a turn', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], chosen: 'a' } },
      } as never);
    });
    await act(async () => {
      await src.post({ type: 'part.state', part: 'loop', state: 'idea' });
    });
    // Three in a minute is the most the board sends: the build ends a minute later.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    await act(async () => {
      await src.post({ type: 'part.state', part: 'loop', state: 'solid' });
      for (const part of ['door', 'queue', 'loop']) {
        await src.postAs('system', { type: 'part.state', part, state: 'building' } as never);
        await src.postAs('system', { type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } } as never);
      }
    });
    expect(FakeNotification.sent.map((x) => x.body)).toEqual([
      'A problem in "One engine". The board says what.',
      'The agent made a choice in "One engine". It is yours to change.',
      'The build of "One engine" waits for you.',
      '"One engine" is built.',
    ]);
    // A short plain line: the feed's own words stay on the board.
    expect(FakeNotification.sent.every((x) => x.title === 'Keel' && x.body!.length <= 80 && !x.body!.includes('The check failed'))).toBe(true);
    vi.useRealTimers();
  });
});

describe('the board pill follows the chapter in view', () => {
  it('names the chapter whose items fill the screen', () => {
    const b = solid();
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
    b.must('owner', note('m2', [6000, 0, 320, 100], {}, 'c2'));
    // The newest open thing is in c2, but the view shows c1.
    render(<App source={localSource({ events: b.events })} show={['m1', 'bp']} />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect(screen.getByTestId('chapter-state').textContent).toBe('solid');
  });

  it('puts a quiet label at each chapter’s first item', () => {
    const b = solid();
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
    b.must('owner', note('m2', [6000, 0, 320, 100], {}, 'c2'));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const labels = [...container.querySelectorAll<HTMLElement>('[data-chapter-label]')];
    expect(labels.map((l) => [l.dataset.chapterLabel, l.textContent, l.style.left])).toEqual([
      ['c1', 'One enginesolid', '0px'],
      ['c2', 'The next ideaidea', '6000px'],
    ]);
  });
});

describe('the board after the journey', () => {
  it('the hint for an empty board goes once anything is on it', async () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    expect(container.querySelector('.hint')).toBeTruthy();
    await act(async () => {
      await src.post({ type: 'chapter.open', chapter: 'c1', title: 'One' });
      await src.post({ type: 'item.add', chapter: 'c1', item: { id: 'm1', kind: 'note', box: [0, 0, 320, 80], text: 'one' } });
    });
    expect(container.querySelector('.hint')).toBeNull();
  });

  it('the tools belong to the board: the Story shows none, and their keys do nothing there', () => {
    const { container } = render(<App source={localSource({ events: building().events })} mode="story" />);
    expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull();
    fireEvent.keyDown(window, { key: 'p' });
    expect(screen.getByTestId('story')).toBeTruthy();
    expect(container.querySelector('.app')!.getAttribute('data-tool')).toBe('select');
  });

  it('a presence note that is only a chapter’s title shows the state instead', () => {
    const src = localSource({ events: building().events, presence: { state: 'building', note: '"One engine"' } });
    render(<App source={src} />);
    expect(screen.getByTestId('presence').textContent).toBe('The agent: building');
  });

  it('comes back where the owner was on a reload, and the pill follows that place', () => {
    const b = building();
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
    b.must('owner', note('m2', [6000, 0, 320, 100], {}, 'c2'));
    localStorage.clear();
    // With nothing kept, the first view is the chapter in work: the new idea, not the old build.
    const first = render(<App source={localSource({ events: b.events })} remember />);
    // One canvas, two ideas on it: the pill names the canvas, then the idea in view.
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine · The next idea');
    expect(screen.queryByTestId('watch')).toBeNull();
    first.unmount();
    // Kept: the camera on the old chapter. A reload comes back there.
    localStorage.setItem('keel.view.demo', JSON.stringify({ camera: { x: 100, y: 100, z: 1 }, mode: 'board' }));
    const { container } = render(<App source={localSource({ events: b.events })} remember />);
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).toBe('translate(100px, 100px) scale(1)');
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    localStorage.clear();
  });
});

describe('the Story', () => {
  it('the switch opens it and goes back; a press on a chapter goes to it on the board', async () => {
    const b = building();
    b.must('system', { type: 'moment.add', chapter: 'c1', title: 'The blueprint', items: ['bp'] });
    render(<App source={localSource({ events: b.events })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    const story = screen.getByTestId('story');
    expect(screen.getByTestId('board-name').textContent).toBe('demo · the story');
    expect(screen.queryByTestId('watch')).toBeNull();
    expect(story.querySelector('[data-moment]')!.textContent).toContain('1 · The blueprint');
    expect(story.querySelector('[data-canvas="c1"] [data-chapter="c1"]')!.textContent).toContain('building part 1 of 3');
    expect(screen.getByTestId('progress-chapters').textContent).toBe('0 of 1 idea built');
    await act(async () => {
      fireEvent.click(story.querySelector('[data-moment]')!);
    });
    expect(screen.queryByTestId('story')).toBeNull();
    expect(screen.getByTestId('watch')).toBeTruthy();
  });

  it('opens first when the checkpoint says so, and Esc goes back to the board', () => {
    render(<App source={localSource({ events: building().events })} mode="story" />);
    expect(screen.getByTestId('story')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('story')).toBeNull();
  });

  it('Start a new canvas: posts canvas.open, and the board goes to it, blank, ready for a first note', async () => {
    const src = localSource({ events: building().events });
    const { container } = render(<App source={src} mode="story" />);
    const n = src.events.length;
    expect(screen.getByTestId('new-canvas').textContent).toContain('Each canvas gets a branch of its own');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a new canvas' }));
    });
    expect(posted(src, n).map((e) => [e.type, (e as { canvas?: string }).canvas, e.by])).toEqual([['canvas.open', 'canvas-2', 'owner']]);
    expect(screen.queryByTestId('story')).toBeNull();
    expect(screen.getByTestId('canvas-name').textContent).toBe(' · Untitled canvas');
    // Nothing of the other canvas is on this one: no item, no label, no watch panel.
    expect(container.querySelectorAll('[data-item]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-chapter-label]')).toHaveLength(0);
    expect(screen.queryByTestId('watch')).toBeNull();
    expect(screen.getByTestId('item-count').dataset.n).toBe('0');
    expect(screen.getByTestId('hint').textContent).toContain('Write it, draw it');
  });

});

describe('what the server says about the build', () => {
  class Sock implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
    receive(msg: ServerMessage) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }

  it('comes on the websocket, and the panel says it: the board’s info is asked once, on init, never polled', async () => {
    const sock = new Sock();
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const src = serverSource({
      url: 'ws://127.0.0.1:1/ws',
      http: { base: 'http://127.0.0.1:1', token: 't' },
      socket: () => sock,
      fetch: fetch as unknown as typeof globalThis.fetch,
      probe: async () => 'ok',
    });
    sock.readyState = 1;
    const b = building();
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The builder failed: no disk.' });
    const presence = { state: 'building' as const, since: '2026-11-17T13:00:00Z' };
    act(() => sock.receive({ t: 'init', name: 'demo', role: 'owner', events: b.events, presence, build: { chapter: 'c1', title: 'One engine', state: 'queued', built: 0, total: 3 } }));
    render(<App source={src} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('queued');
    expect(screen.getByTestId('watch-status').textContent).toContain('Waiting its turn');

    act(() => sock.receive({ t: 'build', build: { chapter: 'c1', title: 'One engine', state: 'running', built: 0, total: 3, part: 'The door' } }));
    expect(screen.getByTestId('watch').dataset.state).toBe('running');
    expect(screen.getByTestId('watch-status').textContent).toBe('Building The door now.');

    act(() => sock.receive({ t: 'build', build: { chapter: 'c1', title: 'One engine', state: 'stopped', built: 0, total: 3 } }));
    expect(screen.getByTestId('watch').dataset.state).toBe('stopped');
    expect(screen.getByRole('button', { name: 'See why in the feed' })).toBeTruthy();

    // No build goes any more: the board's own state says what it can.
    act(() => sock.receive({ t: 'build', build: null }));
    expect(src.build).toBeUndefined();
    expect(screen.getByTestId('watch').dataset.state).toBe('running');

    // Time passes, events come: the page never asks the board's info for the build.
    await act(async () => {
      sock.receive({ t: 'event', event: { type: 'build.pause', chapter: 'c1', by: 'owner', id: `e${b.events.length + 1}`, at: '2026-11-17T14:00:00Z' } as BoardEvent });
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(screen.getByTestId('watch').dataset.state).toBe('paused');
    // Once, on init, for what came from outside: never for the build, never again with time.
    expect(fetch).toHaveBeenCalledTimes(1);
    src.close();
  });
});
