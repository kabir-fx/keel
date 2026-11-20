import type { Box, InkItem } from '@keel/protocol';
import { pngOf, snapshotRegion } from '../dom';
import type { TargetRect } from '../geometry';
import { snapshotArea } from '../marks';
import type { BoardSource } from '../source';

/** A snapshot that takes longer than this is left out: the mark goes without it, in ms. */
const SNAPSHOT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take a PNG of an ink mark and what it covers, and store it with the board: the agent reads
 * the mark from it. `world` is the element that carries the camera's transform. Left out
 * (nothing is answered) where the board keeps no snapshots, and when it is slow or fails.
 */
export async function snapshotInk(world: HTMLElement | null, source: BoardSource, item: InkItem, rects: readonly TargetRect[]): Promise<string | undefined> {
  if (!source.snapshots || !world) return undefined;
  const targetBoxes = item.targets.map((t) => rects.find((r) => r.item === t.item && r.sub === t.sub)?.box).filter((b): b is Box => !!b);
  const region = snapshotArea(item.box, targetBoxes);
  const work = (async () => {
    const ratio = Math.min(2, 1600 / Math.max(region[2], region[3], 1));
    const canvas = await snapshotRegion(world, region, ratio);
    const png = await pngOf(canvas);
    if (!png) return undefined;
    const r = await source.upload(`${item.id}.png`, png);
    return r.ok ? r.asset : undefined;
  })().catch(() => undefined);
  return Promise.race([work, sleep(SNAPSHOT_MS).then(() => undefined)]);
}
