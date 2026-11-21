import type { Box, Id } from '@keel/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cue } from '../src/arrival/cues';
import { cursorAt, planArrival } from '../src/arrival/plan';
import type { Animate, ArrivalStage } from '../src/arrival/player';
import { PLAYS, WAITS } from '../src/arrival/attributes';
import { ArrivalPlayer, motionsOf } from '../src/arrival/player';
import { readPicture } from '../src/arrival/read';
import { FrameLoop, ManualClock } from '../src/frame';
import type { Point } from '../src/motion/path';
import { ARRIVAL_GUESS_MS, BAND_OUT_MS, GATE_MAX_MS, HAND_STAGGER_MS, HANDS_MAX, LAG_MAX_MS, RATE_MAX, REST_PX, STILL_AFTER_MS } from '../src/motion/timing';

/**
 * The player, on a page built by hand, with a stand-in for `element.animate` that writes down
 * what it is asked, a stand-in cursor store that writes down how its cursors are led, and frames
 * stepped by hand on a manual clock.
 */

/** One animation the player asked for: its element, keyframes and timing, and what became of it. */
interface Asked {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: Animation & { cancelled: boolean };
}

function fakeAnimate(asked: Asked[]): Animate {
  return (el, keyframes, options) => {
    const animation = {
      playState: 'running' as AnimationPlayState,
      currentTime: 0 as CSSNumberish | null,
      cancelled: false,
      pause: () => {
        animation.playState = 'paused';
      },
      cancel: () => {
        animation.playState = 'idle';
        animation.currentTime = null;
        animation.cancelled = true;
      },
    };
    asked.push({ el, keyframes, options, animation: animation as unknown as Asked['animation'] });
    return animation as unknown as Animation;
  };
}

/** A picture on the page: a card with a head and two blocks, and the arrow into it. */
function picture(id: Id, x: number): { el: HTMLElement; arrow: SVGPathElement; box: Box } {
  const el = document.createElement('div');
  el.dataset.item = id;
  el.innerHTML = `<article data-build="frame" style="background-color: rgb(255, 250, 240); border-radius: 10px"><h3 data-build="head">${id}</h3><p data-build="block">one</p><p data-build="block">two</p></article>`;
  document.body.append(el);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', `M ${x - 70} 50 L ${x - 6} 50`);
  svg.append(arrow);
  document.body.append(svg);
  return { el, arrow, box: [x, 0, 380, 152] };
}

/** One cursor as the stand-in store has it: where it is, and every lead it was given. */
interface Hand {
  id: number;
  at: Point | undefined;
  leads: Array<(() => Point) | null>;
}

/** A stand-in for the cursor store: the agent's own cursor is hand 0, split ones follow. */
function fakeCursor() {
  const hands: Hand[] = [{ id: 0, at: [332, 60], leads: [] }];
  const calls: Array<{ call: 'travelTo' | 'split' | 'merge'; at?: Point; n?: number }> = [];
  // Led, a cursor is where its lead says on every frame, as the store draws it.
  const leadOf = (h: Hand) => ({
    at: () => h.leads[h.leads.length - 1]?.() ?? h.at,
    lead: (to: (() => Point) | null) => {
      if (!to) h.at = h.leads[h.leads.length - 1]?.() ?? h.at;
      h.leads.push(to);
      if (to) h.at = to();
    },
  });
  const own = hands[0]!;
  const cursor = {
    ...leadOf(own),
    travelTo: (p: Point) => {
      calls.push({ call: 'travelTo', at: p });
      own.at = p;
    },
    split: (n: number) => {
      calls.push({ call: 'split', n });
      return Array.from({ length: n }, () => {
        const h: Hand = { id: hands.length, at: cursor.at(), leads: [] };
        hands.push(h);
        return leadOf(h);
      });
    },
    merge: (p: Point) => {
      calls.push({ call: 'merge', at: p });
      for (const h of hands.splice(1)) h.at = undefined;
      own.at = p;
    },
  };
  /** Whether a hand is led now: its last lead was not a letting go. */
  const led = (h: Hand) => h.leads.length > 0 && h.leads[h.leads.length - 1] !== null;
  return { cursor, hands, calls, own, led };
}

