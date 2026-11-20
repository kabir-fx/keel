import type { Digest } from './digest';
import type { PresenceUpdate } from './wire';

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
  title: string;
  /** The parts to build, in order, one commit each. Parts already built are left out. */
  track: Array<{ id: string; name: string; plain?: string }>;
  /** The check command the owner agreed to. The build's tools run this command and no other on their own. */
  check?: string;
  /** The brief: the idea as text, from `renderBrief`. It is what the builder reads. */
  brief: string;
  /** True when this run carries on after a pause or a restart. */
  resume: boolean;
}

export interface BuildResult {
  /** `done`: every part on the track is built. `paused`: stopped when asked. `failed`: it could not go on. */
  outcome: 'done' | 'paused' | 'failed';
  note?: string;
}

export interface Builder {
  readonly name: string;
  /** Build the track. It resolves when the builder stops, for any reason. Never two runs at once. */
  run(job: BuildJob): Promise<BuildResult>;
  /** Stop after the current step. The run then resolves with `paused`. */
  pause(): Promise<void>;
  close(): Promise<void>;
}

/** What the server gives a builder: the link's context, and the token of the build's own tools. */
export interface BuilderContext extends LinkContext {
  /** The token for what the build's tools report: a commit, a check that passed. */
  systemToken: string;
}

/** What an adapter module may also export, as `createBuilder`. */
export type CreateBuilder = (ctx: BuilderContext) => Builder | Promise<Builder>;
