import type { BoardState, Id } from '@keel/protocol';
import { scopeToCanvas } from '@keel/protocol';
import type { Draft } from './drafts';
import { chapterId } from './drafts';
import type { BoardSource, PostResult } from './source';

/**
 * The board as the canvas in view shows it (record 0014): a source whose `state` holds only
 * that canvas's chapters, items, acts, feed and moments, with the whole model. Everything in
 * the Board view reads it, so nothing of another canvas is laid out, placed, fitted or counted
 * there. The Story and the try room read the whole board (`whole`).
 *
 * What the page posts goes to the canvas in view: a new idea is opened on it. Its id is made
 * from the canvas's own state, so an id another canvas holds is given a free one here, and the
 * rest of the same gesture follows it.
 */
export class CanvasSource implements BoardSource {
  private cache: { whole: BoardState; canvas: Id | undefined; state: BoardState } | undefined;
  /** Ids of new ideas given a free one, by the canvas they were opened on. */
  private readonly renamed = new Map<Id, Map<Id, Id>>();

  constructor(
    readonly inner: BoardSource,
    private readonly canvas: () => Id | undefined,
  ) {}

  get state(): BoardState {
    const whole = this.inner.state;
    const canvas = this.canvas();
    const c = this.cache;
    if (c && c.whole === whole && c.canvas === canvas) return c.state;
    const state = canvas && whole.canvases[canvas] ? scopeToCanvas(whole, canvas) : whole;
    this.cache = { whole, canvas, state };
    return state;
  }

  get whole(): BoardState {
    return this.inner.whole ?? this.inner.state;
  }

  get presence() {
    return this.inner.presence;
  }
  get role() {
    return this.inner.role;
  }
  get connection() {
    return this.inner.connection;
  }
  get build() {
    return this.inner.build;
  }
  get foreign() {
    return this.inner.foreign;
  }
  get snapshots() {
    return this.inner.snapshots;
  }
  get works() {
    return this.inner.works;
  }
  get shows() {
    return this.inner.shows;
  }
  get home() {
    return this.inner.home;
  }
  get keep() {
    return this.inner.keep;
  }
  get show() {
    return this.inner.show;
  }
  get showStream() {
    return this.inner.showStream;
  }
  get push() {
    return this.inner.push;
  }
  get sync() {
    return this.inner.sync;
  }
  get onOwnMark() {
    return this.inner.onOwnMark;
  }

  readAsset = (asset: string) => this.inner.readAsset(asset);
  upload = (name: string, body: Blob) => this.inner.upload(name, body);
  subscribe = (l: () => void) => this.inner.subscribe(l);
  close = () => this.inner.close();

  post = (draft: Draft): Promise<PostResult> => this.inner.post(this.onCanvas(draft));

  /** The draft as the canvas in view sends it. */
  onCanvas(draft: Draft): Draft {
    const canvas = this.canvas();
    const whole = this.whole;
    if (draft.type === 'chapter.open') {
      let id = draft.chapter;
      if (whole.chapters[id] || whole.removedChapters[id]) {
        const free = chapterId(draft.title, whole);
        if (canvas) this.renamedOn(canvas).set(id, free);
        id = free;
      }
      const on = draft.canvas ?? (canvas && whole.canvases[canvas] ? canvas : undefined);
      return { ...draft, chapter: id, ...(on ? { canvas: on } : {}) };
    }
    const named = 'chapter' in draft && typeof draft.chapter === 'string' ? draft.chapter : undefined;
    const free = named && canvas ? this.renamed.get(canvas)?.get(named) : undefined;
    // Only while the id it stood for is another canvas's: on that canvas, it is its own.
    if (free && named && whole.chapters[named]?.canvas !== canvas) return { ...draft, chapter: free } as Draft;
    return draft;
  }

  private renamedOn(canvas: Id): Map<Id, Id> {
    let m = this.renamed.get(canvas);
    if (!m) this.renamed.set(canvas, (m = new Map()));
    return m;
  }
}

/** A free id for a new canvas: never one a canvas holds or held. */
export function newCanvasId(whole: BoardState): Id {
  const taken = (id: Id) => !!whole.canvases[id] || !!whole.removedCanvases[id] || !!whole.chapters[id] || !!whole.removedChapters[id];
  for (let n = whole.canvasOrder.length + Object.keys(whole.removedCanvases).length + 1; ; n++) {
    const id = `canvas-${n}`;
    if (!taken(id)) return id;
  }
}

/** The canvas to show: the one asked for while it is there, else the newest. */
export function canvasToShow(whole: BoardState, asked: Id | undefined): Id | undefined {
  if (asked && whole.canvases[asked]) return asked;
  return whole.canvasOrder[whole.canvasOrder.length - 1];
}
