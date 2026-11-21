/**
 * Every number of the agent's motion on the board, in one place (plan section 6). Times are in
 * ms, distances in screen pixels unless a line says board units. They are starting values: the
 * arrival is tuned on its frames, and a change here says where the new value came from.
 *
 * One personality for the whole board: calm and exact, a working tool.
 */

/* ------------------------------------------------------------------ the cursor */

/** The shortest trip the cursor makes: a hop of a few pixels still reads as a move. */
export const CURSOR_TRAVEL_MIN_MS = 320;

/** The longest trip the cursor makes, however far it goes: the owner should not wait on it. */
export const CURSOR_TRAVEL_MAX_MS = 750;

/**
 * How long a trip takes for how far it goes on the screen, as [pixels, ms]: between two rows it
 * is a straight line, before the first and past the last it is the end's own time. The motion
 * skill's distance scaling (50 px 0.8×, 100 px 1×, 200 px 1.3×, 300 px 1.5×, 400 px 1.6×, a whole
 * screen 1.8 to 2×) on a base of 400 ms, which runs from the shortest trip to the longest.
 */
export const CURSOR_TRAVEL_BY_DISTANCE: readonly (readonly [px: number, ms: number])[] = [
  [50, CURSOR_TRAVEL_MIN_MS],
  [100, 400],
  [200, 520],
  [300, 600],
  [400, 640],
  [1400, CURSOR_TRAVEL_MAX_MS],
];

/** The first time on a board, the cursor comes in from the nearest edge of the view over this long. */
export const CURSOR_ENTER_MS = 600;

/** At rest the cursor stays bright this long before it dims and the drop closes its eyes: the end of a turn is seen, then it quietens. */
export const CURSOR_REST_HOLD_MS = 1200;

/** How long the cursor takes to dim, and the drop to close its eyes, once the hold is over. */
export const CURSOR_DIM_MS = 400;

/* ------------------------------------------------------------------ the figure */

/** The drop turns into a pose (a lean, its pupils' look) over this long, and opens its eyes as fast. */
export const DROP_POSE_MS = 200;

/** Reading, the drop leans this far toward the mark it reads, which is on its left. */
export const DROP_LEAN_DEG = 5;

/** Reading, its pupils go left to right over two lines in this long, then start again. */
export const DROP_READ_MS = 1800;

/** How far its pupils look, in pixels of the drop's own drawing: up while it thinks, at the tip while it draws, along a line while it reads. */
export const DROP_LOOK_PX = 1;

/** Thinking, it bobs once up and down in this long. */
export const DROP_BOB_MS = 2000;

/** How far it bobs, in pixels. */
export const DROP_BOB_PX = 3;

/** Thinking, its three dots come one after another and go, in this long. */
export const DROP_DOTS_MS = 1500;

/** Drawing or writing, its tip scribbles one way in this long, and back in as long again. */
export const DROP_SCRIBBLE_MS = 160;

/** How far the scribble turns it each way about its tip. */
export const DROP_SCRIBBLE_DEG = 3;

/** A droplet comes out of the drop over this long. */
export const DROP_SPLIT_MS = 280;

/** Coming out, a droplet grows this much past its size before it settles: the one small overshoot. */
export const DROP_SPLIT_OVERSHOOT = 1.08;

/** Merging, a droplet goes into the drop over this last share of its flight: it is gone as it lands. */
export const DROP_SINK_SHARE = 0.25;

/** The droplets in, the drop swells once by about a seventh and settles over this long. */
export const DROP_SWELL_MS = 320;

/** How much the drop swells once the droplets are in. */
export const DROP_SWELL = 8 / 7;

/** New words in the cursor's tag, and the title under it, rise in over this long: not swapped. */
export const CURSOR_WORDS_MS = 180;

/** How far new words rise as they come in, in pixels. */
export const CURSOR_WORDS_RISE_PX = 3;

/** A trip's curve bends to one side by this share of its length. */
export const ARC_BEND = 0.12;

/** A trip's curve bends by no more than this, in board units, however long the trip. */
export const ARC_BEND_MAX = 96;

/** A trip's curve is measured in this many straight pieces: fine enough that no corner is seen. */
export const ARC_STEPS = 32;

