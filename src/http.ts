// HTTP plumbing shared by every APIKO call.
//
// Node's built-in fetch ignores HTTPS_PROXY / HTTP_PROXY. When one of those is
// set we switch to undici's fetch with an EnvHttpProxyAgent (which also honours
// NO_PROXY); without them the built-in fetch is used and nothing changes.
// Every request carries a real User-Agent: Cloudflare in front of APIKO blocks
// some default library agents (error 1010).

import { USER_AGENT } from './version.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_VARS.some((name) => (env[name] ?? '').trim() !== '');
}

let cachedFetch: Promise<FetchLike> | null = null;

/** The fetch to use in this process: proxy-aware only when a proxy env var is set. */
export function defaultFetch(): Promise<FetchLike> {
  if (!cachedFetch) {
    cachedFetch = (async () => {
      if (!proxyConfigured()) return globalThis.fetch.bind(globalThis) as FetchLike;
      const undici = await import('undici');
      const dispatcher = quietly(() => new undici.EnvHttpProxyAgent());
      return ((input: string, init?: RequestInit) =>
        undici.fetch(input, { ...(init as object), dispatcher } as Parameters<typeof undici.fetch>[1])) as unknown as FetchLike;
    })();
  }
  return cachedFetch;
}

/** Run `make` without undici's "EnvHttpProxyAgent is experimental" warning on stderr. */
function quietly<T>(make: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const options = rest[0];
    const code = typeof options === 'object' && options ? (options as { code?: string }).code : rest[1];
    if (code === 'UNDICI-EHPA') return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return make();
  } finally {
    process.emitWarning = original;
  }
}

/** An HTTP or network failure, with the gateway's own message when it sent one. */
export class ApikoError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly type?: string,
    readonly code?: string,
    /** True when the request may have reached the server (timeouts, dropped connections). */
    readonly outcomeUnknown = false
  ) {
    super(message);
    this.name = 'ApikoError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

/** Pull `{ error: { message, type, code } }` (or `{ message }`) out of an error body. */
function errorFromBody(status: number, text: string): ApikoError {
  let message = text.trim().slice(0, 500) || `HTTP ${status}`;
  let type: string | undefined;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const err = (parsed.error ?? parsed) as Record<string, unknown>;
    if (typeof err === 'object' && err) {
      if (typeof err.message === 'string' && err.message) message = err.message;
      if (typeof err.type === 'string') type = err.type;
      if (typeof err.code === 'string' && err.code) code = err.code;
    } else if (typeof parsed.error === 'string') {
      message = parsed.error;
    }
  } catch {
    // Not JSON (an HTML error page from a proxy); keep the trimmed text.
    if (/<html/i.test(message)) message = `HTTP ${status} from the edge (non-JSON body)`;
  }
  return new ApikoError(`HTTP ${status}: ${message}`, status, type, code);
}

export async function requestJson<T = unknown>(fetchImpl: FetchLike, url: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
      body: options.body as RequestInit['body'],
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    const reason = aborted ? `timed out after ${Math.round(timeoutMs / 1000)} s` : describeNetworkError(error);
    throw new ApikoError(`Request to ${new URL(url).host} failed: ${reason}`, null, undefined, undefined, true);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    clearTimeout(timer);
    throw new ApikoError(`Reading the response from ${new URL(url).host} failed: ${describeNetworkError(error)}`, response.status, undefined, undefined, true);
  }
  clearTimeout(timer);
  if (!response.ok) throw errorFromBody(response.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApikoError(`Expected JSON from ${new URL(url).pathname}, got: ${text.slice(0, 200)}`, response.status);
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : '';
    return `${error.message}${causeText}`;
  }
  return String(error);
}
