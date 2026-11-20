import { describe, expect, it } from 'vitest';
import type { PictureKind } from '@keel/protocol';
import { PICTURE_KINDS, Presence } from '@keel/protocol';
import { KIND_NOTES, postKindSoFar, toolPresence, writingPresence } from '../src/presence';

/** A real `board_post` input, written out as the model might, and the first picture's kind in it. */
interface Case {
  name: string;
  input: string;
  kind: PictureKind | undefined;
  /** Where the first picture's kind is written: the input holds it whole from the end of this. */
  at?: RegExp;
}

const card = {
  pictures: [
    {
      picture: { kind: 'text', title: 'How I read your note', blocks: [{ kind: 'list', items: ['one', 'two'] }] },
      answers: ['m1'],
    },
  ],
};

// Keys in another order: the answers first, the kind after options that have kinds of their own.
const spread = {
  chapter: 'c1',
  pictures: [
    {
      answers: ['m1'],
      near: 'm1',
      picture: {
        title: 'Two ways',
        options: [
          { kind: 'lanes', title: 'Queue' },
          { kind: 'free', title: 'Screen' },
        ],
        kind: 'spread',
      },
    },
    { picture: { kind: 'mini', title: 'Later' } },
  ],
};

// A kind in the model, before the pictures, and a title that says "kind" inside a string.
const pipeline = {
  model: { parts: [{ id: 'p1', kind: 'text' }] },
  pictures: [{ picture: { title: 'say "kind": "mini"', kind: 'pipeline' }, answers: ['m2'] }],
};

const written = (name: string, value: object, kind: PictureKind, at: RegExp): Case[] => [
  { name: `${name}, compact`, input: JSON.stringify(value), kind, at },
  { name: `${name}, two spaces`, input: JSON.stringify(value, null, 2), kind, at },
  { name: `${name}, tabs`, input: JSON.stringify(value, null, '\t'), kind, at },
];

const CASES: Case[] = [
  ...written('a card', card, 'text', /"kind":\s*"text"/),
  ...written('a spread', spread, 'spread', /"kind":\s*"spread"/),
  ...written('a pipeline', pipeline, 'pipeline', /"kind":\s*"pipeline"/),
  {
    name: 'odd spacing and an escaped key',
    input: ' {\n "pictures" :[ \t{ "picture"\n:{ "k\\u0069nd"  :  "mini" , "title": "x"} } ] }',
    kind: 'mini',
    at: /"mini"/,
  },
  { name: 'a kind the contract does not know', input: JSON.stringify({ pictures: [{ picture: { kind: 'poster', title: 'x' } }] }), kind: undefined },
  { name: 'a first picture with no kind', input: JSON.stringify({ pictures: [{ picture: { title: 'x' } }, { picture: { kind: 'text' } }] }), kind: undefined },
  { name: 'a picture sent as a string', input: JSON.stringify({ pictures: [{ picture: '{"kind":"text"}' }] }), kind: undefined },
];

describe('the kind of the first picture, from the input written so far', () => {
  it.each(CASES)('$name: nothing until the kind is whole, then the right kind, at every cut', ({ input, kind, at }) => {
    // Every cut, from nothing to the whole input.
    const whole = at ? at.exec(input)!.index + at.exec(input)![0].length : input.length + 1;
    for (let i = 0; i <= input.length; i++) {
      expect(postKindSoFar(input.slice(0, i)), `cut at ${i}: ${JSON.stringify(input.slice(Math.max(0, i - 20), i))}`).toBe(i >= whole ? kind : undefined);
    }
  });

  it('every case is a real input: the whole of it is JSON, and toolPresence reads the same kind', () => {
    for (const c of CASES) {
      expect(() => JSON.parse(c.input)).not.toThrow();
      expect(toolPresence('board_post', c.input).note).toBe(c.kind ? KIND_NOTES[c.kind] : 'drawing');
    }
  });

  it('gives nothing for what is not a board_post input', () => {
    for (const s of ['', '{', '"', '\\', 'null', '[{"pictures":[{"picture":{"kind":"text"}}]}]', '{"pictures":{"picture":{"kind":"text"}}}', '}}]]"kind":"text"', '{"kind":"text"}', '{"pictures":[{"picture":{"kind":1,:"text"'])
      expect(postKindSoFar(s), s).toBeUndefined();
  });
});

describe('the words for a picture kind', () => {
  it('has a note for every kind the contract knows, each one a note the contract takes', () => {
    expect(Object.keys(KIND_NOTES).sort()).toEqual([...PICTURE_KINDS].sort());
    for (const note of Object.values(KIND_NOTES)) {
      expect(note.startsWith('drawing ')).toBe(true);
      expect(Presence.shape.note.safeParse(note).success).toBe(true);
    }
    expect(KIND_NOTES.text).toBe('drawing a card');
    expect(KIND_NOTES.mini).toBe('drawing a small picture');
  });
});

describe('presence while a call is written', () => {
  it('says what the tool does and names no place', () => {
    expect(writingPresence('mcp__board__board_post', '')).toEqual({ state: 'drawing', note: 'drawing' });
    expect(writingPresence('mcp__board__board_read', '')).toEqual({ state: 'drawing', note: 'reading the board' });
    expect(writingPresence('Glob', '{"pattern": "*.md"}')).toEqual({ state: 'drawing', note: 'reading the code' });
    expect(writingPresence('SomethingElse', '')).toEqual({ state: 'drawing' });
  });

  it('names the first picture of a board_post once its kind is whole, still with no place', () => {
    expect(writingPresence('mcp__board__board_post', '{"pictures":[{"answers":["m1"],"picture":{"kind":"tex')).toEqual({ state: 'drawing', note: 'drawing' });
    expect(writingPresence('mcp__board__board_post', '{"pictures":[{"answers":["m1"],"picture":{"kind":"text"')).toEqual({ state: 'drawing', note: 'drawing a card' });
    // Only for a board_post.
    expect(writingPresence('mcp__board__board_answer', '{"pictures":[{"picture":{"kind":"text"')).toEqual({ state: 'drawing', note: 'answering' });
  });

  it('says the same note as the whole call, which adds the cursor', () => {
    const input = { pictures: [{ picture: { kind: 'spread', title: 'x', options: [] }, answers: ['m1'] }] };
    const text = JSON.stringify(input);
    expect(toolPresence('mcp__board__board_post', input)).toEqual({ ...writingPresence('mcp__board__board_post', text), cursor: { item: 'm1' } });
    expect(toolPresence('mcp__board__board_post', input).note).toBe('drawing a spread');
  });
});
