import type { BoardState, PICTURE_KINDS } from '@keel/protocol';
import { ideaBoard } from '../../protocol/test/helpers';

/**
 * The contract's example of every picture kind, as in protocol/test/schema.test.ts (that file
 * runs tests when it is imported, so the examples are copied here). They are drawn on
 * `ideaBoard()`, the protocol's own small board with a model of four parts in two lanes.
 */

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

export const EXAMPLES: Record<(typeof PICTURE_KINDS)[number], Record<string, unknown>> = {
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

/**
 * Pictures that push a layout to its limits, beyond the contract's one example per kind: a
 * focus with eight long crossings and long sample chips, and a blueprint with assumptions.
 */
export const STRESS: Record<string, Record<string, unknown>> = {
  'ex-focus-crossings': {
    kind: 'focus',
    part: 'door',
    title: 'The door, with eight crossings',
    crosses: [
      { dir: 'in', what: 'Path to the budget file from the command line', part: 'handler', note: 'from the command line, as typed by the owner on the first run' },
      { dir: 'in', what: 'groceries 200, eating out 80', note: 'the limits, one per category, as the budget file says them' },
      { dir: 'in', what: 'Submit', part: 'handler', note: 'a new request' },
      { dir: 'in', what: 'Abort req-41', note: 'the client left' },
      { dir: 'out', what: 'Limits in cents, by category name', part: 'scheduler', note: 'to the over-budget check' },
      { dir: 'out', what: 'Bad file message, the same as a bad CSV', note: 'to the command line' },
      { dir: 'out', what: 'Delta', part: 'scheduler', note: 'a piece of text' },
      { dir: 'out', what: 'Finished', part: 'scheduler', note: 'the end, with counts' },
    ],
    inside: [
      { name: 'Read and decode', plain: 'opens the file, reads the JSON', holds: ['budget.json'] },
      { name: 'Check each limit', plain: 'a number, not negative', holds: ['200', '80.50', '-5 rejected'] },
      { name: 'Match names', plain: 'lowercase, trimmed, like the parser', holds: ['Groceries to groceries', 'Eating Out to eating ou'] },
      { name: 'Make cents', plain: 'reuses the parser\'s toCents', tone: 'teal' },
    ],
    summary: 'Reads the budget file once, turns each limit into cents, and refuses a bad file with a plain message.',
  },
  'ex-blueprint-assumed': {
    kind: 'blueprint',
    title: 'The blueprint, with what I assumed',
    picks: [{ text: 'One engine loop', from: { item: 'a2' } }],
    assumed: [
      'A limit of 0 means "no spending allowed", not "no limit".',
      'Category names match without case: "Groceries" is "groceries".',
      'The budget file sits next to the expenses file.',
    ],
    proof: ['ullm sim runs 50 clients and each gets one answer'],
    parts: ['door', 'scheduler'],
    check: 'make check',
  },
};

/** The idea board with each example posted on it as a picture `ex-<kind>`, and with `stress` the pictures of STRESS too. */
export function examplesBoard(stress = false): { state: BoardState; items: string[] } {
  const b = ideaBoard();
  const items: string[] = [];
  const all = { ...Object.fromEntries(Object.entries(EXAMPLES).map(([k, v]) => [`ex-${k}`, v])), ...(stress ? STRESS : {}) };
  for (const [id, picture] of Object.entries(all)) {
    b.must('agent', { type: 'item.add', chapter: 'engine-loop', item: { id, kind: 'picture', picture, from: ['a1'] } });
    items.push(id);
  }
  return { state: b.state, items };
}
