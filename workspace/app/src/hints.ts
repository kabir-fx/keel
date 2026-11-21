import type { BoardState, Id } from '@keel/protocol';
import { liveItems } from '@keel/protocol';
import type { ToolId } from './chrome';
import type { KeyName } from './input/keytable';
import { keyWords } from './input/keytable';
import { onMac } from './input/match';

/**
 * The hint line: one quiet line above the toolbar that says the owner's next step, so they never
 * have to guess. It is picked from one table, top to bottom, and the first rule that matches
 * wins: what the owner is doing comes before what the agent waits for, which comes before what
 * the tool in hand does, which comes before the empty board.
 *
 * The rules come from Excalidraw's hint line (packages/excalidraw/components/HintViewer.tsx,
 * `getHints`, commit 9fbeaed): one line, verb first, the key named. The words are the board's
 * own, and are all in `HINTS` below, so they can be changed in one place.
 */

/** What the board knows that decides the line. */
export interface HintFacts {
  /** A go of the pen is open: strokes wait to become one mark. */
  readonly penGo: boolean;
  /** The field open for typing, if one is: the words of a mark just drawn, or a note. */
  readonly field: 'label' | 'note' | undefined;
  /** The agent waits for the owner's go. */
  readonly agentWaits: boolean;
  /** How many of the agent's questions no mark of the owner's answers yet. */
  readonly questions: number;
  /** How many things the open lasso holds: 0 when no lasso is open. */
  readonly lassoed: number;
  /** A blueprint is in view whose idea is solid and not built: it waits for "Build this". */
  readonly toBuild: boolean;
  /** The idea in view is built and not in the home branch yet: it waits to be tried and approved. */
  readonly toTry: boolean;
  readonly tool: ToolId;
  /** Nothing is on the board yet. */
  readonly empty: boolean;
  /** The agent is away. */
  readonly away: boolean;
}

/** One rule of the hint line: when it applies, and what it says then. */
export interface HintRule {
  /** When it applies, in a few words. */
  readonly when: string;
  applies(facts: HintFacts): boolean;
  /** The line. `key` gives a shortcut's words as the owner's keyboard writes them. */
  says(facts: HintFacts, key: (name: KeyName) => string): string;
}

/** What each tool is for, said while it is in hand and no press is open. Select is the board's rest: it says nothing. */
export const TOOL_LINES: Partial<Record<ToolId, string>> = {
  pan: 'Drag to move the board.',
  pen: 'Draw on a picture to mark it. Its buttons still work.',
  box: 'Drag round a thing, then type why.',
  arrow: 'Drag from one thing to another.',
  note: 'Click where the note goes, then type.',
  pin: 'Click a place inside a picture.',
  lasso: 'Draw a loop round the pictures you pick.',
  eraser: 'Drag across a mark of yours, or a picture, to take it off.',
};

/** The words for an empty board. They say the agent is there only when it is. */
export const emptyLine = (away: boolean): string =>
  `Write it, draw it, drop something in, or say it. ${away ? 'The agent is away: it reads what you add when it is back.' : 'The agent is on the board with you.'}`;

/** The rules, in the order they are tried. */
export const HINTS: readonly HintRule[] = [
  {
    when: 'a go of the pen is open',
    applies: (f) => f.penGo,
    says: (_f, key) => `Keep drawing. It becomes one mark when you rest the pen. ${key('undo')} takes back the last stroke.`,
  },
  {
    when: 'a label is open',
    applies: (f) => f.field === 'label',
    says: () => 'Type a few words. Enter keeps them.',
  },
  {
    when: 'a note is open',
    applies: (f) => f.field === 'note',
    says: () => 'Type the note. Enter keeps it, Shift+Enter starts a new line.',
  },
  {
    when: 'the agent waits, and a question of its is not answered',
    applies: (f) => f.agentWaits && f.questions > 0,
    says: (f, key) =>
      f.questions === 1
        ? `Answer the question: press ${key('tool.note')}, click beside it, and type. Or ${key('talk')} and say it.`
        : `Answer the ${f.questions} questions: press ${key('tool.note')}, click beside one, and type. Or ${key('talk')} and say it.`,
  },
  {
    when: 'the agent waits, and nothing is lassoed',
    applies: (f) => f.agentWaits && f.lassoed === 0,
    says: (_f, key) => `Pick what to build: press ${key('tool.lasso')} and draw a loop round the pictures you want.`,
  },
  {
    when: 'a lasso holds things',
    applies: (f) => f.lassoed > 0,
    says: (f, key) => `Press Solidify (${key('solidify')}) to make a blueprint from the ${f.lassoed} you picked.`,
  },
  {
    when: 'a blueprint is in view and not built',
    applies: (f) => f.toBuild,
    says: () => 'Read the blueprint, then press Build this.',
  },
  {
    when: 'the idea in view is built and not approved',
    applies: (f) => f.toTry,
    says: () => 'Press Try it to run what was built. When it does what you asked, approve it.',
  },
  {
    when: 'a tool is in hand',
    applies: (f) => TOOL_LINES[f.tool] !== undefined,
    says: (f) => TOOL_LINES[f.tool] ?? '',
  },
  {
    when: 'the board is empty',
    applies: (f) => f.empty,
    says: (f) => emptyLine(f.away),
  },
];

/** The line for what the board knows: the first rule that applies, or none. The keys are written as on a Mac or not, as `mac` says. */
export function hintFor(facts: HintFacts, mac: boolean = onMac()): string | undefined {
  const rule = HINTS.find((r) => r.applies(facts));
  return rule?.says(facts, (name) => keyWords(name, mac));
}

/** True when the chapter in view is built and not merged: the owner has a build to try and approve. */
export function buildWaits(state: BoardState, chapter: Id | undefined): boolean {
  const c = chapter ? state.chapters[chapter] : undefined;
  return c?.state === 'built' && !c.merged;
}

/** True when the chapter in view is solid and holds a blueprint: the owner has a build to agree to. */
export function blueprintWaits(state: BoardState, chapter: Id | undefined): boolean {
  if (!chapter || state.chapters[chapter]?.state !== 'solid') return false;
  return liveItems(state).some((s) => s.chapter === chapter && s.item.kind === 'picture' && s.item.picture.kind === 'blueprint');
}
