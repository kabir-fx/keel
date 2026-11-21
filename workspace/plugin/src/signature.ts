import { z } from 'zod';
import type { PictureKind } from '@keel/protocol';
import {
  BlueprintPicture,
  ChoicePicture,
  FocusPicture,
  FreeApproach,
  FreePicture,
  Id,
  LanesApproach,
  MiniPicture,
  ModelData,
  PipelinePicture,
  ShelfPicture,
  ShowPlan,
  SpreadPicture,
  Sub,
  Target,
  TextPicture,
  WalkPicture,
  LanesPicture,
} from '@keel/protocol';

/**
 * The keys and limits of each picture kind, in one short line, generated from the contract's
 * schemas. The grammar file carries these lines and a test compares them with this output,
 * so the limits the agent reads are the limits the server checks.
 *
 * Notation: `key?` is optional. `text≤60` is a string of at most 60 characters. `id` is a
 * slug (a-z, 0-9, "-"). `T[1-6]` is a list of 1 to 6. `int 1-40` is a whole number.
 */

type Node = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Node;
  anyOf?: Node[];
  /** A discriminated union: one of these, told apart by a key they all have. */
  oneOf?: Node[];
  properties?: Record<string, Node>;
  required?: string[];
};

function schemaOf(s: z.ZodType): Node {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io: 'input' }) as Node & { $schema?: string };
  return rest;
}

const key = (n: Node) => JSON.stringify(n);

/** Sub-schemas printed by name. The pictures that hold a whole model say `model`; a blueprint says `show`. */
const NAMED = new Map<string, string>([
  [key(schemaOf(Id)), 'id'],
  [key(schemaOf(Sub)), 'sub'],
  [key(schemaOf(Target)), '{item: id, sub?: sub}'],
  [key(schemaOf(ModelData)), 'candidate-model'],
  [key(schemaOf(LanesApproach)), 'lanes-approach'],
  [key(schemaOf(FreeApproach)), 'free-approach'],
  [key(schemaOf(ShowPlan)), 'show'],
]);

function count(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && min > 0) return max !== undefined ? `[${min}-${max}]` : `[${min}+]`;
  return max !== undefined ? `[≤${max}]` : '[]';
}

function render(n: Node, top = false): string {
  const named = top ? undefined : NAMED.get(key(n));
  if (named) return named;
  if (n.anyOf) return n.anyOf.map((x) => render(x)).join(' | ');
  if (n.oneOf) return n.oneOf.map((x) => render(x)).join(' | ');
  if (n.const !== undefined) return JSON.stringify(n.const);
  if (n.enum) return n.enum.map((v) => JSON.stringify(v)).join('|');
  switch (n.type) {
    case 'string':
      // Only an SVG is this long.
      if (n.maxLength !== undefined && n.maxLength >= 10_000) return `svg≤${n.maxLength}`;
      return n.maxLength !== undefined ? `text≤${n.maxLength}` : 'text';
    case 'integer':
    case 'number':
      return n.minimum !== undefined && n.maximum !== undefined ? `int ${n.minimum}-${n.maximum}` : 'number';
    case 'boolean':
      return 'bool';
    case 'array': {
      const inner = n.items ? render(n.items) : 'any';
      const wrap = inner.includes(' | ') ? `(${inner})` : inner;
      return `${wrap}${count(n.minItems, n.maxItems)}`;
    }
    case 'object': {
      const req = new Set(n.required ?? []);
      const fields = Object.entries(n.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${render(v)}`);
      return `{${fields.join(', ')}}`;
    }
    default:
      return 'any';
  }
}

/** One line for a schema: its keys, what each holds, and the limits. */
export function signatureOf(schema: z.ZodType): string {
  return render(schemaOf(schema), true);
}

const PICTURES: Record<PictureKind, z.ZodType> = {
  text: TextPicture,
  shelf: ShelfPicture,
  lanes: LanesPicture,
  spread: SpreadPicture,
  mini: MiniPicture,
  pipeline: PipelinePicture,
  walk: WalkPicture,
  focus: FocusPicture,
  blueprint: BlueprintPicture,
  choice: ChoicePicture,
  free: FreePicture,
};

/** The keys line of one picture kind. */
export function pictureSignature(kind: PictureKind): string {
  return signatureOf(PICTURES[kind]);
}

/**
 * Every keys line the grammar file carries, by the name its block has there: the eleven
 * picture kinds, the two kinds of approach in a spread, the candidate model of a pipeline, and
 * the show of a blueprint.
 * The board's own model (`board_model`) is added by the tools, which own its input schema.
 */
export function grammarSignatures(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kind, schema] of Object.entries(PICTURES)) out[kind] = signatureOf(schema);
  out['lanes-approach'] = signatureOf(LanesApproach);
  out['free-approach'] = signatureOf(FreeApproach);
  out['candidate-model'] = signatureOf(ModelData);
  out.show = signatureOf(ShowPlan);
  return out;
}
