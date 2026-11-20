/**
 * Whether the test page asks for reduced motion. Every test starts with it on (`setup.ts`), so
 * the camera lands at once, as a jump; a test of the camera's glide turns it off.
 */

interface HappyWindow {
  happyDOM: { settings: { device: { prefersReducedMotion: 'reduce' | 'no-preference' } } };
}

/** Ask for reduced motion, or stop asking. */
export function reduceMotion(on: boolean): void {
  (window as unknown as HappyWindow).happyDOM.settings.device.prefersReducedMotion = on ? 'reduce' : 'no-preference';
}
