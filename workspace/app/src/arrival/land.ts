import type { Measuring } from '../board/measure';

/** The measuring functions that read where things are drawn on the page. */
const READS_THE_PAGE = ['measure', 'measureAll', 'targetBox', 'noteTarget'] as const;

/**
 * The board's measuring, landing every arrival before it reads the page. What a gesture measures
 * (what a stroke covers, where a note is anchored, what a pin hangs on) goes into the log, so it
 * is measured from the board at rest, never from a picture half drawn on.
 */
export function landFirst<M extends Pick<Measuring, (typeof READS_THE_PAGE)[number]>>(measuring: M, land: () => void): M {
  const out = { ...measuring };
  for (const name of READS_THE_PAGE) {
    const read = measuring[name] as (...args: unknown[]) => unknown;
    (out as Record<string, unknown>)[name] = (...args: unknown[]) => {
      land();
      return read(...args);
    };
  }
  return out;
}
