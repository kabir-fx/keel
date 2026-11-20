import { z } from 'zod';

/**
 * A slug: lower-case letters, digits and hyphens.
 * Items, parts, lanes, walks, chapters and events all use it, so one list can name any of them.
 */
export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'an id is 1 to 48 characters of a-z, 0-9 and "-"')
  // The state keeps things in plain maps by id. A name every object already has, such as
  // "constructor", would look like something that exists.
  .refine((v) => !(v in Object.prototype), 'this word cannot be an id: choose another');
export type Id = z.infer<typeof Id>;

/** The log owner numbers events: e1, e2, e3. */
export const EventId = z.string().regex(/^e[1-9][0-9]{0,9}$/, 'an event id is "e" and a number');
export type EventId = z.infer<typeof EventId>;

/**
 * One thing inside a picture: "part:bridge", "step:5", "approach:b", "option:cap-door".
 * A renderer puts the same string on the element as `data-sub`, so the app can hit-test
 * without knowing what the picture is.
 */
export const Sub = z
  .string()
  .max(64)
  .regex(/^[a-z]+:[a-z0-9][a-z0-9-]*$/, 'a sub is "<kind>:<id>", for example "part:bridge"')
  .refine((v) => !(v.slice(v.indexOf(':') + 1) in Object.prototype), 'this word cannot be an id: choose another');
export type Sub = z.infer<typeof Sub>;

/** What a mark points at: an item, and optionally one thing inside it. */
export const Target = z.strictObject({ item: Id, sub: Sub.optional() });
export type Target = z.infer<typeof Target>;

/** A position on the board. Bounded, so that no item can be put where nobody can find it. */
export const Coord = z.number().min(-1_000_000).max(1_000_000);
const Size = z.number().min(0).max(100_000);

/** `[x, y, width, height]` in board units. */
export const Box = z.tuple([Coord, Coord, Size, Size]);
export type Box = z.infer<typeof Box>;

/**
 * What a mark was drawn against. `box` is where that thing was when the mark was made.
 * The app draws the mark moved and scaled so that `box` lands on where the thing is now.
 * So a circle stays round its approach when a picture is moved or redrawn. A note keeps
 * its size and only moves.
 */
export const Anchor = z.strictObject({ item: Id, sub: Sub.optional(), box: Box });
export type Anchor = z.infer<typeof Anchor>;

export const Point = z.tuple([Coord, Coord]);
export type Point = z.infer<typeof Point>;

export const Actor = z.enum(['owner', 'agent', 'system']);
export type Actor = z.infer<typeof Actor>;

/** A path under `.keel/board/`, for example "assets/m13.png". Never absolute, never upward. */
export const AssetPath = z
  .string()
  .max(160)
  .regex(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'an asset path is "assets/<file name>"');
export type AssetPath = z.infer<typeof AssetPath>;

/** The number in an event id: 12 for "e12". */
export function seqOf(eventId: string): number {
  return Number(eventId.slice(1));
}

/** The highest event number an id can carry. */
export const MAX_SEQ = 9_999_999_999;

export function subKind(sub: string): string {
  return sub.slice(0, sub.indexOf(':'));
}

export function subId(sub: string): string {
  return sub.slice(sub.indexOf(':') + 1);
}
