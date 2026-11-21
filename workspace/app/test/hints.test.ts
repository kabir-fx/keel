import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { HintFacts } from '../src/hints';
import { blueprintWaits, buildWaits, emptyLine, HINTS, hintFor, TOOL_LINES } from '../src/hints';
import type { LocalSource } from '../src/source';
import { localSource } from '../src/source';
import { CH, Board, note, openBoard, placeAt, text } from './helpers';
import { PEN_PAUSE } from '../src/input/constants';
import { Keyboard, Pointer, frame, resetInput, wheel } from './pointer';

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A board where nothing calls for a word: the Select tool in hand, the agent listening, things on the board. */
const QUIET: HintFacts = { penGo: false, field: undefined, agentWaits: false, questions: 0, lassoed: 0, toBuild: false, toTry: false, tool: 'select', empty: false, away: false };

const facts = (over: Partial<HintFacts>): HintFacts => ({ ...QUIET, ...over });

const ANSWER_ONE = 'Answer the question: press N, click beside it, and type. Or hold T and say it.';
const PICK = 'Pick what to build: press L and draw a loop round the pictures you want.';
const solidifyLine = (n: number) => `Press Solidify (Shift+S) to make a blueprint from the ${n} you picked.`;

describe('the hint line: one table, the first rule that matches wins', () => {
  it('each state gives its line', () => {
    const table: Array<[string, Partial<HintFacts>, string]> = [
      ['a go of the pen is open', { penGo: true }, 'Keep drawing. It becomes one mark when you rest the pen. Cmd+Z takes back the last stroke.'],
      ['a label is open', { field: 'label' }, 'Type a few words. Enter keeps them.'],
      ['a note is open', { field: 'note' }, 'Type the note. Enter keeps it, Shift+Enter starts a new line.'],
      ['the agent waits on one question', { agentWaits: true, questions: 1 }, ANSWER_ONE],
      ['the agent waits on three questions', { agentWaits: true, questions: 3 }, 'Answer the 3 questions: press N, click beside one, and type. Or hold T and say it.'],
      ['the agent waits, nothing lassoed', { agentWaits: true }, PICK],
      ['a lasso holds one thing', { lassoed: 1 }, solidifyLine(1)],
      ['a lasso holds three things', { lassoed: 3 }, solidifyLine(3)],
      ['a blueprint waits to be built', { toBuild: true }, 'Read the blueprint, then press Build this.'],
      ['a build waits to be tried and approved', { toTry: true }, 'Press Try it to run what was built. When it does what you asked, approve it.'],
      ['the pen in hand', { tool: 'pen' }, 'Draw on a picture to mark it. Its buttons still work.'],
      ['the board is empty', { empty: true }, emptyLine(false)],
      ['the board is empty and the agent away', { empty: true, away: true }, 'Write it, draw it, drop something in, or say it. The agent is away: it reads what you add when it is back.'],
    ];
    for (const [when, over, line] of table) expect([when, hintFor(facts(over), true)]).toEqual([when, line]);
  });

  it('every tool but Select has its line, and Select says nothing', () => {
    for (const tool of ['pan', 'pen', 'box', 'arrow', 'note', 'pin', 'lasso', 'eraser'] as const) {
      const line = hintFor(facts({ tool }), true);
      expect(line).toBe(TOOL_LINES[tool]);
      expect(line).toMatch(/^[A-Z][a-z]+ /);
    }
    expect(hintFor(facts({ tool: 'select' }), true)).toBeUndefined();
  });

  it('a state the list does not know gives none', () => {
    expect(hintFor(QUIET, true)).toBeUndefined();
    // Things on the board with the agent away say nothing either: away matters only on an empty board.
    expect(hintFor(facts({ away: true }), true)).toBeUndefined();
    // Questions are open, and the agent does not wait on them: nothing is asked of the owner yet.
    expect(hintFor(facts({ questions: 2 }), true)).toBeUndefined();
  });

  it('the first match wins, in the order of the table', () => {
    const all = facts({ penGo: true, field: 'label', agentWaits: true, questions: 2, lassoed: 2, toBuild: true, tool: 'pen', empty: true });
    const order: Array<[keyof HintFacts, HintFacts[keyof HintFacts]]> = [
      ['penGo', false],
      ['field', 'note'],
      ['field', undefined],
      ['questions', 0],
      ['agentWaits', false],
      ['lassoed', 0],
      ['toBuild', false],
      ['tool', 'select'],
      ['empty', false],
    ];
    const lines: Array<string | undefined> = [hintFor(all, true)];
    let now: HintFacts = all;
    for (const [key, value] of order) {
      now = { ...now, [key]: value };
      lines.push(hintFor(now, true));
    }
    expect(lines).toEqual([
      'Keep drawing. It becomes one mark when you rest the pen. Cmd+Z takes back the last stroke.',
      'Type a few words. Enter keeps them.',
      'Type the note. Enter keeps it, Shift+Enter starts a new line.',
      'Answer the 2 questions: press N, click beside one, and type. Or hold T and say it.',
      // No question waits now, and the lasso holds things: the agent waiting does not ask for a pick.
      solidifyLine(2),
      solidifyLine(2),
      'Read the blueprint, then press Build this.',
      'Draw on a picture to mark it. Its buttons still work.',
      emptyLine(false),
      undefined,
    ]);
  });

  it('every line starts with a verb and is one line', () => {
    const every = facts({ penGo: true, tool: 'pen' });
    for (const rule of HINTS) {
      const line = rule.says({ ...every, questions: 2, lassoed: 2 }, () => 'K');
      expect(line, rule.when).toMatch(/^(Keep|Type|Answer|Pick|Press|Read|Draw|Drag|Click|Write) /);
      expect(line, rule.when).not.toContain('\n');
    }
  });

  it('names the key as the keyboard writes it: Cmd on a Mac, Ctrl elsewhere', () => {
    expect(hintFor(facts({ penGo: true }), true)).toContain('Cmd+Z takes back');
    expect(hintFor(facts({ penGo: true }), false)).toContain('Ctrl+Z takes back');
    expect(hintFor(facts({ penGo: true }), false)).not.toContain('Cmd');
  });
});

