import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARROW_LINE, BOX_LINE, LASSO_LINE, PIN_SIZE, PIN_TIP, pinIcon } from '../src/markSizes';

/**
 * The sizes the owner's marks are drawn at (`src/markSizes.ts`) are what the styles draw: the
 * code that finds a line under the pointer, or under the eraser, and the line itself agree.
 */

/** The styles of the marks, with their comments taken out. */
const css = readFileSync(join(__dirname, '../src/styles/marks.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the one rule with exactly this selector. */
function rule(selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.trim() === selector);
  if (found.length !== 1) throw new Error(`${found.length} rules for "${selector}" in marks.css`);
  return found[0]![2]!;
}

/** A number a rule sets, read by a pattern with one group. */
function numberIn(selector: string, pattern: RegExp): number {
  const m = pattern.exec(rule(selector));
  if (!m) throw new Error(`"${selector}" in marks.css does not set ${pattern}`);
  return Number(m[1]);
}

describe('the sizes of the owner’s marks', () => {
  it('a drawn box’s line is its border in the styles', () => {
    expect(numberIn('.drawn-box', /border:\s*([\d.]+)px solid/)).toBe(BOX_LINE);
  });

  it('an arrow’s line is its stroke in the styles, and it keeps its width on screen at any zoom', () => {
    expect(numberIn('.line-mark > path', /stroke-width:\s*([\d.]+)/)).toBe(ARROW_LINE);
    expect(rule('.line-mark > path')).toContain('vector-effect: non-scaling-stroke');
  });

  it('a lasso’s line is its stroke in the styles', () => {
    expect(numberIn('.line-mark .line-mark--lasso', /stroke-width:\s*([\d.]+)/)).toBe(LASSO_LINE);
  });

  it('a pin’s icon stands on its point: the styles move it left and up by the tip’s place', () => {
    const m = /transform:\s*translate\(-([\d.]+)px,\s*-([\d.]+)px\)/.exec(rule('.pin__icon'));
    expect(m && [Number(m[1]), Number(m[2])]).toEqual([...PIN_TIP]);
  });

  it('a pin’s icon is a square with its tip on the pin’s point, counted from where its mark is drawn', () => {
    expect(pinIcon([100, 200, 0, 0], [0, 0])).toEqual([100 - PIN_TIP[0], 200 - PIN_TIP[1], PIN_SIZE, PIN_SIZE]);
    expect(pinIcon([100, 200, 50, 50], [30, 10])).toEqual([117, 186, 26, 26]);
  });
});
