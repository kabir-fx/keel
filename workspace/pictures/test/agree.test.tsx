import { cleanup, fireEvent, render } from '@testing-library/react';
import type { BlueprintPicture, BoardState, Chapter, PictureItem, ShowPlan } from '@keel/protocol';
import type { PictureView } from '../src';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Picture } from '../src';
import { at, item } from './fixture';

afterEach(cleanup);

/**
 * What "Build this" agrees to, read before the press: the check, the setup and how the result
 * is tried (records 0007 and 0013), and where the build starts (record 0014, plan 5.7).
 */

const withPlan = (bp: PictureItem, plan: { setup?: string; show?: ShowPlan }): PictureItem => ({ ...bp, picture: { ...(bp.picture as BlueprintPicture), ...plan } });

/** The board with one more idea on the same canvas as the blueprint's, built. */
function withBuiltHere(state: BoardState): BoardState {
  const own = state.chapters['engine-loop']!;
  const calc: Chapter = { ...own, id: 'calc', title: 'Typing calculator', state: 'built', track: [], builtAt: '2026-11-20T11:00:00Z' };
  return { ...state, chapters: { ...state.chapters, calc }, chapterOrder: ['calc', ...state.chapterOrder] };
}

const HOME = { branch: 'main', commit: 'abc1234' };

const agrees = (c: HTMLElement) => c.querySelector('[data-testid="blueprint-agrees"]')!;
const buildThis = (c: HTMLElement) => [...c.querySelectorAll('button')].find((b) => b.textContent === 'Build this')!;

