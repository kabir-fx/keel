import type { Digest } from './digest';
import type { ShowPlan } from './pictures';
import type { AgentSetup, PresenceUpdate } from './wire';

/**
 * The agent link is a seam. The board server knows one call, `wake`, and nothing about how
 * the agent is reached. An adapter is a module that exports `createLink`. The server loads
 * it by name, so a new harness needs a new adapter and no change to the server.
 */

/** Why the server wakes the agent. */
export type WakeReason = 'marks' | 'act' | 'start';

export interface Wake {
  /** What changed, and what is owed. */
  digest: Digest;
  /** The digest as text: what the agent reads. */
  text: string;
  reason: WakeReason;
  /**
   * True when the chapter has no picture from the agent yet: this wake is the first look at
   * a new idea. An adapter may spend more on it, for example a stronger model for the spread.
   */
  firstOfChapter?: boolean;
}

export interface WakeResult {
  ok: boolean;
  /** A few words for the server's log when a wake fails. */
  note?: string;
}

export interface AgentLink {
  /** The adapter's name, shown by `keel-board status`. */
  readonly name: string;
  /**
   * Tell the agent the board changed. The server calls this once per pause, and waits for
   * it to resolve before the next one. It resolves when the agent has finished its turn.
   * One exception: a wake that takes longer than the server's limit counts as failed, and
   * the server may then call `wake` again while the first turn still runs. An adapter holds
   * that second wake until its turn ends.
   */
  wake(wake: Wake): Promise<WakeResult>;
  /** Stop the agent and free what the adapter holds. */
  close(): Promise<void>;
  /** What the agent's harness needs on this machine before it can answer. An adapter that needs nothing leaves it out. */
  setup?: LinkSetup;
}

/**
 * The owner's first page asks this of the adapter: is the harness installed and signed in,
 * and take the next step for me. Each call answers with how things stand after it.
 */
export interface LinkSetup {
  look(): Promise<AgentSetup>;
  /** Install the harness. It resolves when the install has ended. */
  install(): Promise<AgentSetup>;
  /** Start a sign-in, in place of one that runs. It resolves once the sign-in page has an address, or has ended. */
  signIn(): Promise<AgentSetup>;
  /** Hand a running sign-in the code its page showed. It resolves when the sign-in has ended. */
  code(code: string): Promise<AgentSetup>;
}

/** What the server gives an adapter when it creates the link. */
export interface LinkContext {
  /** The repository the board belongs to. */
  repoDir: string;
  /** `.keel/board` inside it. */
  boardDir: string;
  /**
   * A private folder for the adapter's own files, such as the agent's session id. It is
   * outside the repository, so nothing in it is committed and nothing in the repository can
   * point it elsewhere.
   */
  stateDir?: string;
  /** The server's address: `http://127.0.0.1:<port>`. */
  serverUrl: string;
  /** The token the agent's tools use. */
  agentToken: string;
  /** Options from the command line, for the adapter to read. */
  options: Record<string, string>;
  /** Report what the agent does now. The server shows it on the presence pill. */
  presence(update: PresenceUpdate): void;
  log(message: string): void;
}

/** What an adapter module exports as `createLink`. */
export type CreateLink = (ctx: LinkContext) => AgentLink | Promise<AgentLink>;

/* --------------------------------------------------------------- builder */

/**
 * The builder is a second seam. The board agent listens and draws. The builder writes the
 * code, in the background, in its own copy of the repository. The server starts it when the
 * owner presses "Build this", and knows three calls: run, pause, close.
 */
export interface BuildJob {
  chapter: string;
  /**
   * The canvas the chapter is on, and what the canvas is called. The build's copy and its
   * branch belong to the canvas: every chapter on it is built there, one after another.
   */
  canvas: string;
  canvasTitle: string;
  title: string;
  /** The parts to build, in order, one commit each. Parts already built are left out. */
  track: Array<{ id: string; name: string; plain?: string }>;
  /** The check command the owner agreed to. The build's tools run this command and no other on their own. */
  check?: string;
  /** The brief: the idea as text, from `renderBrief`. It is what the builder reads. */
  brief: string;
  /** True when this run carries on after a pause or a restart. */
  resume: boolean;
  /** The setup command the owner agreed to, when the idea has one. The build's tools run it once, before the first part. */
  setup?: string;
  /** How the owner will try the result. The builder makes sure it works before it says done. */
  show?: ShowPlan;
  /**
   * Where a new branch starts: the home branch and its commit, as the server just read them.
   * Left out in a repository with no commit, where the branch starts from nothing.
   */
  base?: { branch: string; commit: string };
}