/* ------------------------------------------------------------------ lines */

/**
 * The shortest time a line (an arrow, a connector) takes to be drawn on. A line of a few dozen
 * pixels, as an answer's arrow from the mark beside it is, took the 400 ms that suit a long one
 * and read as lag on the frames: a short line is a short stroke.
 */
export const LINE_MIN_MS = 180;

/** The longest time a line takes to be drawn on, however long it is. */
export const LINE_MAX_MS = 650;

/** A line this long, in pixels, takes the shortest time of a line of some length. */
export const LINE_SHORT_PX = 40;

/**
 * A line this short on the screen, in pixels, or shorter, as an answer's arrow is at a low zoom,
 * is a flick: it takes `LINE_TINY_MS`, and a line between it and `LINE_SHORT_PX` takes between
 * the two. At 180 ms a 10 px arrow read as the cursor standing still before the pull.
 */
export const LINE_TINY_PX = 8;

/** How long a line `LINE_TINY_PX` long or shorter takes to be drawn on. */
export const LINE_TINY_MS = 80;

/** A line this long, in pixels, or longer, takes the longest time. */
export const LINE_LONG_PX = 800;

/* ------------------------------------------------------------------ pictures */

/** A block on a card comes in over this long, rising as it shows. */
export const BLOCK_IN_MS = 220;

/** The next block starts this long after the one before it. */
export const BLOCK_GAP_MS = 60;

/** A block rises this far, in pixels, as it comes in: never a fade alone. */
export const BLOCK_RISE_PX = 6;

/** A box inside a drawing comes in over this long. */
export const BOX_IN_MS = 180;

/** The next box starts this long after the one before it. */
export const BOX_GAP_MS = 40;

/** A box inside a drawing grows from this share of its size. */
export const BOX_FROM_SCALE = 0.96;

/** A label comes in over this long. */
export const LABEL_IN_MS = 160;

/** A label rises this far, in pixels, as it comes in: less than a block, it is small. */
export const LABEL_RISE_PX = 3;

/** A dashed line cannot be drawn on: it shows as it grows from this share of its size. */
export const LINE_FADE_FROM_SCALE = 0.98;

/** A sheet on a wide picture (an approach, a panel) is set down over this long, lightly. */
export const SHEET_SET_MS = 260;

/** A sheet is set down from this share of its size. */
export const SHEET_FROM_SCALE = 0.97;

/** The next sheet is set down this long after the last part of the sheet before it started: one is filled, then the next. */
export const SHEET_GAP_MS = 120;

/** Not more than this share of a picture's parts move at once. */
export const MOVING_SHARE_MAX = 1 / 3;

/** However small a picture, this many of its parts may move at once: the card, and two lines of words. */
export const MOVING_MIN = 3;

/* ------------------------------------------------------------------ the arrival */

/**
 * The cursor is all but where it is going when it is this close, in pixels: its trip is a nudge.
 * Beside the owner's mark it waits about 15 px from where the mark's arrow starts; inside a
 * picture's corner, where presence puts it for a redraw, about 45 px from where it rests.
 */
export const CURSOR_NEAR_PX = 48;

/** A nudge of a few pixels. The picture is in the log already: the owner does not wait on the cursor. */
export const CURSOR_NUDGE_MS = 80;

/** The longest the cursor takes to get to the arrow's start, however far: the picture is there, the cursor must not wander over to it. */
export const APPROACH_MAX_MS = 300;

/** The shortest pull: a small card is pulled out over this long. */
export const PULL_MIN_MS = 320;

/** The longest pull, however large the picture. */
export const PULL_MAX_MS = 600;

/** A pull this long on the screen, in pixels, from the arrow's end to the far corner, or shorter, takes the shortest time. */
export const PULL_SHORT_PX = 200;

/** A pull this long, in pixels, or longer, takes the longest time. */
export const PULL_LONG_PX = 1200;

/** Once the band is dragged out whole, the picture shows in place and the band goes over this long. */
export const BAND_OUT_MS = 120;

/** The cursor rests this far past the picture's bottom right corner, in pixels: on nothing the picture shows. */
export const REST_PX = 8;

