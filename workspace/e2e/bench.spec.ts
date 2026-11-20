import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The bench: how the board keeps up on the `bench` fixture (300 items) with three workloads.
 * A pan across the board with the Pan tool, a zoom from 20% to 400% and back about one point
 * with Ctrl and the wheel (a trackpad pinch), and one pen stroke of 2,000 samples.
 *
 * Each workload is driven from inside the page, in a `requestAnimationFrame` loop that sends a
 * fixed number of synthetic events a frame. Not the real mouse: each of Playwright's mouse
 * calls is a round trip from this process, so how many land in a frame depends on the machine
 * and its load, and two runs would not ask the board for the same work. In the page, every
 * run sends the same events in the same frames.
 *
 * It prints every run, then one line a workload, and writes the same numbers to
 * test-results/bench.json. What it records is of two kinds.
 *
 * Counts hold still whatever else the machine is doing. Judge a change by these.
 * - The instructions the page's process retires a frame, on all its threads, and the share of
 *   its CPU time spent on the fast cores, which says why a run's times were slow. macOS keeps
 *   both for every process; `bench-rusage.py` reads them before and after the workload. Where
 *   they cannot be read (not macOS, no python3) the bench says so and leaves the columns out.
 * - React commits, through a minimal DevTools hook installed before the app loads. React calls
 *   it on every commit, in the production build too.
 * - Style and layout passes a frame, from `Performance.getMetrics` (`RecalcStyleCount` and
 *   `LayoutCount`). They are Blink's own counters: exact, and free to read. A trace holds the
 *   same passes, but a page that is traced retires 2% to 5% more instructions.
 * - The main thread's tasks a frame. Only a trace has them, so they are counted on the
 *   warm-up pass, and the measured pass is never traced.
 *
 * Times move with the machine. macOS shifts Chrome between fast and slow cores and between
 * clock speeds: the same pan has read from 0.7 to 1.5 ms of busy time a frame. They are the
 * frame times (median, 95th percentile, worst, how many frames took over 16.7 ms and over
 * 33 ms), the main thread's busy time a frame (Chrome's `TaskDuration`), and the time inside
 * the event handlers. Take the lowest busy time of the runs, and never judge a small change
 * by it.
 *
 * Where a run sits in its renderer's life changes its counts, so every run sits in the same
 * place: the second page of a renderer process of its own (a new browser context), whose first
 * page ran the first frames of the same workload. The first page of a renderer compiles as it
 * goes, and reads high and uneven: the pan retired 12.4 to 13.0 million instructions a frame
 * there. Every later page inherits the heap and the collector's settings of the pages before
 * it: the stroke reads 19% higher from the second page on, and by the third and fourth page
 * two renderers with the same past were up to 1% apart. On the second page they are within
 * about 0.5%, on a busy machine too.
 *
 * It runs only with KEEL_BENCH=1 (`npm run bench`), asserts nothing about speed, and fails only
 * when a workload cannot run or a counter cannot be read.
 */

test.skip(!process.env.KEEL_BENCH, 'the bench runs with KEEL_BENCH=1: npm run bench -w @keel/board-e2e');

const OUT = fileURLToPath(new URL('./test-results/bench.json', import.meta.url));
const COUNTER = fileURLToPath(new URL('./bench-rusage.py', import.meta.url));
const RUNS = 3;
/** How many frames of its workload a renderer runs on its first page, before the measured page. */
const WARM_FRAMES = 60;
const WORKLOADS = ['pan', 'zoom', 'stroke'] as const;
type Workload = (typeof WORKLOADS)[number];
/** What a pass writes on the page's timeline as it starts and as it ends: a trace is read between the two. */
const MARKS = ['bench:start', 'bench:end'] as const;
/** The name a trace gives each task a thread runs. */
const TASK = 'ThreadControllerImpl::RunTask';

