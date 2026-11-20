/**
 * Dropping a file onto the board: what of it may be opened from this page, the "drop here"
 * overlay, and the drop itself.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `dragDepth` in packages/excalidraw/components/FileDropOverlay.tsx, for the count of how deep
 * a drag is inside the board.
 */

import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { noteDrafts } from '../drafts';
import { fitPaste, NOTE_MAX } from '../fieldText';
import { typing } from '../input/keys';
import { fileItem } from '../marks';
import type { BoardSource } from '../source';
import { MAX_UPLOAD } from '../source';
import type { Board } from './context';
import { NOTE_FULL, NOTE_WIDTH } from './notes';

/** A drag over the board, as React hands it over. */
type BoardDragEvent = ReactDragEvent<HTMLDivElement>;

/** A point on the page: clientX and clientY. */
export interface PagePoint {
  x: number;
  y: number;
}

/**
 * A dropped-in file as it may be opened from this page: a picture (not an SVG) or a PDF as it
 * is; anything else that is text (HTML and SVG too) as plain text, so nothing in it can run
 * in the board's own origin, where the owner's token is kept. Other files are saved, not shown.
 */
export function viewable(blob: Blob, name: string): Blob {
  const t = blob.type.toLowerCase();
  if ((t.startsWith('image/') && !t.includes('svg')) || t === 'application/pdf') return blob;
  const texty = t.startsWith('text/') || /json|xml|yaml|javascript|svg/.test(t) || /\.(md|txt|csv|tsv|json|ya?ml|log|html?|svg|xml|[cm]?[jt]sx?|py|rs|go|sh|toml|ini)$/i.test(name);
  return texty ? new Blob([blob], { type: 'text/plain;charset=utf-8' }) : new Blob([blob], { type: 'application/octet-stream' });
}

/**
 * How deep a drag is inside the board, counted from its enter and leave events. Going onto a
 * thing on the board is an enter of that thing and then a leave of what the pointer was on, so
 * the count only reaches nothing when the drag has left the board: the "drop here" overlay
 * neither flickers nor sticks. A drag that is over the board is at least one deep, whatever
 * event was missed. Excalidraw's rule: see the notice at the top of this file.
 */
export function dragDepth(depth: number, event: 'enter' | 'over' | 'leave'): number {
  if (event === 'enter') return depth + 1;
  if (event === 'over') return Math.max(1, depth);
  return Math.max(0, depth - 1);
}

/** What a drag is made of, as the board and the page read it. */
interface Dragged {
  readonly target: EventTarget | null;
  readonly dataTransfer: DataTransfer | null;
}

const carries = (e: Dragged, type: string): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes(type);

/** Does the drag hold something the board takes in: a file, a link or a bit of text? */
const droppable = (e: Dragged): boolean => carries(e, 'Files') || carries(e, 'text/uri-list') || carries(e, 'text/plain');

/** Words dragged over a field the owner types in are the field's: the owner may be moving a word. A file never is. */
const forField = (e: Dragged): boolean => typing(e.target) && !carries(e, 'Files');

/** Dropping things in on one board. */
export interface DropIn {
  /** True while something that can be dropped in is dragged over the board. */
  dropping: boolean;
  onDragEnter(e: BoardDragEvent): void;
  onDragOver(e: BoardDragEvent): void;
  onDragLeave(e: BoardDragEvent): void;
  onDrop(e: BoardDragEvent): void;
  /** Take the "drop here" overlay off. False when it was not showing. */
  end(): boolean;
  /** Drop files in: at a page point, or in the middle of the screen when none is given. */
  addFiles(files: readonly File[], client?: PagePoint): Promise<void>;
  /**
   * A link or a bit of text becomes a note at a page point, on what is there: made plain and cut
   * to what a note holds, as a paste into a note's field is.
   */
  addText(text: string, client: PagePoint): Promise<void>;
  /** Open a dropped-in file in a new tab, or save it where the browser blocks the tab. */
  openFile(asset: string, name: string): Promise<void>;
}

/**
 * Drop in: a file dragged onto the board (or picked) becomes a file mark, a link or a bit of
 * text becomes a note, each where it lands and on what it lands on.
 *
 * A drop never makes the tab leave the board. A browser opens a dropped file or link in the
 * tab unless the page refuses the drag, so the whole page refuses every drag the board does
 * not take: one by a viewer, one over a panel, one of something that cannot be dropped in.
 */
