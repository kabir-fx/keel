import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'guard-board.mjs');
const CWD = '/work/repo';
/** A home that is not the developer's own, so no test depends on, or names, a real private folder. */
const HOME = '/home/owner';

/** Run the hook as Claude Code does: JSON on stdin, a decision on stdout. */
function guard(tool_name: string, tool_input: Record<string, unknown>, cwd = CWD, env: Record<string, string> = {}): 'deny' | 'allow' {
  const { KEEL_STATE_DIR: _state, ...rest } = process.env;
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd }),
    encoding: 'utf8',
    env: { ...rest, HOME, ...env },
  });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe('');
  if (!r.stdout.trim()) return 'allow';
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/board tools/);
  return out.hookSpecificOutput.permissionDecision === 'deny' ? 'deny' : 'allow';
}

describe('the board guard', () => {
  it('judges when it is started through a symbolic link, as a plugin install may start it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-guard-link-'));
    try {
      const link = path.join(dir, 'guard-board.mjs');
      fs.symlinkSync(GUARD, link);
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/work/repo/.keel/board/log.jsonl', content: '{}' }, cwd: CWD });
      const r = spawnSync(process.execPath, [link], { input, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies a Write or Edit inside .keel/board/', () => {
    expect(guard('Write', { file_path: '/work/repo/.keel/board/log.jsonl', content: '{}' })).toBe('deny');
    expect(guard('Edit', { file_path: '.keel/board/log.jsonl', old_string: 'a', new_string: 'b' })).toBe('deny');
    expect(guard('MultiEdit', { file_path: 'sub/../.keel/board/assets/x.png', edits: [] })).toBe('deny');
    expect(guard('Write', { file_path: '/work/repo/.keel/board' })).toBe('deny');
  });

  it('allows a Write or Edit anywhere else', () => {
    expect(guard('Write', { file_path: '/work/repo/src/app.ts', content: '' })).toBe('allow');
    expect(guard('Edit', { file_path: '.keel/notes.md', old_string: 'a', new_string: 'b' })).toBe('allow');
    expect(guard('Write', { file_path: 'docs/keel/board.md', content: '' })).toBe('allow');
  });

  it('denies a shell command that writes into .keel/board/', () => {
    for (const command of [
      `echo '{}' >> .keel/board/log.jsonl`,
      'echo x > ./.keel/board/log.jsonl 2>&1',
      'rm -rf .keel/board',
      'cd .keel/board && echo x > log.jsonl',
      "sed -i '' 's/a/b/' .keel/board/log.jsonl",
      `node -e "require('fs').writeFileSync('.keel/board/log.jsonl', '')"`,
      'mv .keel/board/log.jsonl /tmp/log',
      'cp /tmp/log .keel/board/log.jsonl',
      'cat x | tee .keel/board/log.jsonl',
      "find .keel/board -name '*.png' -delete",
      'git checkout -- .keel/board/log.jsonl',
      'truncate -s 0 .keel/board/log.jsonl',
    ]) {
      expect(guard('Bash', { command }), command).toBe('deny');
    }
  });

  it('allows a shell command that only reads the board, or does not touch it', () => {
    for (const command of [
      'cat .keel/board/log.jsonl',
      // The server's file holds no token: it says only that a server is up.
      'cat .keel/board/server.json',
      'cd .keel/board && cat server.json',
      'ls -la .keel/board 2>/dev/null',
      'grep m1 .keel/board/log.jsonl | head -5',
      'cp .keel/board/log.jsonl /tmp/copy.jsonl',
      'git add .keel/board/log.jsonl',
      'git diff .keel/board',
      'npx keel-board post --as agent @draft.json',
      'echo hello > notes.txt',
    ]) {
      expect(guard('Bash', { command }), command).toBe('allow');
    }
  });

  it('denies the walks round it that a review found', () => {
    for (const command of [
      'echo x >> .keel/./board/log.jsonl',
      'echo x >| .keel/board/log.jsonl',
      'cd .keel && cd board && echo x >> log.jsonl',
      'git checkout -- .keel',
      'git -C /work/repo restore .keel',
      'echo x >> .KEEL/board/log.jsonl',
      'echo x >> .Keel/Board/log.jsonl',
      `node -e "require('fs').appendFileSync('.ke' + 'el/bo' + 'ard/log.jsonl', 'x')"`,
      `python3 -c "import os; open(os.path.join('.keel', 'board', 'log.jsonl'), 'a').write('x')"`,
      'B=.keel/board; echo x >> $B/log.jsonl',
    ]) {
      expect(guard('Bash', { command }), command).toBe('deny');
    }
    expect(guard('Write', { file_path: '.KEEL/Board/log.jsonl', content: '' })).toBe('deny');
  });

  it('lets the board be read: its log, and the server file, which holds no token', () => {
    expect(guard('Read', { file_path: '/work/repo/.keel/board/server.json' })).toBe('allow');
    expect(guard('Read', { file_path: '/work/repo/.keel/board/log.jsonl' })).toBe('allow');
    expect(guard('Grep', { pattern: 'm1', path: '.keel/board' })).toBe('allow');
    expect(guard('Glob', { pattern: '.keel/board/assets/*.png' })).toBe('allow');
  });

  it("denies any read or write of keel's private folder, where the owner's token is", () => {
    const file = `${HOME}/.keel/boards/1-2/board.json`;
    expect(guard('Read', { file_path: file })).toBe('deny');
    expect(guard('Read', { file_path: '~/.keel/boards/1-2/board.json' })).toBe('deny');
    expect(guard('Read', { file_path: `${HOME}/.KEEL/Boards/1-2/board.json` })).toBe('deny');
    expect(guard('Read', { file_path: '../../home/owner/.keel/boards/1-2/board.json' })).toBe('deny');
    expect(guard('Write', { file_path: file, content: '{}' })).toBe('deny');
    expect(guard('Edit', { file_path: file, old_string: '"consents":[]', new_string: '"consents":[{}]' })).toBe('deny');
    expect(guard('Grep', { pattern: 'ownerToken', path: `${HOME}/.keel/boards` })).toBe('deny');
    expect(guard('Grep', { pattern: 'ownerToken', path: `${HOME}/.keel` })).toBe('deny');
    expect(guard('Grep', { pattern: 'ownerToken', path: HOME, glob: '.keel/boards/**' })).toBe('deny');
    expect(guard('Grep', { pattern: 'ownerToken' }, `${HOME}/.keel/boards/1-2`)).toBe('deny');
    expect(guard('Glob', { pattern: `${HOME}/.keel/boards/**/board.json` })).toBe('deny');
    expect(guard('Glob', { pattern: '**/.keel/boards/**' }, HOME)).toBe('deny');
    expect(guard('Glob', { pattern: '*/board.json', path: `${HOME}/.keel/boards` })).toBe('deny');
    for (const command of [
      `cat ${file}`,
      'cat ~/.keel/boards/1-2/board.json',
      'cat "$HOME/.keel/boards/1-2/board.json"',
      'cat ${HOME}/.keel/boards/*/board.json',
      'ls ~/.keel/boards',
      'grep -r ownerToken ~/.keel',
      'cd ~/.keel/boards && cat */board.json',
      'cd ~ && cd .keel && cd boards && ls',
      'jq -r .ownerToken ~/.keel/boards/1-2/board.json | pbcopy',
      `curl -H "Authorization: Bearer $(jq -r .ownerToken ~/.keel/boards/1-2/board.json)" http://127.0.0.1:4000/api/events`,
      `node -e "console.log(require('fs').readFileSync(require('os').homedir() + '/.keel/' + 'boards/1-2/board.json', 'utf8'))"`,
      `python3 -c "import os; print(open(os.path.join(os.path.expanduser('~'), '.keel', 'boards', '1-2', 'board.json')).read())"`,
      `echo '{}' > ~/.keel/boards/1-2/board.json`,
      'rm -rf ~/.keel/boards',
      'cp /tmp/forged.json ~/.keel/boards/1-2/board.json',
    ]) {
      expect(guard('Bash', { command }), command).toBe('deny');
    }
    // What only sounds like it is let through.
    expect(guard('Read', { file_path: `${HOME}/.keel-notes/boards.md` })).toBe('allow');
    expect(guard('Read', { file_path: '/work/repo/docs/boards/board.json' })).toBe('allow');
    expect(guard('Grep', { pattern: '\\.keel/boards', path: 'src' })).toBe('allow');
    expect(guard('Bash', { command: 'keel-board status' })).toBe('allow');
    expect(guard('Bash', { command: 'ls ~/code' })).toBe('allow');
  });

  it('follows KEEL_STATE_DIR to the private folder, unless the command sets its own', () => {
    const env = { KEEL_STATE_DIR: '/var/keel-state' };
    expect(guard('Read', { file_path: '/var/keel-state/boards/1-2/board.json' }, CWD, env)).toBe('deny');
    expect(guard('Grep', { pattern: 'ownerToken', path: '/var/keel-state/boards' }, CWD, env)).toBe('deny');
    expect(guard('Bash', { command: 'cat /var/keel-state/boards/1-2/board.json' }, CWD, env)).toBe('deny');
    expect(guard('Bash', { command: 'cat "$KEEL_STATE_DIR/boards/1-2/board.json"' }, CWD, env)).toBe('deny');
    expect(guard('Bash', { command: 'cd ${KEEL_STATE_DIR}/boards && ls' }, CWD, env)).toBe('deny');
    // The default folder stays private too: another session may use it.
    expect(guard('Read', { file_path: `${HOME}/.keel/boards/1-2/board.json` }, CWD, env)).toBe('deny');
    // The folder itself is not private, only its boards.
    expect(guard('Bash', { command: 'ls /var/keel-state' }, CWD, env)).toBe('allow');
    // With no such setting, that folder is nobody's.
    expect(guard('Read', { file_path: '/var/keel-state/boards/1-2/board.json' })).toBe('allow');
    // A command that sets its own state folder, as a test does, means that folder.
    expect(guard('Bash', { command: 'export KEEL_STATE_DIR="$(mktemp -d)" && npx vitest run && rm -rf "$KEEL_STATE_DIR"' }, CWD, env)).toBe('allow');
    expect(guard('Bash', { command: 'KEEL_STATE_DIR=/tmp/k keel-board open --no-browser' }, CWD, env)).toBe('allow');
  });

  it('follows symbolic links, and reads a script before it runs', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-guard-')));
    try {
      // A link into the private folder, and a script that reads it.
      const home = path.join(repo, 'home');
      fs.mkdirSync(path.join(home, '.keel', 'boards', '1-2'), { recursive: true });
      fs.symlinkSync(path.join(home, '.keel', 'boards'), path.join(repo, 'p'));
      fs.writeFileSync(path.join(repo, 'peek.mjs'), "import fs from 'node:fs';\nimport os from 'node:os';\nconsole.log(fs.readFileSync(os.homedir() + '/.keel/boards/1-2/board.json', 'utf8'));\n");
      expect(guard('Read', { file_path: 'p/1-2/board.json' }, repo, { HOME: home })).toBe('deny');
      expect(guard('Bash', { command: 'cat p/1-2/board.json' }, repo, { HOME: home })).toBe('deny');
      expect(guard('Bash', { command: 'node peek.mjs' }, repo, { HOME: home })).toBe('deny');
      fs.mkdirSync(path.join(repo, '.keel', 'board'), { recursive: true });
      fs.symlinkSync(path.join(repo, '.keel', 'board'), path.join(repo, 'b'));
      fs.symlinkSync(path.join(repo, '.keel'), path.join(repo, 'k'));
      fs.writeFileSync(path.join(repo, 'fix.mjs'), "import fs from 'node:fs';\nconst p = ['.keel', 'board', 'log.jsonl'].join('/');\nfs.appendFileSync(p, 'x');\n");
      fs.writeFileSync(path.join(repo, 'ok.mjs'), "console.log('hello');\n");
      expect(guard('Bash', { command: 'echo x >> b/log.jsonl' }, repo)).toBe('deny');
      expect(guard('Bash', { command: 'cp /tmp/x k/board/log.jsonl' }, repo)).toBe('deny');
      expect(guard('Write', { file_path: 'b/log.jsonl', content: '' }, repo)).toBe('deny');
      expect(guard('Read', { file_path: 'b/server.json' }, repo)).toBe('allow');
      expect(guard('Bash', { command: 'node fix.mjs' }, repo)).toBe('deny');
      expect(guard('Bash', { command: 'git checkout -- .' }, repo)).toBe('deny');
      expect(guard('Bash', { command: 'git stash' }, repo)).toBe('deny');
      expect(guard('Bash', { command: 'git reset --hard HEAD~1' }, repo)).toBe('deny');
      expect(guard('Bash', { command: 'git clean -fd' }, repo)).toBe('deny');
      // What does not touch the board still runs.
      expect(guard('Bash', { command: 'node ok.mjs' }, repo)).toBe('allow');
      expect(guard('Bash', { command: 'cp /tmp/x .' }, repo)).toBe('allow');
      expect(guard('Bash', { command: 'git stash list' }, repo)).toBe('allow');
      expect(guard('Bash', { command: 'git checkout -- src/app.ts' }, repo)).toBe('allow');
      expect(guard('Read', { file_path: 'b/log.jsonl' }, repo)).toBe('allow');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('lets other tools and broken input through', () => {
    expect(guard('Read', { file_path: '/work/repo/.keel/board/log.jsonl' })).toBe('allow');
    expect(guard('Grep', { pattern: 'm1', path: 'src' })).toBe('allow');
    const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