/** What one run of a workload measured. Times are in ms, instructions in millions. */
interface Run {
  frames: number;
  median: number;
  p95: number;
  worst: number;
  over16: number;
  over33: number;
  /**
   * The time from sending a frame's events to the end of the microtasks they queue: the event
   * handlers, and the React work they set off at once. What a handler leaves for the frame
   * callback is not in it, so it cannot be compared across a change that moves work there.
   */
  inHandlersMedian: number;
  inHandlersP95: number;
  busyPerFrame: number;
  /** Not there where macOS's counts cannot be read. */
  instructionsPerFrame?: number;
  /** The share of the process's CPU time spent on the fast cores, in percent. Not there without the counts. */
  fastCores?: number;
  commits: number;
  stylePerFrame: number;
  layoutPerFrame: number;
  /** Counted on the warm-up pass, per frame of that pass. */
  tasksPerFrame: number;
}

/** One workload in one line: what to compare from one bench to the next. */
interface Summary {
  busyPerFrameMin: number;
  instructionsPerFrameMedian?: number;
  commits: number;
  stylePerFrame: number;
  layoutPerFrame: number;
}

/** What the page hands back from one pass of a workload: the raw frame and handler times, and what it did. */
interface Pass {
  deltas: number[];
  handlers: number[];
  commits: number;
  problem?: string;
}

/** Chrome's own counts for a page: its main thread's busy time in ms, and its style and layout passes. */
interface Counts {
  busy: number;
  style: number;
  layout: number;
}

/** macOS's counts for one process: instructions retired, CPU time, and the part of it on the fast cores. */
interface Usage {
  instructions: number;
  cpuNs: number;
  fastNs: number;
}
type Usages = Record<string, Usage | null>;

/** One event of a trace, as far as the bench reads it. */
interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
}

/** A page in a browser context of its own, with Chrome's counters on. */
interface Tab {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
}

const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Frame times are whole frames of 16.67 ms plus up to a tenth of a ms of jitter: a frame counts as over 16.7 ms past this. */
const OVER_ONE_FRAME = 17.2;

function toRun(pass: Pass, during: Counts, used: Usage | undefined, tasksPerFrame: number): Run {
  const frames = pass.deltas.length;
  return {
    frames,
    median: r1(quantile(pass.deltas, 0.5)),
    p95: r1(quantile(pass.deltas, 0.95)),
    worst: r1(Math.max(...pass.deltas)),
    over16: pass.deltas.filter((d) => d > OVER_ONE_FRAME).length,
    over33: pass.deltas.filter((d) => d > 33).length,
    inHandlersMedian: r1(quantile(pass.handlers, 0.5)),
    inHandlersP95: r1(quantile(pass.handlers, 0.95)),
    busyPerFrame: r1(during.busy / frames),
    ...(used ? { instructionsPerFrame: r2(used.instructions / 1e6 / frames), fastCores: Math.round((100 * used.fastNs) / used.cpuNs) } : {}),
    commits: pass.commits,
    stylePerFrame: r2(during.style / frames),
    layoutPerFrame: r2(during.layout / frames),
    tasksPerFrame,
  };
}

/** Busy time only ever reads too high, so its lowest run is kept. The counts are the same in every run, or nearly: their median is kept. */
function summarise(runs: readonly Run[]): Summary {
  const median = (of: (r: Run) => number | undefined) => quantile(runs.map(of).filter((n) => n !== undefined), 0.5);
  return {
    busyPerFrameMin: Math.min(...runs.map((r) => r.busyPerFrame)),
    ...(runs.some((r) => r.instructionsPerFrame !== undefined) ? { instructionsPerFrameMedian: median((r) => r.instructionsPerFrame) } : {}),
    commits: median((r) => r.commits),
    stylePerFrame: median((r) => r.stylePerFrame),
    layoutPerFrame: median((r) => r.layoutPerFrame),
  };
}

