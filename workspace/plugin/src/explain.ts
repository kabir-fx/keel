import type { z } from 'zod';

/**
 * A schema error in words the agent can act on: where, what is wrong, and the limit. The
 * contract's schemas say "Too big: expected string to have <=60 characters"; this says
 * "approaches[0].steps[3].text is 72 characters; the limit is 60".
 */

type Issue = z.core.$ZodIssue;

/** `["approaches", 0, "steps", 3, "text"]` as `approaches[0].steps[3].text`. */
export function pathText(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out ? `.${String(p)}` : String(p);
  return out;
}

function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let v: unknown = root;
  for (const p of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[p];
  }
  return v;
}

const clip = (s: string, max = 40) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One issue as one sentence. */
export function explainIssue(issue: Issue, input: unknown, what = 'the picture'): string {
  const where = pathText(issue.path) || what;
  const value = valueAt(input, issue.path);
  switch (issue.code) {
    case 'too_big':
      if (issue.origin === 'string' && typeof value === 'string') return `${where} is ${value.length} characters; the limit is ${String(issue.maximum)}. Say it shorter.`;
      if (issue.origin === 'array' && Array.isArray(value)) return `${where} has ${value.length} entries; the limit is ${String(issue.maximum)}.`;
      return `${where} is over its limit of ${String(issue.maximum)}.`;
    case 'too_small':
      if (issue.origin === 'string') return `${where} is empty.`;
      if (issue.origin === 'array') return `${where} needs at least ${String(issue.minimum)} entr${issue.minimum === 1 ? 'y' : 'ies'}.`;
      return `${where} is below its least value, ${String(issue.minimum)}.`;
    case 'unrecognized_keys':
      return `${where} has ${issue.keys.length === 1 ? 'a key' : 'keys'} the grammar does not list: ${issue.keys.map((k) => `"${k}"`).join(', ')}. Take ${issue.keys.length === 1 ? 'it' : 'them'} out or use the listed key.`;
    case 'invalid_type':
      if (value === undefined) return `${where} is missing.`;
      return `${where} should be ${issue.expected === 'array' ? 'a list' : issue.expected === 'object' ? 'an object' : `a ${issue.expected}`}.`;
    case 'invalid_value':
      return `${where} must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}${value !== undefined ? `, not ${clip(JSON.stringify(value))}` : ''}.`;
    case 'invalid_format':
      return `${where} ${value !== undefined ? `${clip(JSON.stringify(value))} ` : ''}is not right: ${issue.message}.`;
    case 'invalid_union': {
      const opts = (issue as { options?: unknown[] }).options;
      if (opts) return `${where} must be one of ${opts.map((o) => JSON.stringify(o)).join(', ')}.`;
      return `${where} matches none of its forms. Check it against the keys line in the grammar.`;
    }
    default:
      return `${where}: ${issue.message}.`;
  }
}

/** The first few issues, one sentence each. */
export function explainError(error: z.ZodError, input: unknown, what?: string, max = 4): string {
  const lines = error.issues.slice(0, max).map((i) => explainIssue(i, input, what));
  const more = error.issues.length - max;
  if (more > 0) lines.push(`And ${more} more.`);
  return lines.join('\n');
}
