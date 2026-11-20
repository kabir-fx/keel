import { run } from './cli';

/** The process entry of `keel-board`. `open` keeps running until a signal or `keel-board stop`. */

// A reader that stops early (`keel-board --help | head`) is not a failure of the command.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
  });
}

const result = await run(process.argv.slice(2));
const server = result.server;
if (server) {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`keel-board: ${signal}, stopping.\n`);
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
  process.on('exit', () => server.releaseSync());
  // "keel-board stop" asks the server over HTTP. When it has closed, the process ends.
  void server.closed.then(() => {
    if (!stopping) process.stderr.write('keel-board: stopped.\n');
    process.exit(0);
  });
} else {
  process.exitCode = result.code;
}