function setup(ids: readonly Id[] = ['a1', 'a2', 'a3'], loop?: FrameLoop) {
  const clock = new ManualClock();
  const frames = loop ?? new FrameLoop(clock, clock.now);
  const asked: Asked[] = [];
  const pictures = new Map(ids.map((id, i) => [id, picture(id, 400 + i * 500)]));
  const { cursor, hands, calls, own, led } = fakeCursor();
  const ended: Id[] = [];
  let settled = true;
  const stage: ArrivalStage = {
    item: (id) => pictures.get(id) && { el: pictures.get(id)!.el, box: pictures.get(id)!.box },
    arrow: (id) => pictures.get(id)?.arrow,
    chip: () => undefined,
    boxOf: () => [0, 0, 0, 0],
    zoom: () => 1,
    drawn: () => 1,
    settled: () => settled,
    entry: () => undefined,
  };
  const player = new ArrivalPlayer({ frames, cursor, stage, animate: fakeAnimate(asked), ended: (id) => ended.push(id) });
  /** Step one frame of 1/60 s. */
  const step = () => clock.advance(1000 / 60);
  /** Step frames until `ms` have passed. */
  const run = (ms: number) => {
    const until = clock.now() + ms;
    while (clock.now() < until) step();
  };
  /** Every attribute and band the player sets, wherever it is on the page. */
  const marks = () => document.querySelectorAll(`[${PLAYS}], [${WAITS}], .arrival-band`).length;
  /** The ids that play now. */
  const playing = () => player.films().map((f) => f.cue.id);
  const moveCamera = (moving: boolean) => {
    settled = !moving;
  };
  return { clock, frames, asked, pictures, hands, calls, own, led, cursor, ended, stage, player, step, run, marks, playing, moveCamera };
}

