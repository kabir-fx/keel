import type { Id } from './ids';
import type { BlueprintPicture } from './pictures';
import type { BoardState, PartRecord } from './state';
import { liveParts, remarksOnPart } from './state';
import { describeTarget } from './digest';
import { flatLine } from './secrets';

/**
 * The brief: a solidified idea as plain text. The blueprint is the brief as a picture, and
 * this is the same idea as a page. The builder reads it, and it is written into the target
 * repository beside the code, so the idea outlives the board.
 *
 * It adds no decision. Every line comes from the board: the owner's picks, the blueprint
 * the agent read back, the model and the walk. Every word that came from a person or an
 * agent is put on one line, so none of it can pass for a heading or a section of the brief.
 */
export function renderBrief(state: BoardState, chapter: Id): string | undefined {
  const c = Object.hasOwn(state.chapters, chapter) ? state.chapters[chapter] : undefined;
  if (!c) return undefined;
  const blueprint = findBlueprint(state, chapter);
  const lines: string[] = [];
  lines.push(`# ${one(c.title)}`, '');
  lines.push(`**State:** ${stateLine(state, chapter)}`);
  lines.push(`**Board:** chapter \`${c.id}\` in \`.keel/board/log.jsonl\`. The board is where this idea was worked out.`, '');

  if (blueprint?.summary) lines.push('## The goal', '', one(blueprint.summary), '');

  if (blueprint?.picks.length) {
    lines.push('## What you picked', '');
    blueprint.picks.forEach((p, i) => {
      const from = p.from ? ` (from ${one(describeTarget(state, p.from).label)})` : '';
      lines.push(`${i + 1}. ${one(p.text)}${from}`);
    });
    lines.push('');
  }

  const track = c.track.length ? c.track : (blueprint?.parts ?? []);
  if (track.length) {
    lines.push('## The parts, in build order', '', 'One commit each.', '');
    track.forEach((id, i) => {
      const p = Object.hasOwn(state.model.parts, id) ? state.model.parts[id] : undefined;
      if (!p) return;
      const where = p.lane !== undefined ? state.model.lanes.find((l) => l.id === p.lane)?.name : undefined;
      const bits = [`${i + 1}. **${one(p.name)}**`];
      if (p.plain) bits.push(`: ${one(p.plain)}`);
      if (where) bits.push(` (${one(where)})`);
      bits.push(` \`${p.id}\` · ${p.state}${p.commit ? ` at \`${code(p.commit)}\`` : ''}`);
      lines.push(bits.join(''));
      if (p.note) lines.push(`   - Note: ${one(p.note)}`);
      // What the owner said on this part since the idea was decided, in their words. It is
      // part of the part: build it, whatever the part's own wording says.
      for (const r of remarksOnPart(state, id)) lines.push(`   - The owner said, on this part: "${one(r.text)}"`);
    });
    lines.push('');
  }

  const others = liveParts(state).filter((p) => !track.includes(p.id) && p.lane !== undefined);
  const there = others.filter((p) => p.external || p.state === 'built');
  if (there.length) {
    lines.push('## What is already there', '');
    for (const p of there) lines.push(partLine(p, p.external ? 'outside the system' : 'built'));
    lines.push('');
  }
  const notNow = others.filter((p) => !p.external && p.state !== 'built');
  if (notNow.length) {
    lines.push('## Not in this build', '');
    for (const p of notNow) lines.push(partLine(p, p.state === 'later' ? 'put off' : p.state === 'idea' ? 'an idea' : `${p.state}, on another track`));
    lines.push('');
  }

  const named = blueprint?.walk !== undefined && Object.hasOwn(state.model.walks, blueprint.walk) ? state.model.walks[blueprint.walk] : undefined;
  const walk = named ?? Object.values(state.model.walks)[0];
  if (walk) {
    lines.push(`## ${one(walk.name)}`, '');
    for (const s of walk.steps) {
      const part = Object.hasOwn(state.model.parts, s.part) ? state.model.parts[s.part] : undefined;
      lines.push(`${s.n}. ${one(s.text)}${part ? ` (${one(part.name)})` : ''}`);
    }
    lines.push('');
  }

  if (blueprint?.leftOut?.length) {
    lines.push('## Left out on purpose', '');
    for (const l of blueprint.leftOut) lines.push(`- ${one(l.text)}${l.why ? ` ${one(l.why)}` : ''}`);
    lines.push('');
  }

  if (blueprint?.assumed?.length) {
    lines.push('## What the agent assumed', '', 'The owner did not say these. Each one can be wrong.', '');
    for (const a of blueprint.assumed) lines.push(`- ${one(a)}`);
    lines.push('');
  }

  if (blueprint?.proof.length) {
    lines.push('## How you will know it works', '');
    for (const p of blueprint.proof) lines.push(`- ${one(p)}`);
    lines.push('');
  }

  // Once the owner has pressed "Build this", the check is the one they agreed to, and no
  // later edit of a blueprint changes it.
  const started = c.state === 'building' || c.state === 'built';
  const check = started ? c.check : blueprint?.check;
  if (check) {
    lines.push('## The check', '', 'A part is built when this command passes after its commit:', '', `    ${one(check)}`, '');
  }

  const setup = started ? c.setup : blueprint?.setup;
  if (setup) {
    lines.push('## Setup', '', 'A fresh copy is made ready with this command, run once before the build:', '', `    ${one(setup)}`, '');
  }

  const show = started ? c.show : blueprint?.show;
  if (show) {
    lines.push('## How the owner tries it', '');
    if (show.kind === 'page') lines.push('A page that stands alone: it opens in a browser with nothing run. Every script and style it names is a file beside it.', '');
    else if (show.kind === 'app') {
      lines.push(
        `The board runs this command in the built copy and opens the app when it answers. It listens on ${show.port !== undefined ? `port ${show.port}` : 'the port in `PORT`, on 127.0.0.1'}:`,
        '',
        `    ${one(show.run)}`,
        '',
      );
    } else lines.push('The board opens a terminal in the built copy and types this command:', '', `    ${one(show.run)}`, '');
    lines.push('The build is not done until this works: the parts must include what makes it run.', '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** One line, with nothing at its start that Markdown reads as a heading, a list or a quote. */
function one(text: string): string {
  // On one line, and with nothing that starts a block of its own: a heading, a list, a quote, a code fence.
  const flat = flatLine(text).replace(/`{3,}|~{3,}/g, "'''");
  return flat.replace(/^([#>*+-]|\d+[.)])(\s)/, '\\$1$2');
}

/** Words for a code span: no backtick can end it early. */
function code(text: string): string {
  return one(text).replace(/`/g, "'");
}

function partLine(p: PartRecord, what: string): string {
  return `- **${one(p.name)}**${p.plain ? `: ${one(p.plain)}` : ''} · ${what}${p.commit ? ` at \`${code(p.commit)}\`` : ''}`;
}

function stateLine(state: BoardState, chapter: Id): string {
  const c = state.chapters[chapter]!;
  const built = c.track.filter((id) => state.model.parts[id]?.state === 'built').length;
  switch (c.state) {
    case 'idea':
      return 'an idea. Nothing is decided yet.';
    case 'solid':
      return 'decided. It waits for "Build this".';
    case 'building':
      return `in build, ${built} of ${c.track.length} parts built${c.paused ? ', paused' : ''}.`;
    case 'built':
      return `built, ${built} of ${c.track.length} parts.`;
  }
}

/**
 * The chapter's blueprint. Once the owner has pressed "Build this", it is the one they
 * pressed on, and nothing else. Before that, it is the latest one on the board.
 */
export function findBlueprint(state: BoardState, chapter: Id): BlueprintPicture | undefined {
  const c = Object.hasOwn(state.chapters, chapter) ? state.chapters[chapter] : undefined;
  if (!c) return undefined;
  if (c.blueprint !== undefined) {
    const named = state.items[c.blueprint];
    if (named && !named.removed && named.item.kind === 'picture' && named.item.picture.kind === 'blueprint') return named.item.picture;
  }
  if (c.state === 'building' || c.state === 'built') return undefined;
  for (let i = state.itemOrder.length - 1; i >= 0; i--) {
    const s = state.items[state.itemOrder[i]!];
    if (s && !s.removed && s.chapter === chapter && s.item.kind === 'picture' && s.item.picture.kind === 'blueprint') return s.item.picture;
  }
  return undefined;
}
