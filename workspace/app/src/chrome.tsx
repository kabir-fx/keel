import type { BoardState, ChapterState, Id, Presence, PresenceState } from '@keel/protocol';
import { currentChapter, liveItems, openCount } from '@keel/protocol';
import { Star } from '@keel/pictures';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { KeyName } from './input/keytable';
import { keyCaps, keyWords } from './input/keytable';
import { NO_SPEECH } from './speech';

/* ------------------------------------------------------------ board pill */

const CHIP: Record<ChapterState, string> = { idea: 'idea', solid: 'solid', building: 'building', built: 'built' };

/**
 * The board pill: the board's name, the chapter in view with its state, the items and the open
 * marks. In the Story it says how many ideas there are and how many are built.
 */
export function BoardPill({ state, chapter: inView, mode = 'board' }: { state: BoardState; chapter?: Id | undefined; mode?: ViewMode }) {
  const chapterId = inView && state.chapters[inView] ? inView : currentChapter(state);
  const chapter = chapterId ? state.chapters[chapterId] : undefined;
  const items = liveItems(state).length;
  const open = openCount(state);
  const ideas = state.chapterOrder.length;
  const built = state.chapterOrder.filter((id) => state.chapters[id]?.state === 'built').length;
  const story = mode === 'story';
  return (
    <header className="chrome pill pill--board" aria-label="Board" data-viewport-ui="top" data-chapter={story ? undefined : chapter?.id}>
      <svg width="28" height="28" viewBox="0 0 28 28" role="img" aria-label="Keel">
        <rect width="28" height="28" rx="7" fill="#0F1B2D" />
        <path d="M6 10 H22 C21 16 18 19 14 20 C10 19 7 16 6 10 Z M14 6 V20" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <h1 className="pill__name" data-testid="board-name">
        {state.name || 'Board'}
        {story ? <span className="pill__chapter"> · the story</span> : chapter && <span className="pill__chapter"> · {chapter.title}</span>}
      </h1>
      {!story && chapter && (
        <span className={`k-state k-state--${chapter.state}`} data-testid="chapter-state">
          {CHIP[chapter.state]}
        </span>
      )}
      <span className="sep" aria-hidden="true" />
      {story ? (
        <span className="pill__count" data-testid="idea-count" data-n={ideas}>
          {ideas} {ideas === 1 ? 'idea' : 'ideas'} · {built} built
        </span>
      ) : (
        <span className="pill__count" data-testid="item-count" data-n={items}>
          {items} {items === 1 ? 'item' : 'items'}
        </span>
      )}
      <span className={open > 0 ? 'pill__open pill__open--some' : 'pill__open'} data-testid="open-count" data-n={open}>
        {open} open {open === 1 ? 'mark' : 'marks'}
      </span>
    </header>
  );
}

/* ----------------------------------------------------------- view switch */

export type ViewMode = 'board' | 'story';

/** Board or Story: the board itself, or every idea as a chapter and the whole pipeline. */
export function ViewSwitch({ mode = 'board', onMode }: { mode?: ViewMode; onMode?: (mode: ViewMode) => void }) {
  return (
    <nav className="chrome view-switch" aria-label="View" data-viewport-ui="top">
      {(['board', 'story'] as const).map((m) => (
        <button key={m} type="button" className={mode === m ? 'view-switch__on' : undefined} aria-pressed={mode === m} onClick={() => mode !== m && onMode?.(m)}>
          {m === 'board' ? 'Board' : 'Story'}
        </button>
      ))}
    </nav>
  );
}

/* --------------------------------------------------------- presence pill */

export const PRESENCE_WORDS: Record<PresenceState, string> = {
  listening: 'listening',
  drawing: 'drawing',
  waiting: 'waiting for your go',
  building: 'building',
  away: 'away',
};

/** A note this short fits the pill. A longer one is said beside the agent's cursor. */
export const PILL_NOTE_MAX = 48;

/**
 * What the presence pill says. A short note fits the pill. A longer one is said beside the
 * agent's cursor, when the cursor is on the board; else the pill says it, so a reason is never
 * lost. Away always says why, when the server or the agent gave a reason.
 */
export function presenceText(p: Presence, cursorSays = false, titles: readonly string[] = []): string {
  if (p.state === 'away') return p.note ? `away · ${p.note}` : PRESENCE_WORDS.away;
  if (!p.note || isOnlyTitle(p.note, titles)) return PRESENCE_WORDS[p.state];
  return p.note.length <= PILL_NOTE_MAX || !cursorSays ? p.note : PRESENCE_WORDS[p.state];
}

/**
 * A note that is only a chapter's title ("Tell me when I go over") says what is being worked
 * on, not what the agent does: the pill says the state instead.
 */
export function isOnlyTitle(note: string, titles: readonly string[]): boolean {
  const bare = note.trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim().toLowerCase();
  return bare.length > 0 && titles.some((t) => t.trim().toLowerCase() === bare);
}

/**
 * The note the pill leaves to the agent's cursor: one too long for the pill, while the agent is
 * there and its cursor is on the board. A note that is only a chapter's title is said nowhere:
 * not in the pill, so not beside the cursor either.
 */
