// A stand-in agent for screens 5 and 6, for tests and demos. The board server loads it with
// `--link script:<this file>`. Like echo.mjs it stands in for the real agent, and it does the
// least an agent must do to take an idea from a note to a build:
//
// - a note on a board with no model: it draws the idea as a model (four parts, all ideas);
// - any other note: a card that says how it read it;
// - Solidify: the blueprint, read back from the owner's picks, with the solid parts as the
//   build track and one check command;
// - "Build this": a card that says the owner can leave;
// - Pause, Resume and anything else: an answer that says it heard.
//
// Each idea gets its own model: the first idea's parts are `door`, `queue`, `loop` and
// `reply`; a later idea's carry its number, `2-door`. Three settings come from the server's
// environment, so a test that starts the server can set them:
//
// - KEEL_E2E_SHOW: the blueprint's `show`, as JSON, such as {"kind":"app","run":"node app.mjs"};
// - KEEL_E2E_SETUP: the blueprint's `setup` command;
// - KEEL_E2E_PLANNER_WAIT_MS: how long it thinks before it draws a model.

const LANES = [
  { id: 'api', name: 'API thread', note: 'asyncio' },
  { id: 'bridge', name: 'The bridge', note: 'one queue' },
  { id: 'engine', name: 'Engine thread', note: 'the model' },
];

const PARTS = [
  { id: 'door', name: 'The door', plain: '64 open at most', lane: 'api', col: 1 },
  { id: 'queue', name: 'Inbound queue', plain: 'tickets go down', lane: 'bridge', col: 2 },
  { id: 'loop', name: 'Engine loop', plain: 'one turn, one step', lane: 'engine', col: 3 },
  { id: 'reply', name: 'Reply stream', plain: 'text back as it is made', lane: 'api', col: 4 },
];

const EDGES = [
  { from: 'door', to: 'queue', label: 'put' },
  { from: 'queue', to: 'loop' },
  { from: 'loop', to: 'reply', label: 'push' },
];

/** The check the blueprint shows. The builder runs it in its own copy after every commit. */
export const CHECK = 'test -s parts.txt';

/** The ideas it drew a model for, in order: the prefix of each one's parts. */
const drawn = new Map();
const prefixOf = (chapter) => {
  if (!drawn.has(chapter)) drawn.set(chapter, drawn.size === 0 ? '' : `${drawn.size + 1}-`);
  return drawn.get(chapter);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACTS = new Set(['solidify', 'build.start', 'build.pause', 'build.resume', 'choice.pick', 'ask']);

export async function answer(wake, post) {
  const d = wake.digest;
  const chapter = d.chapter?.id;
  const open = d.open;
  const notes = open.filter((o) => o.kind === 'note' && !o.label);
  const acts = open.filter((o) => ACTS.has(o.kind));
  const rest = open.filter((o) => !notes.includes(o) && !acts.includes(o));
  const drafts = [];
  const noteChapter = notes.find((n) => n.chapter)?.chapter ?? chapter;
  const hasModel = drawn.has(noteChapter);

  if (notes.length > 0 && noteChapter) {
    const chapter = noteChapter;
    const answers = notes.map((n) => n.id);
    if (!hasModel) {
      const pre = prefixOf(chapter);
      const wait = Number(process.env.KEEL_E2E_PLANNER_WAIT_MS ?? 0);
      if (wait > 0) await sleep(wait);
      drafts.push({
        type: 'model.patch',
        chapter,
        ops: [
          ...LANES.map((lane) => ({ op: 'lane.set', lane })),
          ...PARTS.map((part) => ({ op: 'part.set', part: { ...part, id: pre + part.id, name: pre ? `${part.name} ${pre.slice(0, -1)}` : part.name } })),
          ...EDGES.map((edge) => ({ op: 'edge.set', edge: { ...edge, from: pre + edge.from, to: pre + edge.to } })),
        ],
      });
      drafts.push({
        type: 'item.add',
        chapter,
        item: {
          id: `model-${d.seq}`,
          kind: 'picture',
          picture: { kind: 'pipeline', title: 'Your idea, as a model', caption: 'Four parts, all ideas. Lasso what you pick and solidify.', view: 'flat' },
          answers,
        },
      });
    } else {
      drafts.push({
        type: 'item.add',
        chapter,
        item: {
          id: `read-${d.seq}`,
          kind: 'picture',
          picture: { kind: 'text', title: 'How I read your note', body: `You wrote: ${notes.map((n) => n.text).join(' / ').slice(0, 300)}` },
          answers,
        },
      });
    }
  }

  for (const a of acts) {
    const ch = a.chapter ?? chapter;
    if (a.kind === 'solidify' && ch) {
      const parts = d.model.parts.filter((p) => p.state === 'solid' && !p.external).map((p) => p.id);
      drafts.push({
        type: 'item.add',
        chapter: ch,
        item: {
          id: `blueprint-${d.seq}`,
          kind: 'picture',
          picture: {
            kind: 'blueprint',
            title: 'The blueprint',
            summary: 'What I will build, in one picture. Nothing else.',
            picks: [{ text: 'One door, one queue, one engine loop' }, { text: 'Text goes back as it is made' }],
            leftOut: [{ text: 'No batches yet', why: 'one request at a time' }],
            proof: ['parts.txt lists every part, one commit each'],
            parts: parts.length > 0 ? parts : PARTS.map((p) => p.id),
            check: CHECK,
            ...(process.env.KEEL_E2E_SETUP ? { setup: process.env.KEEL_E2E_SETUP } : {}),
            ...(process.env.KEEL_E2E_SHOW ? { show: JSON.parse(process.env.KEEL_E2E_SHOW) } : {}),
          },
          answers: [a.id],
        },
      });
    } else if (a.kind === 'build.start' && ch) {
      drafts.push({
        type: 'item.add',
        chapter: ch,
        item: { id: `leave-${d.seq}`, kind: 'picture', picture: { kind: 'text', title: 'You can leave.', body: 'I will mark this board if something needs you. So far nothing does.' }, answers: [a.id] },
      });
    } else {
      drafts.push({ type: 'answer', answers: [a.id], read: `Heard: ${a.kind}.` });
    }
  }

  if (rest.length > 0) drafts.push({ type: 'answer', answers: rest.map((o) => o.id).slice(0, 24), read: 'Seen. Nothing to draw for it.' });
  if (drafts.length === 0) return;
  const result = await post(drafts);
  if (!result.ok) throw new Error(`${result.rule}: ${result.reason}`);
}
