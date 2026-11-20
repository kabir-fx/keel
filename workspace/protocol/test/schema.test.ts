import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventDraft, Item, PICTURE_KINDS, PictureSpec, checkPicture, emptyState, parseDraft, parseEvent, pictureTitle, svgProblem } from '../src';
import { ideaBoard } from './helpers';

const lanes = {
  lanes: [
    { id: 'client', name: 'Client' },
    { id: 'api', name: 'API thread', note: 'the asyncio event loop' },
  ],
  steps: [
    { id: 'post', n: 1, lane: 'client', text: 'posts "what is 2 + 2"' },
    { id: 'start', n: 2, lane: 'api', text: 'Handler starts req-42' },
    { id: 'reply', n: 3, lane: 'client', text: 'sees "2"' },
  ],
  flows: [
    { from: 'post', to: 'start', label: 'POST' },
    { from: 'start', to: 'reply', label: 'the handler sleeps here; the API thread serves other users', wait: true },
  ],
};

const svg = '<svg viewBox="0 0 200 400" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="180" height="380" fill="#fff" stroke="#0F1B2D"/></svg>';

/** One small example of every picture kind. The model parts they name are in `ideaBoard()`. */
export const EXAMPLES: Record<(typeof PICTURE_KINDS)[number], unknown> = {
  text: { kind: 'text', title: 'My read, and two questions', body: 'Two ways hold up.', lean: 'I lean to one loop.', questions: ['Cap the door?', 'Stream tokens?'] },
  shelf: { kind: 'shelf', tiles: [{ id: 'runner', name: 'Runner', plain: 'runs one step on the GPU', ref: 'PR 11', state: 'built', part: 'handler' }] },
  lanes: { kind: 'lanes', title: 'One loop', risk: 'One slow step holds everyone', divider: { before: 'reply', label: 'later' }, gaps: ['It cannot show 64 at once.'], ...lanes },
  spread: {
    kind: 'spread',
    title: 'Three ways to take many requests',
    request: 'a client posts "what is 2 + 2"',
    lean: 'A',
    approaches: [
      { title: 'One engine loop', risk: 'A new request waits one full step', ...lanes },
      { kind: 'lanes', title: 'A thread per request', risk: 'The GPU is shared anyway', ...lanes },
      { kind: 'free', title: 'As a screen', risk: 'It hides the queue', svg },
    ],
  },
  mini: { kind: 'mini', title: 'Yes. One thread means one line', boxes: [{ text: 'req-42' }, { text: 'the line', tone: 'blue' }, { text: 'the model' }], flows: [{ from: 1, to: 2 }] },
  pipeline: { kind: 'pipeline', title: 'Your pick, in full', view: 'layers', walk: 'req-42', parts: ['handler', 'door'] },
  walk: { kind: 'walk', walk: 'req-42' },
  focus: {
    kind: 'focus',
    part: 'door',
    summary: 'Every request passes it once.',
    crosses: [{ dir: 'in', what: 'a ticket', part: 'handler' }],
    inside: [{ name: 'inbound queue', holds: ['req-42', 'req-43'] }],
    promise: 'Every accepted submit yields exactly one terminal output.',
    cost: 'A new request can wait one full step.',
    made: { title: 'One wake-up per turn' },
    options: { title: 'Two ways to stop a flood', items: [{ id: 'cap-queue', name: 'Cap the queue' }, { id: 'cap-door', name: 'Cap the door' }], lean: 'cap-door' },
    lean: 'Cap the door.',
    code: [{ path: 'src/ullm/core/client.py', lines: '40-88' }],
  },
  blueprint: {
    kind: 'blueprint',
    title: 'The blueprint',
    picks: [{ text: 'One engine loop', from: { item: 'a2' } }],
    leftOut: [{ text: 'Metrics', why: 'later' }],
    proof: ['ullm sim runs 50 clients and each gets one answer'],
    parts: ['door', 'scheduler'],
    check: 'make check',
    walk: 'req-42',
  },
  choice: { kind: 'choice', title: 'A choice I made', options: [{ id: 'fifo', label: 'First in, first out' }, { id: 'short', label: 'Shortest first' }], chosen: 'fifo', part: 'scheduler' },
  free: { kind: 'free', title: 'A screen the grammar cannot say', svg, caption: 'Three tabs.' },
};