const placed = (id: Id): Cue => ({ kind: 'placed', id });
const wave = (...ids: Id[]): Cue[] => ids.map(placed);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the player', () => {
  it('asks the page for exactly the plan: one animation per motion of each beat, the band made for it in the picture, and the film\'s clock last, all on the clock', () => {
    const { player, asked, pictures, clock } = setup(['a1']);
    clock.advance(500);
    player.play(wave('a1'));
    const now = player.films()[0]!;
    expect(now.start).toBe(500);
    const p = pictures.get('a1')!;
    const reading = readPicture(p.el, p.box, 1)!;
    expect(now.arrival).toEqual(planArrival({ card: reading.card, at: [400, 0], paper: reading.paper, route: [[330, 50], [394, 50]], cursor: [332, 60], entry: undefined, parts: reading.planned, zoom: 1 }));
    // The band: in the picture's element, under its root, with the paper's colour and corners, at the root's rectangle when at rest.
    const band = p.el.querySelector<HTMLElement>('.arrival-band')!;
    expect(band).not.toBeNull();
    expect(p.el.firstElementChild).toBe(band);
    expect([band.style.backgroundColor, band.style.borderRadius]).toEqual(['rgb(255, 250, 240)', '10px']);
    expect([band.style.left, band.style.top, band.style.width, band.style.height]).toEqual(['0px', '0px', '380px', '152px']);
    const expected = now.arrival.beats.flatMap((beat) => {
      const el = beat.part === 'arrow' ? p.arrow : beat.part === 'band' ? band : reading.parts[beat.part]!.el;
      return motionsOf(beat, BAND_OUT_MS).map(({ keyframes, timing }) => ({ el, keyframes, options: timing }));
    });
    expected.push({ el: p.el.querySelector('article')!, keyframes: [], options: { duration: now.arrival.total } as never });
    expect(asked.map(({ el, keyframes, options }) => ({ el, keyframes, options }))).toEqual(expected);
    for (const a of asked) expect(clock.holds(a.animation)).toBe(true);
    expect(p.el.querySelector('article')!.hasAttribute(PLAYS)).toBe(true);
  });

  it('never scales the picture\'s root: it is only held unseen until the band is whole, then shown in place', () => {
    const { player, asked, pictures } = setup(['a1']);
    player.play(wave('a1'));
    const root = pictures.get('a1')!.el.querySelector('article')!;
    const onRoot = asked.filter((a) => a.el === root && a.keyframes.length > 0);
    expect(onRoot.map((a) => a.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    const drag = player.films()[0]!.arrival.beats.find((b) => b.part === 'band')!;
    expect(onRoot[0]!.options).toMatchObject({ delay: drag.start + drag.ms, duration: BAND_OUT_MS, fill: 'backwards' });
  });

  it('drags the band by its rectangle, seen only while dragged and as it goes after', () => {
    const { player, asked, pictures } = setup(['a1']);
    player.play(wave('a1'));
    const band = pictures.get('a1')!.el.querySelector('.arrival-band')!;
    const [drag, out] = asked.filter((a) => a.el === band);
    const beat = player.films()[0]!.arrival.beats.find((b) => b.part === 'band')!;
    expect(drag!.keyframes).toEqual([
      { left: '-6px', top: '50px', width: '0px', height: '0px', opacity: 1 },
      { left: '0px', top: '0px', width: '380px', height: '152px', opacity: 1 },
    ]);
    expect(drag!.options).toMatchObject({ delay: beat.start, duration: beat.ms, fill: 'none' });
    expect(out!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(out!.options).toMatchObject({ delay: beat.start + beat.ms, duration: BAND_OUT_MS, fill: 'none' });
  });

  it('measures a picture at the zoom the page is drawn at, while the camera glides to another: the cursor rests by its true corner', () => {
    const { player, pictures, stage } = setup(['a1']);
    stage.zoom = () => 1;
    stage.drawn = () => 2;
    const p = pictures.get('a1')!;
    const rect = (left: number, top: number, width: number, height: number) => (() => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })) as unknown as () => DOMRect;
    p.el.getBoundingClientRect = rect(100, 40, 760, 304);
    p.el.querySelector<HTMLElement>('article')!.getBoundingClientRect = rect(100, 40, 760, 304);
    player.play(wave('a1'));
    const [x, y, w, h] = p.box;
    expect(player.films()[0]!.arrival.rest).toEqual([x + w + REST_PX, y + h + REST_PX]);
  });

  it('holds the arrowhead back until the line is whole: the head is none for as long as the line is drawn on', () => {
    const { player, asked, pictures } = setup(['a1']);
    player.play(wave('a1'));
    const line = asked.find((a) => a.el === pictures.get('a1')!.arrow)!;
    expect(line.keyframes.every((k) => k.markerEnd === 'none')).toBe(true);
    expect(line.options.fill).toBe('backwards');
  });

  it('leads the agent\'s own cursor along the plan on the clock\'s time, and lets it go where it rests: one film splits nothing and merges nothing', () => {
    const { player, own, clock, run, calls } = setup(['a1']);
    clock.advance(200);
    player.play(wave('a1'));
    const { arrival, start } = player.films()[0]!;
    const lead = own.leads[0]!;
    expect(lead()).toEqual(cursorAt(arrival, 0));
    run(300);
    expect(lead()).toEqual(cursorAt(arrival, clock.now() - start));
    run(arrival.total);
    expect(own.leads[own.leads.length - 1]).toBeNull();
    expect(calls).toEqual([]);
  });

  it('once over, leaves the page as if nothing had played: animations cancelled and off the clock, band and attributes gone, no step on the loop', () => {
    const { player, asked, run, clock, frames, marks, ended } = setup(['a1']);
    player.play(wave('a1'));
    expect(frames.running(player)).toBe(true);
    run(player.films()[0]!.arrival.total + 20);
    expect(player.films()).toEqual([]);
    expect(asked.every((a) => a.animation.cancelled && !clock.holds(a.animation))).toBe(true);
    expect(marks()).toBe(0);
    expect(frames.running(player)).toBe(false);
    expect(clock.asked).toBe(false);
    expect(ended).toEqual(['a1']);
  });

  it('ends a film on a live board when its clock is finished, though its time is one float step short of its total, as Chrome reports it', () => {
    const waiting: FrameRequestCallback[] = [];
    let time = 0;
    const live = new FrameLoop({ requestAnimationFrame: (cb) => waiting.push(cb), cancelAnimationFrame: () => undefined }, () => time);
    const { player, asked, ended } = setup(['a1'], live);
    player.play(wave('a1'));
    const { total } = player.films()[0]!.arrival;
    const clock = asked[asked.length - 1]!;
    expect(clock.keyframes).toEqual([]);
    // 1001.3 ms is 1.0013 s to Chrome, and back: one float step under.
    expect((1001.3 / 1000) * 1000).toBeLessThan(1001.3);
    const under = new Float64Array([total]);
    new BigInt64Array(under.buffer)[0]! -= 1n;
    expect(under[0]).toBeLessThan(total);
    const frame = () => {
      time += 1000 / 60;
      for (const cb of waiting.splice(0)) cb(time);
    };
    // One float step short and still running: not over.
    Object.assign(clock.animation, { currentTime: under[0], playState: 'running' });
    frame();
    expect(ended).toEqual([]);
    // The same time, and the clock finished: over.
    Object.assign(clock.animation, { playState: 'finished' });
    frame();
    expect(ended).toEqual(['a1']);
    expect(player.films()).toEqual([]);
  });

  it('ends a film on the board\'s own clock when its time reaches its total, and not before', () => {
    const { player, clock, ended } = setup(['a1']);
    player.play(wave('a1'));
    const { arrival: { total }, start } = player.films()[0]!;
    clock.advanceTo(start + total - 0.01);
    expect(ended).toEqual([]);
    clock.advanceTo(start + total);
    expect(ended).toEqual(['a1']);
  });

  it('splits no cursor for a picture that cannot be read when its turn comes: it simply lands', () => {
    const { player, pictures, run, calls, ended, playing, marks, clock, frames } = setup(['a1', 'a2']);
    player.play(wave('a1', 'a2'));
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(true);
    pictures.get('a2')!.el.innerHTML = '<div>no parts</div>';
    run(HAND_STAGGER_MS + 20);
    expect(calls.filter((c) => c.call === 'split')).toEqual([]);
    expect(ended).toEqual(['a2']);
    expect(playing()).toEqual(['a1']);
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(false);
    while (frames.running(player) && clock.now() < 20_000) run(1);
    expect(calls).toEqual([]);
    expect(marks()).toBe(0);
  });

  it('lands a playing picture at once: every animation cancelled and off the clock, band and attribute gone, the cursor let go where it is', () => {
    const { player, asked, run, clock, own, marks, frames } = setup(['a1']);
    player.play(wave('a1'));
    run(300);
    player.land('a1');
    expect(asked.every((a) => a.animation.cancelled && !clock.holds(a.animation))).toBe(true);
    expect(marks()).toBe(0);
    expect(own.leads[own.leads.length - 1]).toBeNull();
    expect(frames.running(player)).toBe(false);
  });

  it('lands a waiting picture at once: shown, and never played', () => {
    const { player, asked, run, pictures, ended } = setup(['a1', 'a2']);
    player.play(wave('a1', 'a2'));
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(true);
    player.land('a2');
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(false);
    expect(ended).toEqual(['a2']);
    run(5000);
    expect(asked.some((a) => pictures.get('a2')!.el.contains(a.el))).toBe(false);
  });

  it('lands everything at once, and leaves the loop when the board goes: the split cursors merge', () => {
    const { player, run, marks, frames, calls } = setup();
    player.play(wave('a1', 'a2', 'a3'));
    run(HAND_STAGGER_MS + 20);
    player.dispose();
    expect(marks()).toBe(0);
    expect(player.ids()).toEqual([]);
    expect(frames.running(player)).toBe(false);
    expect(calls.filter((c) => c.call === 'merge')).toHaveLength(1);
  });

  it('lands when its arrow is routed anew: its dash was measured on the old route', async () => {
    const { player, pictures, marks } = setup(['a1']);
    player.play(wave('a1'));
    pictures.get('a1')!.arrow.setAttribute('d', 'M 0 0 L 10 10');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(player.films()).toEqual([]);
    expect(marks()).toBe(0);
  });

  it('lets a picture that says nothing of its parts simply be there', () => {
    const { player, asked, pictures, ended, frames } = setup(['a1']);
    pictures.get('a1')!.el.innerHTML = '<div>no parts</div>';
    player.play(wave('a1'));
    expect(asked).toEqual([]);
    expect(ended).toEqual(['a1']);
    expect(frames.running(player)).toBe(false);
  });

  it('plays a picture once, however often it is asked', () => {
    const { player, asked } = setup(['a1']);
    player.play(wave('a1'));
    const n = asked.length;
    player.play(wave('a1'));
    player.play(wave('a1', 'a1'));
    expect(asked).toHaveLength(n);
    expect(player.ids()).toEqual(['a1']);
  });
});