/**
 * What a finished build has to show the owner: the files as they were built, and the page
 * among them to open. The board server serves the folder from an address of its own, never
 * from the board's, and runs nothing to show it. A build with nothing a browser can open by
 * itself (a command, a server, a page that needs a build step) gives none.
 */
export interface BuildShow {
  /**
   * A folder that holds a copy of the built files. It is inside the builder's private folder
   * (`BuilderContext.stateDir`), so nothing in the repository can change what is shown.
   */
  dir: string;
  /** The page to open, as a path inside `dir` with `/` between its parts: `index.html`. */
  page: string;
}

export interface BuildResult {
  /** `done`: every part on the track is built. `paused`: stopped when asked. `failed`: it could not go on. */
  outcome: 'done' | 'paused' | 'failed';
  note?: string;
  /** With `done` only: a page that stands alone, copied out to be served as files. */
  show?: BuildShow;
}

/** A show that runs a command: an app or a terminal. A page runs nothing and is not started. */
export type RunShow = Exclude<ShowPlan, { kind: 'page' }>;

/** What the server asks for when the owner presses to try a built chapter. */
export interface ShowRequest {
  chapter: string;
  /** The canvas the chapter is on: the show runs in that canvas's copy. */
  canvas: string;
  /** What to run, as the owner agreed to it on the press. */
  plan: RunShow;
  /** The size of the terminal, in characters. */
  cols?: number;
  rows?: number;
  /** What the command prints, as it comes. For a terminal it is the terminal's own bytes, as text. */
  onOutput(chunk: string): void;
  /** The command ended, by itself or because it was stopped. Called once. */
  onExit(code: number | null): void;
}

/** A command that runs to show a built chapter, in the build's own copy, boxed in. */
export interface ShowSession {
  /** False when this machine has no box and the command runs with only the short environment. Left out when it is boxed in. */
  boxed?: false;
  /**
   * For an app: resolves with its address, `http://127.0.0.1:<port>/`, once it answers
   * there, and rejects when the command ends or the wait runs out first. Left out for a terminal.
   */
  ready?: Promise<string>;
  /** What the owner typed. A terminal takes it; an app's command reads nothing. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** End the command and everything it started. Resolves when all of it is gone. */
  stop(): Promise<void>;
}

/** What the server asks for before it moves the home branch to a canvas's build. */
export interface RefreshRequest {
  canvas: string;
  /** The home branch as the server just read it. */
  home: { branch: string; commit: string };
  /**
   * The checks the owner agreed to for the built chapters on this canvas, each once. The
   * joined result must pass every one. And their setup commands, each once.
   */
  checks: string[];
  setups: string[];
}

export interface RefreshResult {
  /**
   * `level`: the branch holds the home commit already, nothing was done. `joined`: the home
   * branch was merged in with no conflict, and the checks passed on the result. `resolved`:
   * the two had changed the same lines, the builder joined them, and the checks passed: the
   * owner should try it again before it is merged. `failed`: it could not be joined, or a
   * check does not pass. Nothing of the owner's moved in any case.
   */
  outcome: 'level' | 'joined' | 'resolved' | 'failed';
  note?: string;
}

/** Where a canvas's build lives in the repository. */
export interface BuildPlace {
  /** The build's branch: `board/<name>`. */
  branch: string;
}

export interface Builder {
  readonly name: string;
  /** Build the track. It resolves when the builder stops, for any reason. Never two runs at once. */
  run(job: BuildJob): Promise<BuildResult>;
  /** Stop after the current step. The run then resolves with `paused`. */
  pause(): Promise<void>;
  close(): Promise<void>;
  /**
   * Start what a built chapter shows. A builder that keeps no copy to run in leaves this
   * out, and the board then shows a page only.
   */
  show?(req: ShowRequest): Promise<ShowSession>;
  /** Bring a canvas's branch level with the home branch, and run the checks on the result. */
  refresh?(req: RefreshRequest): Promise<RefreshResult>;
  /**
   * Take a canvas's build away: its copy always, and its branch when `branch` is true, with
   * every commit on it. The server calls it after a merge, and when the owner deletes a canvas.
   */
  discard?(req: { canvas: string; branch: boolean }): Promise<{ ok: boolean; note?: string }>;
}

/** What the server gives a builder: the link's context, and the token of the build's own tools. */
export interface BuilderContext extends LinkContext {
  /** The token for what the build's tools report: a commit, a check that passed. */
  systemToken: string;
  /** Report where a canvas's build lives, as soon as its branch is there. The server keeps it for this machine. */
  place?(canvas: string, place: BuildPlace): void;
}

/** What an adapter module may also export, as `createBuilder`. */
export type CreateBuilder = (ctx: BuilderContext) => Builder | Promise<Builder>;
