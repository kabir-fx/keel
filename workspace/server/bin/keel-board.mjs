#!/usr/bin/env node
// keel-board: run the bundle when it is built, else the source through tsx.
// KEEL_BOARD_SOURCE=1 runs the source even when a bundle exists.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundle = new URL('../dist/keel-board.js', import.meta.url);

if (existsSync(fileURLToPath(bundle)) && !process.env.KEEL_BOARD_SOURCE) {
  await import(bundle.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import(new URL('../src/main.ts', import.meta.url).href);
}
