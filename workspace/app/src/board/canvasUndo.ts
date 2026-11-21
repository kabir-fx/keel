import type { Id } from '@keel/protocol';
import type { Undo } from '../undo';

/**
 * Undo by canvas: each canvas keeps its own list of steps, so Undo on the canvas in view takes
 * back only what the owner did there. A step done on another canvas waits there, and one done on
 * a canvas that was deleted is never posted. It wraps one `Undo` per canvas, made by `make` the
 * first time the canvas is in view; what a step's events answer goes to the list it began in.
 */
export function createCanvasUndo(make: () => Undo, canvas: () => Id | undefined): Undo & { forget(canvas: Id): void } {
  const lists = new Map<Id, Undo>();
  const now = (): Undo => {
    const key = canvas() ?? '';
    // What was done on a board with no canvas yet made its first one: the list goes with it.
    const before = lists.get('');
    if (key !== '' && before && !lists.has(key)) {
      lists.set(key, before);
      lists.delete('');
    }
    let u = lists.get(key);
    if (!u) lists.set(key, (u = make()));
    return u;
  };
  return {
    undo: () => now().undo(),
    redo: () => now().redo(),
    removeSelected: () => now().removeSelected(),
    record: (step) => now().record(step),
    steps: {
      begin: (draft, state) => now().steps.begin(draft, state),
      together: (ids) => now().steps.together(ids),
      notComing: (id) => now().steps.notComing(id),
    },
    /** A canvas that was deleted: its steps go with it. */
    forget: (gone) => {
      lists.delete(gone);
    },
  };
}
