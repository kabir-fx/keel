import type { Box, Id } from '@keel/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cssOf, cursorAt, planArrival } from '../src/arrival/plan';
import type { Animate, ArrivalStage } from '../src/arrival/player';
import { PLAYS, WAITS } from '../src/arrival/attributes';
import { ArrivalPlayer, keyframesFor } from '../src/arrival/player';
import { readPicture } from '../src/arrival/read';
import { FrameLoop, ManualClock } from '../src/frame';
import type { Point } from '../src/motion/path';
import { ARRIVAL_GUESS_MS, LAG_MAX_MS, RATE_MAX, REST_PX, STILL_AFTER_MS } from '../src/motion/timing';

/**
 * The player, on a page built by hand, with a stand-in for `element.animate` that writes down
 * what it is asked, and frames stepped by hand on a manual clock.
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
  el.innerHTML = `<article data-build="frame"><h3 data-build="head">${id}</h3><p data-build="block">one</p><p data-build="block">two</p></article>`;
  document.body.append(el);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', `M ${x - 70} 50 L ${x - 6} 50`);
  svg.append(arrow);
  document.body.append(svg);
  return { el, arrow, box: [x, 0, 380, 152] };
}

function setup(ids: readonly Id[] = ['a1', 'a2', 'a3']) {
  const clock = new ManualClock();
  const frames = new FrameLoop(clock, clock.now);
  const asked: Asked[] = [];
  const pictures = new Map(ids.map((id, i) => [id, picture(id, 400 + i * 500)]));
  const leads: Array<(() => Point) | null> = [];
  let at: Point | undefined = [332, 60];
  const cursor = {
    at: () => at,
    lead: (to: (() => Point) | null) => {
      leads.push(to);
      if (to) at = to();
    },
  };
  const ended: Id[] = [];
  const stage: ArrivalStage = {
    item: (id) => pictures.get(id) && { el: pictures.get(id)!.el, box: pictures.get(id)!.box },
    arrow: (id) => pictures.get(id)?.arrow,
    chip: () => undefined,
    boxOf: () => [0, 0, 0, 0],
    zoom: () => 1,
    drawn: () => 1,
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
  /** Every attribute the player sets, wherever it is on the page. */
  const marks = () => document.querySelectorAll(`[${PLAYS}], [${WAITS}]`).length;
  return { clock, frames, asked, pictures, leads, cursor, ended, stage, player, step, run, marks };
}

