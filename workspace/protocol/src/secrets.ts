/**
 * The board's log is committed with the repository, so a secret that lands on the board is
 * a secret that is published. Every event is looked at before it is admitted, whoever sent
 * it: an agent that quotes a file, or an owner who pastes the wrong thing.
 *
 * This is a list of shapes. It finds the common kinds of key. It does not find a secret
 * that looks like ordinary words.
 */
const SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'an API key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'an API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{3,}@[^\s/]/i, 'a password inside an address'],
];

/** A name that says "this is a secret", then a value that looks made by a machine. */
const NAMED = /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=.-]{20,})/i;

/** What kind of secret this text seems to hold, or undefined. */
export function secretInText(text: string): string | undefined {
  for (const [shape, what] of SHAPES) if (shape.test(text)) return what;
  const named = NAMED.exec(text);
  if (named && /[0-9]/.test(named[1]!) && /[A-Za-z]/.test(named[1]!)) return 'a key or a password';
  return undefined;
}

/** What kind of secret a value seems to hold anywhere inside it, or undefined. */
export function secretIn(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return secretInText(value);
  if (depth > 12 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      // A stroke is thousands of numbers: nothing to read there.
      if (typeof v === 'number') return undefined;
      const found = secretIn(v, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const v of Object.values(value)) {
    const found = secretIn(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// What is not seen and still acts: the control characters (an escape sequence among them),
// and the marks that reorder text on screen, which can make a line read as something else.
// eslint-disable-next-line no-control-regex
const UNSEEN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Text flattened to one line: every run of white space, a line break of any kind among them,
 * becomes one space, and what is not seen is taken out.
 */
export function flatLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').replace(UNSEEN, '').trim();
}

/** Text on one line, cut to a length. Use it wherever words from the board go into a prompt, a commit or a file. */
export function oneLine(text: string, max = 200): string {
  const flat = flatLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
