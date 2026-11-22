import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '../src/board/toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the board\'s one line', () => {
  it('stays up for six seconds, and a new line starts the six seconds again', () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.say('first'));
    act(() => void vi.advanceTimersByTime(4000));
    act(() => result.current.say('second'));
    act(() => void vi.advanceTimersByTime(5999));
    expect(result.current.toast).toBe('second');
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.toast).toBeUndefined();
  });

  it('leaves no timer behind when the page that said it is gone', () => {
    const { result, unmount } = renderHook(() => useToast());
    act(() => result.current.say('first'));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
