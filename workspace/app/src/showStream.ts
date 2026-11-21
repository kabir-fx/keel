import { SHOW_OUTPUT_KEPT } from '@keel/protocol';
import type { SocketLike } from './source';
import { readShowMessage } from './tryit';

const OPEN = 1;

/**
 * One show's stream (`ROUTES.showWs`), as the try room holds it: what the command printed, kept
 * as far as the server keeps it, whether it ended, and a way to type into it. The server sends
 * everything it kept first, so each new connection starts the text again from there. It
 * connects only when asked, and never again by itself: a closed stream stays closed until the
 * show's state changes and the room asks again.
 */
export class ShowStream {
  text = '';
  ended: { code: number | null } | undefined = undefined;
  private sock: SocketLike | undefined;
  /** The next text that comes is everything kept from the start: it replaces what is here. */
  private fresh = false;
  private readonly outs = new Set<(chunk: string, fromStart: boolean) => void>();
  private readonly changes = new Set<() => void>();

  constructor(private readonly open: () => SocketLike | undefined) {}

  /** Connect, unless a connection is open or opening. */
  connect(): void {
    if (this.sock) return;
    const sock = this.open();
    if (!sock) return;
    this.sock = sock;
    this.fresh = true;
    sock.onmessage = (ev) => {
      if (this.sock !== sock) return;
      const msg = readShowMessage(ev.data);
      if (!msg) return;
      if (msg.t === 'out') {
        const fromStart = this.fresh;
        this.fresh = false;
        const next = fromStart ? msg.data : this.text + msg.data;
        this.text = next.length > SHOW_OUTPUT_KEPT ? next.slice(next.length - SHOW_OUTPUT_KEPT) : next;
        for (const l of this.outs) l(msg.data, fromStart);
      } else {
        this.ended = { code: msg.code };
      }
      this.emit();
    };
    sock.onclose = () => {
      if (this.sock === sock) this.sock = undefined;
    };
    sock.onerror = () => undefined;
  }

  /** A new run: what the last one printed goes, and the stream is closed until asked again. */
  restart(): void {
    this.drop();
    this.text = '';
    this.ended = undefined;
    for (const l of this.outs) l('', true);
    this.emit();
  }

  /** What the owner typed. Nothing is sent while the stream is not open. */
  type(data: string): void {
    if (this.sock?.readyState === OPEN) this.sock.send(JSON.stringify({ t: 'in', data }));
  }

  /** The terminal's new size, best effort. */
  size(cols: number, rows: number): void {
    if (this.sock?.readyState === OPEN) this.sock.send(JSON.stringify({ t: 'size', cols, rows }));
  }

  /** Called with each piece of output as it comes; `fromStart` when it replaces all before. Returns the unsubscribe. */
  onOut(l: (chunk: string, fromStart: boolean) => void): () => void {
    this.outs.add(l);
    return () => this.outs.delete(l);
  }

  subscribe = (l: () => void): (() => void) => {
    this.changes.add(l);
    return () => this.changes.delete(l);
  };

  close(): void {
    this.drop();
    this.outs.clear();
    this.changes.clear();
  }

  private drop(): void {
    const sock = this.sock;
    this.sock = undefined;
    sock?.close();
  }

  private emit(): void {
    for (const l of this.changes) l();
  }
}

/** The cell of the terminal's font, in pixels. Measured once on the page; a test's DOM has none, so a plain guess stands in. */
export interface Cell {
  w: number;
  h: number;
}

export const TERMINAL_FONT = { family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', size: 13, lineHeight: 1.2 } as const;

/** How many columns and rows fit in a box of this size, within what the show route takes. */
export function cellsFor(width: number, height: number, cell: Cell): { cols: number; rows: number } {
  const cols = Math.floor(Math.max(0, width) / Math.max(1, cell.w));
  const rows = Math.floor(Math.max(0, height) / Math.max(1, cell.h));
  return { cols: Math.min(400, Math.max(20, cols)), rows: Math.min(200, Math.max(5, rows)) };
}

let measured: Cell | undefined;

/** The terminal font's cell, measured from a line of text drawn off screen. */
export function terminalCell(): Cell {
  if (measured) return measured;
  const guess = { w: TERMINAL_FONT.size * 0.6, h: Math.ceil(TERMINAL_FONT.size * TERMINAL_FONT.lineHeight) };
  if (typeof document === 'undefined') return guess;
  const probe = document.createElement('span');
  probe.textContent = 'W'.repeat(80);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${TERMINAL_FONT.family};font-size:${TERMINAL_FONT.size}px;line-height:${TERMINAL_FONT.lineHeight}`;
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  if (r.width <= 0 || r.height <= 0) return guess;
  measured = { w: r.width / 80, h: r.height };
  return measured;
}