/** Ask the counter helper what macOS has counted for some processes. Throws where it cannot run. */
function readUsage(pids: readonly number[]): Usages {
  const out = execFileSync('python3', ['-I', COUNTER, ...pids.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out) as Usages;
}

/** True where macOS's counts can be read: on macOS, with python3, and with instructions that are counted. */
function hasCounter(): boolean {
  if (platform() !== 'darwin') return false;
  try {
    return (readUsage([process.pid])[process.pid]?.instructions ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The renderer processes the browser has now. One of them holds the page; Chrome keeps spares beside it. */
async function rendererPids(browserCdp: CDPSession): Promise<number[]> {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
}

/** What the page's renderer used between two readings: of the renderers, it is the one that retired the most. The spares retire next to nothing. */
function mostWork(before: Usages, after: Usages): Usage {
  let most: Usage | undefined;
  for (const [pid, b] of Object.entries(after)) {
    const a = before[pid];
    if (!a || !b) continue;
    const used = { instructions: b.instructions - a.instructions, cpuNs: b.cpuNs - a.cpuNs, fastNs: b.fastNs - a.fastNs };
    if (!most || used.instructions > most.instructions) most = used;
  }
  if (!most) throw new Error('no renderer process was there both before and after the pass');
  return most;
}

/** Chrome's counts for the page since it started. */
async function counts(cdp: CDPSession): Promise<Counts> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const of = (name: string) => metrics.find((m) => m.name === name)?.value ?? NaN;
  return { busy: 1000 * of('TaskDuration'), style: of('RecalcStyleCount'), layout: of('LayoutCount') };
}

/**
 * Trace a pass, and count the tasks its page's main thread ran: those that began between the
 * pass's two marks, on the thread that wrote the marks. The trace holds the tasks of every
 * thread and nothing else that is not needed, which is the cheapest trace that has them.
 */
async function withTasksCounted(browserCdp: CDPSession, run: () => Promise<Pass>): Promise<{ pass: Pass; tasks: number }> {
  const events: TraceEvent[] = [];
  const collect = ({ value }: { value: unknown[] }) => {
    events.push(...(value as TraceEvent[]));
  };
  browserCdp.on('Tracing.dataCollected', collect);
  await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: ['toplevel', 'blink.user_timing'] } });
  const pass = await run();
  const complete = new Promise<void>((done) => browserCdp.once('Tracing.tracingComplete', () => done()));
  await browserCdp.send('Tracing.end');
  await complete;
  browserCdp.off('Tracing.dataCollected', collect);
  const [from, to] = MARKS.map((name) => events.find((e) => e.name === name));
  if (!from || !to) throw new Error('the trace does not hold the marks of the pass');
  // A task shorter than the trace's clock can tell is written as an instant, not as a span: it counts too.
  const tasks = events.filter((e) => e.name === TASK && e.ph !== 'E' && e.pid === from.pid && e.tid === from.tid && e.ts >= from.ts && e.ts <= to.ts);
  return { pass, tasks: tasks.length };
}

/** Count React commits through a minimal DevTools hook, installed before React looks for one. */
function countCommits() {
  const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
  w.__commits = 0;
  const renderers = new Map<number, unknown>();
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    inject: (renderer: unknown) => {
      renderers.set(renderers.size + 1, renderer);
      return renderers.size;
    },
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: () => {
      w.__commits += 1;
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
}

/** Open a page in a new browser context: Chrome gives it a renderer process no page has used. */
async function openTab(browser: Browser): Promise<Tab> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(countCommits);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { context, page, cdp };
}

