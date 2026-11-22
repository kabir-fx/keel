// A stand-in for `claude auth status --json` and `claude auth login`, with the words Claude
// Code 2.1.330 printed on 2026-11-21.
//   $FAKE_CLAUDE_AUTH names a file that is there when Claude Code is signed in.
//   $FAKE_CLAUDE_LOG gets one line for each start: its arguments and its environment's names.
//   `auth login` prints the sign-in page's address, then waits. The browser's approval is the
//   file "$FAKE_CLAUDE_AUTH.approve" coming to be. A code on its input signs in when it is
//   "good", and is refused in the real one's words when it is anything else.
//   $FAKE_CLAUDE_STATUS=junk: `auth status` prints words that are not its JSON.
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
// `claude --version`, in the real one's words. $FAKE_CLAUDE_VERSION stands in for an older one.
if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.330'} (Claude Code)\n`);
  process.exit(0);
}
const file = process.env.FAKE_CLAUDE_AUTH;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, pid: process.pid, env: Object.keys(process.env) })}\n`);
const signedIn = () => fs.existsSync(file);

if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_CLAUDE_STATUS === 'junk') {
    process.stdout.write('Something went wrong.\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(signedIn() ? { loggedIn: true, authMethod: 'claude.ai' } : { loggedIn: false, authMethod: 'none' }, null, 2)}\n`);
  process.exit(signedIn() ? 0 : 1);
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?code=true&client_id=fake\nPaste code here if prompted > ");
  const done = () => {
    fs.writeFileSync(file, 'signed in\n');
    process.stdout.write('\nLogin successful.\n');
    process.exit(0);
  };
  const watch = setInterval(() => {
    if (fs.existsSync(`${file}.approve`)) done();
  }, 20);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === 'good') return done();
    clearInterval(watch);
    process.stderr.write("Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n");
    process.exit(1);
  });
} else {
  process.stderr.write(`fake-claude-auth: not a command it knows: ${args.join(' ')}\n`);
  process.exit(2);
}
