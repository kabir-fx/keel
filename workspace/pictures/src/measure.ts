import { CHARS, WIDTHS } from './fontwidths';

/**
 * Text measurement from a table, not from the browser. A renderer lays SVG text out before it
 * is drawn, and it must give the same layout for the same spec everywhere: in a test with no
 * fonts, before the web fonts load, and at any zoom. The table holds Inter and Space Grotesk,
 * the faces the app loads. Kerning is left out, which makes a line a little wider than it
 * draws, never narrower.
 */

export type Face = keyof typeof WIDTHS;

export const FAMILY: Record<Face, string> = {
  ui400: 'Inter, system-ui, sans-serif',
  ui500: 'Inter, system-ui, sans-serif',
  ui600: 'Inter, system-ui, sans-serif',
  ui700: 'Inter, system-ui, sans-serif',
  head600: '"Space Grotesk", Inter, system-ui, sans-serif',
  head700: '"Space Grotesk", Inter, system-ui, sans-serif',
};

export const WEIGHT: Record<Face, number> = { ui400: 400, ui500: 500, ui600: 600, ui700: 700, head600: 600, head700: 700 };

const INDEX = new Map<string, number>([...CHARS].map((ch, i) => [ch, i]));
/** A character the table does not hold is taken as wide as a capital M would be at most. */
const UNKNOWN = 700;

/** The width of a line of text, in px. */
export function measure(text: string, face: Face, size: number): number {
  const table = WIDTHS[face];
  let units = 0;
  for (const ch of text) {
    const i = INDEX.get(ch);
    units += i === undefined ? UNKNOWN : (table[i] ?? UNKNOWN);
  }
  return (units * size) / 1000;
}

/**
 * Break text into lines no wider than `width`. A word breaks inside only when it alone is too
 * wide. Past `maxLines`, the last line ends with an ellipsis.
 */
export function wrap(text: string, width: number, face: Face, size: number, maxLines = 99): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const fits = (s: string) => measure(s, face, size) <= width;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    cur = '';
    if (fits(w)) {
      cur = w;
      continue;
    }
    let piece = '';
    for (const ch of w) {
      if (piece && !fits(piece + ch)) {
        lines.push(piece);
        piece = '';
      }
      piece += ch;
    }
    cur = piece;
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push('');
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] ?? '';
    while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

/** The widest of some lines. */
export function widest(lines: readonly string[], face: Face, size: number): number {
  let w = 0;
  for (const l of lines) w = Math.max(w, measure(l, face, size));
  return w;
}