/** Load the bench fixture afresh, wait until it has settled, and set the tool and zoom the workload starts from. */
async function setUp(page: Page, workload: Workload) {
  await page.goto('/?fixture=bench&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await expect(page.locator('[data-item]')).toHaveCount(300);
  await page.waitForTimeout(1000);
  // 100% about the middle, then down: 51% for the pan and the stroke, the 20% floor for the zoom.
  await page.keyboard.press('0');
  for (let i = 0; i < (workload === 'zoom' ? 10 : 3); i++) await page.keyboard.press('-');
  if (workload === 'pan') await page.keyboard.press('h');
  if (workload === 'stroke') await page.keyboard.press('p');
  await page.waitForTimeout(500);
}

/**
 * Run one workload in the page: all of it, or only its first `cut` frames. Everything inside is
 * sent to the page as code, so it uses nothing from outside.
 */
function drive({ workload, cut, marks }: { workload: Workload; cut?: number; marks: readonly [string, string] }): Promise<Pass> {
  const board = document.querySelector('[data-testid="board"]')!;
  const world = document.querySelector<HTMLElement>('.world')!;
  const w = window as unknown as { __commits: number };
  const camera = () => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(world.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };
  const MID = [720, 450] as const;

  // One mouse with the main button. Every event of a press goes to the element it started on.
  let pressed: Element = board;
  /** Where the mouse is while its button is down. */
  let held: [number, number] | undefined;
  const pointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) => {
    if (type === 'pointerdown') pressed = document.elementFromPoint(x, y) ?? board;
    const down = type !== 'pointerup';
    held = down ? [x, y] : undefined;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    pressed.dispatchEvent(new PointerEvent(type, { ...init, button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, pressure: down ? 0.5 : 0 }));
  };
  const wheel = (dy: number) => {
    const target = document.elementFromPoint(MID[0], MID[1]) ?? board;
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: MID[0], clientY: MID[1], deltaY: dy, ctrlKey: true }));
  };

  /** Send one frame's events; true when the workload is done. */
  let step: (frame: number) => boolean;
  /** What the whole workload must have done, or why it did not. */
  let check: () => string | undefined;
  const start = camera();

  if (workload === 'pan') {
    // 600 moves, 2 a frame, dragging the board 3000 px left and 1500 px up.
    const [x0, y0, per, total] = [1200, 760, 2, 600];
    step = (f) => {
      if (f === 0) pointer('pointerdown', x0, y0);
      for (let k = 1; k <= per; k++) {
        const i = f * per + k;
        pointer('pointermove', x0 - 5 * i, y0 - 2.5 * i);
        if (i === total) {
          pointer('pointerup', x0 - 5 * i, y0 - 2.5 * i);
          return true;
        }
      }
      return false;
    };
    check = () => {
      const c = camera();
      return Math.abs(c.x - start.x + 3000) < 1 && Math.abs(c.y - start.y + 1500) < 1 ? undefined : `the pan moved the camera from ${JSON.stringify(start)} to ${JSON.stringify(c)}`;
    };
  } else if (workload === 'zoom') {
    // One Ctrl-wheel event a frame, as a trackpad pinch sends them: in to the 400% ceiling, then out to the 20% floor.
    let dir = -1;
    step = (f) => {
      if (f > 3000) throw new Error('the zoom did not reach its ends in 3000 frames');
      wheel(dir * 2);
      const z = camera().z;
      if (dir < 0 && z >= 4 - 1e-9) dir = 1;
      return dir > 0 && z <= 0.2 + 1e-9;
    };
    check = () => (start.z <= 0.2 + 1e-9 ? undefined : `the zoom started at ${start.z}, not at 20%`);
  } else {
    // 2000 samples, 4 a frame, along a figure that crosses the screen many times.
    const [per, total] = [4, 2000];
    const at = (i: number): [number, number] => {
      const t = (i / total) * 2 * Math.PI;
      return [MID[0] + 560 * Math.sin(3 * t), MID[1] + 300 * Math.sin(4 * t + 0.5)];
    };
    step = (f) => {
      if (f === 0) pointer('pointerdown', ...at(0));
      for (let k = 1; k <= per; k++) {
        const i = f * per + k;
        pointer('pointermove', ...at(i));
        if (i === total) {
          pointer('pointerup', ...at(i));
          return true;
        }
      }
      return false;
    };
    check = () => (document.querySelector('[data-testid="live"] svg.ink') ? undefined : 'the stroke left nothing on the live layer');
  }

  return new Promise<Pass>((resolve) => {
    const deltas: number[] = [];
    const handlers: number[] = [];
    const commits = w.__commits;
    let last = 0;
    let frame = 0;
    /** Frames left to let the page draw what the last events set off. */
    let tail = -1;
    const tick = (t: number) => {
      if (last) deltas.push(t - last);
      last = t;
      if (tail < 0) {
        const t0 = performance.now();
        let done: boolean;
        try {
          done = step(frame++);
          // A pass that is cut short lets go of the button where it is, as a hand would.
          if (!done && frame === cut) {
            if (held) pointer('pointerup', ...held);
            done = true;
          }
        } catch (e) {
          resolve({ deltas, handlers, commits: 0, problem: String(e) });
          return;
        }
        // React renders an update from a pointer event in a microtask: count it with the handlers.
        queueMicrotask(() => handlers.push(performance.now() - t0));
        if (done) tail = 2;
      } else if (tail-- === 0) {
        const problem = cut === undefined ? check() : undefined;
        performance.mark(marks[1]);
        resolve({ deltas, handlers, commits: w.__commits - commits, ...(problem ? { problem } : {}) });
        return;
      }
      requestAnimationFrame(tick);
    };
    performance.mark(marks[0]);
    requestAnimationFrame(tick);
  });
}