export function leftToCursor(p: Presence, cursorOnBoard: boolean, titles: readonly string[]): string | undefined {
  return cursorOnBoard && p.state !== 'away' && p.note && p.note.length > PILL_NOTE_MAX && !isOnlyTitle(p.note, titles) ? p.note : undefined;
}

export function PresencePill({ presence, cursorSays = false, titles = [] }: { presence: Presence; cursorSays?: boolean; titles?: readonly string[] }) {
  const s = presence.state;
  const text = presenceText(presence, cursorSays, titles);
  // The cursor is drawn in the overlay, where a screen reader does not look: the pill says its note to one, and shows it whole in its tip.
  const left = leftToCursor(presence, cursorSays, titles);
  return (
    <div className={`chrome pill pill--agent pill--${s}`} data-testid="presence" data-viewport-ui="top" data-state={s} role="status" aria-live="polite" data-tip={`The agent: ${left ?? text}`}>
      <Star />
      <span className="pill__said">
        <b>The agent:</b> {text}
      </span>
      {left && <span className="for-reader">{left}</span>}
      {s !== 'away' && (
        <span className={`presence-sign presence-sign--${s}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- toolbar */

/** The tools that change what a press on the board does. */
export type ToolId = 'select' | 'pan' | 'pen' | 'box' | 'arrow' | 'note' | 'pin' | 'lasso' | 'eraser';

interface ToolDef {
  id: ToolId | 'drop' | 'talk';
  label: string;
  /** The tool's word, under its icon. */
  word: string;
  /** The shortcut that picks it, by its name in the key table: its title shows that key's words. */
  shortcut: KeyName;
  /** Owner tools draw in the owner's colour. */
  owner: boolean;
  icon: ReactNode;
}

const ICON = (d: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    {d}
  </svg>
);

export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', word: 'Select', shortcut: 'tool.select', owner: false, icon: ICON(<path d="M5 3 L5 16 L8.5 12.5 L11 18 L13 17 L10.5 11.5 L15.5 11.5 Z" />) },
  { id: 'pan', label: 'Pan', word: 'Pan', shortcut: 'tool.pan', owner: false, icon: ICON(<path d="M10 3 V17 M3 10 H17 M8 5 L10 3 L12 5 M8 15 L10 17 L12 15 M5 8 L3 10 L5 12 M15 8 L17 10 L15 12" />) },
  { id: 'pen', label: 'Draw with the pen', word: 'Pen', shortcut: 'tool.pen', owner: true, icon: ICON(<path d="M4 16 L5 12 L13.5 3.5 L16.5 6.5 L8 15 Z M11.5 5.5 L14.5 8.5" />) },
  { id: 'box', label: 'Draw a box', word: 'Box', shortcut: 'tool.box', owner: true, icon: ICON(<rect x="3.5" y="5" width="13" height="10" rx="1.5" />) },
  { id: 'arrow', label: 'Draw an arrow', word: 'Arrow', shortcut: 'tool.arrow', owner: true, icon: ICON(<path d="M4 16 L16 4 M9 4 H16 V11" />) },
  { id: 'note', label: 'Write a note', word: 'Note', shortcut: 'tool.note', owner: true, icon: ICON(<path d="M4 4 H16 V12 L12 16 H4 Z M12 16 V12 H16" />) },
  {
    id: 'pin',
    label: 'Pin a place inside an item',
    word: 'Pin',
    shortcut: 'tool.pin',
    owner: true,
    icon: ICON(
      <>
        <path d="M10 18 C10 18 15 12.5 15 8.5 A5 5 0 0 0 5 8.5 C5 12.5 10 18 10 18 Z" />
        <circle cx="10" cy="8.5" r="1.8" />
      </>,
    ),
  },
  {
    id: 'lasso',
    label: 'Lasso several items',
    word: 'Lasso',
    shortcut: 'tool.lasso',
    owner: true,
    icon: ICON(
      <>
        <ellipse cx="10" cy="8.5" rx="7" ry="5" strokeDasharray="2.6 2.6" />
        <path d="M6.5 13 L5 17" />
      </>,
    ),
  },
  {
    id: 'eraser',
    label: 'Erase your ink, boxes, arrows and pins',
    word: 'Erase',
    shortcut: 'tool.eraser',
    owner: true,
    icon: ICON(<path d="M8 16.5 L3.5 12 L11.5 4 L16.5 9 L9 16.5 Z M7 8.5 L12 13.5 M9 16.5 H16.5" />),
  },
  {
    id: 'drop',
    label: 'Drop in a file, a picture or a link',
    word: 'Drop in',
    shortcut: 'drop',
    owner: true,
    icon: ICON(
      <>
        <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
        <path d="M3.5 13 L8 9 L11 12 L13 10.5 L16.5 13.5" />
        <circle cx="12.5" cy="8" r="1.1" />
      </>,
    ),
  },
  {
    id: 'talk',
    label: 'Talk to the agent',
    word: 'Talk',
    shortcut: 'talk',
    owner: true,
    icon: ICON(
      <>
        <rect x="8" y="3" width="4" height="8" rx="2" />
        <path d="M5.5 9.5 a4.5 4.5 0 0 0 9 0 M10 14 V17 M7.5 17 H12.5" />
      </>,
    ),
  },
];

export interface TalkControl {
  /** False where the browser has no speech recognition. */
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
  /** A press where there is no speech recognition. */
  unsupported: () => void;
}

export interface SolidifyControl {
  /** How many items the open lasso holds; 0 when there is no lasso to solidify. */
  count: number;
  onSolidify: () => void;
}

/** A tool's tooltip: its name and its key. */
const tipOf = (t: ToolDef) => `${t.label} (${keyWords(t.shortcut)})`;

/**
 * A click by the pointer on the toolbar leaves the focus on the button it pressed, and the next
 * Enter would press that button again (Space pans: see `focusOwner.ts`). So the focus goes back
 * to the page: the keys are the board's again. A click made with the keyboard keeps its place
 * among the buttons.
 */
function giveFocusBack(e: ReactMouseEvent<HTMLElement>): void {
  if (e.detail === 0) return;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && e.currentTarget.contains(focused)) focused.blur();
}

export function Toolbar({
  tool,
  onTool,
  onDrop,
  talk,
  solidify,
}: {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  onDrop: () => void;
  talk: TalkControl;
  solidify: SolidifyControl;
}) {
  const button = (t: ToolDef) => {
    if (t.id === 'talk') return <TalkButton key={t.id} def={t} talk={talk} />;
    const on = tool === t.id;
    const cls = ['tool', t.owner ? 'tool--owner' : 'tool--work', on ? 'tool--on' : ''].filter(Boolean).join(' ');
    return (
      <button
        key={t.id}
        type="button"
        className={cls}
        aria-label={t.label}
        aria-pressed={t.id === 'drop' ? undefined : on}
        data-tip={tipOf(t)}
        data-tool={t.id}
        onClick={() => (t.id === 'drop' ? onDrop() : onTool(t.id as ToolId))}
      >
        {t.icon}
        <span className="tool__word" aria-hidden="true">
          {t.word}
        </span>
      </button>
    );
  };
  const ready = solidify.count > 0;
  return (
    <div className="chrome toolbar" role="toolbar" aria-label="Tools" data-viewport-ui="bottom" onClick={giveFocusBack}>
      {TOOLS.slice(0, 2).map(button)}
      <span className="toolbar__sep" aria-hidden="true" />
      {TOOLS.slice(2).map(button)}
      <span className="toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className={`solidify${ready ? ' solidify--ready' : ''}`}
        disabled={!ready}
        data-tip={
          ready
            ? `Solidify the ${solidify.count} ${solidify.count === 1 ? 'item' : 'items'} in your lasso (${keyWords('solidify')})`
            : `Solidify: first lasso the pictures you pick (${keyWords('solidify')})`
        }
        data-tool="solidify"
        onClick={solidify.onSolidify}
      >
        <span>Solidify</span>
        {ready ? (
          <span className="solidify__n" aria-label={`${solidify.count} picked`}>
            {solidify.count}
          </span>
        ) : (
          <span className="solidify__hint">lasso first</span>
        )}
      </button>
    </div>
  );
}

/** Hold to speak. Where the browser cannot listen, the button says so, and a press says it again. */
function TalkButton({ def, talk }: { def: ToolDef; talk: TalkControl }) {
  const cls = ['tool', 'tool--owner', talk.listening ? 'tool--on tool--listening' : '', talk.supported ? '' : 'tool--off'].filter(Boolean).join(' ');
  if (!talk.supported) {
    return (
      <button type="button" className={cls} aria-label={def.label} aria-disabled="true" data-tip={`${def.label}: ${NO_SPEECH}`} data-tool="talk" onClick={talk.unsupported}>
        {def.icon}
        <span className="tool__word" aria-hidden="true">
          {def.word}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      aria-label={def.label}
      aria-pressed={talk.listening}
      data-tip={`${def.label}: hold to speak (${keyCaps(def.shortcut)})`}
      data-tool="talk"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        talk.start();
      }}
      onPointerUp={talk.stop}
      onPointerCancel={talk.stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          talk.start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') talk.stop();
      }}
    >
      {def.icon}
      <span className="tool__word" aria-hidden="true">
        {def.word}
      </span>
    </button>
  );
}

/** What Talk has heard so far, while the owner holds it. */
export function TalkCaption({ text }: { text: string }) {
  return (
    <div className="chrome talk-caption" role="status" data-testid="talk-caption">
      <span className="talk-caption__dot" aria-hidden="true" />
      <span>{text || 'Listening. Say it, then let go.'}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- toast */

export function Toast({ text, onClose }: { text: string | undefined; onClose: () => void }) {
  if (!text) return null;
  return (
    <div className="chrome toast" role="alert" data-testid="toast">
      <span>{text}</span>
      <button type="button" aria-label="Dismiss" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3 L11 11 M11 3 L3 11" />
        </svg>
      </button>
    </div>
  );
}
