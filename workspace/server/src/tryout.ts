import net from 'node:net';
import type { WebSocket } from 'ws';
import type { Builder, Chapter, RunShow, ShowInfo, ShowPlan, ShowServerMessage, ShowSession } from '@keel/protocol';
import { SHOW_OUTPUT_KEPT, ShowClientMessage } from '@keel/protocol';
import { plain } from './text';

/**
 * What the owner tries of a built chapter, when it runs a command: an app or a terminal
 * (record 0013). The builder runs it in the build's own copy, boxed in. The server starts it
 * only on the owner's press, keeps what it prints for a page that joins late, and stops it
 * when the owner stops it, when the idea is approved, deleted or builds again, and when the
 * server stops. Its state and its address go to the owner's page only, never to the log.
 */

/** How the owner tries a chapter, as the board will run it: the blueprint's show, else a page when the build gave one, else a terminal with the check. */
export function planOf(c: Chapter, hasPage: boolean): ShowPlan | undefined {
  if (c.show) return c.show;
  if (hasPage) return { kind: 'page' };
  return c.check !== undefined ? { kind: 'terminal', run: c.check } : undefined;
}

/** What a sentence from a builder or a process becomes before the owner reads it. */
function sentence(s: string, max = 300): string {
  const t = plain(s).replace(/\s+/g, ' ').trim() || 'It gave no reason.';
  const clipped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

interface Running {
  plan: RunShow;
  state: 'starting' | 'on' | 'failed' | 'off' | 'ended';
  url?: string;
  note?: string;
  code?: number | null;
  /** What it printed, the last `SHOW_OUTPUT_KEPT` characters. */
  output: string;
  session?: ShowSession;
  /** The owner pressed Stop, or the server stopped it. */
  stopping: boolean;
  exited: boolean;
  /** Resolves once the command has ended. */
  gone: Promise<void>;
  markGone: () => void;
  sockets: Set<WebSocket>;
}

export interface ShowRunnerOptions {
  /** The builder, once it is loaded. */
  builder: () => Builder | undefined;
  /** Something the owner's page shows changed. */
  changed: () => void;
  log: (message: string) => void;
  /** How long a stop waits for the command to end before it goes on. */
  stopTimeoutMs?: number;
}

export class ShowRunner {
  private readonly shows = new Map<string, Running>();
  private readonly opts: ShowRunnerOptions;
  private closed = false;

  constructor(opts: ShowRunnerOptions) {
    this.opts = opts;
  }

  /** Can the builder run a command to show a build? */
  get canRun(): boolean {
    return typeof this.opts.builder()?.show === 'function';
  }

  /** What the owner sees for a plan that runs a command, as things stand. */
  info(chapter: string, plan: RunShow): ShowInfo {
    const r = this.shows.get(chapter);
    const same = r && r.plan.kind === plan.kind && r.plan.run === plan.run;
    const unboxed = r?.session?.boxed === false ? { boxed: false as const } : {};
    if (plan.kind === 'app') {
      if (!same || r.state === 'off' || r.state === 'ended') return { kind: 'app', run: plan.run, state: 'off' };
      const state = r.state === 'starting' || r.state === 'on' || r.state === 'failed' ? r.state : 'off';
      return { kind: 'app', run: plan.run, state, ...(r.url && state === 'on' ? { url: r.url } : {}), ...(r.note && state === 'failed' ? { note: r.note } : {}), ...unboxed };
    }
    if (!same || r.state === 'off') return { kind: 'terminal', run: plan.run, state: 'off' };
    if (r.state === 'ended' || r.state === 'failed') return { kind: 'terminal', run: plan.run, state: 'ended', code: r.code ?? null, ...unboxed };
    return { kind: 'terminal', run: plan.run, state: 'on', ...unboxed };
  }

  /**
   * Start the plan for a chapter, on the owner's press. The caller has checked that the press
   * named the chapter's own command. A show that runs already is left as it is. Resolves once
   * the command is under way, or has failed to start; an app goes on to answer, or not, later.
   */
  async start(chapter: string, canvas: string, plan: RunShow, size: { cols?: number; rows?: number }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const b = this.opts.builder();
    if (this.closed) return { ok: false, reason: 'The board server is stopping.' };
    if (!b?.show) return { ok: false, reason: 'The builder linked here cannot run a build to show it. Only a page that stands alone can be shown.' };
    const was = this.shows.get(chapter);
    if (was && !was.exited && (was.state === 'starting' || was.state === 'on')) return { ok: true };
    if (was && !was.exited) await this.stop(chapter);
    for (const ws of was?.sockets ?? []) ws.close(1000, 'A new run started.');

    let markGone: () => void = () => {};
    const gone = new Promise<void>((resolve) => (markGone = resolve));
    const r: Running = { plan, state: plan.kind === 'app' ? 'starting' : 'on', output: '', stopping: false, exited: false, gone, markGone, sockets: new Set() };
    this.shows.set(chapter, r);
    this.opts.changed();

    if (plan.kind === 'app' && plan.port !== undefined && !(await portFree(plan.port))) {
      const reason = `Port ${plan.port} is in use by another program.`;
      this.fail(r, reason);
      r.exited = true;
      r.markGone();
      return { ok: false, reason };
    }

    let session: ShowSession;
    try {
      session = await b.show({
        chapter,
        canvas,
        plan,
        ...(size.cols !== undefined ? { cols: size.cols } : {}),
        ...(size.rows !== undefined ? { rows: size.rows } : {}),
        onOutput: (chunk) => this.output(r, chunk),
        onExit: (code) => this.exit(chapter, r, code),
      });
    } catch (e) {
      // The builder's sentence for the owner: nothing could start.
      const reason = sentence(e instanceof Error ? e.message : String(e));
      this.fail(r, reason);
      r.exited = true;
      r.markGone();
      return { ok: false, reason };
    }
    r.session = session;
    if (this.closed || this.shows.get(chapter) !== r) {
      await this.end(r);
      return { ok: true };
    }
    if (plan.kind === 'app' && session.ready) {
      session.ready.then(
        (url) => {
          if (r.exited || r.stopping || r.state !== 'starting') return;
          const answered = localAddress(url);
          if (!answered) {
            this.fail(r, 'The builder gave an address that is not on this machine, so it is not shown.');
            void this.end(r);
            return;
          }
          r.state = 'on';
          r.url = answered;
          this.opts.changed();
        },
        (e: unknown) => {
          if (r.stopping) return;
          this.fail(r, sentence(e instanceof Error ? e.message : String(e)));
          void this.end(r);
        },
      );
    }
    return { ok: true };
  }

  /** Stop a chapter's show and everything it started. Resolves when it has ended, or its wait ran out. */
  async stop(chapter: string): Promise<void> {
    const r = this.shows.get(chapter);
    if (!r) return;
    if (r.exited) {
      if (r.plan.kind === 'app' && r.state !== 'failed') r.state = 'off';
      return;
    }
    r.stopping = true;
    await this.end(r);
    if (r.plan.kind === 'app') {
      r.state = 'off';
      delete r.url;
    }
    this.opts.changed();
  }

  /** Stop a chapter's show and forget it: the idea is gone, merged, or builds again. */
  async drop(chapter: string): Promise<void> {
    await this.stop(chapter);
    const r = this.shows.get(chapter);
    this.shows.delete(chapter);
    for (const ws of r?.sockets ?? []) ws.close(1000, 'The show ended.');
    if (r) this.opts.changed();
  }

  /** The server stops: every show ends with it. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.shows.keys()].map((c) => this.drop(c)));
  }

  /** Has this chapter a show to join, running or ended? */
  has(chapter: string): boolean {
    return this.shows.has(chapter);
  }

  /** The chapters with a show that runs now. */
  running(): string[] {
    return [...this.shows].filter(([, r]) => !r.exited).map(([c]) => c);
  }

  /**
   * A page joins a chapter's show: it hears what was printed so far, then what is printed, and
   * what it sends goes to the command. False when this chapter has no show to join.
   */
  attach(chapter: string, ws: WebSocket): boolean {
    const r = this.shows.get(chapter);
    if (!r) return false;
    if (r.output !== '') send(ws, { t: 'out', data: r.output });
    if (r.exited) {
      send(ws, { t: 'end', code: r.code ?? null });
      ws.close(1000, 'The show ended.');
      return true;
    }
    r.sockets.add(ws);
    ws.on('close', () => r.sockets.delete(ws));
    ws.on('error', () => r.sockets.delete(ws));
    ws.on('message', (data, isBinary) => {
      if (isBinary || r.exited || !r.session) return;
      let value: unknown;
      try {
        value = JSON.parse(String(data));
      } catch {
        return;
      }
      const m = ShowClientMessage.safeParse(value);
      if (!m.success) return;
      try {
        if (m.data.t === 'in') r.session.write(m.data.data);
        else r.session.resize(m.data.cols, m.data.rows);
      } catch (e) {
        this.opts.log(`show: the command did not take what was sent: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return true;
  }

  /* ------------------------------------------------------------ helpers */

  private output(r: Running, chunk: string): void {
    if (typeof chunk !== 'string' || chunk === '') return;
    r.output += chunk;
    if (r.output.length > SHOW_OUTPUT_KEPT) r.output = r.output.slice(-SHOW_OUTPUT_KEPT);
    for (const ws of r.sockets) send(ws, { t: 'out', data: chunk });
  }

  private exit(chapter: string, r: Running, code: number | null): void {
    if (r.exited) return;
    r.exited = true;
    r.code = code;
    if (r.plan.kind === 'terminal') r.state = 'ended';
    else if (r.stopping) r.state = 'off';
    else if (r.state === 'starting') this.fail(r, `The app ended${code === null ? '' : ` with code ${code}`} before it answered.`);
    else if (r.state === 'on') this.fail(r, `The app ended${code === null ? '' : ` with code ${code}`}.`);
    for (const ws of r.sockets) {
      send(ws, { t: 'end', code });
      ws.close(1000, 'The show ended.');
    }
    r.sockets.clear();
    r.markGone();
    if (this.shows.get(chapter) === r) this.opts.changed();
  }

  private fail(r: Running, note: string): void {
    r.state = 'failed';
    r.note = note;
    // A terminal has no line for a note: it is said in the terminal.
    if (r.plan.kind === 'terminal') this.output(r, `${note}\r\n`);
    delete r.url;
    this.opts.changed();
  }

  /** End the command, and wait until it is gone, or the wait runs out. */
  private async end(r: Running): Promise<void> {
    if (r.exited) return;
    try {
      await r.session?.stop();
    } catch (e) {
      this.opts.log(`show: the command did not stop cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!r.session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      r.gone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.opts.stopTimeoutMs ?? 5000);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}

function send(ws: WebSocket, msg: ShowServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/** The address an app answered at, when it is on this machine: `http://127.0.0.1:<port>/...`. */
function localAddress(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') || u.port === '') return undefined;
    return `http://127.0.0.1:${u.port}${u.pathname}${u.search}`;
  } catch {
    return undefined;
  }
}

/** Is nothing listening on this port of 127.0.0.1? */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
