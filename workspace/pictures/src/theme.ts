import type { Part, PartState } from '@keel/protocol';
import { alreadyThere } from '@keel/protocol';

/**
 * The tokens of roadmap section 7, for SVG drawing. HTML parts of a picture use the CSS
 * variables in styles.css, which hold the same values.
 */
export const T = {
  ink: '#0F1B2D',
  fill: '#1B2A44',
  text2: '#46536A',
  line: '#D5DAE3',
  grey: '#8E99AB',
  grey2: '#C3CAD6',
  light: '#F4F6F9',
  light2: '#E4E9F2',
  ground: '#EEF1F5',
  agentBg: '#E8EEFF',
  agentLine: '#AFC0F5',
  agentPale: '#F1F4FF',
  blue: '#1D4ED8',
  teal: '#0F766E',
  tealLight: '#D5F0EC',
  tealMid: '#9AD3CB',
  tealDark: '#0B5A54',
  white: '#FFFFFF',
  owner: '#C2410C',
  ownerBg: '#FFF0E0',
} as const;

/**
 * How a part is drawn: the states of section 7, `building` in blue, `shelf` for a part the
 * repository had before the board (it exists, but nobody built or checked it here), and
 * `outside` for an external part. A part built here is filled dark only when its check passed.
 */
export type Look = PartState | 'shelf' | 'outside';

export interface LookStyle {
  /** The front face, the top face and the side face of a block. */
  fill: string;
  top: string;
  side: string;
  stroke: string;
  width: number;
  dash?: string;
  text: string;
  sub: string;
  glow?: boolean;
  /** The word the legend uses. */
  label: string;
}

/** "Already there": filled like a built part, so it reads as existing, but lighter, so it never counts as built here. */
export const SHELF_FILL = '#5E6E8A';

export const LOOK: Record<Look, LookStyle> = {
  idea: { fill: T.white, top: T.white, side: T.light, stroke: T.ink, width: 2, dash: '6 4', text: T.ink, sub: T.text2, label: 'idea' },
  solid: { fill: T.white, top: T.light, side: T.light2, stroke: T.ink, width: 2.5, text: T.ink, sub: T.text2, label: 'solid' },
  building: { fill: T.agentBg, top: '#F2F5FF', side: '#D6E0FF', stroke: T.blue, width: 2.5, text: T.ink, sub: T.blue, glow: true, label: 'in work' },
  built: { fill: T.fill, top: '#2E3F5E', side: T.ink, stroke: T.fill, width: 2, text: T.white, sub: '#C9D2E3', label: 'built' },
  shelf: { fill: SHELF_FILL, top: '#7A89A3', side: '#4A5974', stroke: SHELF_FILL, width: 2, text: T.white, sub: '#E4E9F2', label: 'already there' },
  later: { fill: T.ground, top: T.light, side: T.light2, stroke: T.grey2, width: 1.5, text: T.grey, sub: T.grey, label: 'later' },
  outside: { fill: T.white, top: T.white, side: T.light, stroke: T.grey, width: 1.25, text: T.text2, sub: T.grey, label: 'outside' },
};

/** The word for each look, for a legend or a count in the app. */
export const LOOK_WORD: Record<Look, string> = Object.fromEntries(Object.entries(LOOK).map(([k, v]) => [k, v.label])) as Record<Look, string>;

/**
 * The look of a part. A part the repository had before the board (`shelf`) that was not
 * built and checked here is "already there", not "built".
 */
export function lookOf(part: Pick<Part, 'state' | 'external' | 'shelf' | 'check'>): Look {
  if (part.external) return 'outside';
  if (alreadyThere(part)) return 'shelf';
  return part.state;
}

/** The order the legend lists the looks in. */
export const LOOK_ORDER: readonly Look[] = ['built', 'shelf', 'building', 'solid', 'idea', 'later', 'outside'];
