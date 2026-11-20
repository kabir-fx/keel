import { afterEach, describe, expect, it } from 'vitest';
import { motionPlays } from '../src/motion/plays';
import { reduceMotion } from './reducedMotion';

const animate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');

afterEach(() => {
  if (animate) Object.defineProperty(Element.prototype, 'animate', animate);
});

describe('whether the board plays its motion', () => {
  it('does when the owner has not asked for less motion', () => {
    reduceMotion(false);
    expect(motionPlays()).toBe(true);
  });

  it('does not when the owner asks for reduced motion, and is asked again each time', () => {
    reduceMotion(true);
    expect(motionPlays()).toBe(false);
    reduceMotion(false);
    expect(motionPlays()).toBe(true);
  });

  it('does not on a page that cannot animate an element', () => {
    reduceMotion(false);
    delete (Element.prototype as { animate?: unknown }).animate;
    expect(motionPlays()).toBe(false);
  });
});
