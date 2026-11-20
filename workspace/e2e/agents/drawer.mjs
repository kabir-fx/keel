// A stand-in agent for the arrival's live tests. The board server loads it with
// `--link script:<this file>`. It answers as an agent that takes its time does: a note on a
// board where it has drawn nothing yet gets a placeholder at once, which it finishes a moment
// later, as `board_post` does with `status: "drawing"` and then an update with `status: "done"`
// and the finished picture. A note after that gets the picture it drew, drawn again.

/** How long the placeholder shows before it is finished, in ms: long enough to be drawn on first. */
const DRAWING_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function must(result) {
  const r = await result;
  if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
  return r;
}

/** A small drawing of three boxes: wider and taller than the placeholder's card. */
const mini = (title, words) => ({ kind: 'mini', title, boxes: words.map((text) => ({ text })) });

export async function answer(wake, post) {
  const d = wake.digest;
  const chapter = d.chapter?.id;
  const notes = d.open.filter((o) => o.kind === 'note' && o.fresh);
  if (notes.length === 0 || !chapter) return;
  const answers = notes.map((n) => n.id);

  // Drawn before and finished: draw it again, with what it answered and this note.
  const mine = d.pictures.find((p) => p.id.startsWith('drawn-') && p.status !== 'drawing');
  if (mine) {
    await must(
      post({
        type: 'item.update',
        item: mine.id,
        patch: { picture: mini('How it goes, again', ['a bill comes in', 'a day before it is due', 'a mail goes out']), status: 'done', answers: [...new Set([...mine.answers, ...answers])] },
      }),
    );
    return;
  }

  const id = `drawn-${d.seq}`;
  await must(post({ type: 'item.add', chapter, item: { id, kind: 'picture', picture: mini('How it goes', ['a bill', 'a reminder']), answers, status: 'drawing' } }));
  await sleep(DRAWING_MS);
  await must(post({ type: 'item.update', item: id, patch: { picture: mini('How it goes', ['a bill', 'the day before', 'a reminder']), status: 'done' } }));
}
