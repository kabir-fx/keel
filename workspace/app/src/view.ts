import type { Camera } from './camera/camera';
import type { ViewMode } from './chrome';

/**
 * Where the owner looks on a board, kept in this page's storage so a reload comes back to it:
 * the camera, and the Board or the Story. A board's server has its own port, so its own origin
 * and its own storage; the board's name keys it inside that too.
 */
export interface KeptView {
  camera: Camera;
  mode: ViewMode;
  /** The chapter the owner was looking at: in view again until they move. */
  chapter?: string;
}

const PREFIX = 'keel.view.';

export const viewKey = (board: string) => `${PREFIX}${board || 'board'}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function store(): Store | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The view kept for a board, if a sound one is kept. */
export function readView(key: string, s: Store | undefined = store()): KeptView | undefined {
  try {
    const raw = s?.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<KeptView>;
    const c = v.camera;
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    if (!c || !ok(c.x) || !ok(c.y) || !ok(c.z) || c.z <= 0) return undefined;
    return { camera: { x: c.x, y: c.y, z: c.z }, mode: v.mode === 'story' ? 'story' : 'board', ...(typeof v.chapter === 'string' ? { chapter: v.chapter } : {}) };
  } catch {
    return undefined;
  }
}

export function writeView(key: string, v: KeptView, s: Store | undefined = store()): void {
  try {
    // As it is: a reload comes back to exactly the same place.
    s?.setItem(key, JSON.stringify({ camera: { x: v.camera.x, y: v.camera.y, z: v.camera.z }, mode: v.mode, ...(v.chapter ? { chapter: v.chapter } : {}) }));
  } catch {
    // Storage can be full or blocked: the view is simply not kept.
  }
}