/** How often the page draws when nothing happens: the median of 60 idle frames. */
function idleFrame(): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    const tick = (t: number) => {
      if (last) deltas.push(t - last);
      last = t;
      if (deltas.length < 60) requestAnimationFrame(tick);
      else resolve(deltas.sort((a, b) => a - b)[30]!);
    };
    requestAnimationFrame(tick);
  });
}

/** The renderer's first page: the first frames of the workload, traced. Resolves to the main thread's tasks a frame. */
async function warmUp(tab: Tab, browserCdp: CDPSession, workload: Workload): Promise<number> {
  await setUp(tab.page, workload);
  const { pass, tasks } = await withTasksCounted(browserCdp, () => tab.page.evaluate(drive, { workload, cut: WARM_FRAMES, marks: MARKS }));
  expect(pass.problem, `${workload}, warm-up`).toBeUndefined();
  return r2(tasks / pass.deltas.length);
}

/** The renderer's second page: the whole workload, with every count read before it and after it. */
async function measure(tab: Tab, browserCdp: CDPSession, workload: Workload, counted: boolean): Promise<{ pass: Pass; during: Counts; used?: Usage }> {
  await setUp(tab.page, workload);
  const pids = counted ? await rendererPids(browserCdp) : [];
  const usedBefore = counted ? readUsage(pids) : undefined;
  const before = await counts(tab.cdp);
  const pass = await tab.page.evaluate(drive, { workload, marks: MARKS });
  const after = await counts(tab.cdp);
  const used = usedBefore ? mostWork(usedBefore, readUsage(pids)) : undefined;
  const during = { busy: after.busy - before.busy, style: after.style - before.style, layout: after.layout - before.layout };
  return { pass, during, ...(used ? { used } : {}) };
}

/** One column of a table: its heading, and what a row says under it. */
interface Column<Row> {
  head: string;
  cell(row: Row): string;
}

/** Lay rows out under their headings: names to the left, numbers to the right. */
function table<Row>(columns: readonly Column<Row>[], rows: readonly Row[]): string[] {
  const lines = [columns.map((c) => c.head), ...rows.map((r) => columns.map((c) => c.cell(r)))];
  const width = columns.map((_, c) => Math.max(...lines.map((line) => line[c]?.length ?? 0)));
  return lines.map((line) => line.map((s, c) => (c === 0 ? s.padEnd(width[c] ?? 0) : s.padStart(width[c] ?? 0))).join('  '));
}

// The columns never change their order, and a number never changes its form: one decimal for
// ms, two for instructions in millions and for counts a frame. Two benches can be diffed.
const ms = (n: number) => n.toFixed(1);
const fine = (n: number | undefined) => (n ?? NaN).toFixed(2);

const runColumns = (counted: boolean): Column<Run & { workload: string; run: number }>[] => [
  { head: 'workload', cell: (r) => r.workload },
  { head: 'run', cell: (r) => String(r.run) },
  { head: 'frames', cell: (r) => String(r.frames) },
  { head: 'median', cell: (r) => ms(r.median) },
  { head: 'p95', cell: (r) => ms(r.p95) },
  { head: 'worst', cell: (r) => ms(r.worst) },
  { head: '>16.7', cell: (r) => String(r.over16) },
  { head: '>33', cell: (r) => String(r.over33) },
  { head: 'in handlers med', cell: (r) => ms(r.inHandlersMedian) },
  { head: 'in handlers p95', cell: (r) => ms(r.inHandlersP95) },
  { head: 'busy/frame', cell: (r) => ms(r.busyPerFrame) },
  ...(counted ? [{ head: 'instr M/frame', cell: (r: Run) => fine(r.instructionsPerFrame) }, { head: 'fast cores %', cell: (r: Run) => String(r.fastCores) }] : []),
  { head: 'commits', cell: (r) => String(r.commits) },
  { head: 'style/frame', cell: (r) => fine(r.stylePerFrame) },
  { head: 'layout/frame', cell: (r) => fine(r.layoutPerFrame) },
  { head: 'tasks/frame', cell: (r) => fine(r.tasksPerFrame) },
];

