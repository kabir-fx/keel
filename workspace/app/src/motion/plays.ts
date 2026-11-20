import { prefersReducedMotion } from '../camera/motion';

/**
 * True when the board plays its motion: the page does not ask for reduced motion, and the
 * browser can animate an element (Web Animations).
 *
 * When it is false nothing is drawn on. A picture is simply there, the cursor and the camera
 * jump, and a picture the camera brings into view is announced the old way, with a blink. Every
 * part of the board that plays or announces asks here, so they always agree. Asked each time:
 * the owner can change the setting while the board is open.
 */
export function motionPlays(): boolean {
  return !prefersReducedMotion() && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}