/** A picture is pulled out by another corner than its bottom right only when that corner is this share farther from where the pull starts: a near-tie goes to the bottom right, so pictures pulled from nearly the same place go the same way. */
export const CORNER_TIE_SHARE = 0.2;

/** A finished placeholder whose rectangle moved by no more than this, in pixels, is not pulled: only filled. */
export const SAME_PX = 1;

/** A picture drawn again comes in this many times as fast as at its arrival: it is known already, only its words are new. */
export const REDRAW_RATE = 1.5;

/** After writing a chip in, the cursor settles just past its end over this long. */
export const CHIP_REST_MS = 120;

/** The film of a card, from the cursor's first move to the last part in, at the usual rate. */
export const ARRIVAL_SMALL_MS = 1200;

/** The film of the widest picture (a spread, a pipeline, a blueprint): the longest one may take. */
export const ARRIVAL_WIDE_MS = 2400;

/** A picture of this many parts or fewer is a card, for its film's length. */
export const PARTS_SMALL = 6;

/** A picture of this many parts or more is as wide as they come, for its film's length. */
export const PARTS_WIDE = 24;

/** The board is never more than this far behind the log: when more waits, the arrivals run faster. */
export const LAG_MAX_MS = 3500;

/** The fastest the arrivals run when the board is behind: beyond it, the oldest that wait simply land. */
export const RATE_MAX = 3;

/** How long an arrival that waits its turn is reckoned to take, before it is planned. */
export const ARRIVAL_GUESS_MS = ARRIVAL_SMALL_MS;

/** The pictures of one post are drawn at once, each by its own cursor, each this long after the one before began: a beat apart, not in a burst. */
export const HAND_STAGGER_MS = 140;

/** At most this many pictures are drawn at once, each by its own cursor: more wait for a cursor to be free. */
export const HANDS_MAX = 4;

/** The pictures of a post wait for the camera to stop before they are drawn on, but never longer than this: a little over the camera's reveal. */
export const GATE_MAX_MS = 700;

/* ------------------------------------------------------------------ the board */

/** The camera brings a new picture into view over this long, easing both ways: nobody holds it. */
export const CAMERA_REVEAL_MS = 560;

/** After a film, its cursor is still this long before it takes the next picture that waits. */
export const STILL_AFTER_MS = 150;

/* ------------------------------------------------------------------ durations by size */

/** How long the cursor takes to travel this far on the screen, in pixels: longer for a longer trip, from 320 to 750 ms. */
export function travelMs(distancePx: number): number {
  const table = CURSOR_TRAVEL_BY_DISTANCE;
  const first = table[0]!;
  if (!(distancePx > first[0])) return first[1];
  for (let i = 1; i < table.length; i++) {
    const [px, ms] = table[i]!;
    if (distancePx <= px) {
      const [px0, ms0] = table[i - 1]!;
      return ms0 + ((ms - ms0) * (distancePx - px0)) / (px - px0);
    }
  }
  return table[table.length - 1]![1];
}

/** How long a line this long on the screen, in pixels, takes to be drawn on: from 80 ms for a flick to 650 ms. */
export function lineMs(lengthPx: number): number {
  if (lengthPx < LINE_SHORT_PX) {
    const tiny = (lengthPx - LINE_TINY_PX) / (LINE_SHORT_PX - LINE_TINY_PX);
    return LINE_TINY_MS + (LINE_MIN_MS - LINE_TINY_MS) * (tiny > 0 ? tiny : 0);
  }
  const share = (lengthPx - LINE_SHORT_PX) / (LINE_LONG_PX - LINE_SHORT_PX);
  return LINE_MIN_MS + (LINE_MAX_MS - LINE_MIN_MS) * (share > 0 ? Math.min(1, share) : 0);
}

/** How long a pull this long on the screen, in pixels, takes: from 320 to 600 ms. */
export function pullMs(lengthPx: number): number {
  const share = (lengthPx - PULL_SHORT_PX) / (PULL_LONG_PX - PULL_SHORT_PX);
  return PULL_MIN_MS + (PULL_MAX_MS - PULL_MIN_MS) * (share > 0 ? Math.min(1, share) : 0);
}
