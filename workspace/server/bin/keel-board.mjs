#!/usr/bin/env node
// keel-board: run the bundle when it is built, else the source through tsx.
// KEEL_BOARD_SOURCE=1 runs the source even when a bundle exists.

// First, the Node version. This part is plain old syntax, so an old Node can run it.
var major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write('keel-board needs Node 22 or newer. This is Node ' + process.versions.node + '. Get it from https://nodejs.org.\n');
  process.exit(1);
}

async function main() {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const bundle = new URL('../dist/keel-board.js', import.meta.url);

  if (existsSync(fileURLToPath(bundle)) && !process.env.KEEL_BOARD_SOURCE) {
    await import(bundle.href);
  } else {
    const { register } = await import('tsx/esm/api');
    register();
    await import(new URL('../src/main.ts', import.meta.url).href);
  }
}

main();
