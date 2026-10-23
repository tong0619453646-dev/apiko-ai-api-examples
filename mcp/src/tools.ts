// Tool definitions and handlers, independent of any MCP transport. server.ts
// mounts them on an McpServer; a remote HTTP endpoint can mount the same list.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ApikoClient } from './client.js';
import type { Catalog, CatalogEntry } from './catalog.js';
import type { ApikoConfig } from './config.js';
import { ApikoError } from './http.js';
import { estimateCost, priceSummary, round6, usd, type CostEstimate } from './pricing.js';
import { MAX_WAIT_SECONDS, pollTask, resultUrls, taskView, type TaskView } from './tasks.js';
import { validateInput } from './validate.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Spends money or publishes data; hidden when APIKO_MCP_READ_ONLY=1. */
  writes: boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolDeps {
  client: ApikoClient;
  catalog: Catalog;
  config: ApikoConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_SUBMIT_TIMEOUT_MS = 60_000;
/** Sync image calls: the edge closes requests at ~100 s (HTTP 524) while still charging. */
const IMAGE_SYNC_TIMEOUT_MS = 110_000;
const VIDEO_SUBMIT_TIMEOUT_MS = 60_000;
const DASHBOARD_USAGE = 'https://apiko.app/dashboard/usage';

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

function errorHint(error: ApikoError): string | undefined {
  if (error.code === 'insufficient_user_quota' || error.status === 402) return 'Balance used up: the user can top up at https://apiko.app/dashboard/billing.';
  if (error.status === 401) return 'The API key was rejected: check APIKO_API_KEY in the MCP server config (create keys at https://apiko.app/dashboard/apikeys).';
  if (error.code === 'model_not_found') return 'This key cannot use that model id; pick one from search_models.';
  if (error.status === 429) return 'Rate limited: wait a little and retry.';
  return undefined;
}

function failFrom(error: unknown): ToolResult {
  if (error instanceof ApikoError) {
    const hint = errorHint(error);
    return fail(error.message, hint ? { hint } : undefined);
  }
  return fail(error instanceof Error ? error.message : String(error));
}

function generateToolFor(entry: CatalogEntry): 'generate_image' | 'generate_video' | null {
  if (entry.category === 'image') return 'generate_image';
  if (entry.category === 'video') return 'generate_video';
  return null;
}

async function findModel(deps: ToolDeps, model: string): Promise<{ entry: CatalogEntry } | { error: ToolResult }> {
  const { entry, snapshot } = await deps.catalog.get(model);
  if (entry) return { entry };
  const suggestions = deps.catalog.suggest(snapshot, model);
  return {
    error: fail(`Unknown model "${model}" for this API key.`, {
      did_you_mean: suggestions,
      hint: 'Model ids are exact; use search_models to list them.',
    }),
  };
}

// ── request preparation shared by estimate_cost and the generate tools ─────

interface Prepared {
  body: Record<string, unknown>;
  notes: string[];
}

function prepareBody(entry: CatalogEntry, input: Record<string, unknown>, prompt: unknown): Prepared | { problem: string } {
  const body: Record<string, unknown> = { ...input };
  const notes: string[] = [];
  if (prompt !== undefined) {
    if (body.prompt !== undefined && body.prompt !== prompt) return { problem: 'prompt is given both at the top level and in input with different values; send it once.' };
    body.prompt = prompt;
  }
  if (body.model !== undefined && body.model !== entry.id) return { problem: `input.model "${String(body.model)}" does not match model "${entry.id}"; leave model out of input.` };
  body.model = entry.id;
  if (body.async !== undefined) {
    delete body.async;
    notes.push('input.async is managed by this server (async whenever the model supports it) and was ignored.');
  }
  if (body.response_format === 'b64_json') return { problem: 'response_format "b64_json" would put the whole image into the conversation; omit it to get a URL.' };
  return { body, notes };
}

function isImageEdit(body: Record<string, unknown>): boolean {
  return Array.isArray(body.images) && body.images.length > 0;
}

function compactEstimate(e: CostEstimate): Record<string, unknown> {
  const out: Record<string, unknown> = { status: e.status, estimated_usd: e.estimated_usd };
  for (const key of ['range_usd', 'hold_usd', 'upper_bound_usd', 'indicative_usd', 'missing', 'problems'] as const) {
    if (e[key] !== undefined) out[key] = e[key];
  }
  out.basis = e.basis;
  out.price_label = e.price_label;
  return out;
}

// ── client_request_id: same-process protection against double submission ───

type Outcome = { kind: 'task'; taskId: string } | { kind: 'sync'; urls: string[] } | { kind: 'unknown' } | { kind: 'pending' };
interface Submission {
  fingerprint: string;
  outcome: Outcome;
}
const MAX_REMEMBERED = 500;

class SubmissionLog {
  private readonly entries = new Map<string, Submission>();
  get(id: string): Submission | undefined {
    return this.entries.get(id);
  }
  delete(id: string): void {
    this.entries.delete(id);
  }
  set(id: string, submission: Submission): void {
    this.entries.delete(id);
    this.entries.set(id, submission);
    while (this.entries.size > MAX_REMEMBERED) this.entries.delete(this.entries.keys().next().value as string);
  }
}

// ── tool builders ──────────────────────────────────────────────────────────

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const BILLABLE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const inputRecord = z
  .record(z.string(), z.unknown())
  .describe('Model request fields exactly as listed in get_model input_schema (e.g. {"prompt": "...", "resolution": "2k"}). Leave out model and async.');

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const submissions = new SubmissionLog();
  const sleep = deps.sleep;
  const now = deps.now;

  const searchModels: ToolDefinition = {
    name: 'search_models',
    title: 'Search APIKO models',
    description:
      'List the APIKO models this API key can use, with category (image / video / chat), list prices and generation modes. Free. Use it before get_model; never guess model ids. Text models are listed for reference: call them with the OpenAI-compatible API, not through this server.',
    inputSchema: {
      query: z.string().max(100).optional().describe('Words that must all appear in the id, name or provider, e.g. "seedance" or "banana 2.1".'),
      category: z.enum(['all', 'image', 'video', 'chat']).optional().describe('Default "all".'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    },
    annotations: { ...READ_ONLY, title: 'Search APIKO models' },
    writes: false,
    handler: async (args) => {
      try {
        const snapshot = await deps.catalog.load();
        const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const category = (args.category as string | undefined) ?? 'all';
        const limit = (args.limit as number | undefined) ?? 20;
        const matches = snapshot.entries.filter((e) => {
          if (category !== 'all' && e.category !== category) return false;
          const hay = `${e.id} ${e.public?.displayName ?? ''} ${e.public?.provider ?? ''}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        const rank = (e: CatalogEntry) => (e.category === 'chat' ? 1 : 0);
        matches.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
        return ok({
          count: Math.min(limit, matches.length),
          total_matching: matches.length,
          key_scoped: snapshot.keyScoped,
          models: matches.slice(0, limit).map((e) => ({
            id: e.id,
            name: e.public?.displayName ?? e.id,
            category: e.category,
            provider: e.public?.provider,
            status: e.public?.status,
            price: priceSummary(e.public?.pricing) ?? 'no public price',
            modes: e.parameters?.supported_modes,
            operations: e.parameters?.operations,
            generate_tool: generateToolFor(e),
          })),
          ...(snapshot.warnings.length ? { warnings: snapshot.warnings } : {}),
          next_step: 'Call get_model for the request fields and price tiers of a model.',
        });
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const getModel: ToolDefinition = {
    name: 'get_model',
    title: 'Get APIKO model details',
    description:
      'Read one model\'s request fields (input_schema: types, enums, defaults, required fields), endpoints, async/sync modes and price tiers. Free. Send only fields from input_schema to estimate_cost and the generate tools.',
    inputSchema: { model: z.string().min(1).max(128).describe('Exact model id from search_models.') },
    annotations: { ...READ_ONLY, title: 'Get APIKO model details' },
    writes: false,
    handler: async (args) => {
      try {
        const found = await findModel(deps, String(args.model));
        if ('error' in found) return found.error;
        const e = found.entry;
        const tool = generateToolFor(e);
        return ok({
          id: e.id,
          name: e.public?.displayName ?? e.id,
          provider: e.public?.provider,
          category: e.category,
          status: e.public?.status,
          context_tokens: e.public?.context ?? undefined,
          generate_tool: tool,
          endpoints: e.parameters?.endpoints ?? e.gateway?.supported_endpoint_types,
          operations: e.parameters?.operations,
          supported_modes: e.parameters?.supported_modes,
          input_schema: e.parameters?.input_schema,
          price: priceSummary(e.public?.pricing),
          pricing: e.public?.pricing ?? null,
          docs_url: `https://apiko.app/models/${encodeURIComponent(e.id)}`,
          notes: tool
            ? [
                'Reference media must be public https:// URLs; use upload_image for local images.',
                'Run estimate_cost with the exact input and get the user\'s approval before generating.',
              ]
            : ['Text model: call it with the OpenAI-compatible API at https://api.apiko.app/v1 (chat/completions), not through this server.'],
        });
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const estimate: ToolDefinition = {
    name: 'estimate_cost',
    title: 'Estimate generation cost',
    description:
      'Validate a planned input against the model schema and quote its list price without submitting anything. Free. status "estimated" gives a number; "needs_input" names what is missing (e.g. reference_video_seconds); "token_billed" and "unknown" mean no reliable number exists, so never present them as a price. Show the user the model, input and estimate and wait for explicit approval before calling generate_image or generate_video.',
    inputSchema: {
      model: z.string().min(1).max(128),
      input: inputRecord.optional(),
      reference_video_seconds: z
        .number()
        .positive()
        .max(600)
        .optional()
        .describe('Total length in seconds of all reference_videos, when the input has any; used only for the estimate.'),
    },
    annotations: { ...READ_ONLY, title: 'Estimate generation cost' },
    writes: false,
    handler: async (args) => {
      try {
        const found = await findModel(deps, String(args.model));
        if ('error' in found) return found.error;
        const entry = found.entry;
        const prepared = prepareBody(entry, (args.input as Record<string, unknown>) ?? {}, undefined);
        if ('problem' in prepared) return fail(prepared.problem);
        const schema = entry.parameters?.input_schema;
        const validation = schema ? validateInput(entry.id, schema, prepared.body) : null;
        const result = estimateCost(entry, prepared.body, { referenceVideoSeconds: args.reference_video_seconds as number | undefined });
        return ok({
          model: entry.id,
          input_valid: validation ? validation.valid : null,
          problems: validation?.problems ?? [],
          operation: entry.category === 'image' ? (isImageEdit(prepared.body) ? 'edit (POST /v1/images/edits)' : 'generation (POST /v1/images/generations)') : undefined,
          estimate: {
            status: result.status,
            estimated_usd: result.estimated_usd,
            ...(result.range_usd ? { range_usd: result.range_usd } : {}),
            ...(result.hold_usd !== undefined ? { hold_usd: result.hold_usd } : {}),
            ...(result.indicative_usd !== undefined ? { indicative_usd: result.indicative_usd } : {}),
            ...(result.missing ? { missing: result.missing } : {}),
            ...(result.problems ? { problems: result.problems } : {}),
            basis: result.basis,
            notes: [...prepared.notes, ...result.notes],
          },
          pricing: result.pricing,
          price_label: result.price_label,
          ...(validation === null && entry.category !== 'chat' ? { warning: 'No input_schema available; the input could not be validated.' } : {}),
        });
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  async function generate(kind: 'image' | 'video', args: Record<string, unknown>): Promise<ToolResult> {
    const found = await findModel(deps, String(args.model));
    if ('error' in found) return found.error;
    const entry = found.entry;
    if (entry.category !== kind) {
      const other = generateToolFor(entry);
      return fail(`${entry.id} is a ${entry.category} model; ${other ? `use ${other}` : 'it cannot be called through this server'}.`);
    }
    const params = entry.parameters;
    const schema = params?.input_schema;
    if (!params || !schema) return fail(`${entry.id} has no published input_schema for this key, so the request cannot be validated; not submitted.`);

    const prepared = prepareBody(entry, (args.input as Record<string, unknown>) ?? {}, args.prompt);
    if ('problem' in prepared) return fail(prepared.problem);
    const body = prepared.body;

    // Endpoint and mode.
    let path: string;
    let mode: 'async' | 'sync';
    const modes = params.supported_modes ?? [];
    const endpoints = params.endpoints ?? [];
    if (kind === 'image') {
      const edit = isImageEdit(body);
      if (edit && !(params.operations ?? []).includes('edit')) return fail(`${entry.id} does not support editing with reference images.`);
      if (!edit && body.mask !== undefined) return fail('mask needs at least one reference image in "images".');
      path = edit ? '/v1/images/edits' : '/v1/images/generations';
      if (endpoints.length && !endpoints.includes(`POST ${path}`)) return fail(`${entry.id} does not offer POST ${path}.`);
      mode = modes.includes('async') ? 'async' : 'sync';
      if (mode === 'async') body.async = true;
    } else {
      path = '/v1/videos';
      if (endpoints.length && !endpoints.includes('POST /v1/videos')) return fail(`${entry.id} does not offer POST /v1/videos.`);
      mode = 'async';
    }

    const validation = validateInput(entry.id, schema, body);
    if (!validation.valid) {
      return fail('Input does not match the model schema; nothing was sent or charged.', { problems: validation.problems, hint: 'Fix the fields (see get_model) and run estimate_cost again.' });
    }

    const cost = estimateCost(entry, body, { referenceVideoSeconds: args.reference_video_seconds as number | undefined });
    const cap = args.max_cost_usd as number | undefined;
    if (cap !== undefined) {
      const bound = cost.status === 'estimated' ? cost.estimated_usd : cost.upper_bound_usd;
      if (bound === null || bound === undefined) {
        return fail(`max_cost_usd ${usd(cap)} cannot be checked: the cost status is "${cost.status}". Not submitted; ask the user how to proceed.`, { estimate: compactEstimate(cost) });
      }
      if (bound > cap) {
        return fail(`Estimated ${usd(bound)} exceeds max_cost_usd ${usd(cap)}. Not submitted.`, { estimate: compactEstimate(cost) });
      }
    }

    // Same-process duplicate protection.
    const requestId = args.client_request_id as string | undefined;
    const fingerprint = JSON.stringify({ path, body });
    if (requestId) {
      const previous = submissions.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail(`client_request_id "${requestId}" was already used for a different request; use a new id for a new, separately approved request.`);
        if (previous.outcome.kind === 'task') {
          const view = await pollTask(deps.client, previous.outcome.taskId, { waitSeconds: 0, sleep, now });
          return ok({ deduplicated: true, note: 'This client_request_id was already submitted; returning the existing task instead of charging again.', model: entry.id, ...view });
        }
        if (previous.outcome.kind === 'sync') return ok({ deduplicated: true, model: entry.id, status: 'completed', result_urls: previous.outcome.urls });
        return fail(
          `client_request_id "${requestId}" was submitted before and its outcome is unknown (or still in flight). Not resubmitted to avoid a double charge. Check ${DASHBOARD_USAGE}; if the user approves a retry, use a new client_request_id.`
        );
      }
      submissions.set(requestId, { fingerprint, outcome: { kind: 'pending' } });
    }

    let response: Record<string, unknown>;
    try {
      const timeout = kind === 'video' ? VIDEO_SUBMIT_TIMEOUT_MS : mode === 'sync' ? IMAGE_SYNC_TIMEOUT_MS : IMAGE_SUBMIT_TIMEOUT_MS;
      response = await deps.client.postJson(path, body, timeout);
    } catch (error) {
      if (error instanceof ApikoError && (error.outcomeUnknown || error.status === 524)) {
        if (requestId) submissions.set(requestId, { fingerprint, outcome: { kind: 'unknown' } });
        return fail(
          `${error.message}. The request may have been accepted and billed. Do not resubmit automatically: check ${DASHBOARD_USAGE} and ask the user before any retry.`,
          requestId ? { client_request_id: requestId } : undefined
        );
      }
      // The gateway answered with an error, so nothing was charged and the id may be reused.
      if (requestId) submissions.delete(requestId);
      return failFrom(error);
    }

    const notes = [
      ...prepared.notes,
      'Billed to the APIKO balance of this key at list price; a task that fails is refunded automatically.',
      'Result links are signed and kept for 24 hours; download anything worth keeping.',
    ];
    const taskId = typeof response.id === 'string' ? response.id : typeof response.task_id === 'string' ? response.task_id : null;
    if (mode === 'sync' || !taskId) {
      const urls = resultUrls(response);
      if (requestId) submissions.set(requestId, { fingerprint, outcome: { kind: 'sync', urls } });
      return ok({ submitted: true, model: entry.id, endpoint: `POST ${path}`, mode, status: urls.length ? 'completed' : 'unknown', result_urls: urls, cost: compactEstimate(cost), notes });
    }
    if (requestId) submissions.set(requestId, { fingerprint, outcome: { kind: 'task', taskId } });

    const waitSeconds = (args.wait_seconds as number | undefined) ?? (kind === 'image' ? 30 : 0);
    let view: TaskView = taskView(taskId, response);
    if (waitSeconds > 0 && !view.done) {
      try {
        view = await pollTask(deps.client, taskId, { waitSeconds, sleep, now });
      } catch {
        // The task exists; a failed status read is not a failed task.
      }
    }
    return ok({
      submitted: true,
      model: entry.id,
      endpoint: `POST ${path}`,
      mode,
      ...view,
      ...(requestId ? { client_request_id: requestId } : {}),
      cost: compactEstimate(cost),
      next_step: view.done ? 'Give the user the result_urls (or the fail_reason).' : `Call get_task with task_id "${taskId}" (wait_seconds up to ${MAX_WAIT_SECONDS}); do not call the generate tool again for the same job.`,
      notes,
    });
  }

  const generateShape = (kind: 'image' | 'video') => ({
    model: z.string().min(1).max(128).describe(`Exact ${kind} model id.`),
    input: inputRecord.optional(),
    prompt: z.string().min(1).max(32000).optional().describe('Shortcut for input.prompt; give the prompt once.'),
    client_request_id: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,96}$/)
      .optional()
      .describe('Your id for this one approved request (8-96 chars of letters, digits, . _ -). Reusing it with the same input returns the earlier task instead of charging twice.'),
    max_cost_usd: z.number().positive().max(10000).optional().describe('Budget the user approved; the call is refused if the estimate (or its upper bound) is higher or cannot be computed.'),
    ...(kind === 'video'
      ? { reference_video_seconds: z.number().positive().max(600).optional().describe('Total reference video length, for the cost check only; not sent.') }
      : {}),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe(kind === 'image' ? 'Seconds to wait for the result (default 30).' : 'Seconds to wait (default 0; videos take minutes, use get_task).'),
  });

  const generateImage: ToolDefinition = {
    name: 'generate_image',
    title: 'Generate or edit an image (billable)',
    description:
      'BILLABLE: creates a paid image task charged to the user\'s APIKO balance. Only call after estimate_cost on the same input and the user\'s explicit approval of the model and cost. With reference images in input.images it edits (POST /v1/images/edits), otherwise it generates. The input is validated against the model schema first. Runs async when the model supports it and waits up to wait_seconds; if not done, poll with get_task. Never call again to check progress.',
    inputSchema: generateShape('image'),
    annotations: { ...BILLABLE, title: 'Generate or edit an image (billable)' },
    writes: true,
    handler: async (args) => {
      try {
        return await generate('image', args);
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const generateVideo: ToolDefinition = {
    name: 'generate_video',
    title: 'Generate a video (billable)',
    description:
      'BILLABLE: creates a paid video task (POST /v1/videos) charged per second to the user\'s APIKO balance. Only call after estimate_cost on the same input and the user\'s explicit approval of the model, duration, resolution and cost. Reference videos add billed seconds. Returns a task_id at once; poll with get_task (videos take minutes). Never call again to check progress.',
    inputSchema: generateShape('video'),
    annotations: { ...BILLABLE, title: 'Generate a video (billable)' },
    writes: true,
    handler: async (args) => {
      try {
        return await generate('video', args);
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const getTask: ToolDefinition = {
    name: 'get_task',
    title: 'Get task status and results',
    description:
      'Read an image or video task: status (queued, in_progress, completed, failed), progress, result_urls and fail_reason. Free. wait_seconds (0-45, default 30) keeps polling until the task finishes or the time runs out. Failed tasks are refunded automatically. Result links last 24 hours.',
    inputSchema: {
      task_id: z.string().min(1).max(200).describe('task_id returned by generate_image or generate_video.'),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
    },
    annotations: { ...READ_ONLY, title: 'Get task status and results' },
    writes: false,
    handler: async (args) => {
      try {
        const view = await pollTask(deps.client, String(args.task_id), {
          waitSeconds: (args.wait_seconds as number | undefined) ?? 30,
          sleep,
          now,
        });
        return ok({
          ...view,
          next_step: view.done
            ? view.status === 'completed'
              ? 'Give the user the result_urls; they expire after 24 hours.'
              : 'Explain the fail_reason; the charge is refunded. Ask the user before submitting again.'
            : 'Still running: call get_task again with the same task_id.',
        });
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const checkBalance: ToolDefinition = {
    name: 'check_balance',
    title: 'Check key limit and usage',
    description:
      'Show what this API key has spent and its own spending limit, if it has one. Free. Keys without a limit draw on the account balance, which API keys cannot read; the user sees it at https://apiko.app/dashboard/billing.',
    inputSchema: {},
    annotations: { ...READ_ONLY, title: 'Check key limit and usage' },
    writes: false,
    handler: async () => {
      try {
        const [subscription, usage] = await Promise.all([deps.client.subscription(), deps.client.usage()]);
        return ok(balanceView(subscription, usage));
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  const uploadImage: ToolDefinition = {
    name: 'upload_image',
    title: 'Upload a reference image',
    description:
      'Upload a JPEG, PNG or WebP (up to 10 MB) and get a public https://img.apiko.app URL for reference fields such as images, first_image_url or reference_image_urls. Free (per key: 60 per minute, 1,000 per day). Give exactly one of path (a local file the user named) or url. The uploaded copy is public to anyone with the link and deleted after 72 hours, so only upload files the user asked to use.',
    inputSchema: {
      path: z.string().min(1).max(4096).optional().describe('Local file path (absolute, ~/..., or relative to the server\'s working directory).'),
      url: z.string().url().max(4096).optional().describe('Public http(s) image URL to copy.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, title: 'Upload a reference image' },
    writes: true,
    handler: async (args) => {
      try {
        return await upload(deps, args);
      } catch (error) {
        return failFrom(error);
      }
    },
  };

  return [searchModels, getModel, estimate, generateImage, generateVideo, getTask, checkBalance, uploadImage];
}

// ── check_balance ──────────────────────────────────────────────────────────

/**
 * new-api answers both endpoints from the calling token when
 * DisplayTokenStatEnabled is on (its default, and what production returns):
 * subscription = (remain + used) / QuotaPerUnit, or exactly 100000000 for an
 * unlimited token; usage.total_usage = used / QuotaPerUnit * 100 (cents).
 * See controller/billing.go in new-api.
 */
export const UNLIMITED_SENTINEL = 100000000;

export function balanceView(subscription: Record<string, unknown>, usage: Record<string, unknown>): Record<string, unknown> {
  const hard = Number(subscription.hard_limit_usd);
  const usedCents = Number(usage.total_usage);
  const usedUsd = Number.isFinite(usedCents) ? round6(usedCents / 100) : null;
  const accessUntil = Number(subscription.access_until);
  const unlimited = hard === UNLIMITED_SENTINEL;
  const view: Record<string, unknown> = {
    key_spent_usd: usedUsd,
    key_limit: unlimited ? 'none (the key draws on the account balance)' : Number.isFinite(hard) ? round6(hard) : null,
  };
  if (!unlimited && Number.isFinite(hard) && usedUsd !== null) view.key_remaining_usd = round6(Math.max(0, hard - usedUsd));
  view.key_expires_at = accessUntil > 0 ? new Date(accessUntil * 1000).toISOString() : 'never';
  view.notes = [
    unlimited
      ? 'This key has no spending limit of its own. The account balance is not readable with an API key; the user can see it at https://apiko.app/dashboard/billing. A generation fails with insufficient_user_quota when the balance runs out.'
      : 'key_limit is the spending limit set on this key; the account balance itself may be lower (see https://apiko.app/dashboard/billing).',
    'Amounts are USD. key_spent_usd counts everything this key has been charged, including text models.',
  ];
  return view;
}

// ── upload_image ───────────────────────────────────────────────────────────

export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Literal private / loopback hosts are refused so a prompt cannot publish internal images. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}

async function upload(deps: ToolDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const path = args.path as string | undefined;
  const url = args.url as string | undefined;
  if ((path ? 1 : 0) + (url ? 1 : 0) !== 1) return fail('Give exactly one of path or url.');

  let bytes: Uint8Array;
  let source: string;
  if (path) {
    const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
    const full = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    let info;
    try {
      info = await stat(full);
    } catch {
      return fail(`File not found: ${full}`);
    }
    if (!info.isFile()) return fail(`Not a file: ${full}`);
    if (info.size > UPLOAD_MAX_BYTES) return fail(`File is ${(info.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`);
    if (info.size === 0) return fail('File is empty.');
    bytes = new Uint8Array(await readFile(full));
    source = full;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url!);
    } catch {
      return fail('url is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fail('Only http(s) URLs can be copied.');
    if (parsed.username || parsed.password) return fail('URLs with embedded credentials are refused.');
    if (isPrivateHost(parsed.hostname)) return fail('Private, loopback and local-network hosts are refused; give a public URL or a local file path.');
    const downloaded = await deps.client.downloadPublic(parsed.toString(), UPLOAD_MAX_BYTES);
    bytes = downloaded.bytes;
    source = parsed.toString();
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) return fail('Not a JPEG, PNG or WebP image (checked by file content).');
  const response = await deps.client.uploadImage(bytes, contentType);
  if (typeof response.url !== 'string') return fail('Upload answered without a url.', { response });
  return ok({
    url: response.url,
    content_type: response.content_type ?? contentType,
    bytes: response.bytes ?? bytes.byteLength,
    expires_at: response.expires_at,
    source,
    notes: ['Public link, deleted after 72 hours. Put it in the model\'s reference field (images, first_image_url, reference_image_urls, ...).'],
  });
}
