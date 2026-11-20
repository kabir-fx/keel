/**
 * A flag a press writes straight onto things on the page while it lasts: the eraser's fade, the
 * lasso's light. It is an attribute the styles read, so nothing renders for it. React leaves an
 * attribute it did not write alone, so the flag stays when the thing draws again.
 *
 * The set of keys is what the press reached; a key whose thing is not on the page is in the set
 * all the same, with nothing to show.
 */
export class Flags {
  private readonly name: string;
  private readonly on = new Map<string, Element | undefined>();

  /** `name` is the attribute: `data-erasing`, `data-lassoed`. */
  constructor(name: string) {
    this.name = name;
  }

  /** Flag a thing, drawn in `el`. A thing flagged already keeps the element it was flagged on. */
  set(key: string, el: Element | undefined): void {
    if (this.on.has(key)) return;
    el?.setAttribute(this.name, '');
    this.on.set(key, el);
  }

  /** Take a thing's flag off. */
  unset(key: string): void {
    this.on.get(key)?.removeAttribute(this.name);
    this.on.delete(key);
  }

  has(key: string): boolean {
    return this.on.has(key);
  }

  /** What is flagged, in the order it was. */
  keys(): string[] {
    return [...this.on.keys()];
  }

  /** Take every flag off. */
  clear(): void {
    for (const key of this.keys()) this.unset(key);
  }
}
