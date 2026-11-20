// Bundle the keel-board command into one file that runs under plain `node`.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here('./src/main.ts')],
  outfile: here('./dist/keel-board.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws loads these native speed-ups only when they are installed.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS: give the bundle a real `require` for the Node built-ins it asks for.
  banner: {
    js: "import { createRequire as __keelRequire } from 'node:module';\nconst require = __keelRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
});
