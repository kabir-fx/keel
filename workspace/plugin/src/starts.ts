import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * When each part started: the commit the builder's branch was at when the part went
 * "building". `board_check` needs a commit after it. The file lives in the builder's private
 * folder, outside the worktree, so the model cannot write it.
 */

export const STARTS_FILE = 'parts.json';

export type Starts = Record<string, { start: string; at: string }>;

/** A link in the file's place is not followed. */
export function readStarts(stateDir: string): Starts {
  try {
    const file = path.join(stateDir, STARTS_FILE);
    if (!fs.lstatSync(file).isFile()) return {};
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Starts) : {};
  } catch {
    return {};
  }
}

export function recordStart(stateDir: string, part: string, start: string, at: string = new Date().toISOString()): void {
  const all = readStarts(stateDir);
  all[part] = { start, at };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(stateDir, `.${STARTS_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, path.join(stateDir, STARTS_FILE));
}
