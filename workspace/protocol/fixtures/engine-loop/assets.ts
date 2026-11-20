import { deflateSync } from 'node:zlib';
import { sketchStrokes } from './draw';

/**
 * The files the log names. Both are small and real: the dropped file is the request path
 * of uLLM's own AGENT_ROADMAP.md (section 5.3), and the snapshot is the owner's sketch as a PNG.
 */

export const ROADMAP_EXCERPT = `### 5.3 Request path

client -> router -> API thread -> inbound queue -> ENGINE THREAD -> output queue -> API thread -> SSE -> client

ENGINE THREAD, one step, forever:
  1. drain the inbound queue (new tickets, abort tickets); never wait
  2. nothing to do -> sleep until a ticket arrives (no busy spin)
  3. scheduler: remove finished, make room for running, admit waiting (FCFS), choose prefill or decode
  4. runner: one forward pass, sample, mx.eval
  5. push text chunks to output queues; append telemetry events
`;

export const ROADMAP_BYTES = Buffer.byteLength(ROADMAP_EXCERPT);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** The sketch drawn at half size on the board's paper colour, as an 8-bit RGB PNG. */
export function sketchPng(): Buffer {
  const w = 400;
  const h = 190;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set([0xee, 0xf1, 0xf5], i * 3);
  const dot = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const X = Math.round(x) + dx;
        const Y = Math.round(y) + dy;
        if (X >= 0 && X < w && Y >= 0 && Y < h) px.set([0xc2, 0x41, 0x0c], (Y * w + X) * 3);
      }
  };
  for (const s of sketchStrokes()) {
    const pts = s.pts.map((v, i) => (i % 2 === 0 ? (v - 760) / 2 : (v - 210) / 2));
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [x0, y0, x1, y1] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]] as [number, number, number, number];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k <= n; k++) dot(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    }
  }
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Every asset of the fixture, by path under `.keel/board/`. */
export function makeAssets(): Record<string, Buffer> {
  return {
    'assets/AGENT_ROADMAP.md': Buffer.from(ROADMAP_EXCERPT),
    'assets/sketch.png': sketchPng(),
  };
}
