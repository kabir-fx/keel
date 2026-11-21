import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShowPlan } from '@keel/protocol';
import { FakeBoard } from './fake-board';

/** A board with one chapter the owner solidified and started: `parts` on the track, `check` agreed. */

export const BCH = 'adder';

export interface BuildBoardOptions {
  parts?: string[];
  check?: string;
  /** Leave out "Build this": the chapter stays solid. */
  noStart?: boolean;
  /** The chapter's name, set by the agent while it is an idea. */
  title?: string;
  /** Each part's plain words. */
  plain?: (id: string) => string;
  /** A note on each part, and the files it touches. */
  note?: (id: string) => string;
  files?: (id: string) => string[];
  /** The words of the blueprint's one pick. */
  pick?: string;
  /** What the owner pins on a part after the idea is decided. */
  remark?: { part: string; text: string };
  /** The blueprint's setup and show, agreed to with "Build this". */
  setup?: string;
  show?: ShowPlan;
}

export async function buildBoard(o: BuildBoardOptions = {}): Promise<FakeBoard> {
  const parts = o.parts ?? ['sum', 'cli', 'docs'];
  const b = await new FakeBoard().start();
  b.must('system', { type: 'board.open', name: 'toy' });
  b.must(
    'owner',
    { type: 'chapter.open', chapter: BCH, title: 'An adder' },
    { type: 'item.add', chapter: BCH, item: { id: 'm1', kind: 'note', box: [0, 0, 200, 100], text: 'A tiny adder with a command line' } },
  );
  b.must('agent', {
    type: 'model.patch',
    chapter: BCH,
    ops: parts.map((id) => ({
      op: 'part.set',
      part: { id, name: `The ${id}`, plain: o.plain?.(id) ?? `the ${id} part`, ...(o.note ? { note: o.note(id) } : {}), ...(o.files ? { files: o.files(id) } : {}) },
    })),
  });
  if (o.title) b.must('agent', { type: 'chapter.rename', chapter: BCH, title: o.title });
  b.must('agent', {
    type: 'item.add',
    chapter: BCH,
    item: {
      id: 'bp',
      kind: 'picture',
      answers: ['m1'],
      picture: {
        kind: 'blueprint',
        title: 'The blueprint',
        summary: 'Add two numbers, from the command line.',
        picks: [{ text: o.pick ?? 'A pure function and a thin command line', from: { item: 'm1' } }],
        leftOut: [{ text: 'No floats yet.', why: 'Integers are enough to try it.' }],
        proof: ['make check passes.'],
        parts,
        check: o.check ?? 'true',
        ...(o.setup ? { setup: o.setup } : {}),
        ...(o.show ? { show: o.show } : {}),
      },
    },
  });
  b.must('owner', { type: 'solidify', chapter: BCH, picks: ['bp'], parts });
  if (!o.noStart) b.must('owner', { type: 'build.start', chapter: BCH, track: parts, blueprint: 'bp', check: o.check ?? 'true', ...(o.setup ? { setup: o.setup } : {}), ...(o.show ? { show: o.show } : {}) });
  if (o.remark) {
    b.must('owner', { type: 'item.add', chapter: BCH, item: { id: 'pin1', kind: 'pin', box: [0, 0, 9, 9], at: [1, 1], on: { item: 'bp', sub: `part:${o.remark.part}` }, text: o.remark.text } });
  }
  return b;
}

export const sh = (cwd: string, cmd: string, ...args: string[]): string =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A git repository with one commit, and an identity of its own. */
export function makeRepo(dir: string, files: Record<string, string> = { 'README.md': '# toy\n' }): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git', 'init', '--quiet', '-b', 'main');
  sh(dir, 'git', 'config', 'user.name', 'Owner');
  sh(dir, 'git', 'config', 'user.email', 'owner@example.invalid');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '--quiet', '-m', 'first');
  return dir;
}