/** The line the board shows, or none. */
const shownLine = () => screen.queryByTestId('hint')?.textContent ?? null;

describe('a blueprint that waits for "Build this"', () => {
  function withBlueprint(state: 'solid' | 'building') {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 400, 200], path: [0, 0, 400, 0, 400, 200], targets: [{ item: 'm1' }] } });
    b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'core', name: 'Core' } }, { op: 'part.set', part: { id: 'sched', name: 'The scheduler', lane: 'core' } }] });
    b.must('owner', { type: 'solidify', chapter: CH, picks: ['m1'], parts: ['sched'], lasso: 'l1' });
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'bp', kind: 'picture', answers: ['m1'], picture: { kind: 'blueprint', title: 'The plan', picks: [{ text: 'one engine', from: { item: 'm1' } }], proof: ['it runs'], parts: ['sched'], check: 'make check' } } });
    if (state === 'building') b.must('owner', { type: 'build.start', chapter: CH, track: ['sched'], blueprint: 'bp', check: 'make check' });
    return b;
  }

  it('is one in a solid chapter in view; none once it builds, none in another chapter', () => {
    expect(blueprintWaits(withBlueprint('solid').state, CH)).toBe(true);
    expect(blueprintWaits(withBlueprint('building').state, CH)).toBe(false);
    expect(blueprintWaits(withBlueprint('solid').state, 'another')).toBe(false);
    expect(blueprintWaits(withBlueprint('solid').state, undefined)).toBe(false);
  });

  it('on the board, the line says to read it and press Build this; once it builds, it says nothing', async () => {
    const src = localSource({ events: withBlueprint('solid').events });
    render(createElement(App, { source: src }));
    expect(shownLine()).toBe('Read the blueprint, then press Build this.');
    await act(async () => {
      await src.post({ type: 'build.start', chapter: CH, track: ['sched'], blueprint: 'bp', check: 'make check' });
    });
    expect(shownLine()).toBeNull();
  });

  it('a solid chapter with no blueprint yet waits for none, whatever other pictures it holds', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 400, 200], path: [0, 0, 400, 0, 400, 200], targets: [{ item: 'm1' }] } });
    b.must('owner', { type: 'solidify', chapter: CH, picks: ['m1'], parts: [], lasso: 'l1' });
    expect(b.state.chapters[CH]?.state).toBe('solid');
    expect(blueprintWaits(b.state, CH)).toBe(false);
  });

  it('a blueprint waits only in its own chapter, not in another solid one', () => {
    const b = withBlueprint('solid');
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
    b.must('owner', note('n2', [2000, 0, 320, 100], {}, 'c2'));
    b.must('owner', { type: 'item.add', chapter: 'c2', item: { id: 'l2', kind: 'lasso', box: [1990, -10, 340, 120], path: [1990, -10, 2330, -10, 2330, 110], targets: [{ item: 'n2' }] } });
    b.must('owner', { type: 'solidify', chapter: 'c2', picks: ['n2'], parts: [], lasso: 'l2' });
    expect(b.state.chapters.c2?.state).toBe('solid');
    expect(blueprintWaits(b.state, 'c2')).toBe(false);
    expect(blueprintWaits(b.state, CH)).toBe(true);
  });
});