describe('a wave: the pictures of one commit', () => {
  it('plays at once, one cursor per film: the agent\'s own leads the first, each further one a cursor split off it, a stagger after the one before began', () => {
    const { player, hands, calls, run, clock, playing, led, pictures } = setup();
    player.play(wave('a1', 'a2', 'a3'));
    expect(playing()).toEqual(['a1']);
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(true);
    const starts: number[] = [clock.now()];
    while (playing().length < 3 && clock.now() < 2000) {
      run(1);
      if (playing().length > starts.length) starts.push(clock.now());
    }
    expect(playing()).toEqual(['a1', 'a2', 'a3']);
    for (let i = 1; i < 3; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(HAND_STAGGER_MS);
      expect(starts[i]! - starts[i - 1]!).toBeLessThan(HAND_STAGGER_MS + 17);
    }
    // One cursor split off for each further film, each led by its own film.
    expect(calls).toEqual([
      { call: 'split', n: 1 },
      { call: 'split', n: 1 },
    ]);
    expect(hands.map(led)).toEqual([true, true, true]);
    const films = player.films();
    for (const [i, h] of hands.entries()) expect(h.leads[h.leads.length - 1]!()).toEqual(cursorAt(films[i]!.arrival, clock.now() - films[i]!.start));
    // A split cursor's film starts where the agent's own cursor was when it was split.
    expect(cursorAt(films[1]!.arrival, 0)).toEqual(cursorAt(films[0]!.arrival, starts[1]! - starts[0]!));
    expect(document.querySelectorAll(`[${WAITS}]`).length).toBe(0);
  });

  it('gives the agent\'s own cursor the film that starts nearest it', () => {
    const { player, own, playing } = setup();
    // By the third picture's arrow.
    own.at = [1320, 60];
    player.play(wave('a1', 'a2', 'a3'));
    expect(playing()).toEqual(['a3']);
    expect(own.leads).toHaveLength(1);
  });

  it('plays no more than the cap at once: the rest wait out of sight, and a cursor whose film is over takes the next after a moment of stillness, so no more are split than play', () => {
    const ids = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
    const { player, calls, run, clock, playing, pictures, frames } = setup(ids);
    player.play(wave(...ids));
    run(HAND_STAGGER_MS * HANDS_MAX);
    expect(playing()).toEqual(ids.slice(0, HANDS_MAX));
    for (const id of ids.slice(HANDS_MAX)) expect(pictures.get(id)!.el.hasAttribute(WAITS)).toBe(true);
    const firstEnds = player.films()[0]!.start + player.films()[0]!.arrival.total;
    while (clock.now() < firstEnds) run(1);
    expect(playing()).not.toContain('a4');
    while (!playing().includes('a4') && clock.now() < firstEnds + 2000) run(1);
    expect(clock.now() - firstEnds).toBeGreaterThanOrEqual(STILL_AFTER_MS - 17);
    expect(clock.now() - firstEnds).toBeLessThan(STILL_AFTER_MS + HAND_STAGGER_MS + 17);
    while (frames.running(player) && clock.now() < 20_000) {
      expect(player.films().length).toBeLessThanOrEqual(HANDS_MAX);
      run(1);
    }
    expect(calls.filter((c) => c.call === 'split')).toHaveLength(HANDS_MAX - 1);
    expect(calls.filter((c) => c.call === 'merge')).toHaveLength(1);
  });

  it('a cue read while films play joins at once with a cursor of its own, a stagger after the last began', () => {
    const { player, run, playing, calls } = setup(['a1', 'a2']);
    player.play(wave('a1'));
    run(HAND_STAGGER_MS + 20);
    player.play(wave('a2'));
    expect(playing()).toEqual(['a1', 'a2']);
    expect(calls).toEqual([{ call: 'split', n: 1 }]);
  });

  it('a cue read just after another began waits for the stagger, then joins', () => {
    const { player, run, playing } = setup(['a1', 'a2']);
    player.play(wave('a1'));
    run(20);
    player.play(wave('a2'));
    expect(playing()).toEqual(['a1']);
    run(HAND_STAGGER_MS);
    expect(playing()).toEqual(['a1', 'a2']);
  });

  it('merges the cursors when nothing plays or waits, where the film that ended last rests', () => {
    const { player, run, calls, frames, pictures, clock } = setup(['a1', 'a2']);
    // The second picture is taller: its film is longer, and ends last.
    pictures.get('a2')!.box = [900, 0, 380, 600];
    player.play(wave('a1', 'a2'));
    run(HAND_STAGGER_MS + 20);
    const [f1, f2] = player.films();
    expect(f2!.start + f2!.arrival.total).toBeGreaterThan(f1!.start + f1!.arrival.total);
    while (frames.running(player) && clock.now() < 20_000) {
      expect(calls.filter((c) => c.call === 'merge')).toEqual([]);
      run(1);
    }
    expect(calls.filter((c) => c.call === 'merge')).toEqual([{ call: 'merge', at: f2!.arrival.rest }]);
  });

  it('a film landed mid-wave lets its cursor go where it is; the others play on, and merge when they are over', () => {
    const { player, run, playing, hands, calls, frames, marks, clock } = setup();
    player.play(wave('a1', 'a2', 'a3'));
    run(HAND_STAGGER_MS * 2 + 20);
    player.land('a2');
    expect(playing()).toEqual(['a1', 'a3']);
    expect(hands[1]!.leads[hands[1]!.leads.length - 1]).toBeNull();
    expect(calls.filter((c) => c.call === 'merge')).toEqual([]);
    while (frames.running(player) && clock.now() < 20_000) run(1);
    expect(calls.filter((c) => c.call === 'merge')).toHaveLength(1);
    expect(marks()).toBe(0);
  });

  it('runs faster when much waits, reckoned for films that play side by side', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `a${i}`);
    const { player, pictures } = setup(ids);
    player.play(wave(...ids));
    const p = pictures.get('a0')!;
    const reading = readPicture(p.el, p.box, 1)!;
    const usual = planArrival({ card: reading.card, at: [400, 0], paper: reading.paper, route: [[330, 50], [394, 50]], cursor: [332, 60], parts: reading.planned, zoom: 1 });
    // Three more begin a stagger apart; the other twelve wait for three rounds of four.
    const later = Math.ceil((ids.length - HANDS_MAX) / HANDS_MAX);
    const rate = Math.min(RATE_MAX, (usual.total + later * (ARRIVAL_GUESS_MS + STILL_AFTER_MS)) / LAG_MAX_MS);
    expect(rate).toBeGreaterThan(1);
    expect(player.films()[0]!.arrival.total / (usual.total / rate)).toBeCloseTo(1, 1);
  });

  it('lets the oldest that wait simply land when even the fastest rate would leave the board too far behind', () => {
    const ids = Array.from({ length: 48 }, (_, i) => `a${i}`);
    const { player, ended, pictures } = setup(ids);
    player.play(wave(...ids));
    const left = player.films()[0]!.arrival.total;
    const behind = (waiting: number) => (left + Math.ceil(Math.max(0, waiting - (HANDS_MAX - 1)) / HANDS_MAX) * (ARRIVAL_GUESS_MS + STILL_AFTER_MS)) / RATE_MAX;
    const kept = player.ids().length - 1;
    expect(behind(kept)).toBeLessThanOrEqual(LAG_MAX_MS);
    expect(behind(kept + 1)).toBeGreaterThan(LAG_MAX_MS);
    // The oldest waiting landed first, and nothing holds them any more.
    expect(ended).toEqual(ids.slice(1, ids.length - kept));
    for (const id of ended) expect(pictures.get(id)!.el.hasAttribute(WAITS)).toBe(false);
    expect(player.ids()).toEqual([ids[0], ...ids.slice(ids.length - kept)]);
  });
});

