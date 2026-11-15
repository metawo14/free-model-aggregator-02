// lib/brief.ts — the trial brief: the free-model list, the prompt manifest, the
// catalog, and the quality-ordered routing order.
//
// A trial's brief ($MAKEFUN_PROMPT_FILE) is prose carrying two JSON documents:
// the free models (schema free-model-aggregator-02/models/v1) and the six
// prompts (free-model-aggregator-02/prompts/v1). Each model row carries the id
// the gateway routes (openrouter/<vendor>/<model>:free), the house's quality
// rating in milli-points, its context length and its capabilities (tools,
// vision, JSON mode). Each prompt row carries the requirements a model must
// meet to serve it. Routing is a pure function of the brief and the request:
// candidates that meet the requirements, best rating first, brief order
// breaking ties, so a live pass and its replay pick the same model.
//
// Nothing here reads a clock or unseeded randomness.

import { readFileSync } from 'node:fs';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

/** What one prompt needs from the model that serves it. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
}

/** One prompt the client will send, as the brief lists it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: CatalogModel[];
  }>;
}

export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

const SCHEMA_PREFIX = 'free-model-aggregator-02/';

/** The index of the `}` closing the object that opens at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object in `text` carrying a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return out;
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOf(v: unknown): boolean {
  return v === true;
}

function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = stringOf(v.id) !== '' ? stringOf(v.id) : stringOf(v.model);
  if (raw === '') return null;
  const named = stringOf(v.provider) !== '' ? stringOf(v.provider) : stringOf(v.wire);
  const id =
    named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/')
      ? `openrouter/${raw}`
      : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : raw,
    rating_milli: numberOrNull(v.rating_milli) ?? 0,
    context_length: numberOrNull(v.context_length),
    tools: boolOf(v.tools),
    vision: boolOf(v.vision),
    json: boolOf(v.json),
    free: v.free !== false,
  };
}

function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      ...(requires.tools === true ? { tools: true } : {}),
      ...(requires.vision === true ? { vision: true } : {}),
      ...(requires.json === true ? { json: true } : {}),
    },
  };
}

/** The brief at `path`, its two documents found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const modelsDoc =
    docs.find(
      (d) => typeof d.schema === 'string' && d.schema.includes(SCHEMA_PREFIX) && Array.isArray(d.models),
    ) ??
    docs.find(
      (d) => typeof d.schema === 'string' && d.schema.includes(SCHEMA_PREFIX) && Array.isArray(d.ratings),
    );
  if (modelsDoc === undefined) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no free-model list` };
  }
  const rows = (modelsDoc.models ?? modelsDoc.ratings) as unknown[];
  const models = rows.flatMap((v) => {
    const m = modelOf(v);
    return m === null ? [] : [m];
  });
  const promptsDoc = docs.find(
    (d) =>
      typeof d.schema === 'string' &&
      d.schema.includes(SCHEMA_PREFIX) &&
      (Array.isArray(d.prompts) || Array.isArray(d.manifest)),
  );
  const prompts =
    promptsDoc === undefined
      ? []
      : ((promptsDoc.prompts ?? promptsDoc.manifest) as unknown[]).flatMap((v) => {
          const p = promptOf(v);
          return p === null ? [] : [p];
        });
  return { models, prompts, error: null };
}

/** The models this entry may serve: the brief's free ones, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** Whether a model meets one prompt's requirements. */
export function meets(model: ModelRow, requires: Requirement): boolean {
  if (requires.tools === true && !model.tools) return false;
  if (requires.vision === true && !model.vision) return false;
  if (requires.json === true && !model.json) return false;
  return true;
}

/**
 * The routing order for a prompt: every free model that meets its
 * requirements, best rating first, brief order breaking ties. With the
 * practice brief this puts Thinking Machines Inkling 2 Small (1475) first
 * for plain and tools prompts, and NVIDIA Nemotron 3.5 Super VL (1303, the
 * best JSON-capable model) first for JSON-mode prompts.
 */
export function routingOrder(brief: Brief, requires: Requirement): ModelRow[] {
  const eligible = freeModels(brief).filter((m) => meets(m, requires));
  return eligible
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.rating_milli - a.m.rating_milli || a.i - b.i)
    .map(({ m }) => m);
}

/**
 * The catalog: one provider, every free model the brief names, once each.
 * base_url is OpenRouter's public endpoint, never the gateway's trial-local
 * address: the catalog is part of the state export a replay must reproduce
 * byte for byte, and the gateway's origin differs between a live pass and
 * its replay.
 */
export function buildCatalog(brief: Brief): Catalog {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
