// A stand-in agent for tests and demos. The board server loads it with
// `--link script:<this file>`. It answers every open mark with one card that says how it
// read the mark. It stands in for the real agent, and it shows the smallest thing an agent
// has to do: read the digest, post a picture, name what it answers.
export async function answer(wake, post) {
  const marks = wake.digest.open.filter((o) => o.kind !== 'lasso');
  if (marks.length === 0) return;
  const chapter = wake.digest.chapter?.id;
  const said = marks.map((m) => m.text).filter(Boolean);
  const result = await post({
    type: 'item.add',
    chapter,
    item: {
      id: `a-${wake.digest.seq}`,
      kind: 'picture',
      picture: {
        kind: 'text',
        title: 'How I read your note',
        body: said.length ? `You wrote: ${said.join(' / ').slice(0, 400)}` : 'I see your marks.',
        lean: 'This is the stand-in agent. The real one answers in pictures.',
      },
      answers: marks.map((m) => m.id),
    },
  });
  if (!result.ok) throw new Error(`${result.rule}: ${result.reason}`);
}
