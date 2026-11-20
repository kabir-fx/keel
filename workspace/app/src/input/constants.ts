/**
 * Every threshold of the pointer, the keys and the wheel, in one place. Each says what it is.
 * The values are the board's own as they stood on 2026-11-18; a package that changes one says
 * here where the new value came from.
 */

/** A press that moves no further than this from where it went down, in screen pixels, is a click. */
export const CLICK_SLOP = 4;

/**
 * A press held back on a control inside an item (a picture's button) becomes the tool's once it
 * has gone further than this from where it went down, in screen pixels. Up to it, the press is
 * a click for the control. Excalidraw's `DRAGGING_THRESHOLD` (packages/common/src/constants.ts).
 */
export const CONTROL_SLOP = 10;

/** How near a line mark (ink, an arrow, a lasso) a click must be to select it, in screen pixels. */
export const LINE_SLOP = 8;

/** The strokes of one go become one ink mark when the pen has been up this long, in ms. */
export const PEN_PAUSE = 700;

/**
 * A go of the pen that reaches this many strokes is made into marks at once, without the pause:
 * the contract takes no more in one mark. A stroke that fills up and carries on in a new one can
 * bring a go to it while the pen is still down; the strokes before are made into marks there.
 */
export const GO_MAX_STROKES = 120;

/**
 * A pen sample nearer than this to the last one kept is dropped, in screen pixels at the zoom
 * the stroke began at. The board's own 1.5, which was counted in board units: at 400% that kept
 * a point only every 6 pixels, and a curve was saved as corners.
 */
export const INK_MIN_GAP = 1.5;

/**
 * A stroke keeps at most this many points: the contract allows a stroke 6,000 numbers. A stroke
 * that fills up ends there, and the pen carries on in a new stroke of the same go from its last
 * point: no point is let go, so the line does not thin under the hand.
 */
export const STROKE_MAX_POINTS = 3000;

/**
 * A stroke that carries on from a full one begins this many points back along it, under its ink.
 * perfect-freehand works a line's width up from its first points, so a stroke begun at the join
 * came out about 12% narrower for its first 15 px; begun 24 points back, the line comes out from
 * under the full one within 1.3% of its width. The board's own, measured on a steady hand.
 */
export const STROKE_JOIN_POINTS = 24;

/**
 * A stroke whose two ends are this near each other when the pen lifts, in screen pixels, is
 * closed: its last point is put on its first. Excalidraw's `LINE_CONFIRM_THRESHOLD`
 * (packages/common/src/constants.ts).
 */
export const LOOP_CLOSE = 8;

/**
 * Only a stroke that has travelled this far, in screen pixels, is closed. A shorter one is a
 * tick or a dash, and stays as drawn. The board's own: the shortest stroke that can be read as
 * a loop (`LOOP_MIN_DIAGONAL` times `LOOP_MIN_ROUND`).
 */
export const LOOP_MIN_TRAVEL = 36;

/**
 * A stroke is read from this many points, spaced evenly along it, so the speed of the hand does
 * not change what it is read as. Excalidraw's `RESAMPLE_N` (packages/element/src/convertToShape.ts).
 */
export const READ_POINTS = 64;

/**
 * Which way a stroke is heading at one of its read points is taken across this many of them, so
 * the wobble of a hand is not read as a turn. Excalidraw's `TURN_WINDOW` (convertToShape.ts).
 */
export const TURN_SPAN = 3;

/** A loop is at least this far from corner to corner, in screen pixels. The board's own 24, which was counted in board units. */
export const LOOP_MIN_DIAGONAL = 24;

/** A loop's shorter side is at least this share of its longer one: a flatter stroke is a line gone back on itself. The board's own. */
export const LOOP_MIN_ASPECT = 0.05;

/** A loop goes round: its path is at least this many times its corner-to-corner distance. The board's own. */
export const LOOP_MIN_ROUND = 1.5;

/** A loop comes back: its ends pass each other within this share of its corner-to-corner distance. The board's own. */
export const LOOP_MAX_GAP = 0.25;

/** A loop turns at least this much of one full turn, counting the turn that closes it. The board's own. */
export const LOOP_MIN_TURN = 0.8;

/** A straight stroke that can underline is longer than this from end to end, in screen pixels. The board's own 20, which was counted in board units. */
export const LINE_MIN_LENGTH = 20;

/**
 * A stroke whose path is shorter than this many times the chord between its ends is straight: a
 * lazy arc under a word, or a short hook as the hand lifts. The board's own rule from before the
 * reading was made the same at any speed (it allows an arc that bows about 0.3 of its length),
 * now measured on the read points, so a hand that wobbles fast is not taken for a bent one.
 */
export const LINE_MAX_BEND = 1.25;

