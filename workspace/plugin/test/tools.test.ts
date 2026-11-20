import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PICTURE_KINDS, RULES, STATE_DIR_ENV, admit, openCount, privateBoardKey } from '@keel/protocol';
import { BoardClient, locateBoard, privateBoardPath } from '../src/client';
import type { ModelInput } from '../src/tools';
import { createBoardMcp, modelOps } from '../src/tools';
import { toolPresence } from '../src/presence';
import { CH, FakeBoard, noteBoard } from './fake-board';

let board: FakeBoard;
let client: Client;

async function connect(url: string, token: string): Promise<Client> {
  const server = createBoardMcp(new BoardClient(() => ({ url, token })));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
}

/** What the rules say about a draft from the agent, on the board as it is now. */
function reasonFor(draft: Record<string, unknown>): string {
  const r = admit(board.state, draft, 'agent', '2026-11-17T14:00:00Z');
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
}

const card = (title: string, extra: Record<string, unknown> = {}) => ({ picture: { kind: 'text', title }, ...extra });

beforeEach(async () => {
  board = await noteBoard();
  client = await connect(board.url, board.tokens.agent);
});

afterEach(async () => {
  await client.close();
  await board.stop();
});

describe('the board tools', () => {
  it('lists six tools whose limits come from the contract', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['board_answer', 'board_model', 'board_part', 'board_post', 'board_read', 'board_update']);
    const post = tools.find((t) => t.name === 'board_post')!;
    const schema = JSON.stringify(post.inputSchema);
    // The picture is open in the schema, named by kind; the grammar file carries its keys.
    expect(schema).toContain(`"enum":${JSON.stringify(PICTURE_KINDS)}`);
    expect(schema).toContain('grammar.md');
    // A part's name is at most 32 characters, as in the contract, and the envelope is strict.
    expect(schema).toMatch(/"name":\{"type":"string","minLength":1,"maxLength":32\}/);
    expect(schema).toContain('"additionalProperties":false');
    // The strict schema of every picture kind is not sent: it is four times the grammar.
    expect(schema.length).toBeLessThan(6000);
  });

  it('a picture that breaks a limit is refused with the place, the length and the limit', async () => {
    const before = board.events.length;
    const long = 'x'.repeat(72);
    const spread = {
      kind: 'spread',
      title: 'Two ways',
      request: 'one photo',
      approaches: [
        { title: 'A', lanes: [{ id: 'u', name: 'User' }], steps: [{ id: 's', lane: 'u', text: long }], risk: 'r' },
        { title: 'B', lanes: [{ id: 'u', name: 'User' }], steps: [{ id: 's', lane: 'u', text: 'ok' }], risk: 'r', colour: 'blue' },
      ],
    };
    const r = await call('board_post', { pictures: [card('fine', { answers: ['m1'] }), { picture: spread, answers: ['m1'] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Refused picture 2 of 2 (spread). Nothing was posted.');
    expect(r.text).toContain('approaches[0].steps[0].text is 72 characters; the limit is 60.');
    expect(r.text).toContain('approaches[1] has a key the grammar does not list: "colour".');
    expect(board.events.length).toBe(before);
  });

  it('a missing key and an unknown kind are named', async () => {
    const missing = await call('board_post', { pictures: [{ picture: { kind: 'mini', title: 'x' }, answers: ['m1'] }] });
    expect(missing.text).toContain('boxes is missing.');
    const kind = await call('board_post', { pictures: [{ picture: { kind: 'card', title: 'x' }, answers: ['m1'] }] });
    expect(kind.isError).toBe(true);
    expect(kind.text).toMatch(/kind/);
  });

  it('board_post with a model patches it first, so its pipeline and walk can name the parts', async () => {
    const r = await call('board_post', {
      model: {
        lanes: [{ id: 'you', name: 'You' }, { id: 'tool', name: 'The tool' }],
        parts: [
          { id: 'notes', name: 'Your notes', lane: 'you', external: true },
          { id: 'reader', name: 'Reader', plain: 'reads the week', lane: 'tool' },
        ],
        edges: [{ from: 'notes', to: 'reader' }],
        walks: [{ id: 'week', name: 'One week', steps: [{ n: 1, part: 'notes', text: 'you write' }, { n: 2, part: 'reader', text: 'it reads' }] }],
      },
      pictures: [
        { picture: { kind: 'pipeline', walk: 'week' }, answers: ['m1'] },
        { picture: { kind: 'walk', walk: 'week' }, from: ['m1'] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Posted: a-[a-z0-9]{6}, a-[a-z0-9]{6} \(after the model patch\)$/);
    const types = board.events.slice(-3).map((e) => e.type);
    expect(types).toEqual(['model.patch', 'item.add', 'item.add']);
    expect(board.state.model.walks.week).toBeDefined();
  });

  it('a model that breaks a rule is refused as "the model", and nothing lands', async () => {
    const before = board.events.length;
    const r = await call('board_post', {
      model: { parts: [{ id: 'reader', name: 'Reader', lane: 'nowhere' }] },
      pictures: [card('The reader', { answers: ['m1'] })],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Refused the model.');
    expect(r.text).toContain('lane "nowhere"');
    expect(board.events.length).toBe(before);
    const pic = await call('board_post', { model: { lanes: [{ id: 'tool', name: 'Tool' }] }, pictures: [{ picture: { kind: 'walk', walk: 'none' }, answers: ['m1'] }] });
    expect(pic.text).toContain('Refused picture 1 of 1 (walk).');
  });

  it('"name" gives a new picture its id, so a later entry can come from it and finish it', async () => {
    const r = await call('board_post', {
      pictures: [
        card('How I read your note', { name: 'read-1', answers: ['m1'] }),
        card('Drawing two ways', { name: 'spread-1', from: ['read-1'], status: 'drawing' }),
      ],
    });
    expect(r).toEqual({ text: 'Posted: read-1, spread-1', isError: false });
    expect(board.state.items['spread-1']?.item).toMatchObject({ status: 'drawing', from: ['read-1'] });
    const done = await call('board_post', { pictures: [card('Two ways', { id: 'spread-1' })] });
    expect(done.text).toBe('Posted: spread-1 (replaced)');
    const taken = await call('board_post', { pictures: [card('Again', { name: 'read-1', answers: ['m1'] })] });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain('the id "read-1" is taken on this board. Pick another name, such as "read-1-2".');
  });

  it('an "id" that is not on the board is refused, and the error points at "name"', async () => {
    const before = board.events.length;
    const r = await call('board_post', { pictures: [card('Drawing your pick', { id: 'draw-a', answers: ['m1'], status: 'drawing' })] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('there is no picture "draw-a" to finish. To give a new picture an id of your choosing, use "name".');
    expect(board.events.length).toBe(before);
  });

  it('a "near" that is not an item is dropped, said back, and the picture still lands', async () => {
    const r = await call('board_post', {
      pictures: [card('A it is', { answers: ['m1'], near: 'approach:a' }), card('Beside the note', { from: ['m1'], near: 'm1', side: 'below' }), card('Nowhere', { from: ['m1'], near: 'no-such' })],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"near": "approach:a" of picture 1 is not an item on the board');
    expect(r.text).toContain('"near": "no-such" of picture 3');
    const adds = board.events.slice(-3).map((e) => (e.type === 'item.add' ? e.item : undefined));
    expect(adds[0]).not.toHaveProperty('place');
    expect(adds[1]).toMatchObject({ place: { near: 'm1', side: 'below' } });
  });

  it('board_read opens a picture in full, with the marks on it, and the whole model', async () => {
    const posted = await call('board_post', { pictures: [card('Two ways', { answers: ['m1'] })] });
    const id = /Posted: (a-[a-z0-9]{6})$/.exec(posted.text)![1]!;
    board.must('owner', {
      type: 'item.add',
      chapter: CH,
      item: { id: 'x1', kind: 'ink', box: [0, 0, 5, 5], strokes: [{ pts: [0, 0, 1, 1] }], targets: [{ item: id }], hint: 'cross' },
    });
    await call('board_model', { lanes: [{ id: 'tool', name: 'The tool' }], parts: [{ id: 'reader', name: 'Reader', lane: 'tool' }] });
    const r = await call('board_read', { items: [id, 'nope'], model: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('{"kind":"text","title":"Two ways"}');
    expect(r.text).toContain('x1 ink cross on the whole picture (open)');
    expect(r.text).toContain('nope: there is no such item.');
    expect(r.text).toMatch(/MODEL \{"lanes":\[\{"id":"tool"/);
    expect(r.text).toContain('"id":"reader"');
  });

  it('board_read returns the digest text', async () => {
    const r = await call('board_read', {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain('BOARD demo');
    expect(r.text).toContain('m1 note "Turn my notes into a weekly summary"');
  });

  it('board_post adds a picture that answers the note, after reporting presence on it', async () => {
    const r = await call('board_post', { pictures: [card('How I read your note', { answers: ['m1'], near: 'm1', side: 'right' })] });
    expect(r.isError).toBe(false);
    const id = /Posted: (a-[a-z0-9]{6})$/.exec(r.text)?.[1];
    expect(id).toBeDefined();
    const ev = board.events.at(-1)!;
    expect(ev).toMatchObject({ type: 'item.add', by: 'agent', chapter: CH, item: { id, kind: 'picture', answers: ['m1'], place: { near: 'm1', side: 'right' } } });
    expect(openCount(board.state)).toBe(0);
    // Presence came first: drawing, with the cursor on the note, before the event landed.
    expect(board.presence[0]).toMatchObject({ state: 'drawing', cursor: { item: 'm1' }, seq: Number(ev.id.slice(1)) - 1 });
  });

  it('board_post finishes a placeholder through item.update', async () => {
    const first = await call('board_post', { pictures: [card('Drawing three ways', { answers: ['m1'], status: 'drawing' })] });
    const id = /Posted: (a-[a-z0-9]{6})$/.exec(first.text)![1]!;
    expect(board.state.items[id]?.item).toMatchObject({ status: 'drawing' });

    const second = await call('board_post', { pictures: [card('Three ways', { id })] });
    expect(second).toEqual({ text: `Posted: ${id} (replaced)`, isError: false });
    expect(board.events.at(-1)).toMatchObject({ type: 'item.update', item: id, patch: { status: 'done', picture: { kind: 'text', title: 'Three ways' } } });
    expect(board.state.items[id]?.item).toMatchObject({ status: 'done', picture: { title: 'Three ways' }, answers: ['m1'] });
  });

  it('posts several pictures as one: a refusal names the picture and posts none', async () => {
    const before = board.events.length;
    const r = await call('board_post', { pictures: [card('One', { answers: ['m1'] }), card('Two')] });
    expect(r.isError).toBe(true);
    const reason = reasonFor({ type: 'item.add', chapter: CH, item: { id: 'x1', kind: 'picture', picture: { kind: 'text', title: 'Two' } } });
    expect(r.text).toContain('Refused picture 2 of 2');
    expect(r.text).toContain(`Reason: ${reason}`);
    expect(r.text).toContain(`Rule R3: ${RULES.R3}`);
    expect(board.events.length).toBe(before);
  });

  it('a shape error is refused with the contract schema\'s words', async () => {
    const r = await call('board_post', { pictures: [card('x'.repeat(91), { answers: ['m1'] })] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/title/);
    expect(r.text).toMatch(/90/);
  });

  it('board_answer closes marks with a read', async () => {
    const r = await call('board_answer', { answers: ['m1'], read: 'You want a summary each week. I will draw two ways.' });
    expect(r.isError).toBe(false);
    expect(board.events.at(-1)).toMatchObject({ type: 'answer', by: 'agent', answers: ['m1'], read: 'You want a summary each week. I will draw two ways.' });
    expect(openCount(board.state)).toBe(0);
  });

  it('board_answer refuses an id that is not the owner\'s, word for word', async () => {
    const r = await call('board_answer', { answers: ['nope'], read: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Reason: ${reasonFor({ type: 'answer', answers: ['nope'], read: 'x' })}`);
    expect(r.text).toContain('Rule R7');
  });

  it('board_model patches the model in the current chapter, then a pipeline can name it', async () => {
    const r = await call('board_model', {
      lanes: [{ id: 'you', name: 'You' }, { id: 'tool', name: 'The tool' }],
      parts: [
        { id: 'notes', name: 'Your notes', lane: 'you', external: true },
        { id: 'reader', name: 'Reader', plain: 'reads the week', lane: 'tool' },
      ],
      edges: [{ from: 'notes', to: 'reader', label: 'read' }],
      walks: [{ id: 'week', name: 'One week', steps: [{ n: 1, part: 'notes', text: 'you write' }, { n: 2, part: 'reader', text: 'it reads' }] }],
    });
    expect(r.isError).toBe(false);
    // A patch answers no mark: the note stays open until a picture the owner can see answers it.
    expect(openCount(board.state)).toBe(1);
    const answering = await call('board_model', { parts: [{ id: 'x', name: 'X', lane: 'tool' }], answers: ['m1'] });
    expect(answering.isError).toBe(true);
    expect(r.text).toContain('6 changes');
    expect(board.state.model.parts.reader).toMatchObject({ state: 'idea', lane: 'tool', chapter: CH });
    const pic = await call('board_post', { pictures: [{ picture: { kind: 'pipeline', walk: 'week' }, answers: ['m1'] }] });
    expect(pic.isError).toBe(false);
  });

  it('board_part refuses to make a part solid, word for word', async () => {
    await call('board_model', { lanes: [{ id: 'tool', name: 'The tool' }], parts: [{ id: 'reader', name: 'Reader', lane: 'tool' }] });
    const r = await call('board_part', { part: 'reader', state: 'solid' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Reason: ${reasonFor({ type: 'part.state', part: 'reader', state: 'solid' })}`);
    expect(r.text).toContain(`Rule R1: ${RULES.R1}`);
    const later = await call('board_part', { part: 'reader', state: 'later' });
    expect(later.isError).toBe(false);
    expect(board.state.model.parts.reader?.state).toBe('later');
  });

  it('board_update adds a feed entry in the current chapter; it answers requests, never a mark, and carries no evidence', async () => {
    const r = await call('board_update', { text: 'Read the notes folder.', kind: 'update' });
    expect(r.isError).toBe(false);
    expect(board.events.at(-1)).toMatchObject({ type: 'feed.add', by: 'agent', chapter: CH, text: 'Read the notes folder.' });
    const mark = await call('board_update', { text: 'Answered your note.', answers: ['m1'] });
    expect(mark.isError).toBe(true);
    expect(mark.text).toContain('A feed entry answers a request from the owner');
    expect((await call('board_update', { text: 'Built it.', kind: 'commit' })).isError).toBe(true);
  });

  it('board_post names the chapter first while it is an idea, and a redraw keeps what the picture answered', async () => {
    const r = await call('board_post', { rename: 'Weekly summary', pictures: [card('How I read your note', { answers: ['m1'], name: 'read-ch1' })] });
    expect(r.isError, r.text).toBe(false);
    expect(board.state.chapters[CH]?.title).toBe('Weekly summary');
    board.must('owner', { type: 'item.add', chapter: CH, item: { id: 'm2', kind: 'note', box: [0, 200, 200, 100], text: 'Fridays only' } });
    const again = await call('board_post', { pictures: [card('My read, now', { id: 'read-ch1', answers: ['m2'] })] });
    expect(again.isError, again.text).toBe(false);
    expect(openCount(board.state)).toBe(0);
    expect((board.events.at(-1) as { patch: { answers: string[] } }).patch.answers).toEqual(['m1', 'm2']);
  });

  it('board_answer needs "read": it is what closes the marks', async () => {
    const none = await call('board_answer', { answers: ['m1'] });
    expect(none.isError).toBe(true);
    expect(openCount(board.state)).toBe(1);
    const r = await call('board_answer', { answers: ['m1'], read: 'You want a weekly summary of your notes.' });
    expect(r.isError).toBe(false);
    expect(openCount(board.state)).toBe(0);
  });

  it('board_post sends no coordinates, and a placeholder closes nothing until it is finished', async () => {
    const r = await call('board_post', { pictures: [card('Drawing three ways', { answers: ['m1'], name: 'spread-1', status: 'drawing' })] });
    expect(r.isError).toBe(false);
    const add = board.events.at(-1) as { item: Record<string, unknown> };
    expect(add.item.box).toBeUndefined();
    expect(openCount(board.state)).toBe(1);
    const done = await call('board_post', { pictures: [card('Three ways', { id: 'spread-1' })] });
    expect(done.isError).toBe(false);
    expect((board.events.at(-1) as { patch: Record<string, unknown> }).patch.box).toBeUndefined();
    expect(openCount(board.state)).toBe(0);
    const boxed = await call('board_post', { pictures: [card('Here', { answers: ['m1'], box: [0, 0, 10, 10] })] });
    expect(boxed.isError).toBe(true);
  });

  it('says so when the board server does not answer', async () => {
    const url = board.url;
    await client.close();
    await board.stop();
    client = await connect(url, 'agent-token');
    const r = await call('board_read', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('does not answer');
    board = await new FakeBoard().start(); // for afterEach
  });
});

describe('board_model translation', () => {
  it('turns the input into ops: drops first, then lanes, parts, edges, walks', () => {
    const input: ModelInput = {
      lanes: [{ id: 'api', name: 'API', at: 0 }, { id: 'engine', name: 'Engine' }],
      parts: [{ id: 'door', name: 'The door', lane: 'api' }],
      edges: [{ from: 'door', to: 'sched', kind: 'wait' }],
      walks: [{ id: 'w1', name: 'One request', steps: [{ n: 1, part: 'door', text: 'takes a ticket' }] }],
      drop: { parts: ['old'], edges: [{ from: 'a', to: 'b' }], walks: ['w0'] },
    };
    expect(modelOps(input)).toEqual([
      { op: 'walk.drop', id: 'w0' },
      { op: 'edge.drop', from: 'a', to: 'b' },
      { op: 'part.drop', id: 'old' },
      { op: 'lane.set', lane: { id: 'api', name: 'API' }, at: 0 },
      { op: 'lane.set', lane: { id: 'engine', name: 'Engine' } },
      { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } },
      { op: 'edge.set', edge: { from: 'door', to: 'sched', kind: 'wait' } },
      { op: 'walk.set', walk: { id: 'w1', name: 'One request', steps: [{ n: 1, part: 'door', text: 'takes a ticket' }] } },
    ]);
    expect(modelOps({})).toEqual([]);
  });

  it('an empty patch is an error the agent can read', async () => {
    const r = await call('board_model', {});
    expect(r).toEqual({ text: 'The patch is empty. Give lanes, parts, edges, walks or drop.', isError: true });
  });
});

describe('finding the board server', () => {
  it('takes the address from the environment first', () => {
    expect(locateBoard({ KEEL_BOARD_URL: 'http://127.0.0.1:5000/', KEEL_BOARD_TOKEN: 't' }, '/')).toEqual({ url: 'http://127.0.0.1:5000', token: 't' });
  });

  it('else finds the board folder above, and takes the token from its private file, never from the repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-plugin-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-state-'));
    try {
      const board = path.join(repo, '.keel', 'board');
      fs.mkdirSync(board, { recursive: true });
      fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
      // The repository's own file: forged, with a token of its choosing. It is not read for one.
      fs.writeFileSync(path.join(board, 'server.json'), JSON.stringify({ pid: 1, port: 1111, tokens: { agent: 'forged' }, startedAt: 'x' }));
      const env = { [STATE_DIR_ENV]: state };
      expect(() => locateBoard(env, path.join(repo, 'src', 'deep'))).toThrow(/keel-board open/);
      const file = privateBoardPath(board, env);
      const st = fs.statSync(board, { bigint: true });
      expect(file).toBe(path.join(state, 'boards', privateBoardKey(st.dev, st.ino), 'board.json'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const priv = { boardDir: fs.realpathSync(board), boardKey: 'k'.repeat(20), port: 4321 };
      fs.writeFileSync(file, JSON.stringify(priv));
      // A server ran once, but none runs now.
      expect(() => locateBoard(env, path.join(repo, 'src', 'deep'))).toThrow(/No board server runs/);
      fs.writeFileSync(file, JSON.stringify({ ...priv, running: { pid: 2, ownerToken: 'o', agentToken: 'a', systemToken: 's', startedAt: '2026-11-18T10:00:00Z' } }));
      // The tools take the agent's token, never the owner's.
      expect(locateBoard(env, path.join(repo, 'src', 'deep'))).toEqual({ url: 'http://127.0.0.1:4321', token: 'a' });
      // A link in the private file's place is not followed.
      const target = path.join(state, 'elsewhere.json');
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
      expect(() => locateBoard(env, path.join(repo, 'src', 'deep'))).toThrow(/cannot be read/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('says how to start one when there is none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-plugin-'));
    try {
      expect(() => locateBoard({ [STATE_DIR_ENV]: dir }, dir)).toThrow(/keel-board open/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('presence for a tool call', () => {
  it('puts the cursor on the item a call answers, never on an act', () => {
    expect(toolPresence('mcp__board__board_post', { pictures: [{ picture: {}, answers: ['e12', 'm3'] }] })).toEqual({ state: 'drawing', note: 'drawing', cursor: { item: 'm3' } });
    expect(toolPresence('board_post', { pictures: [{ picture: {}, id: 'a-abc123', answers: ['m1'] }] })).toMatchObject({ cursor: { item: 'a-abc123' } });
    expect(toolPresence('mcp__plugin_keel-board_board__board_answer', { answers: ['e7'] })).toEqual({ state: 'drawing', note: 'answering' });
    expect(toolPresence('Read', { file_path: 'README.md' })).toEqual({ state: 'drawing', note: 'reading the code' });
  });

  it('reads an input that arrives as a JSON string', () => {
    expect(toolPresence('board_answer', JSON.stringify({ answers: ['m2'], read: 'x' }))).toMatchObject({ cursor: { item: 'm2' } });
    expect(toolPresence('board_answer', '{not json')).toEqual({ state: 'drawing', note: 'answering' });
  });
});
