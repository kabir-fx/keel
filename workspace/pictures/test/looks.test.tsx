import { cleanup, fireEvent, render } from '@testing-library/react';
import type { BlueprintPicture, PictureItem } from '@keel/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOK_ORDER, LOOK_WORD, Picture, lookOf } from '../src';
import { LOOK } from '../src/theme';
import { STRESS, examplesBoard } from './examples';
import { at, item } from './fixture';

afterEach(cleanup);

/** The fill of a part's own box, by its look. */
const boxFill = (c: HTMLElement, part: string, look: 'shelf' | 'built') =>
  c.querySelector(`[data-part="${part}"] rect[fill="${LOOK[look].fill}"]`);

describe('a part that was already there, and a part built here', () => {
  it('have their own looks and their own words', () => {
    expect(LOOK.shelf.fill).not.toBe(LOOK.built.fill);
    expect(LOOK_WORD.shelf).toBe('already there');
    expect(LOOK_WORD.built).toBe('built');
    expect(LOOK_ORDER.indexOf('shelf')).toBe(LOOK_ORDER.indexOf('built') + 1);
    const shelf = { state: 'built' as const, shelf: true, commit: 'pull request 11' };
    expect(lookOf(shelf)).toBe('shelf');
    // Built here and checked, even if the repository had an older one: built.
    expect(lookOf({ ...shelf, check: { cmd: 'make check', passed: true } })).toBe('built');
    const here = { state: 'built' as const, commit: 'eb39c5b', check: { cmd: 'make check', passed: true } };
    expect(lookOf(here)).toBe('built');
    expect(lookOf({ state: 'built', external: true })).toBe('outside');
  });

  it('are drawn apart in both views of the pipeline, with both words in the legend', () => {
    const { state } = at(6);
    for (const view of ['flat', 'layers'] as const) {
      const pipe = item(state, 'pipe');
      const { container, unmount } = render(<Picture item={{ ...pipe, picture: { ...pipe.picture, view } as PictureItem['picture'] }} state={state} />);
      expect(container.querySelector('[data-part="tokenizer"]')?.getAttribute('data-state')).toBe('shelf');
      expect(container.querySelector('[data-part="runner"]')?.getAttribute('data-state')).toBe('shelf');
      expect(container.querySelector('[data-part="request"]')?.getAttribute('data-state')).toBe('built');
      expect(boxFill(container, 'tokenizer', 'shelf')).not.toBeNull();
      expect(boxFill(container, 'tokenizer', 'built')).toBeNull();
      expect(boxFill(container, 'request', 'built')).not.toBeNull();
      // Only a part built here carries its commit.
      expect(container.querySelector('[data-part="request"]')?.textContent).toContain('658b4ec');
      expect(container.querySelector('[data-part="runner"]')?.textContent).not.toContain('pull request 11');
      const legend = container.querySelector('.kp-legend')!;
      expect(legend.querySelector('.k-state--shelf')?.textContent).toBe('already there');
      expect(legend.querySelector('.k-state--built')?.textContent).toBe('built');
      unmount();
    }
  });

  it('are drawn apart in the blueprint and on its track, and only built parts count as built', () => {
    const { state } = at(7);
    const { container } = render(<Picture item={item(state, 'blueprint')} state={state} />);
    expect(container.querySelector('[data-part="tokenizer"]')?.getAttribute('data-state')).toBe('shelf');
    expect(container.querySelector('[data-part="engine-loop"]')?.getAttribute('data-state')).toBe('built');
    expect(container.querySelector('.kp-legend .k-state--shelf')?.textContent).toBe('already there');
    expect(container.textContent).toContain('7 of 7 built');
    expect(container.querySelectorAll('.kp-track .k-state--built')).toHaveLength(7);
  });

  it('are drawn apart on the shelf, which says "already there"', () => {
    const { state } = at(2);
    const { container } = render(<Picture item={item(state, 'shelf')} state={state} />);
    const tiles = [...container.querySelectorAll('[data-sub^="tile:"]')];
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.getAttribute('data-state')).toBe('shelf');
      expect(t.className).toContain('kp-tile--shelf');
      expect(t.className).not.toContain('kp-tile--built');
    }
    expect(container.querySelector('.kp-shelf__legend')?.textContent).toBe('already there');
  });

  it('shows a focus on a part that was already there with its own word', () => {
    const { state } = examplesBoard();
    const f: PictureItem = { id: 'f', kind: 'picture', picture: { kind: 'focus', part: 'handler', summary: 'It was here first.' } };
    const { container } = render(<Picture item={f} state={state} />);
    expect(container.querySelector('.kp-focus__head .k-state')?.textContent).toBe('already there');
  });
});