const placed = (id: Id) => ({ kind: 'placed' as const, id });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the player', () => {
  it('asks the page for exactly the plan: one animation per pose, with the beat\'s delay, length and easing, filled backwards and on the clock', () => {
    const { player, asked, pictures, clock } = setup(['a1']);
    clock.advance(500);
    player.play(placed('a1'));
    const now = player.now()!;
    expect(now.start).toBe(500);
    const p = pictures.get('a1')!;
    const reading = readPicture(p.el, p.box, 1)!;
    expect(now.arrival).toEqual(planArrival({ card: reading.card, paper: reading.paper, route: [[330, 50], [394, 50]], cursor: [332, 60], entry: undefined, parts: reading.planned, zoom: 1 }));
    const expected = now.arrival.beats.flatMap((beat) => {
      const el = beat.part === 'arrow' ? p.arrow : reading.parts[beat.part]!.el;
      return keyframesFor(beat.pose).map(([keyframes, share]) => ({
        el,
        keyframes,
        options: { delay: beat.start, duration: beat.ms * share, easing: share === 1 ? cssOf(beat.ease) : expect.any(String), fill: 'backwards' },
      }));
    });
    // And last, the film's clock: an animation of the film's length, made with the others, so the browser starts them together.
    expected.push({ el: p.el.querySelector('article')!, keyframes: [], options: { duration: now.arrival.total } as never });
    expect(asked.map(({ el, keyframes, options }) => ({ el, keyframes, options }))).toEqual(expected);
    // Each is on the clock from the arrival's start: the clock sets it on every frame.
    for (const a of asked) expect(clock.holds(a.animation)).toBe(true);
    expect(p.el.querySelector('article')!.hasAttribute(PLAYS)).toBe(true);
  });

  it('measures a picture at the zoom the page is drawn at, while the camera glides to another: the cursor rests by its true corner', () => {
    const { player, pictures, stage } = setup(['a1']);
    // Drawn at 200% now, on the way to 100%: on the screen it is twice its size in board units.
    stage.zoom = () => 1;
    stage.drawn = () => 2;
    const p = pictures.get('a1')!;
    const rect = (left: number, top: number, width: number, height: number) => (() => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })) as unknown as () => DOMRect;
    p.el.getBoundingClientRect = rect(100, 40, 760, 304);
    p.el.querySelector<HTMLElement>('article')!.getBoundingClientRect = rect(100, 40, 760, 304);
    player.play(placed('a1'));
    const [x, y, w, h] = p.box;
    // The card is the picture's own box, and the rest is the gap outside its corner at the zoom it is going to.
    expect(player.now()!.arrival.rest).toEqual([x + w + REST_PX, y + h + REST_PX]);
  });

  it('holds the arrowhead back until the line is whole: the head is none for as long as the line is drawn on', () => {
    const { player, asked, pictures } = setup(['a1']);
    player.play(placed('a1'));
    const line = asked.find((a) => a.el === pictures.get('a1')!.arrow)!;
    expect(line.keyframes.every((k) => k.markerEnd === 'none')).toBe(true);
    expect(line.options.fill).toBe('backwards');
  });

  it('leads the cursor along the plan on the clock\'s time, and lets it go where it rests', () => {
    const { player, leads, clock, run } = setup(['a1']);
    clock.advance(200);
    player.play(placed('a1'));
    const { arrival, start } = player.now()!;
    const lead = leads[0]!;
    expect(lead()).toEqual(cursorAt(arrival, 0));
    run(300);
    expect(lead()).toEqual(cursorAt(arrival, clock.now() - start));
    run(arrival.total);
    expect(leads[leads.length - 1]).toBeNull();
  });

  it('once it is over, leaves the page as if nothing had played: animations cancelled and off the clock, attributes gone, no step on the loop', () => {
    const { player, asked, run, clock, frames, marks, ended } = setup(['a1']);
    player.play(placed('a1'));
    expect(frames.running(player)).toBe(true);
    run(player.now()!.arrival.total + 20);
    expect(player.now()).toBeNull();
    expect(asked.every((a) => a.animation.cancelled && !clock.holds(a.animation))).toBe(true);
    expect(marks()).toBe(0);
    expect(frames.running(player)).toBe(false);
    expect(clock.asked).toBe(false);
    expect(ended).toEqual(['a1']);
  });

  it('plays several one after another: the next waits out of sight, with its arrow, and starts once the board has been still a moment', () => {
    const { player, asked, pictures, run, clock } = setup();
    player.play(placed('a1'));
    player.play(placed('a2'));
    player.play(placed('a3'));
    expect(player.ids()).toEqual(['a1', 'a2', 'a3']);
    for (const id of ['a2', 'a3']) {
      expect(pictures.get(id)!.el.hasAttribute(WAITS)).toBe(true);
      expect(pictures.get(id)!.arrow.hasAttribute(WAITS)).toBe(true);
      expect(asked.some((a) => pictures.get(id)!.el.contains(a.el) || a.el === pictures.get(id)!.arrow)).toBe(false);
    }
    const first = player.now()!;
    run(first.arrival.total);
    // Over, and still: the next has not started yet.
    expect(player.now()).toBeNull();
    const over = clock.now();
    while (!player.now()) run(1);
    expect(player.now()!.cue.id).toBe('a2');
    expect(clock.now() - over).toBeGreaterThanOrEqual(STILL_AFTER_MS);
    expect(clock.now() - over).toBeLessThan(STILL_AFTER_MS + 20);
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(false);
    expect(pictures.get('a3')!.el.hasAttribute(WAITS)).toBe(true);
    run(player.now()!.arrival.total + STILL_AFTER_MS + 40);
    expect(player.now()!.cue.id).toBe('a3');
  });

  it('runs faster when much waits, so the board is never far behind the log', () => {
    const ids = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
    const { player, run, pictures, cursor } = setup(ids);
    for (const id of ids) player.play(placed(id));
    run(player.now()!.arrival.total + 40);
    const from = cursor.at();
    while (player.now()?.cue.id !== 'a1') run(1);
    const p = pictures.get('a1')!;
    const reading = readPicture(p.el, p.box, 1)!;
    const usual = planArrival({ card: reading.card, paper: reading.paper, route: [[830, 50], [894, 50]], cursor: from, parts: reading.planned, zoom: 1 });
    const waiting = 4;
    const rate = Math.min(RATE_MAX, (usual.total + waiting * (ARRIVAL_GUESS_MS + STILL_AFTER_MS)) / LAG_MAX_MS);
    expect(rate).toBeGreaterThan(1);
    expect(player.now()!.arrival.total / (usual.total / rate)).toBeCloseTo(1, 1);
  });

  it('lets the oldest that wait simply land when even the fastest rate would leave the board too far behind', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `a${i}`);
    const { player, ended, pictures } = setup(ids);
    for (const id of ids) player.play(placed(id));
    // What is left of the one playing, and the guess of each that waits, at the fastest rate.
    const left = player.now()!.arrival.total;
    const behind = (n: number) => (left + n * (ARRIVAL_GUESS_MS + STILL_AFTER_MS)) / RATE_MAX;
    const kept = player.ids().length - 1;
    expect(behind(kept)).toBeLessThanOrEqual(LAG_MAX_MS);
    expect(behind(kept + 1)).toBeGreaterThan(LAG_MAX_MS);
    // The oldest waiting landed first, and nothing holds them any more.
    expect(ended).toEqual(ids.slice(1, ids.length - kept));
    for (const id of ended) expect(pictures.get(id)!.el.hasAttribute(WAITS)).toBe(false);
    expect(player.ids()).toEqual([ids[0], ...ids.slice(ids.length - kept)]);
  });

  it('lands a playing picture at once: every animation cancelled and off the clock, the attribute gone, the cursor let go where it is', () => {
    const { player, asked, run, clock, leads, marks, frames } = setup(['a1']);
    player.play(placed('a1'));
    run(300);
    player.land('a1');
    expect(asked.every((a) => a.animation.cancelled && !clock.holds(a.animation))).toBe(true);
    expect(marks()).toBe(0);
    expect(leads[leads.length - 1]).toBeNull();
    expect(frames.running(player)).toBe(false);
  });

  it('lands a waiting picture at once: shown, and never played', () => {
    const { player, asked, run, pictures, ended } = setup(['a1', 'a2']);
    player.play(placed('a1'));
    player.play(placed('a2'));
    player.land('a2');
    expect(pictures.get('a2')!.el.hasAttribute(WAITS)).toBe(false);
    expect(ended).toEqual(['a2']);
    run(5000);
    expect(asked.some((a) => pictures.get('a2')!.el.contains(a.el))).toBe(false);
  });

  it('lands everything at once, and leaves the loop when the board goes', () => {
    const { player, run, marks, frames } = setup();
    for (const id of ['a1', 'a2', 'a3']) player.play(placed(id));
    run(100);
    player.dispose();
    expect(marks()).toBe(0);
    expect(player.ids()).toEqual([]);
    expect(frames.running(player)).toBe(false);
  });

  it('lands when its arrow is routed anew: its dash was measured on the old route', async () => {
    const { player, pictures, marks } = setup(['a1']);
    player.play(placed('a1'));
    pictures.get('a1')!.arrow.setAttribute('d', 'M 0 0 L 10 10');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(player.now()).toBeNull();
    expect(marks()).toBe(0);
  });

  it('lets a picture that says nothing of its parts simply be there', () => {
    const { player, asked, pictures, ended, frames } = setup(['a1']);
    pictures.get('a1')!.el.innerHTML = '<div>no parts</div>';
    player.play(placed('a1'));
    expect(asked).toEqual([]);
    expect(ended).toEqual(['a1']);
    expect(frames.running(player)).toBe(false);
  });

  it('plays a picture once, however often it is asked', () => {
    const { player, asked } = setup(['a1']);
    player.play(placed('a1'));
    const n = asked.length;
    player.play(placed('a1'));
    expect(asked).toHaveLength(n);
    expect(player.ids()).toEqual(['a1']);
  });
});

