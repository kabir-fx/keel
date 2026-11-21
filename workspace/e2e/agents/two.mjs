// A stand-in agent for the arrival's live tests. The board server loads it with
// `--link script:<this file>`. It answers a note as the real agent often does: one post that
// brings two pictures, a small drawing that answers the note and a card drawn from it, as
// `board_post` posts them, in one batch.
export async function answer(wake, post) {
  const d = wake.digest;
  const chapter = d.chapter?.id;
  const notes = d.open.filter((o) => o.kind === 'note' && o.fresh);
  if (notes.length === 0 || !chapter) return;
  const answers = notes.map((n) => n.id);
  const result = await post([
    {
      type: 'item.add',
      chapter,
      item: {
        id: `how-${d.seq}`,
        kind: 'picture',
        picture: { kind: 'mini', title: 'How a reminder goes', boxes: [{ text: 'a bill comes in' }, { text: 'a day before it is due', tone: 'blue' }, { text: 'a mail goes out' }] },
        answers,
      },
    },
    {
      type: 'item.add',
      chapter,
      item: {
        id: `read-${d.seq}`,
        kind: 'picture',
        picture: { kind: 'text', title: 'How I read it', body: 'One reminder per bill, by mail, a day before it is due.', questions: ['By text as well?'] },
        from: answers,
      },
    },
  ]);
  if (!result.ok) throw new Error(`${result.rule}: ${result.reason}`);
}
