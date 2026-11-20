import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '@keel/protocol';
import { PICTURE_KINDS, PictureSpec, admitAll, checkPicture, emptyState } from '@keel/protocol';
import { grammarSignatures, signatureOf } from '../src/signature';
import { ModelBody, modelOps } from '../src/tools';

/**
 * The grammar file cannot drift from the contract: every JSON example in it is parsed with
 * the contract's schemas and checked with its rules, and every keys line in it equals the
 * line generated from the schemas.
 */

const GRAMMAR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'board', 'grammar.md');
const text = fs.readFileSync(GRAMMAR, 'utf8');

/** Fenced blocks, with their info string: "json", "keys text", ... */
function blocks(md: string): Array<{ info: string; body: string; line: number }> {
  const out: Array<{ info: string; body: string; line: number }> = [];
  const re = /^```([^\n]*)\n([\s\S]*?)^```$/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    out.push({ info: m[1]!.trim(), body: m[2]!, line: md.slice(0, m.index).split('\n').length });
  }
  return out;
}

const all = blocks(text);
const examples = all.filter((b) => b.info === 'json').map((b) => ({ ...b, value: JSON.parse(b.body) as Record<string, unknown> }));
const keyLines = all.filter((b) => b.info.startsWith('keys '));

/**
 * A board for the examples: the owner's marks and an earlier spread that the blueprint's
 * picks come from, then every model example as a patch.
 */
function exampleBoard(): BoardState {
  const at = '2026-11-17T13:00:00Z';
  let state = emptyState();
  const step = (by: 'owner' | 'agent' | 'system', drafts: unknown[]) => {
    const r = admitAll(state, drafts, by, at);
    if (!r.ok) throw new Error(`setup refused under ${r.rule}: ${r.reason}`);
    state = r.state;
  };
  step('system', [{ type: 'board.open', name: 'photos' }]);
  step('owner', [
    { type: 'chapter.open', chapter: 'uploads', title: 'Fast uploads' },
    { type: 'item.add', chapter: 'uploads', item: { id: 'note-1', kind: 'note', box: [0, 0, 200, 80], text: 'Uploads feel slow. Make them instant.' } },
  ]);
  step('agent', [
    {
      type: 'item.add',
      chapter: 'uploads',
      item: { id: 'spread-1', kind: 'picture', answers: ['note-1'], picture: examples.find((e) => e.value.kind === 'spread')!.value },
    },
  ]);
  step('owner', [
    {
      type: 'item.add',
      chapter: 'uploads',
      item: { id: 'circle-1', kind: 'ink', box: [0, 0, 10, 10], strokes: [{ pts: [0, 0, 5, 5] }], targets: [{ item: 'spread-1', sub: 'approach:b' }], hint: 'circle' },
    },
  ]);
  for (const e of examples.filter((x) => x.value.kind === undefined)) {
    step('agent', [{ type: 'model.patch', chapter: 'uploads', ops: modelOps(ModelBody.parse(e.value)) }]);
  }
  return state;
}

describe('the grammar file', () => {
  it('has one example of every picture kind, and a model', () => {
    const kinds = examples.map((e) => e.value.kind).filter((k) => k !== undefined);
    expect([...kinds].sort()).toEqual([...PICTURE_KINDS].sort());
    expect(examples.some((e) => e.value.kind === undefined && Array.isArray(e.value.parts))).toBe(true);
  });

  it('every example passes the contract\'s schema and its rules', () => {
    const state = exampleBoard();
    for (const e of examples) {
      if (e.value.kind === undefined) continue; // the model, applied by exampleBoard
      const parsed = PictureSpec.safeParse(e.value);
      expect(parsed.success, `the ${String(e.value.kind)} example at line ${e.line}: ${parsed.error?.message}`).toBe(true);
      const verdict = checkPicture(state, parsed.data!);
      expect(verdict, `the ${String(e.value.kind)} example at line ${e.line}`).toEqual({ ok: true });
    }
  });

  it('every keys line is the one the contract\'s schemas give', () => {
    const want: Record<string, string> = { ...grammarSignatures(), model: signatureOf(ModelBody) };
    const seen = new Set<string>();
    for (const b of keyLines) {
      const name = b.info.slice('keys '.length);
      expect(want[name], `an unknown keys block "${name}" at line ${b.line}`).toBeDefined();
      // On a mismatch, paste the expected line into grammar.md.
      expect(b.body.trim(), `the keys line of "${name}" at line ${b.line}`).toBe(want[name]);
      seen.add(name);
    }
    expect([...seen].sort()).toEqual(Object.keys(want).sort());
  });

  it('names no picture kind the contract does not have', () => {
    for (const m of text.matchAll(/^## (\w[\w-]*):/gm)) {
      expect(PICTURE_KINDS as readonly string[]).toContain(m[1]);
    }
  });
});