describe('a finished placeholder held out of sight', () => {
  const waits = (el: Element) => el.getAttribute(WAITS);

  it('is held by its element until it is landed, alone or with everything', () => {
    const { player, pictures, ended } = setup(['a1']);
    const el = pictures.get('a1')!.el;
    player.veil('a1');
    expect(waits(el)).toBe('');
    expect(player.has('a1')).toBe(true);
    player.land('a1');
    expect(waits(el)).toBeNull();
    expect(player.has('a1')).toBe(false);
    // Held, not played: landing it ends no film.
    expect(ended).toEqual([]);
    player.veil('a1');
    player.landAll();
    expect(waits(el)).toBeNull();
    expect(player.ids()).toEqual([]);
  });

  it('is let go when it plays: the pull shows it', () => {
    const { player, pictures } = setup(['a1']);
    const el = pictures.get('a1')!.el;
    player.veil('a1');
    player.play(placed('a1'));
    expect(waits(el)).toBeNull();
    expect(player.now()!.cue.id).toBe('a1');
  });

  it('held again on a new element, lets go of the old one; held again on the same, changes nothing', () => {
    const { player, pictures } = setup(['a1']);
    const p = pictures.get('a1')!;
    const old = p.el;
    player.veil('a1');
    player.veil('a1');
    expect(waits(old)).toBe('');
    const fresh = old.cloneNode(true) as HTMLElement;
    fresh.removeAttribute(WAITS);
    document.body.append(fresh);
    p.el = fresh;
    player.veil('a1');
    expect(waits(old)).toBeNull();
    expect(waits(fresh)).toBe('');
    player.land('a1');
    expect(waits(fresh)).toBeNull();
  });
});

