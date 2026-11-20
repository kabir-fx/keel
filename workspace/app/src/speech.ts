/**
 * Talk: the browser's speech recognition, where it has one. Chrome and Safari call it
 * `webkitSpeechRecognition`. The app holds one session while the owner holds the button or
 * the key, and turns the words into a spoken remark when they let go.
 */

export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionCtor = new () => Recognition;

/** The browser's speech recognition, or undefined when it has none. */
export function recognitionOf(win: object = globalThis): RecognitionCtor | undefined {
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const NO_SPEECH = 'This browser has no speech recognition, so Talk cannot listen. Chrome and Safari have it.';

/** What was heard so far: the settled words, and the words still being made out. */
export function heard(e: RecognitionEvent): { final: string; interim: string } {
  let final = '';
  let interim = '';
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i]!;
    const t = r[0]?.transcript ?? '';
    if (r.isFinal) final += t;
    else interim += t;
  }
  return { final: final.trim(), interim: interim.trim() };
}

/** Words a stopped session can have missed are not worth a remark: a cough, a click. */
export function worthSaying(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
