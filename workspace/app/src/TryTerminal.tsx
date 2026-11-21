import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import type { ShowStream } from './showStream';
import { TERMINAL_FONT, cellsFor, terminalCell } from './showStream';

/**
 * A terminal in the try room: xterm.js over a show's stream. What was printed before the page
 * joined is written first, then each piece as it comes; what the owner types and pastes goes
 * back. The size was fixed when the show started (plan 5.3): a new size is sent as the room
 * changes size, and the server takes it as far as it can.
 */
export function TryTerminal({ stream, label, handle }: { stream: ShowStream; label: string; handle?: RefObject<{ focus(): void } | null> }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const cell = terminalCell();
    const { cols, rows } = cellsFor(el.clientWidth, el.clientHeight, cell);
    const term = new Terminal({
      cols,
      rows,
      fontFamily: TERMINAL_FONT.family,
      fontSize: TERMINAL_FONT.size,
      lineHeight: TERMINAL_FONT.lineHeight,
      cursorBlink: true,
      scrollback: 5000,
      screenReaderMode: true,
      theme: { background: '#0f1b2d', foreground: '#e4e9f2', cursor: '#9ad3cb', selectionBackground: '#46536a' },
    });
    term.open(el);
    if (stream.text) term.write(stream.text);
    const offOut = stream.onOut((chunk, fromStart) => {
      if (fromStart) term.reset();
      if (chunk) term.write(chunk);
    });
    const typed = term.onData((data) => stream.type(data));
    if (handle) handle.current = { focus: () => term.focus() };
    const grows =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            const next = cellsFor(el.clientWidth, el.clientHeight, cell);
            if (next.cols === term.cols && next.rows === term.rows) return;
            term.resize(next.cols, next.rows);
            stream.size(next.cols, next.rows);
          });
    grows?.observe(el);
    return () => {
      grows?.disconnect();
      typed.dispose();
      offOut();
      if (handle) handle.current = null;
      term.dispose();
    };
  }, [stream, handle]);
  return <div ref={box} className="try__terminal" data-testid="try-terminal" role="group" aria-label={label} />;
}