/**
 * A stroke that wobbles is straight too, when, its tips left out, it strays from the chord
 * between its ends by no more than this share of the chord's length. Excalidraw's
 * `LINEAR_MAX_SHAFT_DEVIATION` (convertToShape.ts).
 */
export const LINE_MAX_BOW = 0.15;

/**
 * The tips of a stroke, left out when it is judged by how near it keeps to its chord: this share
 * of its path at each end, where a hand flicks or hooks as it lands or lifts, taken to the nearest
 * whole read point. Of the 63 steps between `READ_POINTS`, that is 9 at each end: 14.3% of the
 * path. The board's own; Excalidraw leaves out the points near the far tip only
 * (`ARROWHEAD_ZONE_RATIO`, convertToShape.ts).
 */
export const TIP_SHARE = 0.15;

/**
 * Between its tips, a stroke that keeps to its chord may come back along it by no more than this
 * share of the chord's length: further, and it has turned round, a scratch and not a line. The
 * board's own.
 */
export const LINE_MAX_BACK = 0.05;

/** Within this many degrees of level, a straight stroke runs across: it can underline. The board's own. */
export const UNDERLINE_MAX_DEG = 20;

/**
 * An underline is under a thing whose bottom edge is no further above the line than this, in
 * screen pixels at the zoom it was drawn at. The board's own 28, which was counted in board units.
 */
export const UNDER_GAP = 28;

/**
 * An underline may run up into the thing it is under by this much, in screen pixels at the zoom
 * it was drawn at, and by no more than `UNDER_INTO_SHARE` of the thing's height. The board's own
 * 14, which was counted in board units.
 */
export const UNDER_INTO = 14;

/** An underline runs up into the thing it is under by no more than this share of its height. The board's own. */
export const UNDER_INTO_SHARE = 0.5;

/** An underline and the thing it is under share at least this much of the shorter one's width. The board's own. */
export const UNDER_ACROSS = 0.5;

/** Each stroke of a cross is longer than this from end to end, in screen pixels. The board's own 16, which was counted in board units. */
export const CROSS_MIN_LENGTH = 16;

/** A stroke of a cross may bend more than a line that underlines: a quick X is two arcs. The board's own, as `LINE_MAX_BEND` is. */
export const CROSS_MAX_BEND = 1.35;

/** The two strokes of a cross meet at least this many degrees apart: an X over a wide, low row is flat. The board's own. */
export const CROSS_MIN_DEG = 4;

/** The two strokes of a cross meet no nearer an end of either than this share of its length: nearer, it is a T or an L. The board's own. */
export const CROSS_MIDDLE = 0.15;

/** A tap that comes this soon after a drag is the end of the drag, not a tap, in ms. */
export const TAP_AFTER_DRAG_MS = 300;

/** A box drawn smaller than this on either side, in screen pixels, is dropped. */
export const MIN_BOX = 10;

/** An arrow drawn shorter than this, in screen pixels, is dropped, and an end dragged until its arrow is that short changes nothing. Excalidraw's `MINIMUM_ARROW_SIZE` (components/App.tsx). */
export const MIN_ARROW = 20;

/** A lasso with fewer points than this is a click, not a loop, and is dropped. */
export const MIN_LASSO_POINTS = 6;

/** One step of the zoom buttons and the zoom keys: the zoom is multiplied or divided by this. */
export const ZOOM_STEP = 1.25;

/** How fast the wheel zooms: one event multiplies the zoom by `exp(-deltaY * WHEEL_ZOOM_RATE)`. */
export const WHEEL_ZOOM_RATE = 0.01;

/**
 * The wheel's vertical delta is cut to this either way before it zooms, so one event zooms by
 * at most `exp(0.1)`, 10.5%: a mouse notch of 100 px no longer zooms by 2.7 times. From
 * Excalidraw's App.wheel.ts (`MAX_STEP`), on our multiplying zoom.
 */
export const WHEEL_MAX_ZOOM_DELTA = 10;

/** A wheel that counts in lines moves this many pixels a line. Excalidraw reads no lines; 16 px is a browser's line. */
export const WHEEL_LINE = 16;

/** How long the camera takes to glide to where it is going, in ms. From Excalidraw's App.viewport.ts. */
export const GLIDE_MS = 500;

/** How long it takes to glide to something new on the board, in ms: shorter, the owner asked for it. From Excalidraw. */
export const GLIDE_NEW_MS = 300;

/** A fit keeps this far from the edge of the board and from every panel, in screen pixels. From Excalidraw's App.viewport.ts. */
export const FIT_MARGIN = 24;

/**
 * A fit is never given a room smaller than this a side, in screen pixels, on a board that has
 * them: less is no room at all. The board's own, from the hand-written margins the measured room
 * replaced.
 */
export const FIT_MIN_ROOM = 200;

