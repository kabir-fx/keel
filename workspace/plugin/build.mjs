// Bundle the board tools and the hosted link into files that run under plain `node`.
//   dist/board-mcp.js    the stdio MCP server: the board tools
//   dist/hosted-link.js  the agent link the board server loads with --link, and the builder beside it
//   dist/hosted-builder.js  the builder alone
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some dependencies are CommonJS: give the bundle a real `require` for the Node built-ins.
  banner: {
    js: "import { createRequire as __keelRequire } from 'node:module';\nconst require = __keelRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
};

await build({ ...common, entryPoints: [here('./src/mcp.ts')], outfile: here('./dist/board-mcp.js') });
await build({ ...common, entryPoints: [here('./src/hosted-link.ts')], outfile: here('./dist/hosted-link.js') });
await build({ ...common, entryPoints: [here('./src/hosted-builder.ts')], outfile: here('./dist/hosted-builder.js') });
