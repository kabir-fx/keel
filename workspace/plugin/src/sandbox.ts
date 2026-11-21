import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The check runs code the builder wrote: tests, a Makefile, a script. So it runs boxed in,
 * where the system has a box. `sandbox-exec` on macOS, `bwrap` on Linux: no network, writes
 * only inside the worktree and a temp folder of its own, and no reading of the places that
 * hold the board's tokens or the owner's keys. Its environment is a short allow-list, never
 * the owner's whole one. Where there is no box, only the allow-list holds, and the builder
 * says so on the board.
 */

/** The only settings from the environment the check gets. */
export const ENV_ALLOWED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ'] as const;

export type SandboxKind = 'seatbelt' | 'bwrap' | 'none';

export interface SandboxPlaces {
  /** Where the check runs, and may write: the repository's folder in the worktree. */
  workdir: string;
  /** A temp folder of the check's own: TMPDIR. */
  tmp: string;
  /** Folders whose contents the check may not read: the state root, the owner's .keel, keys. */
  denyRead: string[];
  /**
   * Paths inside the workdir the check may not change: the worktree's `.git`, the link to
   * its git folder. Code that rewrote it could point a later git at a config of its own.
   */
  denyWrite?: string[];
  /** The network is on: for the setup, which fetches, and for a show, which may serve. */
  network?: boolean;
  /** More folders it may write in: the package managers' caches, for the setup. */
  write?: string[];
}

export interface SandboxPlan {
  kind: SandboxKind;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Is a program on the PATH? */
function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

let found: { kind: SandboxKind; bin: string } | undefined;

/** The box this machine has, found once. `KEEL_SANDBOX=none` turns it off, for a machine where it misbehaves. */
export function sandboxKind(): { kind: SandboxKind; bin: string } {
  if (process.env.KEEL_SANDBOX === 'none') return { kind: 'none', bin: '/bin/sh' };
  if (found) return found;
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) found = { kind: 'seatbelt', bin: '/usr/bin/sandbox-exec' };
  else if (process.platform === 'linux') {
    const bwrap = onPath('bwrap');
    // A bwrap that cannot make a namespace here (some containers) is no box at all.
    found = bwrap && spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '/bin/true']).status === 0 ? { kind: 'bwrap', bin: bwrap } : { kind: 'none', bin: '/bin/sh' };
  } else found = { kind: 'none', bin: '/bin/sh' };
  return found;
}

/** The check's environment: the allow-list, and TMPDIR its own. */
export function sandboxEnv(tmp: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWED) if (base[k] !== undefined) env[k] = base[k];
  env.TMPDIR = tmp;
  return env;
}

/** The usual package managers' caches under the home folder: where the setup may write outside the copy. */
export function packageCaches(home: string = os.homedir()): string[] {
  return ['.npm', '.cache', 'Library/Caches', '.cargo', 'go/pkg', '.pnpm-store', '.yarn', '.bun', '.gradle', '.m2', '.local/share/pnpm'].map((d) => path.join(home, d));
}

/** The folders the check never reads: where the board keeps its tokens, and the owner's keys. */
export function defaultDenyRead(o: { stateRoot: string; ownerRepo?: string; home?: string }): string[] {
  const home = o.home ?? os.homedir();
  const out = [o.stateRoot, ...['.ssh', '.aws', '.claude', '.gnupg', '.config/gh', '.docker', '.kube'].map((d) => path.join(home, d))];
  if (o.ownerRepo) out.push(path.join(o.ownerRepo, '.keel'));
  return out;
}

const sbpl = (p: string) => `"${real(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The macOS profile. Last match wins: network and writes are denied, then writes inside the
 * worktree and the temp folder come back; reading the contents of the denied folders is
 * refused, then the worktree and the temp folder come back, since they sit inside the state
 * root. A file's metadata stays readable, so a path can still be resolved.
 */
export function seatbeltProfile(p: SandboxPlaces): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    ...(p.network ? [] : ['(deny network*)']),
    // Three ways to have another program, outside the box, do the work: ask the system to open
    // a file or an app, send an app a scripting event, or hand the system a job to run.
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny job-creation)',
    '(deny file-write*)',
    `(allow file-write* ${[p.workdir, p.tmp, ...(p.write ?? [])].map((d) => `(subpath ${sbpl(d)})`).join(' ')} (regex #"^/dev/(null|zero|tty|dtracehelper|fd/)"))`,
  ];
  if (p.denyRead.length) lines.push(`(deny file-read-data ${p.denyRead.map((d) => `(subpath ${sbpl(d)})`).join(' ')})`);
  lines.push(`(allow file-read-data (subpath ${sbpl(p.workdir)}) (subpath ${sbpl(p.tmp)}))`);
  // Last, so it wins over the worktree's allow: the path itself, and anything put in its place.
  for (const d of p.denyWrite ?? []) lines.push(`(deny file-write* (literal ${sbpl(d)}) (subpath ${sbpl(d)}))`);
  return `${lines.join('\n')}\n`;
}

/** The Linux box: the whole system read-only, the denied folders hidden, the worktree and temp writable, no network. */
export function bwrapArgs(p: SandboxPlaces, cmd: string): string[] {
  // Its own process numbers too: it sees no process outside the box, cannot read one's
  // environment through /proc, and every process it starts ends with it, whatever group it joins.
  const args = ['--die-with-parent', ...(p.network ? [] : ['--unshare-net']), '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const d of p.denyRead) if (fs.existsSync(d)) args.push('--tmpfs', real(d));
  args.push('--bind', real(p.workdir), real(p.workdir), '--bind', real(p.tmp), real(p.tmp));
  for (const d of p.write ?? []) if (fs.existsSync(d)) args.push('--bind', real(d), real(d));
  // Read-only again inside the writable worktree. A bound path cannot be renamed or taken away.
  for (const d of p.denyWrite ?? []) if (fs.existsSync(d)) args.push('--ro-bind', real(d), real(d));
  args.push('--chdir', real(p.workdir));
  return [...args, '/bin/sh', '-c', cmd];
}

/** How to run `cmd` boxed in on this machine. */
export function sandboxPlan(cmd: string, p: SandboxPlaces, kind = sandboxKind()): SandboxPlan {
  const env = sandboxEnv(p.tmp);
  if (kind.kind === 'seatbelt') return { kind: 'seatbelt', bin: kind.bin, args: ['-p', seatbeltProfile(p), '/bin/sh', '-c', cmd], env };
  if (kind.kind === 'bwrap') return { kind: 'bwrap', bin: kind.bin, args: bwrapArgs(p, cmd), env };
  return { kind: 'none', bin: '/bin/sh', args: ['-c', cmd], env };
}

/** What the owner reads when there is no box, once per build. */
export const NO_SANDBOX_NOTE =
  'This computer has no sandbox for the check (sandbox-exec or bwrap), so the check runs with a short list of settings only. It can still read and write your files like any program you run.';