describe('the camera first', () => {
  it('a wave read while the camera moves waits out of sight, and the agent\'s own cursor travels to where its film will start; it begins once the camera stops', () => {
    const { player, run, step, playing, pictures, calls, moveCamera, own } = setup(['a1', 'a2']);
    moveCamera(true);
    player.play(wave('a1', 'a2'));
    expect(playing()).toEqual([]);
    for (const id of ['a1', 'a2']) expect(pictures.get(id)!.el.hasAttribute(WAITS)).toBe(true);
    expect(calls).toEqual([{ call: 'travelTo', at: [330, 50] }]);
    run(300);
    expect(playing()).toEqual([]);
    // The frame the camera lands in still has nothing drawn on; the next begins the wave.
    moveCamera(false);
    step();
    expect(playing()).toEqual([]);
    step();
    expect(playing()).toEqual(['a1']);
    expect(own.leads).toHaveLength(1);
    // From where it travelled: its approach is a nudge, not a trip.
    expect(cursorAt(player.films()[0]!.arrival, 0)).toEqual([330, 50]);
  });

  it('sends the agent\'s own cursor to the start of what will begin first: an older cue that waits, not the one just read', () => {
    const { player, calls, moveCamera } = setup(['a1', 'a2']);
    moveCamera(true);
    player.play(wave('a1'));
    player.play(wave('a2'));
    expect(calls.filter((c) => c.call === 'travelTo').map((c) => c.at)).toEqual([[330, 50], [330, 50]]);
  });

  it('never waits on the camera longer than the gate allows', () => {
    const { player, run, playing, clock, moveCamera } = setup(['a1']);
    moveCamera(true);
    const read = clock.now();
    player.play(wave('a1'));
    while (playing().length === 0 && clock.now() < read + 5000) run(1);
    expect(clock.now() - read).toBeGreaterThanOrEqual(GATE_MAX_MS);
    expect(clock.now() - read).toBeLessThan(GATE_MAX_MS + 17);
  });

  it('does not send the agent\'s own cursor away from a film it leads', () => {
    const { player, run, calls, moveCamera } = setup(['a1', 'a2']);
    player.play(wave('a1'));
    run(HAND_STAGGER_MS + 20);
    moveCamera(true);
    player.play(wave('a2'));
    expect(calls).toEqual([]);
  });
});