/**
 * Page Up and Page Down move the board by this share of its height, so an eighth of what was
 * in view stays in view: the step a browser pages by (Chrome's `kMinFractionToStepWhenPaging`).
 */
export const PAGE_STEP = 0.875;

/** The minimap's view box is never drawn smaller than this, in pixels, so it can still be seen and grabbed. From Excalidraw's Minimap. */
export const MINI_VIEW_MIN = 6;

/**
 * A field the owner types in (a note, a label) is this many times as tall as its text, so a
 * glyph that reaches past its line never makes the browser scroll the field under the hand.
 * From Excalidraw's textWysiwyg.tsx ("add 5% buffer otherwise it causes wysiwyg to jump").
 */
export const FIELD_ROOM = 1.05;

/** Tab in a field types this many spaces, and a pasted tab becomes as many. Excalidraw's TAB_SIZE (textWysiwyg.tsx). */
export const TAB_SPACES = 4;

/**
 * Words being typed are written to the browser's storage this long after a key, in ms, and at
 * once when the page is hidden: a few writes a second at most, never one a key. The board's
 * own: short enough that a crash loses a word at most.
 */
export const DRAFT_PAUSE_MS = 400;

/** The field for a label's words starts this wide, in world units: the width it always had. */
export const LABEL_MIN_WIDTH = 240;

/**
 * The field for a label's words grows with them up to this width, in world units, and then
 * wraps. The board's own: twice the starting width, about 40 letters of the hand a line.
 */
export const LABEL_MAX_WIDTH = 480;

/**
 * A change to a note posts a new height for it only when its paper is more than this far from
 * the height the note has, in world units: a pixel or two is the page's rounding, not a line
 * more or less. The board's own.
 */
export const NOTE_HEIGHT_SLACK = 2;

/**
 * Undo waits this long, in ms, for the marks of a step that are still to be posted: ink waits
 * for its snapshot, which is given up after 5 s. Past it, Undo takes back what has reached the
 * board, so a mark that never comes cannot hold Undo up for good. The board's own.
 */
export const STEP_WAIT_MS = 6000;

/** The line round what is selected is this wide, in screen pixels, at any zoom. Excalidraw's (renderer/interactiveScene.ts). */
export const SELECT_LINE = 1;

/** The line round what is selected keeps this far from the thing, in screen pixels, at any zoom. Excalidraw's (renderer/interactiveScene.ts). */
export const SELECT_PAD = 4;

/**
 * A resize handle is drawn this big, in screen pixels, and is grabbed inside the square it is
 * drawn in. Excalidraw's for a mouse (packages/element/src/transformHandles.ts).
 */
export const HANDLE_SIZE = 8;

/**
 * An edge of what can be resized is grabbed in a band this wide, in screen pixels, along the
 * line round it, with nothing drawn there. Excalidraw's `SIDE_RESIZING_THRESHOLD`
 * (packages/common/src/constants.ts).
 */
export const EDGE_BAND = 4;

/** A resized box is never smaller than this a side, in world units. The board's own: a box a word can still sit in. */
export const MIN_RESIZE_BOX = 24;

/** A resized note is never narrower than this, in world units. The board's own: about two words of the hand a line. */
export const MIN_NOTE_WIDTH = 120;

/**
 * An edge or a centre of what is moved or resized snaps to one of another thing in view within
 * this, in screen pixels, and so does an equal gap. Excalidraw's `SNAP_DISTANCE` (snapping.ts).
 */
export const SNAP_DISTANCE = 8;

/** An arrow key moves what is selected this far, in world units. Excalidraw's (packages/common/src/constants.ts). */
export const NUDGE = 1;

/** An arrow key with Shift moves what is selected this far, in world units. Excalidraw's. */
export const NUDGE_FAR = 5;

/**
 * A run of arrow-key presses is posted once the keys have rested this long, in ms: one change of
 * each thing, and one step for Undo, however many presses. The board's own: longer than a key's
 * repeat, short enough that the owner never waits for it.
 */
export const NUDGE_REST_MS = 500;

/**
 * The eraser reaches this far past the line of what it passes over, in screen pixels, on top of
 * half that line's width. Excalidraw's tolerance `max(2.25, 5 / zoom)` (eraser/index.ts).
 */
export const ERASER_REACH = 5;

/** The eraser never reaches less far than this, in board units, however far the board is zoomed in. Excalidraw's 2.25 (eraser/index.ts). */
export const ERASER_REACH_MIN = 2.25;

/** The eraser's trail is this wide either side of its line at its head, in screen pixels. Excalidraw's `EraserTrail` (eraser/index.ts). */
export const ERASER_TRAIL_SIZE = 5;

/** How far the eraser's trail lags the pointer to lose its wobble, from 0 to 1. Excalidraw's `EraserTrail`. */
export const ERASER_TRAIL_STREAMLINE = 0.2;

