import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decide, differences, level, newest, nextVersion } from './next.mjs';

describe('what the pipeline does with the staged package', () => {
  // main: a - b - c. 0.1.0 was built from b. `side` is on another history.
  const after = { a: ['b', 'c'], b: ['c'], c: [], side: [] };
  const facts = (over) => ({
    previous: '0.1.0',
    built: 'b',
    live: true,
    head: 'c',
    comesAfter: (older, newer) => after[older].includes(newer),
    changed: () => ['server/dist/keel-board.js'],
    messages: () => ['feat(server): x'],
    ...over,
  });
  const never = () => {
    throw new Error('not asked for');
  };

  it('publishes the next version when the package changed, stamped with the staged commit', () => {
    expect(decide(facts())).toMatchObject({ action: 'publish', version: '0.2.0', commit: 'c', previous: '0.1.0' });
    expect(decide(facts({ messages: () => ['fix: x'] }))).toMatchObject({ action: 'publish', version: '0.1.1' });
  });

  it('does nothing when the package holds what the newest version holds: a merge of documents', () => {
    expect(decide(facts({ changed: () => [], messages: never }))).toMatchObject({ action: 'none', previous: '0.1.0' });
  });

  it('does nothing on the commit the newest version was built from, and looks at no file', () => {
    expect(decide(facts({ head: 'b', changed: never, messages: never }))).toMatchObject({ action: 'none' });
  });

  it('promotes the newest version when it never became latest, from its own commit or a later one that ships the same', () => {
    expect(decide(facts({ live: false, head: 'b', changed: never }))).toMatchObject({ action: 'promote', version: '0.1.0', commit: 'b' });
    expect(decide(facts({ live: false, changed: () => [], messages: never }))).toMatchObject({ action: 'promote', version: '0.1.0', commit: 'b' });
  });

  it('publishes over a version that never became latest when the package changed since', () => {
    expect(decide(facts({ live: false }))).toMatchObject({ action: 'publish', version: '0.2.0', commit: 'c' });
  });

  it('does nothing from a commit older than the newest version, whether that version is latest or not', () => {
    expect(decide(facts({ head: 'a', changed: never }))).toMatchObject({ action: 'none' });
    expect(decide(facts({ head: 'a', live: false, changed: never }))).toMatchObject({ action: 'none' });
  });

  it('stops on a history that does not hold the commit npm names', () => {
    expect(() => decide(facts({ head: 'side', changed: never }))).toThrow(/does not come after it/);
  });
});

describe('what a commit message asks for', () => {
  it.each([
    ['feat(app): the agent is a figure', 'minor'],
    ['feat: the board workspace', 'minor'],
    ['fix(server): a push origin refuses leaves both sides as they were', 'patch'],
    ['chore(deps): bump ws', 'patch'],
    ['feat(protocol)!: the log gains a version line', 'major'],
    ['fix!: the port flag is --port', 'major'],
    ['refactor(server): one reader\n\nBREAKING CHANGE: the old log is not read', 'major'],
    ['refactor(server): one reader\n\nBREAKING-CHANGE: the old log is not read', 'major'],
    ['Merge pull request #5 from kabir-fx/feat/agent-motion-continuity', 'patch'],
    ['fix the thing', 'patch'],
    ['docs: say what a BREAKING CHANGE: footer does', 'patch'],
  ])('%s', (message, asked) => {
    expect(level(message)).toBe(asked);
  });
});

describe('the newest version on npm', () => {
  it('is the highest by number, not the last in the list or the longest', () => {
    expect(newest(['0.0.0-stage', '0.1.0'])).toBe('0.1.0');
    expect(newest(['0.9.0', '0.10.0', '0.2.11'])).toBe('0.10.0');
    expect(newest(['1.0.0', '0.12.4'])).toBe('1.0.0');
  });

  it('passes over a version with a suffix', () => {
    expect(newest(['0.1.0', '0.2.0-beta.1'])).toBe('0.1.0');
    expect(newest(['0.0.0-stage'])).toBeUndefined();
  });
});

describe('the next version', () => {
  it('raises the patch number for fixes and for commits that say nothing', () => {
    expect(nextVersion('0.1.0', ['fix(server): x', 'chore: y'])).toBe('0.1.1');
    expect(nextVersion('0.1.9', [])).toBe('0.1.10');
  });

  it('raises the minor number for a feature, and starts the patch number again', () => {
    expect(nextVersion('0.1.4', ['fix: x', 'feat(app): y'])).toBe('0.2.0');
    expect(nextVersion('2.3.4', ['feat: y'])).toBe('2.4.0');
  });

  it('raises the major number for a breaking change, from 1.0.0 on', () => {
    expect(nextVersion('1.4.2', ['feat!: x', 'fix: y'])).toBe('2.0.0');
  });

  it('never reaches 1.0.0 by itself: before it, a breaking change raises the minor number', () => {
    expect(nextVersion('0.9.3', ['feat!: x'])).toBe('0.10.0');
    expect(nextVersion('0.9.3', ['fix: x\n\nBREAKING CHANGE: y'])).toBe('0.10.0');
  });

  it('refuses a version that is not three plain numbers', () => {
    expect(() => nextVersion('0.0.0-stage', ['fix: x'])).toThrow(/not a plain version/);
    expect(() => nextVersion('v1.2.3', [])).toThrow(/not a plain version/);
  });
});

describe('what differs between two package folders', () => {
  const made = [];
  afterEach(() => {
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function pkg(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-next-test-'));
    made.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
  }

  const base = { 'package.json': { name: 'keel-workspace', version: '0.1.0', engines: { node: '>=22' } }, 'server/dist/keel-board.js': 'a', 'app/dist/index.html': '<html>' };

  it('is nothing when only the version and the commit differ', () => {
    const staged = pkg({ ...base, 'package.json': { ...base['package.json'], version: '0.0.0', gitHead: 'abc' } });
    expect(differences(staged, pkg(base))).toEqual([]);
  });

  it('names a file whose bytes changed', () => {
    expect(differences(pkg({ ...base, 'server/dist/keel-board.js': 'b' }), pkg(base))).toEqual(['server/dist/keel-board.js']);
  });

  it('names a file only one side holds, whichever side', () => {
    const more = pkg({ ...base, 'app/dist/assets/index-1.js': 'x' });
    expect(differences(more, pkg(base))).toEqual(['app/dist/assets/index-1.js']);
    expect(differences(pkg(base), more)).toEqual(['app/dist/assets/index-1.js']);
  });

  it('names package.json when a field other than the stamp changed', () => {
    const staged = pkg({ ...base, 'package.json': { ...base['package.json'], engines: { node: '>=24' } } });
    expect(differences(staged, pkg(base))).toEqual(['package.json']);
  });
});
