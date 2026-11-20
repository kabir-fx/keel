import { describe, expect, it } from 'vitest';
import { readView, viewKey, writeView } from '../src/view';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('the view kept per board', () => {
  it('writes the camera and the mode, and reads them back', () => {
    const s = store();
    writeView(viewKey('uLLM'), { camera: { x: 12.4, y: -300.6, z: 0.4567 }, mode: 'story', chapter: 'engine-loop' }, s);
    expect(readView(viewKey('uLLM'), s)).toEqual({ camera: { x: 12.4, y: -300.6, z: 0.4567 }, mode: 'story', chapter: 'engine-loop' });
    expect(readView(viewKey('another'), s)).toBeUndefined();
  });

  it('reads nothing from a broken or odd entry', () => {
    const s = store();
    s.setItem(viewKey('a'), '{not json');
    s.setItem(viewKey('b'), JSON.stringify({ camera: { x: 1, y: 2, z: 0 } }));
    s.setItem(viewKey('c'), JSON.stringify({ camera: { x: 'x', y: 2, z: 1 } }));
    for (const k of ['a', 'b', 'c']) expect(readView(viewKey(k), s)).toBeUndefined();
    expect(readView(viewKey('a'), undefined)).toBeUndefined();
  });

  it('keys a board with no name too', () => {
    expect(viewKey('')).toBe('keel.view.board');
  });
});
