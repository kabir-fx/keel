import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentLink, BoardEvent, Builder, BuilderContext, CreateBuilder, CreateLink, LinkContext, Refusal, Wake } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';

/**
 * Loading the agent link. `--link none` runs no agent. `--link script:<module>` runs a
 * script that answers each wake. Any other value names a module that exports `createLink`.
 *
 * Loading the builder. The module named by `--link` may also export `createBuilder`.
 * `--builder <module>` names another module, and `--builder none` runs no builder.
 */

export type ScriptPost = (
  drafts: unknown | unknown[],
) => Promise<{ ok: true; events: BoardEvent[] } | ({ ok: false } & Refusal)>;

/** What a `script:` module exports. */
export type ScriptAnswer = (wake: Wake, post: ScriptPost) => unknown;

/** Turn `--link-opt key=value` flags into `LinkContext.options`. */
export function parseLinkOptions(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--link-opt takes key=value, not "${pair}".`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** The link named by `spec`, or undefined for `none`. Throws when it cannot be loaded. */
export async function loadLink(spec: string, ctx: LinkContext): Promise<AgentLink | undefined> {
  const s = spec.trim();
  if (s === '' || s === 'none') return undefined;
  if (s.startsWith('script:')) return scriptLink(s.slice('script:'.length), ctx);

  const mod = (await importModule(s, ctx.repoDir, 'link')) as { createLink?: unknown; default?: { createLink?: unknown } };
  const create = (mod.createLink ?? mod.default?.createLink) as CreateLink | undefined;
  if (typeof create !== 'function') throw new Error(`The link module "${s}" does not export createLink.`);
  const link = await create(ctx);
  if (!link || typeof link.wake !== 'function' || typeof link.close !== 'function') {
    throw new Error(`createLink in "${s}" did not return an AgentLink with wake and close.`);
  }
  return link;
}

/**
 * The builder, and the name `keel-board status` shows for it. `spec` is `--builder`: `none`,
 * or a module that must export `createBuilder`. Left out, the `--link` module is asked, and
 * runs no builder when it exports none. Throws when a builder cannot be loaded.
 */
export async function loadBuilder(
  spec: string | undefined,
  linkSpec: string,
  ctx: BuilderContext,
): Promise<{ builder: Builder; name: string } | undefined> {
  const named = spec?.trim();
  if (named === 'none') return undefined;
  let source: string;
  if (named) {
    source = named;
  } else {
    const l = linkSpec.trim();
    if (l === '' || l === 'none') return undefined;
    source = l.startsWith('script:') ? l.slice('script:'.length) : l;
    if (!source) return undefined;
  }
  const mod = (await importModule(source, ctx.repoDir, 'builder')) as { createBuilder?: unknown; default?: { createBuilder?: unknown } };
  const create = (mod.createBuilder ?? mod.default?.createBuilder) as CreateBuilder | undefined;
  if (typeof create !== 'function') {
    if (named) throw new Error(`The builder module "${source}" does not export createBuilder.`);
    return undefined;
  }
  const builder = await create(ctx);
  if (!builder || typeof builder.run !== 'function' || typeof builder.pause !== 'function' || typeof builder.close !== 'function') {
    throw new Error(`createBuilder in "${source}" did not return a Builder with run, pause and close.`);
  }
  const name = typeof builder.name === 'string' && builder.name.trim() ? builder.name.trim().slice(0, 80) : path.basename(source);
  return { builder, name };
}

function looksLikePath(spec: string): boolean {
  return spec.startsWith('.') || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec) || fs.existsSync(spec);
}

async function importModule(spec: string, repoDir: string, what: 'link' | 'builder'): Promise<unknown> {
  if (looksLikePath(spec)) {
    const file = path.resolve(spec);
    if (!fs.existsSync(file)) throw new Error(`No ${what} module at ${file}.`);
    return import(pathToFileURL(file).href);
  }
  // A package name: first from the server's own install, then from where the owner stands.
  try {
    return await import(spec);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw e;
  }
  for (const base of [process.cwd(), repoDir]) {
    try {
      const resolved = createRequire(path.join(base, 'package.json')).resolve(spec);
      return await import(pathToFileURL(resolved).href);
    } catch {
      // Try the next place.
    }
  }
  throw new Error(`Cannot find the ${what} module "${spec}".`);
}

/** The built-in adapter for tests and demos: a module whose `answer(wake, post)` is the agent. */
async function scriptLink(file: string, ctx: LinkContext): Promise<AgentLink> {
  if (!file) throw new Error('--link script: needs a module path, for example script:./agent.mjs');
  const full = path.resolve(file);
  if (!fs.existsSync(full)) throw new Error(`No script at ${full}.`);
  const mod = (await import(pathToFileURL(full).href)) as { answer?: unknown; default?: unknown };
  const answer = (mod.answer ?? (mod.default as { answer?: unknown } | undefined)?.answer ?? mod.default) as
    | ScriptAnswer
    | undefined;
  if (typeof answer !== 'function') throw new Error(`The script ${full} does not export answer(wake, post).`);

  const post: ScriptPost = async (drafts) => {
    const res = await fetch(`${ctx.serverUrl}${ROUTES.events}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ drafts: Array.isArray(drafts) ? drafts : [drafts] }),
    });
    const body = (await res.json()) as { events?: BoardEvent[] } & Partial<Refusal> & { error?: string };
    if (res.ok) return { ok: true, events: body.events ?? [] };
    return { ok: false, rule: body.rule ?? 'shape', reason: body.reason ?? body.error ?? `HTTP ${res.status}`, ...(body.index !== undefined ? { index: body.index } : {}) };
  };

  return {
    name: `script:${path.basename(full)}`,
    async wake(w) {
      try {
        await answer(w, post);
        return { ok: true };
      } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
      }
    },
    async close() {},
  };
}