describe('what "Build this" agrees to', () => {
  it('lists the check, the setup and how the result is tried, and the press sends all three', () => {
    const { state } = at(5);
    const onAct = vi.fn();
    const bp = withPlan(item(state, 'blueprint'), { setup: 'npm ci', show: { kind: 'app', run: 'npm start' } });
    const { container } = render(<Picture item={bp} state={state} onAct={onAct} />);
    const list = agrees(container);
    expect(list.querySelector('h4')!.textContent).toBe('What “Build this” agrees to');
    expect([...list.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['make check', 'npm ci', 'npm start']);
    expect(list.querySelector('[data-agree="show"]')!.textContent).toContain('An app. When you press Try it, the board runs npm start in the build’s own copy');
    // The commands are read before the button.
    expect(list.compareDocumentPosition(buildThis(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(buildThis(container));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ type: 'build.start', check: 'make check', setup: 'npm ci', show: { kind: 'app', run: 'npm start' } }));
  });

  it('says each kind of show in words, and what happens when none is named', () => {
    const { state } = at(5);
    const words = (show?: ShowPlan) => {
      const { container } = render(<Picture item={withPlan(item(state, 'blueprint'), show ? { show } : {})} state={state} />);
      const t = agrees(container).querySelector('[data-agree="show"] dd')!.textContent;
      cleanup();
      return t;
    };
    expect(words({ kind: 'page' })).toBe('A page. It opens on the board, and nothing runs.');
    expect(words({ kind: 'terminal', run: 'node calc.js' })).toBe('A terminal. When you press Try it, the board opens one in the build’s own copy and types node calc.js.');
    expect(words({ kind: 'app', run: 'python app.py', port: 8000 })).toContain('shows it here, on port 8000.');
    expect(words()).toBe('Not named. The board shows a page when the build makes one, else a terminal with the check typed in.');
  });

  it('leaves the setup out when there is none, and sends none', () => {
    const { state } = at(5);
    const onAct = vi.fn();
    const { container } = render(<Picture item={item(state, 'blueprint')} state={state} onAct={onAct} />);
    expect(agrees(container).querySelector('[data-agree="setup"]')).toBeNull();
    fireEvent.click(buildThis(container));
    expect(Object.keys(onAct.mock.calls[0]![0] as object)).not.toContain('setup');
    expect(Object.keys(onAct.mock.calls[0]![0] as object)).not.toContain('show');
  });

  it('once it builds, says what was agreed, as the chapter holds it', () => {
    const { state } = at(6);
    const c = state.chapters['engine-loop']!;
    const agreed: BoardState = { ...state, chapters: { ...state.chapters, 'engine-loop': { ...c, setup: 'npm ci', show: { kind: 'terminal', run: 'make demo' } } } };
    const { container } = render(<Picture item={item(agreed, 'blueprint')} state={agreed} />);
    expect(agrees(container).querySelector('h4')!.textContent).toBe('What you agreed to with “Build this”');
    expect([...agrees(container).querySelectorAll('code')].map((x) => x.textContent)).toEqual(['make check', 'npm ci', 'make demo']);
    expect(container.querySelector('[data-testid="blueprint-start"]')).toBeNull();
  });
});

describe('a build whose last step is the app', () => {
  const building = (): BoardState => {
    const state = at(5).state;
    const own = state.chapters['engine-loop']!;
    const part = Object.keys(state.model.parts)[0]!;
    return {
      ...state,
      model: { ...state.model, parts: { ...state.model.parts, [part]: { ...state.model.parts[part]!, state: 'built', commit: 'abc1234' } } },
      chapters: { ...state.chapters, 'engine-loop': { ...own, state: 'building', paused: false, track: [part], check: 'npm test', show: { kind: 'app', run: 'npm start' } } },
    };
  };
  const says = (state: BoardState) => render(<Picture item={item(state, 'blueprint')} state={state} view={{}} onAct={vi.fn()} />).container.textContent;

  it('says the app is started once, and nothing about a part in work', () => {
    const text = says(building());
    expect(text).toContain('Every part is built. The app is started once before this counts as built.');
    expect(text).not.toContain('blue is where I am');
  });

  it('says it builds while a part is still to do', () => {
    const state = building();
    const part = state.chapters['engine-loop']!.track[0]!;
    const text = says({ ...state, model: { ...state.model, parts: { ...state.model.parts, [part]: { ...state.model.parts[part]!, state: 'solid' } } } });
    expect(text).toContain('Building. Filled parts are built, blue is where I am.');
  });
});

describe('where the build goes', () => {
  const line = (state: BoardState, build: PictureView['build'], onAct = vi.fn()) =>
    render(<Picture item={item(state, 'blueprint')} state={state} view={build ? { build } : {}} onAct={onAct} />).container.querySelector('[data-testid="blueprint-start"]');

  it('a canvas with no branch yet: from the home branch, on a branch of its own', () => {
    expect(line(at(5).state, { home: HOME, waiting: [] })!.textContent).toBe('This build starts from main at abc1234, on a branch of its own.');
  });

  it('a home branch with no commit yet, and nothing at all with no word from a server', () => {
    expect(line(at(5).state, { home: { branch: 'main' }, waiting: [] })!.textContent).toBe('This build starts from main, which has no commit yet, on a branch of its own.');
    cleanup();
    expect(line(at(5).state, undefined)).toBeNull();
  });

  it('a canvas that has a branch: the build goes onto it, with the ideas already there', () => {
    const state = withBuiltHere(at(5).state);
    expect(line(state, { home: HOME, branch: 'board/engine-loop', waiting: [] })!.textContent).toBe('This build goes onto this canvas’s branch, board/engine-loop, with “Typing calculator”.');
  });

  it('names an idea on another canvas that is built and not approved, and offers to try it first', () => {
    const onAct = vi.fn();
    const l = line(at(5).state, { home: HOME, waiting: [{ chapter: 'calc', title: 'Typing calculator' }] }, onAct)!;
    expect(l.textContent).toBe('This build starts from main at abc1234, on a branch of its own. “Typing calculator” is built and not approved yet, so this build will not have it. Try “Typing calculator” first');
    fireEvent.click(l.querySelector('button')!);
    expect(onAct).toHaveBeenCalledWith({ type: 'try', chapter: 'calc' });
  });

  it('an idea whose app runs says so, and one press opens it; one the board is busy with says why, with nothing to press', () => {
    const onAct = vi.fn();
    const l = line(at(5).state, { waiting: [{ chapter: 'calc', title: 'Typing calculator', running: true }] }, onAct)!;
    expect(l.querySelector('button')!.textContent).toBe('“Typing calculator” is running: open it');
    fireEvent.click(l.querySelector('button')!);
    expect(onAct).toHaveBeenCalledWith({ type: 'try', chapter: 'calc' });
    cleanup();
    const held = line(at(5).state, { waiting: [{ chapter: 'calc', title: 'Typing calculator', held: '“Typing calculator” can be tried once the builder is done with its canvas.' }] })!;
    expect(held.querySelector('button')).toBeNull();
    expect(held.querySelector('[data-held="calc"]')!.textContent).toBe('“Typing calculator” can be tried once the builder is done with its canvas.');
  });

  it('two of them are named together', () => {
    const l = line(at(5).state, { waiting: [{ chapter: 'a', title: 'A' }, { chapter: 'b', title: 'B' }] })!;
    expect(l.textContent).toContain('“A” and “B” are built and not approved yet, so this build will not have them.');
    expect(l.querySelectorAll('button')).toHaveLength(2);
  });
});