export function useDrop(board: Board, source: BoardSource): DropIn {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const { say } = board;

  const count = (event: 'enter' | 'over' | 'leave') => {
    depth.current = dragDepth(depth.current, event);
    setDropping(depth.current > 0);
  };

  const end = useCallback(() => {
    const was = depth.current > 0;
    depth.current = 0;
    setDropping(false);
    return was;
  }, []);

  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || forField(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const dropped = (e: DragEvent) => {
      end();
      if (!e.defaultPrevented && !forField(e)) e.preventDefault();
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', dropped);
    // A drag that ends out of the board's sight leaves no overlay behind.
    window.addEventListener('dragend', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', dropped);
      window.removeEventListener('dragend', end);
      window.removeEventListener('blur', end);
    };
  }, [end]);

  /**
   * Open a dropped-in file: read it with the page's token, then show it in a new tab. The token
   * never goes into a link. Where the browser blocks the tab, the file is saved instead.
   */
  const openFile = useCallback(
    async (asset: string, name: string) => {
      const blob = await source.readAsset(asset);
      if (!blob) {
        say(`"${name}" could not be read from the board.`);
        return;
      }
      if (typeof URL.createObjectURL !== 'function') return;
      const url = URL.createObjectURL(viewable(blob, name));
      const tab = window.open(url, '_blank');
      if (tab) tab.opener = null;
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [source, say],
  );

  /** Where a file lands when no place is given: a little left of and above the middle of the screen. */
  const centre = (): [number, number] => {
    const cam = board.camera.get();
    const viewport = board.viewport();
    return [(viewport.w / 2 - 170 - cam.x) / cam.z, (viewport.h / 2 - 60 - cam.y) / cam.z];
  };

  /** A dropped file stored on the board: its asset, or nothing when it was not, and the board has said why. */
  const store = async (file: File): Promise<string | undefined> => {
    if (file.size > MAX_UPLOAD) {
      say(`"${file.name}" is larger than ${MAX_UPLOAD / 1024 / 1024} MB, so it was not dropped in.`);
      return undefined;
    }
    const up = await source.upload(file.name, file);
    if (up.ok) return up.asset;
    say(`"${file.name}" was not saved: ${up.reason}`);
    return undefined;
  };

  const addFiles = async (files: readonly File[], client?: PagePoint) => {
    const rects = client ? board.measure() : [];
    const [wx, wy] = client ? board.toWorld(client.x, client.y) : centre();
    // The files go up first, side by side. Undo never waits for an upload, however long it
    // takes: the files of one drop that are stored become one step only now, and are posted.
    const assets = await Promise.all(files.map(store));
    const stored = files.flatMap((file, i) => {
      const asset = assets[i];
      return asset === undefined ? [] : [{ file, asset, id: board.newId() }];
    });
    board.together(stored.map((s) => s.id));
    for (const [row, { file, asset, id }] of stored.entries()) {
      try {
        await board.postMark(fileItem(id, [wx, wy + row * 76], file, asset, row === 0 ? rects : [], board.targetBox));
      } finally {
        // Posted or not, this file's id is free again, and Undo no longer waits for it.
        board.freeId(id);
      }
    }
  };

  const addText = async (text: string, client: PagePoint) => {
    const { text: words, cut } = fitPaste(text.trim(), NOTE_MAX, true);
    if (!words) return;
    const [wx, wy] = board.toWorld(client.x, client.y);
    const { on, anchor } = board.noteTarget(client.x, client.y);
    const id = board.newId();
    try {
      // One step, which takes its place now, also when a chapter must be opened for it first.
      const drafts = noteDrafts(board.state(), { id, text: words, box: [Math.round(wx), Math.round(wy), NOTE_WIDTH, 60], ...(on ? { on } : {}), ...(anchor ? { anchor } : {}) });
      if ((await board.postNew(id, drafts)) && cut) say(NOTE_FULL);
    } finally {
      board.freeId(id);
    }
  };

  /** Only the owner drops in, and only what the board can take in. */
  const takes = (e: BoardDragEvent) => board.isOwner && droppable(e) && !forField(e);

  const onDragEnter = (e: BoardDragEvent) => {
    if (takes(e)) count('enter');
  };

  const onDragOver = (e: BoardDragEvent) => {
    if (!takes(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    count('over');
  };

  const onDragLeave = () => count('leave');

  const onDrop = (e: BoardDragEvent) => {
    if (!takes(e)) return;
    e.preventDefault();
    end();
    const at = { x: e.clientX, y: e.clientY };
    const files = [...e.dataTransfer.files];
    if (files.length > 0) void addFiles(files, at);
    else void addText(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'), at);
  };

  return { dropping, onDragEnter, onDragOver, onDragLeave, onDrop, end, addFiles, addText, openFile };
}
