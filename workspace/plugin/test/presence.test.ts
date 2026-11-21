import { describe, expect, it } from 'vitest';
import type { PictureKind } from '@keel/protocol';
import { PICTURE_KINDS, Presence } from '@keel/protocol';
import { KIND_NOTES, postPictureSoFar, toolPresence, writingPresence } from '../src/presence';

/** A real `board_post` input, written out as the model might, and the first picture's kind and title in it. */
interface Case {
  name: string;
  input: string;
  kind: PictureKind | undefined;
  /** Where the first picture's kind is written: the input holds it whole from the end of this. */
  at?: RegExp;
  title?: string;
  /** Where the first picture's title is written: the input holds it whole from the end of this. */
  titleAt?: RegExp;
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

// The kind first, then options with titles of their own, then the picture's own title.
const spreadTitleLast = {
  pictures: [
    {
      picture: { kind: 'spread', options: [{ kind: 'lanes', title: 'Queue' }, { kind: 'free', title: 'Screen' }], title: 'Two ways' },
      answers: ['m1'],
    },
  ],
};

// A picture with no title of its own: the title of what it has made, and of the next picture, are not it.
const focus = {
  pictures: [{ picture: { kind: 'focus', part: 'p1', made: { title: 'Made so far' } } }, { picture: { kind: 'text', title: 'Later' } }],
};

// A kind in the model, before the pictures, and a title that says "kind" inside a string.
const pipeline = {
  model: { parts: [{ id: 'p1', kind: 'text' }] },
  pictures: [{ picture: { title: 'say "kind": "mini"', kind: 'pipeline' }, answers: ['m2'] }],
};

const written = (name: string, value: object, kind: PictureKind, at: RegExp, title?: string, titleAt?: RegExp): Case[] => [
  { name: `${name}, compact`, input: JSON.stringify(value), kind, at, title, titleAt },
  { name: `${name}, two spaces`, input: JSON.stringify(value, null, 2), kind, at, title, titleAt },
  { name: `${name}, tabs`, input: JSON.stringify(value, null, '\t'), kind, at, title, titleAt },
];

const CASES: Case[] = [
  ...written('a card', card, 'text', /"kind":\s*"text"/, 'How I read your note', /"title":\s*"How I read your note"/),
  ...written('a spread, its title before its kind', spread, 'spread', /"kind":\s*"spread"/, 'Two ways', /"title":\s*"Two ways"/),
  ...written('a spread, its title after its options', spreadTitleLast, 'spread', /"kind":\s*"spread"/, 'Two ways', /"title":\s*"Two ways"/),
  ...written('a focus with no title of its own', focus, 'focus', /"kind":\s*"focus"/),
  ...written('a pipeline', pipeline, 'pipeline', /"kind":\s*"pipeline"/, 'say "kind": "mini"', /"title":\s*"say \\"kind\\": \\"mini\\""/),
  {
    name: 'odd spacing and escaped keys',
    input: ' {\n "pictures" :[ \t{ "picture"\n:{ "k\\u0069nd"  :  "mini" , "t\\u0069tle"\t:\n"x"} } ] }',
    kind: 'mini',
    at: /"mini"/,
    title: 'x',
    titleAt: /"x"/,
  },
  { name: 'a kind the contract does not know', input: JSON.stringify({ pictures: [{ picture: { kind: 'poster', title: 'x' } }] }), kind: undefined },
  { name: 'a first picture with no kind', input: JSON.stringify({ pictures: [{ picture: { title: 'x' } }, { picture: { kind: 'text' } }] }), kind: undefined },
  { name: 'a picture sent as a string', input: JSON.stringify({ pictures: [{ picture: '{"kind":"text","title":"x"}' }] }), kind: undefined },
  { name: 'a title that is not a string', input: JSON.stringify({ pictures: [{ picture: { kind: 'text', title: 5 } }] }), kind: 'text', at: /"text"/ },
  { name: 'an empty title', input: JSON.stringify({ pictures: [{ picture: { kind: 'text', title: '' } }] }), kind: 'text', at: /"text"/ },
];

/** Where a pattern ends in the input, or past its end when there is none. */
const end = (input: string, at: RegExp | undefined) => {
  const m = at?.exec(input);
  return m ? m.index + m[0].length : input.length + 1;
};

describe('the first picture, from the input written so far', () => {
  it.each(CASES)('$name: nothing until the kind is whole, then the kind, then the title once it is whole, at every cut', ({ input, kind, at, title, titleAt }) => {
    const kindWhole = kind ? end(input, at) : input.length + 1;
    const titleWhole = title !== undefined ? end(input, titleAt) : input.length + 1;
    // Every cut, from nothing to the whole input.
    for (let i = 0; i <= input.length; i++) {
      const want = i < kindWhole ? undefined : { kind, ...(i >= titleWhole ? { title } : {}) };
      expect(postPictureSoFar(input.slice(0, i)), `cut at ${i}: ${JSON.stringify(input.slice(Math.max(0, i - 20), i))}`).toEqual(want);
    }
  });

  it('every case is a real input: the whole of it is JSON, and toolPresence reads the same kind and title', () => {
    for (const c of CASES) {
      expect(() => JSON.parse(c.input)).not.toThrow();
      expect(toolPresence('board_post', c.input).note, c.name).toBe(c.kind ? KIND_NOTES[c.kind] : 'drawing');
      expect(toolPresence('board_post', c.input).picture, c.name).toEqual(postPictureSoFar(c.input));
    }
  });

  it('gives nothing for what is not a board_post input', () => {
    for (const s of ['', '{', '"', '\\', 'null', '[{"pictures":[{"picture":{"kind":"text"}}]}]', '{"pictures":{"picture":{"kind":"text"}}}', '}}]]"kind":"text"', '{"kind":"text"}', '{"pictures":[{"picture":{"kind":1,:"text"'])
      expect(postPictureSoFar(s), s).toBeUndefined();
  });

  it('cuts a title longer than presence takes to fit, with an ellipsis, while written and when whole', () => {
    const post = (title: string) => JSON.stringify({ pictures: [{ picture: { kind: 'text', title } }] });
    const cut = `${'a'.repeat(119)}…`;
    expect(postPictureSoFar(post('a'.repeat(130)))).toEqual({ kind: 'text', title: cut });
    expect(toolPresence('board_post', post('a'.repeat(130))).picture).toEqual({ kind: 'text', title: cut });
    expect(Presence.shape.picture.safeParse({ kind: 'text', title: cut }).success).toBe(true);
    // A title that fits is kept whole.
    expect(postPictureSoFar(post('a'.repeat(120)))?.title).toBe('a'.repeat(120));
    // A character of two halves is never split by the cut.
    expect(postPictureSoFar(post(`${'a'.repeat(118)}\u{1F600}${'b'.repeat(9)}`))?.title).toBe(`${'a'.repeat(118)}…`);
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

describe('what a call is busy with', () => {
  it('reads, draws or writes by its tool, while it is written and when it is whole; a tool it does not know gives none', () => {
    const doing = {
      mcp__board__board_read: 'reading',
      Read: 'reading',
      Grep: 'reading',
      Glob: 'reading',
      mcp__board__board_post: 'drawing',
      mcp__board__board_model: 'drawing',
      mcp__board__board_part: 'drawing',
      mcp__board__board_answer: 'writing',
      mcp__board__board_update: 'writing',
    };
    for (const [tool, d] of Object.entries(doing)) {
      expect(writingPresence(tool, '').doing, tool).toBe(d);
      expect(toolPresence(tool, {}).doing, tool).toBe(d);
    }
    expect(writingPresence('SomethingElse', '')).toEqual({ state: 'drawing' });
    expect(toolPresence('SomethingElse', {})).toEqual({ state: 'drawing' });
  });
});

describe('presence while a call is written', () => {
  it('says what the tool does and names no place', () => {
    expect(writingPresence('mcp__board__board_post', '')).toEqual({ state: 'drawing', note: 'drawing', doing: 'drawing' });
    expect(writingPresence('mcp__board__board_read', '')).toEqual({ state: 'drawing', note: 'reading the board', doing: 'reading' });
    expect(writingPresence('Glob', '{"pattern": "*.md"}')).toEqual({ state: 'drawing', note: 'reading the code', doing: 'reading' });
  });

  it('names the first picture of a board_post once its kind is whole, then its title, still with no place', () => {
    const post = 'mcp__board__board_post';
    expect(writingPresence(post, '{"pictures":[{"answers":["m1"],"picture":{"kind":"tex')).toEqual({ state: 'drawing', note: 'drawing', doing: 'drawing' });
    expect(writingPresence(post, '{"pictures":[{"answers":["m1"],"picture":{"kind":"text"')).toEqual({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } });
    expect(writingPresence(post, '{"pictures":[{"answers":["m1"],"picture":{"kind":"text","title":"Wh')).toEqual({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } });
    expect(writingPresence(post, '{"pictures":[{"answers":["m1"],"picture":{"kind":"text","title":"Why"')).toEqual({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'Why' } });
    // Only for a board_post.
    expect(writingPresence('mcp__board__board_answer', '{"pictures":[{"picture":{"kind":"text"')).toEqual({ state: 'drawing', note: 'answering', doing: 'writing' });
  });

  it('says the same as the whole call, which adds the cursor and keeps the picture', () => {
    const input = { pictures: [{ picture: { kind: 'spread', title: 'x', options: [] }, answers: ['m1'] }] };
    const text = JSON.stringify(input);
    expect(toolPresence('mcp__board__board_post', input)).toEqual({ ...writingPresence('mcp__board__board_post', text), cursor: { item: 'm1' } });
    expect(toolPresence('mcp__board__board_post', input)).toMatchObject({ note: 'drawing a spread', picture: { kind: 'spread', title: 'x' } });
  });
});
