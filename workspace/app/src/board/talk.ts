import type { Target } from '@keel/protocol';
import { useCallback, useMemo, useRef, useState } from 'react';
import { LINE_KINDS, targetAt } from '../dom';
import { voiceItem } from '../marks';
import type { Recognition } from '../speech';
import { heard, NO_SPEECH, recognitionOf, worthSaying } from '../speech';
import type { Board } from './context';

/** Why the browser stopped listening, in the owner's words. */
const SPEECH_ERRORS: Record<string, string> = {
  'not-allowed': 'the browser was not allowed to use the microphone',
  'service-not-allowed': 'the browser was not allowed to use the microphone',
  'audio-capture': 'no microphone was found',
  network: 'the speech service could not be reached',
};

/** One go of talking: the recogniser, what it has heard, and what the words are about. */
interface Session {
  rec: Recognition;
  final: string;
  interim: string;
  at: [number, number];
  on: Target | undefined;
  stopped: boolean;
}

/** Talk on one board. */
export interface Talk {
  /** True where the browser can recognise speech. */
  supported: boolean;
  /** What is heard so far while the owner talks; null when they do not. */
  talking: { text: string } | null;
  start(): void;
  stop(): void;
  /** True from the moment the recogniser starts until it ends. */
  listening(): boolean;
}

/**
 * Talk: hold the key or the button, say it, let go. The words become a voice mark on what the
 * pointer was over when the owner began to speak.
 */
export function useTalk(board: Board): Talk {
  const Speech = useMemo(() => (typeof window === 'undefined' ? undefined : recognitionOf(window)), []);
  const [talking, setTalking] = useState<{ text: string } | null>(null);
  const session = useRef<Session | null>(null);

  const postVoice = useCallback(
    async (text: string, at: [number, number], on?: Target) => {
      const id = board.newId();
      try {
        const state = board.state();
        const target = on && state.items[on.item] && !state.items[on.item]!.removed ? on : undefined;
        await board.postMark(voiceItem(id, at, text, target, board.targetBox));
      } finally {
        board.freeId(id);
      }
    },
    [board],
  );

  const start = useCallback(() => {
    if (!Speech) {
      board.say(NO_SPEECH);
      return;
    }
    if (session.current || !board.isOwner) return;
    // What the pointer is over, as the owner starts to speak.
    const p = board.pointer();
    const state = board.state();
    let on: Target | undefined;
    let at: [number, number];
    if (p) {
      const hit = targetAt(p.x, p.y);
      if (hit && state.items[hit.item] && !LINE_KINDS.has(state.items[hit.item]!.item.kind)) on = hit.sub ? { item: hit.item, sub: hit.sub } : { item: hit.item };
      at = board.toWorld(p.x, p.y);
    } else {
      const cam = board.camera.get();
      const viewport = board.viewport();
      at = [(viewport.w / 2 - cam.x) / cam.z, (viewport.h / 2 - cam.y) / cam.z];
    }
    // With nothing under the pointer, the step of the walk being played is what is in view.
    const walk = board.view().walk;
    if (!on && walk) {
      const el = board.layerEl()?.querySelector<HTMLElement>(`[data-sub="step:${walk.step}"]`);
      const item = el?.closest<HTMLElement>('[data-item]')?.dataset.item;
      if (item) on = { item, sub: `step:${walk.step}` };
    }
    let rec: Recognition;
    try {
      rec = new Speech();
      rec.lang = navigator.language || 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
    } catch {
      board.say(NO_SPEECH);
      return;
    }
    const t: Session = { rec, final: '', interim: '', at, on, stopped: false };
    rec.onresult = (e) => {
      const h = heard(e);
      t.final = h.final;
      t.interim = h.interim;
      setTalking({ text: [h.final, h.interim].filter(Boolean).join(' ') });
    };
    rec.onerror = (e) => {
      const why = SPEECH_ERRORS[e.error];
      if (why) board.say(`Talk stopped: ${why}.`);
    };
    rec.onend = () => {
      if (session.current === t) session.current = null;
      setTalking(null);
      const text = (t.final || t.interim).trim();
      if (worthSaying(text)) void postVoice(text, t.at, t.on);
      else if (t.stopped) board.say('Nothing was heard. Hold Talk, say it, then let go.');
    };
    try {
      rec.start();
    } catch {
      board.say('Talk could not start listening. Try again in a moment.');
      return;
    }
    session.current = t;
    setTalking({ text: '' });
  }, [board, Speech, postVoice]);

  const stop = useCallback(() => {
    const t = session.current;
    if (!t || t.stopped) return;
    t.stopped = true;
    t.rec.stop();
  }, []);

  const listening = useCallback(() => session.current !== null, []);

  return { supported: !!Speech, talking, start, stop, listening };
}