describe('what the blueprint assumed', () => {
  const ASSUMED = ['A limit of 0 means no spending allowed.', 'Names match without case.'];
  const withAssumed = (bp: PictureItem, assumed?: string[]): PictureItem => {
    const p = { ...(bp.picture as BlueprintPicture) };
    if (assumed) p.assumed = assumed;
    else delete p.assumed;
    return { ...bp, picture: p };
  };

  it('stands in a section of its own, just above "Build this", with the words the owner must read', () => {
    const { state } = at(5);
    const { container } = render(<Picture item={withAssumed(item(state, 'blueprint'), ASSUMED)} state={state} onAct={() => {}} />);
    const section = container.querySelector('.kp-assumed')!;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('You did not say these. Each one can be wrong.');
    expect([...section.querySelectorAll('li')].map((l) => l.textContent)).toEqual(ASSUMED);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Build this')!;
    expect(button).toBeDefined();
    // The section comes before the button, and outside the two columns, so it is never missed.
    expect(section.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.nextElementSibling?.contains(button)).toBe(true);
    expect(section.closest('.kp-blueprint__body')).toBeNull();
  });

  it('makes each assumption a tap target, and strikes through one the owner crossed out', () => {
    const { state } = at(5);
    const bp = withAssumed(item(state, 'blueprint'), ASSUMED);
    const onAct = vi.fn();
    const { container, rerender } = render(<Picture item={bp} state={state} onAct={onAct} />);
    const lines = [...container.querySelectorAll('.kp-assumed li')];
    expect(lines.map((l) => l.getAttribute('data-sub'))).toEqual(['assumed:1', 'assumed:2']);
    fireEvent.click(lines[1]!);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith({ type: 'tap', item: 'blueprint', sub: 'assumed:2' });
    expect(lines[0]!.className).not.toContain('kp--crossed');
    rerender(<Picture item={bp} state={state} onAct={onAct} markings={{ crossed: ['assumed:1'], circled: ['assumed:2'] }} />);
    const [one, two] = [...container.querySelectorAll('.kp-assumed li')];
    expect(one!.className).toContain('kp--crossed');
    expect(one!.className).toContain('kp-assumed__item');
    expect(two!.className).toContain('kp--circled');
    expect(two!.className).not.toContain('kp--crossed');
  });

  it('shows nothing when the agent assumed nothing', () => {
    const { state } = at(5);
    for (const assumed of [undefined, []]) {
      const { container, unmount } = render(<Picture item={withAssumed(item(state, 'blueprint'), assumed)} state={state} />);
      expect(container.querySelector('.kp-assumed')).toBeNull();
      expect(container.textContent).not.toContain('You did not say these');
      unmount();
    }
  });

  it('draws the stress example on the board it was posted to', () => {
    const { state, items } = examplesBoard(true);
    expect(items).toEqual(expect.arrayContaining(Object.keys(STRESS)));
    const { container } = render(<Picture item={item(state, 'ex-blueprint-assumed')} state={state} />);
    expect(container.querySelectorAll('.kp-assumed li')).toHaveLength(3);
  });
});
