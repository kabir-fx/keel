import { beforeEach } from 'vitest';
import { reduceMotion } from './reducedMotion';

// Every test sees the camera land at once, as it did before the camera could glide. A test of
// the glide itself turns this off.
beforeEach(() => reduceMotion(true));
