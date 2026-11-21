// A stand-in agent for the arrival's live tests. The board server loads it with
// `--link script:<this file>`. It answers a note as the agent's skill asks for a slow picture:
// a card placeholder at once, finished a moment later as a wide picture (lanes).

/** How long the placeholder shows before it is finished, in ms: long enough to be drawn on first. */
const DRAWING_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function must(result) {
  const r = await result;
  if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
  return r;
}

export async function answer(wake, post) {
  const d = wake.digest;
  const chapter = d.chapter?.id;
  const notes = d.open.filter((o) => o.kind === 'note' && o.fresh);
  if (notes.length === 0 || !chapter) return;
  const id = `wide-${d.seq}`;
  await must(post({ type: 'item.add', chapter, item: { id, kind: 'picture', picture: { kind: 'text', title: 'Reading your idea back', body: 'Drawing the lanes.' }, answers: notes.map((n) => n.id), status: 'drawing' } }));
  await sleep(DRAWING_MS);
  const lanes = [
    { id: 'owner', name: 'The owner' },
    { id: 'app', name: 'The app' },
    { id: 'mail', name: 'The mail' },
  ];
  const steps = [
    { id: 's1', lane: 'owner', text: 'adds a bill and its due day' },
    { id: 's2', lane: 'app', text: 'keeps it, and counts the days' },
    { id: 's3', lane: 'app', text: 'a day before, writes the reminder' },
    { id: 's4', lane: 'mail', text: 'sends it to the owner' },
  ];
  await must(post({ type: 'item.update', item: id, patch: { picture: { kind: 'lanes', title: 'How a reminder goes', lanes, steps }, status: 'done' } }));
}
