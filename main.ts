// free-model-aggregator-02: one server, two client wires, one live free model
// behind every answer.
//
// A client points at this server as an OpenAI service (POST
// /v1/chat/completions) or an Anthropic one (POST /v1/messages), in JSON or
// server-sent events. Each prompt is answered by a real free OpenRouter
// model, dialled through the grader's gateway on the trial's key — never by
// an answer of this server's own. The brief ($MAKEFUN_PROMPT_FILE) lists
// the fourteen free models with the house's quality ratings and the six
// prompts' requirements; routing picks the best-rated model that meets a
// prompt's requirements (JSON-mode prompts need a JSON-capable model, tools
// prompts a tools-capable one), retries a refused model once, then fails
// over to the next-best eligible model, and reports the refusals it
// recovered from in the x-makefun-upstream-failures header.
//
// The server listens on 0.0.0.0 at a free port, registers that port and its
// catalog at POST $MAKEFUN_ENV_URL/register, polls GET $MAKEFUN_ENV_URL/work
// and exits 0 when the env says done. `node main.ts --list` prints the
// catalog document and exits 0.
//
// Determinism: every choice is a function of the brief, the requests and
// the gateway's answers. No wall clock, no unseeded randomness.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  isRecord,
  readBrief,
  routingOrder,
  type Catalog,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/brief.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicStreamRelay,
  anthropicToOpenAI,
  openAIAnswerToAnthropic,
  openAIAnswerWithModel,
  openAIError,
  openAIModelList,
  openAIStreamRelay,
  openAIToGateway,
  type ListedModel,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_MS = 200;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most gateway calls one prompt may cost (retry + failovers). */
const MAX_CALLS_PER_PROMPT = 6;
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: Catalog = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief lists them in arrival order. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** The gateway's Chat Completions route. A base not ending in /v1 gets one. */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function listedModels(): ListedModel[] {
  return brief.models
    .filter((m) => m.free)
    .map((m) => ({ id: m.id, provider: m.provider, display_name: m.display_name }));
}

/** Requirements read off a request body: tools, images, JSON mode. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: true } : {}),
    ...(vision ? { vision: true } : {}),
    ...(format === 'json_object' || format === 'json_schema' ? { json: true } : {}),
  };
}

/**
 * The requirements of the prompt now arriving: the brief's row for it,
 * unioned with what its own body declares, so a body asking for JSON mode
 * or tools is never routed to a model that cannot do it.
 */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  const fromBody = requirementsFromBody(body);
  const fromManifest = entry === undefined ? {} : entry.requires;
  return {
    ...(fromManifest.tools === true || fromBody.tools === true ? { tools: true } : {}),
    ...(fromManifest.vision === true || fromBody.vision === true ? { vision: true } : {}),
    ...(fromManifest.json === true || fromBody.json === true ? { json: true } : {}),
  };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = listedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

/** The short code of a refused gateway answer, from its error body when it has one. */
function failureCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.code === 'string' && parsed.error.code !== '') return parsed.error.code;
      if (typeof parsed.error.type === 'string' && parsed.error.type !== '') return parsed.error.type;
    }
  } catch {
    // Not JSON: fall through to the status default.
  }
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'upstream_error';
}

/** POST one body to the gateway's Chat Completions route, naming `model`. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(28000),
  });
}

interface DialResult {
  /** The gateway response that answered, or null when every attempt was refused. */
  response: Response | null;
  /** The model whose answer it is. */
  model: string | null;
  /** Every refusal on the way there, in order, for the failures header. */
  failures: UpstreamFailure[];
}

/**
 * Dial a prompt through the gateway, best model first: retry a refused
 * model once, then fail over to the next-best eligible model, until one
 * answers or the attempts run out. A refusal is not an answer. At most
 * MAX_CALLS_PER_PROMPT gateway calls are spent on one prompt, so the
 * trial's 60-call cap is never approached by failover alone.
 */
async function dialWithFailover(candidates: ModelRow[], body: Json): Promise<DialResult> {
  const failures: UpstreamFailure[] = [];
  let calls = 0;
  for (const model of candidates) {
    for (let attempt = 0; attempt < 2 && calls < MAX_CALLS_PER_PROMPT; attempt += 1) {
      calls += 1;
      let upstream: Response;
      try {
        upstream = await dial(model.id, body);
      } catch (err) {
        failures.push({ status: 502, code: 'upstream_unreachable', model: model.id });
        log(`dial ${model.id} failed: ${(err as Error).message}`);
        break;
      }
      if (upstream.ok) return { response: upstream, model: model.id, failures };
      const text = await upstream.text();
      failures.push({ status: upstream.status, code: failureCode(upstream.status, text), model: model.id });
      log(`dial ${model.id} refused HTTP ${upstream.status}`);
      // A 400 that is not a rate limit is the request's, not the model's:
      // retrying the same body on another model will not help.
      if (upstream.status === 400) return { response: null, model: null, failures };
      if (upstream.status !== 429 && upstream.status < 500) {
        return { response: null, model: null, failures };
      }
    }
  }
  return { response: null, model: null, failures };
}

/** The failures header: at most 8 rows, in the order the calls refused. */
function failuresHeader(failures: UpstreamFailure[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) };
}

/** A prompt every model refused, as a 502 in the client's wire. */
function giveUp(res: ServerResponse, wire: 'openai' | 'anthropic', failures: UpstreamFailure[]): void {
  const last = failures[failures.length - 1];
  const detail = last === undefined ? '' : ` (gateway HTTP ${last.status}: ${last.code})`;
  sendError(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', `the gateway refused every free model${detail}`);
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by a live free model. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = routingOrder(brief, requirementsFor(body));
  if (candidates.length === 0) {
    return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  }
  const upstreamBody = openAIToGateway(body, 'auto');
  const { response, model, failures } = await dialWithFailover(candidates, upstreamBody);
  if (response === null || model === null || response.body === null) return giveUp(res, 'openai', failures);
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const frame of openAIStreamRelay(response.body, model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await response.json();
  sendJson(res, 200, openAIAnswerWithModel(isRecord(answer) ? answer : {}, model), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, translated to Chat Completions and back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const candidates = routingOrder(brief, requirementsFor(body));
  if (candidates.length === 0) {
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  }
  const upstreamBody = anthropicToOpenAI(body, 'auto');
  const { response, model, failures } = await dialWithFailover(candidates, upstreamBody);
  if (response === null || model === null || response.body === null) return giveUp(res, 'anthropic', failures);
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const event of anthropicStreamRelay(response.body, model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await response.json();
  sendJson(res, 200, openAIAnswerToAnthropic(isRecord(answer) ? answer : {}, model), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env may still be starting, so retry briefly. */
async function register(port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') {
        log(`registered: the trial holds ${reply.requests} prompts`);
      }
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Poll GET /work; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the
    // one built object and stop before any server starts.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${listedModels().length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}

// The default output cap lives in lib/wire.ts (openAIToGateway and
// anthropicToOpenAI send 1024 when a request names none): the gateway
// refuses a call with no output cap, and this server always sends one.