describe('a build that waits to be tried', () => {
  it('on the board, the line says Try it, then approve; once merged, it says nothing', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 400, 200], path: [0, 0, 400, 0, 400, 200], targets: [{ item: 'm1' }] } });
    b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'core', name: 'Core' } }, { op: 'part.set', part: { id: 'sched', name: 'The scheduler', lane: 'core' } }] });
    b.must('owner', { type: 'solidify', chapter: CH, picks: ['m1'], parts: ['sched'], lasso: 'l1' });
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'bp', kind: 'picture', answers: ['m1'], picture: { kind: 'blueprint', title: 'The plan', picks: [{ text: 'one engine' }], proof: ['it runs'], parts: ['sched'], check: 'make check' } } });
    b.must('owner', { type: 'build.start', chapter: CH, track: ['sched'], blueprint: 'bp', check: 'make check' });
    b.must('system', { type: 'part.state', part: 'sched', state: 'building' });
    b.must('system', { type: 'part.state', part: 'sched', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
    expect(buildWaits(b.state, CH)).toBe(true);
    const src = localSource({ events: b.events });
    render(createElement(App, { source: src }));
    expect(shownLine()).toBe('Press Try it to run what was built. When it does what you asked, approve it.');
    await act(async () => {
      await src.post({ type: 'canvas.approve', canvas: CH });
      await src.postAs('system', { type: 'canvas.merged', canvas: CH, commit: 'abc1234', into: 'main' });
    });
    expect(shownLine()).toBeNull();
    expect(buildWaits(src.state, CH)).toBe(false);
  });
});

