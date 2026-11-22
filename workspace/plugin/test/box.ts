import fs from 'node:fs';
import { sandboxKind } from '../src/sandbox';
import type { SandboxKind } from '../src/sandbox';

function aliveHere(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid each process in a box has inside it, for the boxed processes this process started. Linux only. */
function boxedPids(): number[] {
  const procs = new Map<number, { parent: number; inner: number | undefined }>();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let status: string;
    try {
      status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
    } catch {
      continue;
    }
    const ns = (/^NSpid:\s+(.+)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/).map(Number);
    procs.set(Number(name), { parent: Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]), inner: ns.length > 1 ? ns.at(-1) : undefined });
  }
  const ours = (pid: number): boolean => {
    for (let p = procs.get(pid)?.parent; p !== undefined && p > 0; p = procs.get(p)?.parent) if (p === process.pid) return true;
    return false;
  };
  return [...procs].filter(([pid, p]) => p.inner !== undefined && ours(pid)).map(([, p]) => p.inner!);
}

/**
 * Is the process alive that said, from inside the box, that this is its pid?
 * bwrap gives the box its own process numbers (`--unshare-pid`), so there the number means
 * nothing outside it: it is looked up among the boxed processes this process started.
 * Pass the box when the process ran with another one than this machine's, such as 'none'.
 */
export function aliveInBox(pid: number, box: SandboxKind = sandboxKind().kind): boolean {
  return box === 'bwrap' ? boxedPids().includes(pid) : aliveHere(pid);
}