/** A point of the eraser's trail fades to nothing in this many ms. Excalidraw's `EraserTrail` (`DECAY_TIME`). */
export const ERASER_TRAIL_FADE_MS = 200;

/** The eraser's trail narrows to nothing over this many points back from its head. Excalidraw's `EraserTrail` (`DECAY_LENGTH`). */
export const ERASER_TRAIL_FADE_POINTS = 10;

/** The lasso's trail is this far either side of its line, in screen pixels: its dashes run along one side. Excalidraw's `LaserPointer` default size, which `LassoTrail` keeps. */
export const LASSO_TRAIL_SIZE = 2;

/** How far the lasso's trail lags the pointer to lose its wobble, from 0 to 1. Excalidraw's `LassoTrail` (lasso/index.ts). */
export const LASSO_TRAIL_STREAMLINE = 0.4;

/** The lasso's trail narrows over this many points back from its head: in practice, never. Excalidraw's `LassoTrail` (`DECAY_LENGTH`). */
export const LASSO_TRAIL_FADE_POINTS = 5000;

/**
 * While a lasso is drawn, what it holds is worked out from its path simplified to within this
 * many screen pixels, so a long loop costs no more a frame than a short one. Excalidraw's
 * `simplifyDistance` (lasso/index.ts).
 */
export const LASSO_SIMPLIFY = 5;

/** The first tooltip shows once the pointer has rested on a control this long, in ms. Excalidraw's `TOOLTIP_DELAY` (components/Tooltip.tsx). */
export const TOOLTIP_DELAY = 500;

/**
 * For this long after a tooltip closes, in ms, the next one shows at once: the owner who runs
 * along the toolbar reads each tool's name without waiting again. Excalidraw's
 * `TOOLTIP_WARM_WINDOW` (components/Tooltip.tsx).
 */
export const TOOLTIP_WARM = 300;

/**
 * An arrow's end ties to a thing it lands this near, in board units, at 100% and closer. Zoomed
 * out the reach grows, up to twice this, so a thing small on the screen is still easy to hit.
 * Excalidraw's `maxBindingDistance_simple` (packages/element/src/binding.ts).
 */
export const TIE_REACH = 15;

/** An end tied to a thing's outline stops this far short of it, in board units, and half the arrow's line more. Excalidraw's `BASE_BINDING_GAP` (binding.ts). */
export const TIE_GAP = 5;

/** A tied end drawn on its target's outline would leave the arrow this short or shorter, in board units: it is drawn at its spot instead. Excalidraw's `BASE_ARROW_MIN_LENGTH` (binding.ts). */
export const TIE_MIN_LENGTH = 10;

/** Shift holds an arrow being drawn to steps of this many degrees. Excalidraw's `SHIFT_LOCKING_ANGLE` (packages/common/src/constants.ts). */
export const ANGLE_STEP = 15;

/**
 * Each side of an arrowhead at full size, in board units. The board's own: the head it has always
 * had (sides of 11.5, as a marker on the line). Excalidraw's is 25; what comes from it is how a
 * head shrinks on a short arrow (`getArrowheadPoints`, packages/element/src/bounds.ts).
 */
export const ARROWHEAD = 12;

/** An arrowhead at full size opens this many degrees either side of the line. The board's own, as its head has always opened (24.6). Excalidraw's is 20. */
export const ARROWHEAD_ANGLE = 25;

/** A head shrunk to `ARROWHEAD_WIDEST_SIZE` or smaller, on a short arrow, opens this many degrees, so it does not fold into the line. Excalidraw's `ARROW_ARROWHEAD_WIDEST_ANGLE` (bounds.ts). */
export const ARROWHEAD_WIDEST_ANGLE = 30;

/** See `ARROWHEAD_WIDEST_ANGLE`, in board units: the same share of the full size as Excalidraw's `ARROW_ARROWHEAD_WIDEST_SIZE` is of its own (10 of 25, bounds.ts). */
export const ARROWHEAD_WIDEST_SIZE = 5;

/**
 * A tied arrow dragged by itself stays where it is, and keeps its ties, until the pointer has gone
 * further than this either way, in screen pixels: a click to select it never lets go of what it
 * points at. Excalidraw's `DRAGGING_THRESHOLD` (packages/element/src/dragElements.ts).
 */
export const ARROW_LET_GO = 10;

/** An end handle of the arrow selected is grabbed within this, in screen pixels, of the end. Excalidraw's point handle (`POINT_HANDLE_SIZE` and one more, linearElementEditor.ts). */
export const END_HANDLE_REACH = 11;

/** The outline round the thing an arrow's end would tie to is this wide, in screen pixels, at any zoom. Excalidraw's for a thin line (renderer/interactiveScene.ts). */
export const TIE_LINE = 2;