describe('the hint line on the board', () => {
  it('the agent waits on a question: the line says how to answer, and moves on once a note is put on it', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('agent', text('a1', { answers: ['m1'], picture: { kind: 'text', title: 'My read', questions: ['Is one engine enough?'] } }));
    b.must('owner', placeAt('a1', [400, 0, 380, 200]));
    const src = localSource({ events: b.events, presence: { state: 'waiting' } });
    render(createElement(App, { source: src }));
    expect(shownLine()).toBe(ANSWER_ONE);
    await act(async () => {
      await src.post({ type: 'item.add', chapter: CH, item: { id: 'm2', kind: 'note', box: [800, 0, 320, 80], text: 'Yes, one is enough', on: { item: 'a1', sub: 'q:1' } } });
    });
    expect(shownLine()).toBe(PICK);
  });

  it('the line hears the agent for itself: it changes when the agent starts to wait', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const src = localSource({ events: b.events });
    render(createElement(App, { source: src }));
    expect(shownLine()).toBeNull();
    act(() => src.setPresence({ state: 'waiting' }));
    expect(shownLine()).toBe(PICK);
  });

  it('a lasso holds three pictures: the line says Solidify, with the count', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 300, 320, 100]));
    for (const [id, x] of [['a1', 0], ['a2', 420], ['a3', 840]] as const) {
      b.must('agent', text(id, { answers: ['m1'] }));
      b.must('owner', placeAt(id, [x, 0, 380, 200]));
    }
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [-20, -20, 1260, 240], path: [-20, -20, 1240, -20, 1240, 220], targets: [{ item: 'a1' }, { item: 'a2' }, { item: 'a3' }] } });
    render(createElement(App, { source: localSource({ events: b.events, presence: { state: 'waiting' } }) }));
    expect(shownLine()).toBe(solidifyLine(3));
  });

  it('the pen: its line in hand, and while its go is open the key Undo is, as this keyboard writes it', async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    render(createElement(App, { source: localSource({ events: b.events }) }));
    expect(shownLine()).toBeNull();
    Keyboard.press('p');
    expect(shownLine()).toBe(TOOL_LINES.pen);
    const mouse = new Pointer();
    mouse.down([500, 400]);
    await frame();
    mouse.move([560, 430]);
    await frame();
    mouse.move([620, 470]);
    await frame();
    mouse.up();
    expect(shownLine()).toBe('Keep drawing. It becomes one mark when you rest the pen. Ctrl+Z takes back the last stroke.');
    await act(() => vi.advanceTimersByTimeAsync(PEN_PAUSE));
    expect(shownLine()).toBe(TOOL_LINES.pen);
    // A go that Undo empties is closed: the line hears it from the pen, with nothing else drawn again.
    mouse.down([500, 400]);
    await frame();
    mouse.move([620, 470]);
    await frame();
    mouse.up();
    expect(shownLine()).toContain('Keep drawing.');
    Keyboard.withModifierKeys({ ctrl: true }, () => Keyboard.press('z'));
    expect(shownLine()).toBe(TOOL_LINES.pen);
    Keyboard.press('Escape');
    expect(shownLine()).toBeNull();
  });

  it('a note being written, and the words of a box just drawn, each say how to keep them', async () => {
    vi.useFakeTimers();
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    render(createElement(App, { source: localSource({ events: b.events }) }));
    Keyboard.press('n');
    new Pointer().click([700, 500]);
    expect(screen.getByRole('textbox', { name: 'Your note' })).toBeTruthy();
    expect(shownLine()).toBe('Type the note. Enter keeps it, Shift+Enter starts a new line.');
    Keyboard.press('Escape');
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([600, 300]);
    await frame();
    mouse.move([700, 380]);
    await frame();
    mouse.up();
    expect(screen.getByRole('textbox', { name: 'A few words' })).toBeTruthy();
    expect(shownLine()).toBe('Type a few words. Enter keeps them.');
  });

  it('gives its place to the note or the label being typed where the two would cross, and has it back when they are clear', async () => {
    vi.useFakeTimers();
    // A test page lays nothing out: where the line and the field are is said here. The field starts across the line.
    const HINT = [500, 786, 440, 18];
    let field = [600, 780, 320, 59];
    /** How many times the line's place was read from the page. */
    let reads = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('hint')) reads += 1;
      const [left, top, width, height] = this.classList.contains('hint') ? HINT : this.matches('.item--editor, .label-editor') ? field : [0, 0, 0, 0];
      return { left: left!, top: top!, width: width!, height: height!, right: left! + width!, bottom: top! + height!, x: left!, y: top!, toJSON: () => ({}) };
    });
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const { container } = render(createElement(App, { source: localSource({ events: b.events }) }));
    const under = () => container.querySelector('.hint-line')!.hasAttribute('data-under-field');
    Keyboard.press('n');
    // No field is open yet: the line is the tool's.
    expect(under()).toBe(false);
    new Pointer().click([700, 500]);
    expect(screen.getByRole('textbox', { name: 'Your note' })).toBeTruthy();
    expect(shownLine()).toBe('Type the note. Enter keeps it, Shift+Enter starts a new line.');
    expect(under()).toBe(true);
    // The board moves under the pointer and takes the note clear of the line, then back across it.
    // The page is not read under the wheel: once, when the frame's moves are in. (The first move
    // after a render also measures the room the panels leave, the line among them: let that pass.)
    wheel(screen.getByTestId('board'), { dy: 1 });
    await frame();
    expect(under()).toBe(true);
    field = [600, 400, 320, 59];
    const before = reads;
    for (let i = 0; i < 3; i++) wheel(screen.getByTestId('board'), { dy: 40 });
    expect(reads).toBe(before);
    expect(under()).toBe(true);
    await frame();
    expect(reads).toBe(before + 1);
    expect(under()).toBe(false);
    field = [600, 780, 320, 59];
    wheel(screen.getByTestId('board'), { dy: -40 });
    await frame();
    expect(under()).toBe(true);
    // The field closes: the line has its place back.
    Keyboard.press('Escape');
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
    expect(under()).toBe(false);
    // The words of a box, typed across the line, the same.
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([600, 300]);
    await frame();
    mouse.move([700, 380]);
    await frame();
    mouse.up();
    expect(screen.getByRole('textbox', { name: 'A few words' })).toBeTruthy();
    expect(under()).toBe(true);
  });

  it('looks again when the window changes size: the line stands at the window’s foot and goes with it', async () => {
    vi.useFakeTimers();
    // A test page lays nothing out: where the line and the field are is said here. The field starts across the line.
    let hint = [500, 786, 440, 18];
    const FIELD = [600, 780, 320, 59];
    let reads = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('hint')) reads += 1;
      const [left, top, width, height] = this.classList.contains('hint') ? hint : this.matches('.item--editor, .label-editor') ? FIELD : [0, 0, 0, 0];
      return { left: left!, top: top!, width: width!, height: height!, right: left! + width!, bottom: top! + height!, x: left!, y: top!, toJSON: () => ({}) };
    });
    const listens = { on: vi.spyOn(window, 'addEventListener'), off: vi.spyOn(window, 'removeEventListener') };
    const toResize = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => type === 'resize').length;
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const { container } = render(createElement(App, { source: localSource({ events: b.events }) }));
    const under = () => container.querySelector('.hint-line')!.hasAttribute('data-under-field');
    const resize = () => act(() => void window.dispatchEvent(new Event('resize')));
    const [on0, off0] = [toResize(listens.on), toResize(listens.off)];
    Keyboard.press('n');
    new Pointer().click([700, 500]);
    expect(screen.getByRole('textbox', { name: 'Your note' })).toBeTruthy();
    expect(under()).toBe(true);
    // The window is made taller: the line goes down with its foot, clear of the note. A window dragged
    // to a new size tells of many sizes in a frame: the page is read for them once, when the frame comes.
    hint = [500, 1186, 440, 18];
    resize();
    await frame();
    const read = reads;
    resize();
    resize();
    resize();
    expect(under()).toBe(false);
    await frame();
    expect(reads - read).toBeLessThanOrEqual(2);
    // And shorter again: the line comes back up under the note.
    hint = [500, 786, 440, 18];
    resize();
    expect(under()).toBe(false);
    await frame();
    expect(under()).toBe(true);
    // The field closes: the line has its place back, and listens to the window no more.
    Keyboard.press('Escape');
    expect(under()).toBe(false);
    expect(toResize(listens.on) - on0).toBeGreaterThan(0);
    expect(toResize(listens.off) - off0).toBe(toResize(listens.on) - on0);
  });

  it('a board that is still connecting is not yet empty: it says nothing', () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    const connecting = Object.assign(Object.create(localSource({ events: b.events })) as LocalSource, { connection: 'connecting' as const });
    render(createElement(App, { source: connecting }));
    expect(screen.queryByTestId('hint')).toBeNull();
  });

  it('says today’s words on an empty board, and only to the owner', () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    render(createElement(App, { source: localSource({ events: b.events }) }));
    expect(shownLine()).toBe(emptyLine(false));
    cleanup();
    render(createElement(App, { source: localSource({ events: b.events, presence: { state: 'away' } }) }));
    expect(shownLine()).toBe(emptyLine(true));
    cleanup();
    render(createElement(App, { source: localSource({ events: b.events, role: 'agent' }) }));
    expect(screen.queryByTestId('hint')).toBeNull();
  });

  it('is not shown in the Story', () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    render(createElement(App, { source: localSource({ events: b.events }), mode: 'story' }));
    expect(screen.queryByTestId('hint')).toBeNull();
  });

  it('is a panel at the bottom only while it says something, and never takes a press', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const { container } = render(createElement(App, { source: localSource({ events: b.events }) }));
    expect(container.querySelector('.hint-line [data-viewport-ui]')).toBeNull();
    Keyboard.press('p');
    expect(screen.getByTestId('hint').dataset.viewportUi).toBe('bottom');
  });
});
