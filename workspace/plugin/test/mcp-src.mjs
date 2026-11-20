// The board tools from source, for tests that start them as a process: tsx compiles them on load.
import { register } from 'tsx/esm/api';

register();
await import('../src/mcp.ts');
