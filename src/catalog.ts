// The model catalog an agent sees: the key-scoped `/v1/models?expand=parameters`
// list (what this key can call, with request schemas) joined with the public
// price catalog. Cached briefly so a quote and the generate call that follows
// read the same prices.

import type { ApikoClient, GatewayModel, ModelParameters, PublicModel } from './client.js';

export interface CatalogEntry {
  id: string;
  category: string;
  /** Present when this key can call the model (from `/v1/models`). */
  gateway: GatewayModel | null;
  parameters: ModelParameters | null;
  /** Name, provider, status and prices from the public catalog. */
  public: PublicModel | null;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  /** True when the list is key-scoped; false when only the public catalog could be read. */
  keyScoped: boolean;
  warnings: string[];
  fetchedAt: number;
}

const TTL_MS = 5 * 60 * 1000;

function categoryOf(gateway: GatewayModel | null, pub: PublicModel | null): string {
  const fromGateway = gateway?.parameters?.category ?? gateway?.category;
  if (fromGateway) return fromGateway;
  const caps = pub?.capabilities ?? [];
  if (caps.includes('video')) return 'video';
  if (caps.includes('image')) return 'image';
  return caps[0] ?? 'chat';
}

export class Catalog {
  private snapshot: CatalogSnapshot | null = null;
  private inflight: Promise<CatalogSnapshot> | null = null;

  constructor(
    private readonly client: ApikoClient,
    private readonly now: () => number = Date.now
  ) {}

  async load(force = false): Promise<CatalogSnapshot> {
    if (!force && this.snapshot && this.now() - this.snapshot.fetchedAt < TTL_MS) return this.snapshot;
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => {
        this.inflight = null;
      });
    }
    this.snapshot = await this.inflight;
    return this.snapshot;
  }

  private async fetch(): Promise<CatalogSnapshot> {
    const warnings: string[] = [];
    const [gatewayResult, publicResult] = await Promise.allSettled([
      this.client.hasKey ? this.client.listModels() : Promise.reject(new Error('APIKO_API_KEY is not set')),
      this.client.publicCatalog(),
    ]);
    const publicModels = publicResult.status === 'fulfilled' ? publicResult.value : [];
    if (publicResult.status === 'rejected') {
      warnings.push(`Public price catalog unavailable (${errorText(publicResult.reason)}); prices are missing, so no cost can be estimated.`);
    }
    const byId = new Map(publicModels.map((m) => [m.id, m]));

    if (gatewayResult.status === 'fulfilled') {
      const entries = gatewayResult.value.map((g) => {
        const pub = byId.get(g.id) ?? null;
        return { id: g.id, category: categoryOf(g, pub), gateway: g, parameters: g.parameters ?? null, public: pub };
      });
      return { entries, keyScoped: true, warnings, fetchedAt: this.now() };
    }
    // Key-scoped list failed. A bad key is an error the user must fix; other
    // failures fall back to the public list so prices can still be browsed.
    const reason = errorText(gatewayResult.reason);
    if (this.client.hasKey && /HTTP 40[13]/.test(reason)) throw gatewayResult.reason;
    if (publicResult.status === 'rejected') throw gatewayResult.reason;
    warnings.push(
      `Showing the public catalog only (${reason}). Request schemas and per-key availability need a working APIKO_API_KEY.`
    );
    const entries = publicModels.map((p) => ({ id: p.id, category: categoryOf(null, p), gateway: null, parameters: null, public: p }));
    return { entries, keyScoped: false, warnings, fetchedAt: this.now() };
  }

  async get(model: string): Promise<{ entry: CatalogEntry | null; snapshot: CatalogSnapshot }> {
    const snapshot = await this.load();
    const entry = snapshot.entries.find((e) => e.id === model) ?? null;
    return { entry, snapshot };
  }

  /** Closest ids, for "did you mean" hints. */
  suggest(snapshot: CatalogSnapshot, model: string, limit = 5): string[] {
    const needle = model.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const scored = snapshot.entries
      .map((e) => {
        const id = e.id.toLowerCase().replace(/[^a-z0-9]+/g, '');
        let score = 0;
        if (id.includes(needle) || needle.includes(id)) score += 10;
        for (const part of model.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)) if (e.id.toLowerCase().includes(part)) score += 2;
        return { id: e.id, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.id);
  }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