describe('the picture grammar', () => {
  it('has one example per kind, and each one passes the schema and the board', () => {
    const b = ideaBoard();
    for (const kind of PICTURE_KINDS) {
      const r = PictureSpec.safeParse(EXAMPLES[kind]);
      expect(r.success, `${kind}: ${r.success ? '' : r.error.message}`).toBe(true);
      if (!r.success) continue;
      expect(r.data.kind).toBe(kind);
      expect(checkPicture(b.state, r.data), kind).toEqual({ ok: true });
      expect(pictureTitle(r.data).length).toBeGreaterThan(0);
    }
  });

  it('refuses a key it does not know, so a wrong spec is never half-drawn', () => {
    const bad = { ...(EXAMPLES.mini as object), colour: 'red' };
    expect(PictureSpec.safeParse(bad).success).toBe(false);
    const coords = { ...(EXAMPLES.lanes as object), x: 120, y: 80 };
    expect(PictureSpec.safeParse(coords).success).toBe(false);
  });

  it('refuses a drawing that does not hold together', () => {
    const s = emptyState();
    const parse = (v: unknown) => PictureSpec.parse(v);
    const l = EXAMPLES.lanes as Record<string, unknown>;
    const shape = { ok: false, rule: 'shape' };
    expect(checkPicture(s, parse({ ...l, steps: [{ id: 'x', lane: 'nope', text: 'x' }], flows: [], divider: undefined }))).toMatchObject(shape);
    expect(checkPicture(s, parse({ ...l, flows: [{ from: 'post', to: 'nope' }] }))).toMatchObject(shape);
    expect(checkPicture(s, parse({ ...l, divider: { before: 'nope' } }))).toMatchObject(shape);
    expect(
      checkPicture(s, parse({ ...l, steps: [{ id: 'a', lane: 'api', col: 2, text: 'a' }, { id: 'b', lane: 'api', col: 2, text: 'b' }], flows: [], divider: undefined })),
    ).toMatchObject(shape);
    const spread = EXAMPLES.spread as { approaches: unknown[] };
    expect(checkPicture(s, parse({ ...spread, approaches: spread.approaches.slice(0, 2), lean: 'C' }))).toMatchObject(shape);
    expect(checkPicture(s, parse({ ...(EXAMPLES.choice as object), part: undefined, chosen: 'nope' }))).toMatchObject(shape);
    expect(checkPicture(s, parse({ ...(EXAMPLES.mini as object), flows: [{ from: 1, to: 5 }] }))).toMatchObject(shape);
  });

  it('keeps a free picture to one inert svg', () => {
    const free = EXAMPLES.free as Record<string, unknown>;
    const bad = [
      '<div>not svg</div>',
      '<svg><rect/></svg>',
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1" onload="x()"></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.com/a.png"/></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject><p>x</p></foreignObject></svg>',
      '<svg viewBox="0 0 1 1"><a href=javascript:alert(1)><rect/></a></svg>',
      '<svg viewBox="0 0 1 1"><rect/onclick=alert(1) /></svg>',
      '<svg viewBox="0 0 1 1"><set attributeName="href" to="javascript:alert(1)"/></svg>',
      '<svg viewBox="0 0 1 1"><style>@import url(https://example.com/x.css);</style></svg>',
      '<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.com/x)"/></svg>',
      '<svg viewBox="0 0 1 1"><use href=https://example.com/x.svg#a /></svg>',
    ];
    for (const svgText of bad) expect(PictureSpec.safeParse({ ...free, svg: svgText }).success, svgText).toBe(false);
    // No `use`: one small drawing could ask the browser for millions of shapes.
    expect(PictureSpec.safeParse({ ...free, svg: '<svg viewBox="0 0 1 1"><use href="#a"/></svg>' }).success).toBe(false);
    expect(PictureSpec.safeParse({ ...free, svg: '<svg viewBox="0 0 1 1"><symbol id="a"><rect/></symbol></svg>' }).success).toBe(false);
    const many = `<svg viewBox="0 0 1 1">${'<rect/>'.repeat(1300)}</svg>`;
    expect(many.length).toBeLessThan(16_000);
    expect(PictureSpec.safeParse({ ...free, svg: many }).success).toBe(false);
  });

  it('refuses a free picture that draws shapes many times over: markers, patterns, masks, a clip inside a clip', () => {
    const ok = (svgText: string) => svgProblem(svgText);
    // Markers that hold lines with markers, four deep: under 2,000 characters, and it stopped the tab.
    const level = (n: number) => `<marker id="m${n}" markerWidth="9" markerHeight="9"><path d="M0 0 L1 1 L2 0 L3 1 L4 0 L5 1" marker-mid="url(#m${n + 1})"/></marker>`;
    const bomb = `<svg viewBox="0 0 9 9"><defs>${[0, 1, 2, 3].map(level).join('')}</defs><path d="M0 0 L1 1 L2 0" marker-mid="url(#m0)"/></svg>`;
    expect(ok(bomb)).toBe('svg may not hold <marker>');
    expect(ok('<svg viewBox="0 0 9 9"><path d="M0 0 L9 9" marker-end="url(#a)"/></svg>')).toContain('markers');
    expect(ok('<svg viewBox="0 0 9 9"><path d="M0 0 L9 9" style="stroke:#000; marker-end: url(#a)"/></svg>')).toContain('markers');
    expect(ok('<svg viewBox="0 0 9 9"><defs><pattern id="p" width="1" height="1"><rect/></pattern></defs><rect fill="url(#p)"/></svg>')).toBe('svg may not hold <pattern>');
    expect(ok('<svg viewBox="0 0 9 9"><defs><mask id="k"><rect/></mask></defs><rect mask="url(#k)"/></svg>')).toBe('svg may not hold <mask>');
    expect(ok('<svg viewBox="0 0 9 9"><rect mask="url(#k)"/></svg>')).toContain('mask');
    expect(ok('<svg viewBox="0 0 9 9"><defs><clipPath id="a"><rect clip-path="url(#b)"/></clipPath><clipPath id="b"><rect/></clipPath></defs><rect clip-path="url(#a)"/></svg>')).toContain('inside a <clipPath>');
    expect(ok('<svg viewBox="0 0 9 9"><defs><clipPath id="a"><rect style="clip-path:url(#b)"/></clipPath></defs></svg>')).toContain('inside a <clipPath>');
    // What a screen needs is still fine: a clip, a gradient, and an arrowhead drawn as a polygon.
    expect(ok('<svg viewBox="0 0 9 9"><defs><clipPath id="a"><rect width="4" height="4"/></clipPath><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect clip-path="url(#a)" fill="url(#g)"/><line x1="0" y1="0" x2="8" y2="0"/><polygon points="8,0 6,-1 6,1"/><text x="1" y="1">a marker: and a mask: are only words here</text></svg>')).toBeUndefined();
    // A clip that closed leaves what follows free to use one.
    expect(ok('<svg viewBox="0 0 9 9"><clipPath id="a"><rect/></clipPath><clipPath id="e"/><rect clip-path="url(#a)"/></svg>')).toBeUndefined();
  });

  it('counts elements, not tags, and keeps the view of a free picture to a shape a card can hold', () => {
    const ok = (svgText: string) => svgProblem(svgText);
    // 600 self-closed elements beside the svg itself are too many: one tag each is still one element each.
    expect(ok(`<svg viewBox="0 0 9 9">${'<rect/>'.repeat(599)}</svg>`)).toBeUndefined();
    expect(ok(`<svg viewBox="0 0 9 9">${'<rect/>'.repeat(600)}</svg>`)).toBe('svg may hold at most 600 elements');
    expect(ok(`<svg viewBox="0 0 9 9">${'<g></g>'.repeat(600)}</svg>`)).toBe('svg may hold at most 600 elements');
    // A view far taller than wide would be drawn miles long.
    expect(ok('<svg viewBox="0 0 1 100000"><rect/></svg>')).toContain('viewBox');
    expect(ok('<svg viewBox="0 0 100 501"><rect/></svg>')).toContain('5 times');
    expect(ok('<svg viewBox="0 0 501 100"><rect/></svg>')).toContain('5 times');
    expect(ok('<svg viewBox="0 0 0 10"><rect/></svg>')).toContain('viewBox');
    expect(ok('<svg viewBox="0 0 -5 10"><rect/></svg>')).toContain('viewBox');
    expect(ok('<svg viewBox="0 0 10"><rect/></svg>')).toContain('viewBox');
    expect(ok('<svg viewBox="a b c d"><rect/></svg>')).toContain('viewBox');
    expect(ok('<svg viewBox="0,0,320,200"><rect/></svg>')).toBeUndefined();
    expect(ok('<svg viewBox="-10 -10 640 400"><rect/></svg>')).toBeUndefined();
  });

  it('reads the tags of a free picture, not its words', () => {
    const ok = (svgText: string) => svgProblem(svgText);
    // Ordinary screen text is fine, whatever it says.
    expect(ok('<svg viewBox="0 0 9 9"><text x="1" y="1">Metadata: online = true, url(x), javascript: is a word</text></svg>')).toBeUndefined();
    expect(ok('<svg viewBox="0 0 9 9"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)"/></svg>')).toBeUndefined();
    // What the old text patterns let through.
    expect(ok('<svg viewBox="0 0 1 1"></svg><svg viewBox="0 0 1 1"></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><svg viewBox="0 0 1 1"></svg></svg>')).toBeDefined();
    expect(ok('<svg><text>viewBox="0 0 1 1"</text></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><rect style="fill:u\\72l(https://example.com/x)"/></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><rect style="fill:image-set(\'https://example.com/x\' 1x)"/></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><rect fill="url(&#35;g)"/></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><!-- <script> --></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><![CDATA[<script>]]></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><video src="#a"/></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><rect ONCLICK="x()"/></svg>')).toBeDefined();
    expect(ok('<svg viewBox="0 0 1 1"><use xlink:href="https://example.com/x.svg#a"/></svg>')).toBeDefined();
  });

  it('refuses a text over its limit', () => {
    const l = EXAMPLES.lanes as { steps: Array<Record<string, unknown>> };
    const long = { ...l, steps: [{ ...l.steps[0], text: 'x'.repeat(61) }, ...l.steps.slice(1)] };
    expect(PictureSpec.safeParse(long).success).toBe(false);
  });

  it('turns into a JSON schema the agent\'s tools can carry', () => {
    const schema = z.toJSONSchema(PictureSpec) as { oneOf?: unknown[]; anyOf?: unknown[] };
    expect((schema.oneOf ?? schema.anyOf)?.length).toBe(PICTURE_KINDS.length);
  });
});