describe('what waits its turn behind a film', () => {
  const waits = (el: Element) => el.getAttribute(WAITS);

  it('a redraw keeps its paper and holds back what is on it, until it begins', () => {
    const { player, pictures, step } = setup(['a1', 'a2']);
    player.play(placed('a1'));
    player.play({ kind: 'redrawn', id: 'a2' });
    const p = pictures.get('a2')!;
    const root = p.el.querySelector('[data-build]')!;
    expect(waits(root)).toBe('content');
    expect(waits(p.el)).toBeNull();
    let n = 0;
    while (player.now()?.cue.id !== 'a2' && n++ < 600) step();
    expect(player.now()!.cue.id).toBe('a2');
    expect(waits(root)).toBeNull();
  });

  it('a redraw that waits, landed, shows what is on it at once', () => {
    const { player, pictures, ended } = setup(['a1', 'a2']);
    player.play(placed('a1'));
    player.play({ kind: 'redrawn', id: 'a2' });
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
    const { player, stage, step } = setup(['a1']);
    const chip = chipOn(stage);
    player.play(placed('a1'));
    player.play({ kind: 'read', id: 'r1' });
    expect(waits(chip)).toBe('');
    let n = 0;
    while (player.now()?.cue.id !== 'r1' && n++ < 600) step();
    expect(player.now()!.cue.id).toBe('r1');
    expect(waits(chip)).toBeNull();
  });

  it('a chip of words that waits, landed, is shown at once', () => {
    const { player, stage, ended } = setup(['a1']);
    const chip = chipOn(stage);
    player.play(placed('a1'));
    player.play({ kind: 'read', id: 'r1' });
    player.land('r1');
    expect(waits(chip)).toBeNull();
    expect(ended).toEqual(['r1']);
  });
});