describe('what is held out of sight is told', () => {
  it('names what waits for its turn, for the stagger or for the camera, and what is veiled; tells only on a change, with the same set between', () => {
    const { player, run, moveCamera, frames } = setup(['a1', 'a2', 'a3']);
    let told = 0;
    player.subscribe(() => told++);
    const none = player.held();
    expect([...none]).toEqual([]);
    moveCamera(true);
    player.play(wave('a1', 'a2'));
    expect([...player.held()]).toEqual(['a1', 'a2']);
    expect(told).toBe(1);
    const same = player.held();
    run(100);
    expect(player.held()).toBe(same);
    expect(told).toBe(1);
    moveCamera(false);
    run(34);
    expect([...player.held()]).toEqual(['a2']);
    run(HAND_STAGGER_MS);
    expect([...player.held()]).toEqual([]);
    player.play([{ kind: 'settling', id: 'a3' }]);
    expect([...player.held()]).toEqual(['a3']);
    player.landAll();
    expect([...player.held()]).toEqual([]);
    expect(told).toBe(5);
    expect(frames.running(player)).toBe(false);
  });
});

describe('a finished placeholder held out of sight', () => {
  const waits = (el: Element) => el.getAttribute(WAITS);
  const settling = (id: Id): Cue => ({ kind: 'settling', id });

  it('is held by its element until it is landed, alone or with everything', () => {
    const { player, pictures, ended } = setup(['a1']);
    const el = pictures.get('a1')!.el;
    player.play([settling('a1')]);
    expect(waits(el)).toBe('');
    expect(player.has('a1')).toBe(true);
    player.land('a1');
    expect(waits(el)).toBeNull();
    expect(player.has('a1')).toBe(false);
    // Held, not played: landing it ends no film.
    expect(ended).toEqual([]);
    player.play([settling('a1')]);
    player.landAll();
    expect(waits(el)).toBeNull();
    expect(player.ids()).toEqual([]);
  });

  it('is let go when it plays: the band shows it', () => {
    const { player, pictures, playing } = setup(['a1']);
    const el = pictures.get('a1')!.el;
    player.play([settling('a1')]);
    player.play(wave('a1'));
    expect(waits(el)).toBeNull();
    expect(playing()).toEqual(['a1']);
  });

  it('held again on a new element, lets go of the old one; held again on the same, changes nothing', () => {
    const { player, pictures } = setup(['a1']);
    const p = pictures.get('a1')!;
    const old = p.el;
    player.play([settling('a1')]);
    player.play([settling('a1')]);
    expect(waits(old)).toBe('');
    const fresh = old.cloneNode(true) as HTMLElement;
    fresh.removeAttribute(WAITS);
    document.body.append(fresh);
    p.el = fresh;
    player.play([settling('a1')]);
    expect(waits(old)).toBeNull();
    expect(waits(fresh)).toBe('');
    player.land('a1');
    expect(waits(fresh)).toBeNull();
  });

  it('finished, is dragged from the rectangle it had: the band starts there, and the picture is never scaled', () => {
    const { player, pictures, asked } = setup(['a1']);
    player.play([{ kind: 'finished', id: 'a1', from: [400, 0, 300, 100] }]);
    const p = pictures.get('a1')!;
    const band = p.el.querySelector('.arrival-band')!;
    const drag = asked.find((a) => a.el === band)!;
    expect(drag.keyframes[0]).toMatchObject({ left: '0px', top: '0px', width: '300px', height: '100px' });
    // It stands where the placeholder was while the cursor goes to its corner: the place is never empty.
    expect(drag.options.fill).toBe('backwards');
    const root = p.el.querySelector('article')!;
    expect(asked.filter((a) => a.el === root && a.keyframes.length > 0).map((a) => a.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
  });

  it('finished while the camera moves, keeps its frame where the placeholder was until its film begins: the place is never empty', () => {
    const { player, pictures, asked, playing, moveCamera, step } = setup(['a1']);
    const el = pictures.get('a1')!.el;
    moveCamera(true);
    player.play([{ kind: 'finished', id: 'a1', from: [400, 0, 300, 100] }]);
    expect(playing()).toEqual([]);
    // Only its frame is seen: a band, at the placeholder's rectangle, in the picture's own look.
    expect(waits(el)).toBe('frame');
    const frame = el.querySelector<HTMLElement>(':scope > .arrival-band')!;
    expect(frame.style).toMatchObject({ left: '0px', top: '0px', width: '300px', height: '100px', backgroundColor: 'rgb(255, 250, 240)', borderRadius: '10px' });
    expect(asked).toEqual([]);
    moveCamera(false);
    step();
    step();
    // Its film takes over in one frame: one band, dragged from that same rectangle.
    expect(playing()).toEqual(['a1']);
    expect(waits(el)).toBeNull();
    expect(frame.isConnected).toBe(false);
    const bands = el.querySelectorAll('.arrival-band');
    expect(bands).toHaveLength(1);
    expect(asked.find((a) => a.el === bands[0])!.keyframes[0]).toMatchObject({ left: '0px', top: '0px', width: '300px', height: '100px' });
  });

  it('finished and waiting, landed: its frame goes with it', () => {
    const { player, marks, moveCamera } = setup(['a1']);
    moveCamera(true);
    player.play([{ kind: 'finished', id: 'a1', from: [400, 0, 300, 100] }]);
    expect(marks()).toBe(2);
    player.land('a1');
    expect(marks()).toBe(0);
    player.play([{ kind: 'finished', id: 'a1', from: [400, 0, 300, 100] }]);
    player.landAll();
    expect(marks()).toBe(0);
  });
});

describe('what waits its turn behind a film', () => {
  const waits = (el: Element) => el.getAttribute(WAITS);

  it('a redraw keeps its paper and holds back what is on it, until it begins', () => {
    const { player, pictures, step, playing } = setup(['a1', 'a2']);
    player.play(wave('a1'));
    player.play([{ kind: 'redrawn', id: 'a2' }]);
    const p = pictures.get('a2')!;
    const root = p.el.querySelector('[data-build]')!;
    expect(waits(root)).toBe('content');
    expect(waits(p.el)).toBeNull();
    let n = 0;
    while (!playing().includes('a2') && n++ < 600) step();
    expect(playing()).toContain('a2');
    expect(waits(root)).toBeNull();
    expect(p.el.querySelector('.arrival-band')).toBeNull();
  });

  it('a redraw that waits, landed, shows what is on it at once', () => {
    const { player, pictures, ended } = setup(['a1', 'a2']);
    player.play(wave('a1'));
    player.play([{ kind: 'redrawn', id: 'a2' }]);
    player.land('a2');
    expect(waits(pictures.get('a2')!.el.querySelector('[data-build]')!)).toBeNull();
    expect(ended).toEqual(['a2']);
  });

  /** A chip of words on the page, for the stage to find. */
  function chipOn(stage: ArrivalStage): HTMLElement {
    const chip = document.createElement('span');
    chip.dataset.read = 'r1';
    document.body.append(chip);
    stage.chip = (id) => (id === 'r1' ? chip : undefined);
    stage.boxOf = () => [100, 300, 160, 24];
    return chip;
  }

  it('a chip of words is held out of sight until it begins', () => {
    const { player, stage, step, playing } = setup(['a1']);
    const chip = chipOn(stage);
    player.play(wave('a1'));
    player.play([{ kind: 'read', id: 'r1' }]);
    expect(waits(chip)).toBe('');
    let n = 0;
    while (!playing().includes('r1') && n++ < 600) step();
    expect(playing()).toContain('r1');
    expect(waits(chip)).toBeNull();
  });

  it('a chip of words that waits, landed, is shown at once', () => {
    const { player, stage, ended } = setup(['a1']);
    const chip = chipOn(stage);
    player.play(wave('a1'));
    player.play([{ kind: 'read', id: 'r1' }]);
    player.land('r1');
    expect(waits(chip)).toBeNull();
    expect(ended).toEqual(['r1']);
  });
});
