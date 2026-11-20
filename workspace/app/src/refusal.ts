/**
 * What the owner reads when the board refuses something. The rules write one sentence for the
 * sender, and a malformed draft comes back as a schema message ("item.text: Too big: expected
 * string to have <=2000 characters"). The common ones become a plain sentence here.
 */

const thousands = (n: string) => Number(n).toLocaleString('en-US');

/** One schema problem, `path: message`, in plain words, or undefined when it is not a common one. */
function plainIssue(path: string, message: string): string | undefined {
  const last = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() ?? '';
  const most = /<=\s*(\d+)/.exec(message)?.[1];
  const big = /too big/i.test(message);
  const small = /too small/i.test(message);
  if (last === 'text' && big && most) return `That is too long for the board: it keeps at most ${thousands(most)} characters here. Shorten it and try again.`;
  if (last === 'text' && small) return 'A note needs some words. Write something, or take the note off.';
  if (last === 'title' && big) return 'That title is too long. Shorten it and try again.';
  if (last === 'strokes' && big) return 'That is too many strokes for one mark. Lift the pen, wait a moment, and go on: the rest becomes a second mark.';
  if (last === 'pts' && big) return 'That stroke is too long for one mark. Draw it in shorter strokes.';
  if (last === 'path' && big) return 'That loop is too long. Draw it again with a simpler line.';
  if (last === 'targets' && big) return 'That mark covers too many things at once. Draw it round fewer.';
  if ((last === 'box' || last === 'at' || last === 'from' || last === 'to' || last === 'pts' || last === 'path') && (big || small))
    return 'That is too far out on the board to keep. Draw it nearer the rest.';
  if (last === 'id') return 'The board could not name that mark. Reload the page and try again.';
  if (last === 'name' && big) return 'That file name is too long. Rename the file and drop it in again.';
  return undefined;
}

/** A refusal as one sentence the owner can act on. */
export function plainRefusal(r: { rule: string; reason: string }): string {
  if (r.rule === 'shape') {
    for (const part of r.reason.split('; ')) {
      const cut = part.indexOf(': ');
      if (cut < 0) continue;
      const plain = plainIssue(part.slice(0, cut), part.slice(cut + 2));
      if (plain) return plain;
    }
    // A shape rule's own sentence (no path) is already written for people.
    return /^[A-Z"]/.test(r.reason) && !/: (Too|Invalid|Expected)/.test(r.reason) ? r.reason : 'The board could not read that, so it was not saved. Reload the page and try again.';
  }
  if (r.rule === 'R4' && /is used already/.test(r.reason)) return 'Another open tab used the same name a moment ago. Try again.';
  if (r.rule === 'R7' && /is not on the board|There is no item|is off the board/.test(r.reason)) return 'That is not on the board any more, so this was not saved.';
  if (r.rule === 'R6' && /Only its author/.test(r.reason)) return 'Only the agent takes its own pictures off. Cross one out with the pen instead.';
  return r.reason;
}
