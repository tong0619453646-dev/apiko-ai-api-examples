// Thin client over the public APIKO endpoints. Only `/v1/*` on the data plane
// and the public catalog on the site are used; nothing here needs admin access.

import { ApikoError, defaultFetch, requestJson, type FetchLike } from './http.js';
import type { ApikoConfig } from './config.js';
import { USER_AGENT } from './version.js';

export interface ModelParameters {
  category?: string;
  endpoints?: string[];
  input_schema?: JsonSchemaObject;
  operations?: string[];
  supported_modes?: string[];
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  const?: unknown;
  [key: string]: unknown;
}

/** One entry of `GET /v1/models?expand=parameters` (key-scoped). */
export interface GatewayModel {
  id: string;
  category?: string;
  owned_by?: string;
  supported_endpoint_types?: string[];
  parameters?: ModelParameters | null;
}

export interface PerSecondTier {
  name: string;
  perSecond: number;
  /** Seedance: rate per billed second (input + output) when reference videos are sent. */
  videoInputPerSecond?: number;
}

export interface PublicPricing {
  inputPer1M?: number | null;
  outputPer1M?: number | null;
  cachePer1M?: number | null;
  perCall?: number | null;
  tiers?: Array<{ name: string; perCall: number }>;
  perSecondTiers?: PerSecondTier[];
  contextTiers?: Array<{ upTo: number | null; inputPer1M: number; outputPer1M: number; cachePer1M?: number }>;
  tokenImage?: { textInputPer1M: number; imageInputPer1M: number; outputPer1M: number };
  currency?: string;
}

/** One entry of `GET https://apiko.app/api/public/models?billing=all`. */
export interface PublicModel {
  id: string;
  displayName?: string;
  provider?: string;
  capabilities?: string[];
  context?: number | null;
  status?: string;
  pricing?: PublicPricing | null;
}

export interface SubmitResult {
  /** Parsed JSON body of the submit call. */
  body: Record<string, unknown>;
}

export class ApikoClient {
  private readonly fetchPromise: Promise<FetchLike>;

  constructor(
    private readonly config: Pick<ApikoConfig, 'apiKey' | 'baseUrl' | 'siteUrl'>,
    fetchImpl?: FetchLike
  ) {
    this.fetchPromise = fetchImpl ? Promise.resolve(fetchImpl) : defaultFetch();
  }

  get hasKey(): boolean {
    return Boolean(this.config.apiKey);
  }

  private authHeaders(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new ApikoError(
        'APIKO_API_KEY is not set. Create a key at https://apiko.app/dashboard/apikeys and add it to this MCP server\'s env (never paste it into the chat).',
        null,
        'configuration_error'
      );
    }
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  private async get<T>(url: string, auth: boolean, timeoutMs = 30_000): Promise<T> {
    const fetchImpl = await this.fetchPromise;
    return requestJson<T>(fetchImpl, url, { headers: auth ? this.authHeaders() : {}, timeoutMs });
  }

  async listModels(): Promise<GatewayModel[]> {
    const body = await this.get<{ data?: GatewayModel[] }>(`${this.config.baseUrl}/v1/models?expand=parameters`, true);
    return Array.isArray(body.data) ? body.data : [];
  }

  async publicCatalog(): Promise<PublicModel[]> {
    const body = await this.get<{ code?: number; message?: string; data?: { models?: PublicModel[] }; models?: PublicModel[] }>(
      `${this.config.siteUrl}/api/public/models?billing=all`,
      false
    );
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new ApikoError(`Public catalog error: ${body.message ?? body.code}`, 200);
    }
    const models = body.data?.models ?? body.models;
    return Array.isArray(models) ? models : [];
  }

  async subscription(): Promise<Record<string, unknown>> {
    return this.get(`${this.config.baseUrl}/v1/dashboard/billing/subscription`, true);
  }

  async usage(): Promise<Record<string, unknown>> {
    return this.get(`${this.config.baseUrl}/v1/dashboard/billing/usage`, true);
  }

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    return this.get(`${this.config.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, true);
  }

  /** POST a JSON body to a `/v1/...` path. Billable for generation endpoints. */
  async postJson(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const fetchImpl = await this.fetchPromise;
    return requestJson(fetchImpl, `${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  /** `POST /v1/uploads/images` with the raw image bytes (free, kept 72 hours). */
  async uploadImage(bytes: Uint8Array, contentType: string): Promise<Record<string, unknown>> {
    const fetchImpl = await this.fetchPromise;
    return requestJson(fetchImpl, `${this.config.baseUrl}/v1/uploads/images`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': contentType },
      body: bytes,
      timeoutMs: 120_000,
    });
  }

  /** Download a public image for re-upload (no APIKO credentials are sent). */
  async downloadPublic(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const fetchImpl = await this.fetchPromise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) throw new ApikoError(`Downloading ${new URL(url).host} failed: HTTP ${response.status}`, response.status);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) throw new ApikoError(`Image is larger than ${maxBytes / 1024 / 1024} MB`, 413);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new ApikoError(`Image is larger than ${maxBytes / 1024 / 1024} MB`, 413);
      return { bytes: buffer, contentType: response.headers.get('content-type') };
    } catch (error) {
      if (error instanceof ApikoError) throw error;
      const reason = controller.signal.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
      throw new ApikoError(`Downloading ${url} failed: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }
  }
}