const summaryColumns = (counted: boolean): Column<Summary & { workload: string }>[] => [
  { head: 'summary', cell: (s) => s.workload },
  { head: 'lowest busy/frame', cell: (s) => ms(s.busyPerFrameMin) },
  ...(counted ? [{ head: 'median instr M/frame', cell: (s: Summary) => fine(s.instructionsPerFrameMedian) }] : []),
  { head: 'commits', cell: (s) => String(s.commits) },
  { head: 'style/frame', cell: (s) => fine(s.stylePerFrame) },
  { head: 'layout/frame', cell: (s) => fine(s.layoutPerFrame) },
];

test('the bench: pan, zoom and a long stroke on 300 items', async ({ browser }, info) => {
  test.setTimeout(10 * 60_000);
  const browserCdp = await browser.newBrowserCDPSession();
  const counted = hasCounter();
  if (!counted) console.log('bench: macOS\'s counts cannot be read here (they need macOS and python3), so there is no "instr M/frame" and no "fast cores %"');

  const results: Record<string, { runs: Run[]; summary: Summary }> = {};
  /** What the first measured page says of the machine: how often it draws when idle, and its size. */
  let seen: { idleFrameMs: number; viewport: ReturnType<Page['viewportSize']> } | undefined;
  for (const workload of WORKLOADS) {
    const runs: Run[] = [];
    for (let i = 0; i < RUNS; i++) {
      const tab = await openTab(browser);
      const tasksPerFrame = await warmUp(tab, browserCdp, workload);
      const { pass, during, used } = await measure(tab, browserCdp, workload, counted);
      expect(pass.problem, `${workload}, run ${i + 1}`).toBeUndefined();
      runs.push(toRun(pass, during, used, tasksPerFrame));
      // After the pass, so the first run is measured as every other run is.
      seen ??= { idleFrameMs: r1(await tab.page.evaluate(idleFrame)), viewport: tab.page.viewportSize() };
      await tab.context.close();
    }
    results[workload] = { runs, summary: summarise(runs) };
  }

  const machine = {
    browser: `${browser.browserType().name()} ${browser.version()}`,
    headless: info.project.use.headless ?? true,
    ...seen,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    instructionsCounted: counted,
  };
  mkdirSync(fileURLToPath(new URL('./test-results/', import.meta.url)), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), machine, warmFrames: WARM_FRAMES, results }, null, 2) + '\n');

  const all = Object.entries(results);
  console.log(
    [
      `bench, ${machine.browser}, ${machine.headless ? 'headless' : 'headed'}, idle frame ${ms(seen?.idleFrameMs ?? NaN)} ms; times in ms; every run is the second page of a renderer of its own, after ${WARM_FRAMES} frames of warm-up`,
      ...table(runColumns(counted), all.flatMap(([workload, { runs }]) => runs.map((r, i) => ({ ...r, workload, run: i + 1 })))),
      '',
      ...table(summaryColumns(counted), all.map(([workload, { summary }]) => ({ ...summary, workload }))),
      '',
      'Counts hold still on a busy machine: instr M/frame (millions of instructions the page\'s process retires a frame), commits, style/frame, layout/frame. Times do not.',
      'in handlers: the time inside the event handlers only. What they leave for the frame callback is not in it, so do not compare it across a change that moves work there.',
      'tasks/frame: the main thread\'s tasks, from a trace of the warm-up pass. The measured pass is not traced.',
      `written to ${OUT}`,
    ].join('\n'),
  );
});
