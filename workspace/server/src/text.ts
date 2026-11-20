/**
 * Text that came from a board, a folder name or the agent can carry control characters: an
 * escape sequence that clears the terminal, moves the cursor or rewrites an earlier line.
 * Everything the command prints goes through `plain` first.
 */

// C0 controls but tab and newline, DEL, C1 controls, and the marks that reorder text on screen.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** `s` with its control characters removed. Newline and tab stay. */
export function plain(s: string): string {
  return s.replace(CONTROL, '');
}

/** `s` as one line: control characters removed, and line breaks turned into spaces. For a field that must stay on its line. */
export function oneLine(s: string): string {
  return plain(s.replace(/[\r\n\t\u2028\u2029\u0085]+/g, ' '));
}
