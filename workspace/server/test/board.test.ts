import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCount } from '@keel/protocol';
import { Board, LOG_CHANGED, LOG_REPLACED } from '../src/board';
import { chapter, note, tempRepo } from './helpers';

describe('the board on disk', () => {
  it('opens a new board named after its folder', () => {
    const repo = tempRepo('ullm');
    const b = Board.open(repo);
    expect(b.state.name).toBe('ullm');
    expect(b.events.map((e) => [e.id, e.type, e.by])).toEqual([['e1', 'board.open', 'system']]);
    expect(fs.existsSync(path.join(repo, '.keel/board/assets'))).toBe(true);
    b.close();
  });

  it('appends one line per event, and tells its listeners', () => {
    const b = Board.open(tempRepo());
    const heard: string[] = [];
    b.subscribe((evs) => heard.push(...evs.map((e) => e.id)));
    const r = b.post([chapter(), note('m1', 'one engine, many requests')], 'owner');
    expect(r.ok).toBe(true);
    expect(heard).toEqual(['e2', 'e3']);
    const lines = fs.readFileSync(b.logPath, 'utf8').trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['e1', 'e2', 'e3']);
    expect(openCount(b.state)).toBe(1);
    b.close();
  });

  it('admits all drafts or none', () => {
    const b = Board.open(tempRepo());
    const before = fs.readFileSync(b.logPath, 'utf8');
    const r = b.post([chapter(), { ...note('m1', 'x'), chapter: 'nowhere' }, note('m2', 'y')], 'owner');
    expect(r).toMatchObject({ ok: false, rule: 'R7', index: 1 });
    expect(fs.readFileSync(b.logPath, 'utf8')).toBe(before);
    expect(b.state.seq).toBe(1);
    b.close();
  });

  it('reads back the same state after a restart', () => {
    const repo = tempRepo();
    const a = Board.open(repo);
    a.post([chapter(), note('m1', 'hello')], 'owner');
    a.post([{ type: 'answer', answers: ['m1'], read: 'A greeting.' }], 'agent');
    const state = a.state;
    a.close();
    const b = Board.open(repo);
    expect(b.state).toEqual(state);
    expect(b.problems).toEqual([]);
    b.close();
  });

  it('reports a broken line, still opens, never rewrites the file, and never reuses an id', () => {
    const repo = tempRepo();
    const a = Board.open(repo);
    a.post([chapter()], 'owner');
    a.post([note('m1', 'first')], 'owner');
    a.post([note('m2', 'second')], 'owner');
    a.close();
    const file = path.join(repo, '.keel/board/log.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    // Break e3, the note m1, in the middle of the file.
    lines[2] = lines[2]!.slice(0, 40);
    const broken = `${lines.join('\n')}\n`;
    fs.writeFileSync(file, broken);

    const b = Board.open(repo);
    expect(b.problems).toEqual([{ line: 3, reason: 'not JSON' }]);
    expect(b.state.items.m2).toBeDefined();
    expect(b.state.items.m1).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);

    const r = b.post([note('m3', 'third')], 'owner');
    expect(r.ok && r.events[0]!.id).toBe('e5');
    expect(fs.readFileSync(file, 'utf8').startsWith(broken)).toBe(true);
    b.close();
  });

  it('starts a new line when the last one was cut short', () => {
    const repo = tempRepo();
    const a = Board.open(repo);
    a.post([chapter()], 'owner');
    a.close();
    const file = path.join(repo, '.keel/board/log.jsonl');
    fs.appendFileSync(file, '{"id":"e3","at":"2026');
    const b = Board.open(repo);
    expect(b.problems).toHaveLength(1);
    const r = b.post([note('m1', 'after the cut')], 'owner');
    expect(r.ok && r.events[0]!.id).toBe('e4');
    const after = fs.readFileSync(file, 'utf8').split('\n');
    expect(after[2]).toBe('{"id":"e3","at":"2026');
    expect(JSON.parse(after[3]!).id).toBe('e4');
    b.close();
    const c = Board.open(repo);
    expect(c.state.items.m1).toBeDefined();
    c.close();
  });

  it('stops writing once its log file was replaced on disk, as a pull or a checkout does, and says so', () => {
    const repo = tempRepo();
    const said: string[] = [];
    const b = Board.open(repo, { log: (m) => said.push(m) });
    expect(b.post([chapter()], 'owner').ok).toBe(true);
    const file = path.join(repo, '.keel/board/log.jsonl');
    const before = fs.readFileSync(file, 'utf8');

    // Git writes a new file and gives it the old name: the board still holds the old one.
    fs.writeFileSync(`${file}.new`, before);
    fs.renameSync(`${file}.new`, file);
    const seq = b.state.seq;
    const r = b.post([note('m1', 'would be lost')], 'owner');
    expect(r).toEqual({ ok: false, rule: 'shape', reason: LOG_REPLACED, index: 0 });
    // Nothing was admitted, and nothing was written anywhere.
    expect(b.state.seq).toBe(seq);
    expect(b.state.items.m1).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // Said once, however many posts follow.
    expect(b.post([note('m2', 'nor this')], 'owner').ok).toBe(false);
    expect(said).toEqual([LOG_REPLACED]);
    b.close();
    // Opened again, the board reads the file that is there, and writes to it.
    const c = Board.open(repo);
    expect(c.post([note('m1', 'kept now')], 'owner').ok).toBe(true);
    c.close();
  });

  it('stops writing once another hand wrote into its log file, and when the file is gone', () => {
    const repo = tempRepo();
    const b = Board.open(repo);
    expect(b.post([chapter()], 'owner').ok).toBe(true);
    const file = path.join(repo, '.keel/board/log.jsonl');
    fs.appendFileSync(file, '{"id":"e3","at":"2026-11-17T10:00:00Z","by":"owner","type":"chapter.rename","chapter":"first-idea","title":"Not from the board"}\n');
    expect(b.post([note('m1', 'x')], 'owner')).toEqual({ ok: false, rule: 'shape', reason: LOG_CHANGED, index: 0 });
    b.close();

    const other = tempRepo();
    const c = Board.open(other);
    fs.rmSync(path.join(other, '.keel/board/log.jsonl'));
    expect(c.post([chapter()], 'owner')).toMatchObject({ ok: false, reason: LOG_REPLACED });
    c.close();
  });

  it('a draft the rules refuse is still refused by its rule, and an empty post is fine, whatever is on disk', () => {
    const repo = tempRepo();
    const b = Board.open(repo);
    fs.rmSync(path.join(repo, '.keel/board/log.jsonl'));
    expect(b.post([], 'owner')).toEqual({ ok: true, events: [] });
    expect(b.post([note('m1', 'no chapter yet')], 'owner')).toMatchObject({ ok: false, rule: 'R7' });
    b.close();
  });
});