describe('events', () => {
  it('never has a field named "id" or "at" in a draft, because the stamp would replace it', () => {
    for (const option of EventDraft.options) {
      const keys = Object.keys(option.shape);
      expect(keys, option.shape.type.value).not.toContain('id');
      expect(keys, option.shape.type.value).not.toContain('at');
    }
  });

  it('says what is wrong with a draft in words', () => {
    const r = parseDraft({ type: 'item.add', by: 'owner', chapter: 'c', item: { id: 'Bad Id', kind: 'note', box: [0, 0, 1, 1], text: 'x' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('item.id');
  });

  it('reads a stamped event, and refuses a bad stamp', () => {
    const ev = { id: 'e3', at: '2026-11-17T13:02:11Z', by: 'owner', type: 'chapter.open', chapter: 'engine-loop', title: 'One engine' };
    expect(parseEvent(ev)).toMatchObject({ ok: true, value: ev });
    expect(parseEvent({ ...ev, id: 'x3' }).ok).toBe(false);
    expect(parseEvent({ ...ev, at: 'yesterday' }).ok).toBe(false);
  });

  it('keeps every item within reach: a box far off the board is refused', () => {
    const noteAt = (box: number[]) => Item.safeParse({ id: 'm1', kind: 'note', box, text: 'x' }).success;
    expect(noteAt([0, 0, 300, 120])).toBe(true);
    expect(noteAt([1e308, 0, 300, 120])).toBe(false);
    expect(noteAt([0, 0, 1e9, 120])).toBe(false);
    expect(Item.safeParse({ id: 'm1', kind: 'ink', box: [0, 0, 1, 1], strokes: [{ pts: [0, 0, 1e12, 1] }], targets: [], hint: 'none' }).success).toBe(false);
  });

  it('checks a stroke is pairs', () => {
    const ink = { id: 'm1', kind: 'ink', box: [0, 0, 1, 1], strokes: [{ pts: [0, 0, 1] }], targets: [], hint: 'none' };
    expect(Item.safeParse(ink).success).toBe(false);
    expect(Item.safeParse({ ...ink, strokes: [{ pts: [0, 0, 1, 1] }] }).success).toBe(true);
  });
});
