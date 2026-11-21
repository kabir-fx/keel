import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SetupInfo } from '@keel/protocol';

/**
 * The first executable file called `name` in a `PATH` string, or undefined. A plain scan of
 * the folders: no process is started. An empty entry is skipped.
 */
export function findOnPath(name: string, searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface GitDeps {
  platform?: NodeJS.Platform;
  searchPath?: string;
  /** macOS: are the developer tools installed? Default: `xcode-select -p`, which opens no window. */
  devTools?: () => boolean;
}

const HOW: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Run "xcode-select --install" in a terminal, and press Install in the window that opens.',
  linux: 'Install it with your package manager, for example "sudo apt install git".',
};

/**
 * Is there a git a build can run? On macOS `/usr/bin/git` is always there, and it is a stub
 * that opens an install window until the developer tools are installed, so it is never started here.
 */
export function gitSetup(deps: GitDeps = {}): SetupInfo['git'] {
  const platform = deps.platform ?? process.platform;
  const file = findOnPath('git', deps.searchPath ?? process.env.PATH);
  const devTools = deps.devTools ?? (() => spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore', timeout: 3000 }).status === 0);
  if (file && !(platform === 'darwin' && file === '/usr/bin/git' && !devTools())) return { state: 'ready' };
  return { state: 'missing', how: HOW[platform] ?? 'Get it from https://git-scm.com/downloads.' };
}

/** What the command says before the address, one line for each thing the page will ask for. */
export function setupLines(s: SetupInfo): string[] {
  const lines: string[] = [];
  if (s.agent?.state === 'missing') lines.push(`keel-board: ${s.agent.name} is not installed. The page that opens installs it and signs you in.`);
  if (s.agent?.state === 'signed-out') lines.push(`keel-board: ${s.agent.name} is not signed in. The page that opens signs you in.`);
  if (s.git.state === 'missing') lines.push(`keel-board: git was not found, and a build needs it. ${s.git.how}`);
  return lines;
}
