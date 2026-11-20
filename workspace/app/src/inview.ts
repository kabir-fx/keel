import type { BoardState, Box, Id } from '@keel/protocol';
import { currentChapter, liveItems } from '@keel/protocol';
import type { Camera } from './camera/camera';

/**
 * Which chapter the owner is looking at: the one at the middle of the screen. The item under the
 * middle says it (the smallest one, when items lie on one another: a note on a picture is the
 * more particular). With nothing under the middle, the nearest item on screen says it. With
 * nothing on screen, the chapter in work. The board pill and the watch panel follow it.
 */
export function chapterInView(state: BoardState, boxOf: (id: Id) => Box | undefined, cam: Camera, room: Box): Id | undefined {
  const [rx, ry, rw, rh] = room;
  const wx = (rx + rw / 2 - cam.x) / cam.z;
  const wy = (ry + rh / 2 - cam.y) / cam.z;
  const reach = Math.max(rw, rh) / 2 / cam.z;
  let under: { chapter: Id; area: number } | undefined;
  let near: { chapter: Id; d: number } | undefined;
  for (const s of liveItems(state)) {
    const b = boxOf(s.item.id);
    if (!b || !state.chapters[s.chapter]) continue;
    const dx = Math.max(b[0] - wx, 0, wx - (b[0] + b[2]));
    const dy = Math.max(b[1] - wy, 0, wy - (b[1] + b[3]));
    if (dx === 0 && dy === 0) {
      const area = b[2] * b[3];
      if (!under || area < under.area) under = { chapter: s.chapter, area };
      continue;
    }
    const d = Math.hypot(dx, dy);
    if (d <= reach && (!near || d < near.d)) near = { chapter: s.chapter, d };
  }
  return under?.chapter ?? near?.chapter ?? currentChapter(state);
}

/** Where each chapter starts on the board: its first item that has a place. */
export function chapterStarts(state: BoardState, boxOf: (id: Id) => Box | undefined): Array<{ chapter: Id; item: Id; box: Box }> {
  const out: Array<{ chapter: Id; item: Id; box: Box }> = [];
  const done = new Set<Id>();
  for (const s of liveItems(state)) {
    if (done.has(s.chapter) || !state.chapters[s.chapter]) continue;
    const b = boxOf(s.item.id);
    if (!b) continue;
    done.add(s.chapter);
    out.push({ chapter: s.chapter, item: s.item.id, box: b });
  }
  return out;
}
