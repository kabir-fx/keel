import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ROLE_ENV, builderMcpFromEnv, stopAllChecks } from './build-tools';
import { createBoardMcp } from './tools';

/**
 * The board tools as a stdio MCP server. The hosted link starts it with `KEEL_BOARD_URL`
 * and `KEEL_BOARD_TOKEN`. In the owner's own session the plugin's `.mcp.json` starts it,
 * and it finds the board through the board's private file. The builder starts it with
 * `KEEL_BOARD_ROLE=builder`, and gets the builder's tools instead.
 */
const builder = process.env[ROLE_ENV] === 'builder';
const server = builder ? builderMcpFromEnv() : createBoardMcp();

if (builder) {
  // A check never outlives the tools that started it: not when claude stops, not on a signal.
  const quit = () => {
    stopAllChecks();
    process.exit(0);
  };
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, quit);
  process.on('exit', () => stopAllChecks());
}

await server.connect(new StdioServerTransport());
