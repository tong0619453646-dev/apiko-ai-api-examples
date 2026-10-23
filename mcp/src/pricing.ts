// List-price estimates from the public catalog. Money logic, so the rule is:
// return a number only when the price tier follows unambiguously from the
// input; otherwise say what is missing (`needs_input`) or that no reliable
// number exists (`token_billed` / `unknown`), always with the raw pricing basis.
//
// Billing rules encoded here, with their sources (apiko-web, 2026-10-23):
// - Per-call image tiers are chosen by `resolution` (default from the model's
//   input_schema). gpt-image-2 explicit `WxH` sizes are billed at the tier of
//   their row in the documented size table (docs/data/apiko-media-api.ts
//   gptImage2ResolutionBlocks); any other WxH is rejected before any charge.
// - gpt-image-2.5 Flare / Sunburst are billed by tokens (catalog `tokenImage`);
//   the per-tier `perCall` there is the medium-quality sample, so it is only
//   an indication (src/lib/image-token-pricing.ts).
// - Video: per second of output at the chosen resolution's rate. Reference
//   videos follow the rule written in the schema description of
//   `reference_videos`:
//     "billed as input, at least as long as the output" (Seedance) ->
//        (duration + max(reference seconds, duration)) x videoInputPerSecond
//     "billed with the output" (Wan 3.0, Kling 4.0) ->
//        (duration + reference seconds) x perSecond
//   and the submit-time hold from "Submission holds ..." (blocks/mp-video-contract.ts
//   videoReferenceHoldSeconds). Reference images and audio are not billed.

import type { PublicPricing, PerSecondTier, JsonSchemaProperty } from './client.js';
import type { CatalogEntry } from './catalog.js';

export type EstimateStatus = 'estimated' | 'needs_input' | 'token_billed' | 'unknown';

export interface CostEstimate {
  model: string;
  status: EstimateStatus;
  /** Expected list-price charge in USD; null unless status is `estimated`. */
  estimated_usd: number | null;
  /** Bounds when the exact charge depends on something not supplied. */
  range_usd?: { min: number; max: number };
  /** Amount reserved from the balance when the task is accepted (settled and refunded down later). */
  hold_usd?: number;
  /** Highest charge this input can lead to, when known; used to check a max_cost_usd cap. */
  upper_bound_usd?: number;
  /** Indicative figure for token-billed models; not a quote. */
  indicative_usd?: number;
  basis: string[];
  missing?: string[];
  problems?: string[];
  notes: string[];
  pricing: PublicPricing | null;
  price_label: string;
}

export const PRICE_LABEL =
  'List price in USD from the public APIKO catalog (apiko.app/models). The gateway\'s charge at settlement is final; failed tasks are refunded.';

export interface EstimateOptions {
  /** Total length in seconds of all reference videos (only used for estimating). */
  referenceVideoSeconds?: number;
}

/** gpt-image-2 explicit pixel sizes per tier (landscape rows; portrait swaps for 16:9, 3:2, 4:3, 5:4). */
const GPT_IMAGE_2_TABLE: Record<string, string[]> = {
  '1k': ['1024x1024', '1360x768', '1248x832', '1184x880', '1136x912', '1536x656'],
  '2k': ['2048x2048', '2720x1536', '2496x1680', '2352x1776', '2288x1824', '3120x1344'],
  '4k': ['2880x2880', '3840x2160', '3520x2352', '3312x2496', '3216x2576', '3840x1648'],
};
const PIXEL_TABLES: Record<string, Map<string, string>> = {
  'gpt-image-2': (() => {
    const map = new Map<string, string>();
    for (const [tier, sizes] of Object.entries(GPT_IMAGE_2_TABLE)) {
      sizes.forEach((size, row) => {
        map.set(size, tier);
        // Rows 1–4 (16:9, 3:2, 4:3, 5:4) have portrait counterparts; 1:1 and 21:9 do not.
        if (row >= 1 && row <= 4) {
          const [w, h] = size.split('x');
          map.set(`${h}x${w}`, tier);
        }
      });
    }
    return map;
  })(),
};

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function usd(x: number): string {
  if (x === 0) return '$0';
  if (x >= 1) return `$${x.toFixed(2)}`;
  return `$${Number(x.toPrecision(4))}`;
}

function base(entry: CatalogEntry): CostEstimate {
  return {
    model: entry.id,
    status: 'unknown',
    estimated_usd: null,
    basis: [],
    notes: [],
    pricing: entry.public?.pricing ?? null,
    price_label: PRICE_LABEL,
  };
}

function prop(entry: CatalogEntry, name: string): JsonSchemaProperty | undefined {
  return entry.parameters?.input_schema?.properties?.[name];
}

/** The value the request will use: the input's, else the schema default. */
function effective(entry: CatalogEntry, input: Record<string, unknown>, name: string): unknown {
  if (input[name] !== undefined && input[name] !== null) return input[name];
  return prop(entry, name)?.default;
}

export function estimateCost(entry: CatalogEntry, input: Record<string, unknown>, options: EstimateOptions = {}): CostEstimate {
  const out = base(entry);
  const pricing = entry.public?.pricing;
  if (!pricing) {
    out.notes.push('No public price for this model; do not assume it is free. Check https://apiko.app/models before spending.');
    return out;
  }
  if (pricing.currency && pricing.currency !== 'USD') out.notes.push(`Catalog currency is ${pricing.currency}.`);

  if (entry.category === 'video' || (pricing.perSecondTiers?.length ?? 0) > 0) return estimateVideo(entry, input, pricing, options, out);
  if (entry.category === 'image' || pricing.perCall != null || (pricing.tiers?.length ?? 0) > 0) return estimateImage(entry, input, pricing, out);
  return estimateTokens(pricing, out);
}

// ── images ──────────────────────────────────────────────────────────────────

function imageCount(entry: CatalogEntry, input: Record<string, unknown>, out: CostEstimate): number | null {
  const n = effective(entry, input, 'n') ?? 1;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    out.problems = [...(out.problems ?? []), '"n" must be a positive integer'];
    return null;
  }
  return n;
}

/** The price tier this input is billed at, or why it cannot be told. */
function imageTier(
  entry: CatalogEntry,
  input: Record<string, unknown>
): { tier: string; via: string } | { missing: string } | { problem: string } {
  const size = input.size;
  if (typeof size === 'string' && /^\d+x\d+$/i.test(size)) {
    const table = PIXEL_TABLES[entry.id];
    const tier = table?.get(size.toLowerCase());
    if (tier) return { tier, via: `size ${size} is in the ${tier} row of the size table` };
    if (table) return { problem: `size ${size} is not one of the documented table sizes; the gateway rejects it before any charge` };
    return { missing: 'explicit WIDTHxHEIGHT sizes are billed at their own tier, which this tool cannot map for this model; use an aspect ratio plus "resolution"' };
  }
  const resolution = effective(entry, input, 'resolution');
  if (typeof resolution === 'string' && resolution) {
    const via = input.resolution !== undefined ? 'resolution' : 'default resolution';
    return { tier: resolution.toLowerCase(), via: `${via} ${resolution.toLowerCase()}` };
  }
  return { missing: '"resolution" (no default in the model schema)' };
}

function estimateImage(entry: CatalogEntry, input: Record<string, unknown>, pricing: PublicPricing, out: CostEstimate): CostEstimate {
  const n = imageCount(entry, input, out);
  if (n === null) return out;
  const tiers = pricing.tiers ?? [];

  if (pricing.tokenImage) {
    out.status = 'token_billed';
    const t = pricing.tokenImage;
    out.basis.push(
      `Billed by tokens: text input ${usd(t.textInputPer1M)}/1M, image input ${usd(t.imageInputPer1M)}/1M (reference images), image output ${usd(t.outputPer1M)}/1M.`
    );
    const tier = imageTier(entry, input);
    const quality = String(effective(entry, input, 'quality') ?? 'auto').toLowerCase();
    if ('tier' in tier) {
      const hit = tiers.find((x) => x.name.toLowerCase() === tier.tier);
      const multiplier = qualityMultiplier(prop(entry, 'quality')?.description, quality);
      if (hit && multiplier !== null) {
        const refs = Array.isArray(input.images) ? input.images.length : 0;
        const refUsd = refs * 1100 * (t.imageInputPer1M / 1e6);
        out.indicative_usd = round6((hit.perCall * multiplier + refUsd) * n);
        out.basis.push(
          `Indication only: the catalog's ${tier.tier} medium-quality sample ${usd(hit.perCall)}` +
            (multiplier !== 1 ? ` x ${multiplier} for quality ${quality}` : '') +
            (refs ? ` + ${refs} reference image(s) x ~1,100 image tokens (${usd(refUsd)})` : '') +
            (n > 1 ? ` x ${n}` : '') +
            ` ≈ ${usd(out.indicative_usd)}.`
        );
      }
      if (quality === 'auto') out.notes.push('quality auto (or omitted) lets the model choose; the submit-time hold assumes medium, the charge follows the tokens used.');
    }
    out.notes.push('The real charge is computed from the usage tokens of the finished task; long prompts, references and higher quality cost more.');
    return out;
  }

  if (tiers.length > 0) {
    const tier = imageTier(entry, input);
    if ('problem' in tier) {
      out.problems = [...(out.problems ?? []), tier.problem];
      return out;
    }
    if ('missing' in tier) {
      out.status = 'needs_input';
      out.missing = [tier.missing];
      out.basis.push(`Per-image tiers: ${tiers.map((x) => `${x.name} ${usd(x.perCall)}`).join(', ')}.`);
      return out;
    }
    const hit = tiers.find((x) => x.name.toLowerCase() === tier.tier);
    if (!hit) {
      out.notes.push(`Tier "${tier.tier}" has no published price (published: ${tiers.map((x) => x.name).join(', ')}).`);
      return out;
    }
    out.status = 'estimated';
    out.estimated_usd = round6(hit.perCall * n);
    out.upper_bound_usd = out.estimated_usd;
    out.basis.push(`${tier.via}: ${usd(hit.perCall)} per image${n > 1 ? ` x ${n}` : ''} = ${usd(out.estimated_usd)}.`);
    out.notes.push('Per-image price; reference images and size (aspect ratio) do not change it.');
    return out;
  }

  if (pricing.perCall != null) {
    out.status = 'estimated';
    out.estimated_usd = round6(pricing.perCall * n);
    out.upper_bound_usd = out.estimated_usd;
    out.basis.push(`Flat ${usd(pricing.perCall)} per image${n > 1 ? ` x ${n}` : ''} = ${usd(out.estimated_usd)}.`);
    return out;
  }
  out.notes.push('No per-image price in the catalog for this model.');
  return out;
}

/** "about 0.45x / 4x / 7x / 16x medium for low / high / xhigh / max" -> multiplier for a quality. */
export function qualityMultiplier(description: string | undefined, quality: string): number | null {
  if (quality === 'medium' || quality === 'auto') return 1;
  const match = /about\s+([\d.x\s/]+)\s+medium\s+for\s+([a-z\s/]+)/i.exec(description ?? '');
  if (!match) return null;
  const factors = match[1]!.split('/').map((s) => parseFloat(s.replace(/x/i, '').trim()));
  const names = match[2]!.split('/').map((s) => s.trim().toLowerCase());
  const index = names.indexOf(quality);
  if (index === -1 || !Number.isFinite(factors[index])) return null;
  return factors[index]!;
}

// ── video ───────────────────────────────────────────────────────────────────

interface ReferenceRule {
  kind: 'separate_rate' | 'same_rate';
  totalCap: number | null;
  minEach: number | null;
  /** "holds 15 s per distinct video" */
  holdPerVideo: number | null;
  /** "holds 30 s" / "holds the 30 s maximum" */
  holdFlat: number | null;
}

export function referenceRule(description: string | undefined): ReferenceRule | null {
  const d = description ?? '';
  let kind: ReferenceRule['kind'] | null = null;
  if (/billed as input/i.test(d)) kind = 'separate_rate';
  else if (/billed with the output/i.test(d)) kind = 'same_rate';
  if (!kind) return null;
  const total = /(\d+)\s*s in total/i.exec(d);
  const each = /(\d+)\s*-\s*\d+\s*s each/i.exec(d);
  const perVideo = /holds\s+(\d+)\s*s per distinct video/i.exec(d);
  const flat = perVideo ? null : /holds\s+(?:the\s+)?(\d+)\s*s/i.exec(d);
  return {
    kind,
    totalCap: total ? Number(total[1]) : null,
    minEach: each ? Number(each[1]) : null,
    holdPerVideo: perVideo ? Number(perVideo[1]) : null,
    holdFlat: flat ? Number(flat[1]) : null,
  };
}

function estimateVideo(
  entry: CatalogEntry,
  input: Record<string, unknown>,
  pricing: PublicPricing,
  options: EstimateOptions,
  out: CostEstimate
): CostEstimate {
  const tiers = pricing.perSecondTiers ?? [];
  if (tiers.length === 0) {
    out.notes.push('No per-second price in the catalog for this model.');
    return out;
  }
  out.basis.push(`Per-second rates: ${tiers.map(describeTier).join('; ')}.`);
  const missing: string[] = [];
  const resolution = effective(entry, input, 'resolution');
  const duration = effective(entry, input, 'duration');
  if (typeof resolution !== 'string' || !resolution) missing.push('"resolution" (no default in the model schema)');
  if (typeof duration !== 'number') missing.push('"duration" in seconds (no default in the model schema)');
  if (missing.length) {
    out.status = 'needs_input';
    out.missing = missing;
    return out;
  }
  const res = (resolution as string).toLowerCase();
  const secs = duration as number;
  if (!Number.isInteger(secs) || secs <= 0) {
    out.problems = ['"duration" must be a positive whole number of seconds'];
    return out;
  }
  const tier = tiers.find((t) => t.name.toLowerCase() === res);
  if (!tier) {
    out.notes.push(`Resolution "${res}" has no published price (published: ${tiers.map((t) => t.name).join(', ')}).`);
    return out;
  }
  const resVia = input.resolution !== undefined ? res : `${res} (default)`;
  const durVia = input.duration !== undefined ? `${secs} s` : `${secs} s (default)`;

  const refs = Array.isArray(input.reference_videos) ? (input.reference_videos as unknown[]).filter((v) => typeof v === 'string' && v) : [];
  if (refs.length === 0) {
    out.status = 'estimated';
    out.estimated_usd = round6(secs * tier.perSecond);
    out.upper_bound_usd = out.estimated_usd;
    out.hold_usd = out.estimated_usd;
    out.basis.push(`${resVia}: ${durVia} x ${usd(tier.perSecond)}/s = ${usd(out.estimated_usd)}.`);
    if (options.referenceVideoSeconds !== undefined) out.notes.push('reference_video_seconds ignored: no reference_videos in the input.');
    out.notes.push('Reference images and reference audio are not billed separately.');
    return out;
  }

  const rule = referenceRule(prop(entry, 'reference_videos')?.description);
  if (!rule) {
    out.notes.push('The schema does not state how reference videos are billed, so no estimate is given.');
    return out;
  }
  const distinct = new Set(refs as string[]).size;
  const refSeconds = options.referenceVideoSeconds;
  if (refSeconds !== undefined && (!(refSeconds > 0) || (rule.totalCap !== null && refSeconds > rule.totalCap))) {
    out.problems = [`reference_video_seconds must be > 0${rule.totalCap !== null ? ` and at most ${rule.totalCap} (the model's total)` : ''}`];
    return out;
  }

  let rate: number;
  let billed: (ref: number) => number;
  let holdSeconds: number | null;
  if (rule.kind === 'separate_rate') {
    if (tier.videoInputPerSecond == null) {
      out.notes.push(`No reference-video rate is published for ${res}; no estimate.`);
      return out;
    }
    rate = tier.videoInputPerSecond;
    billed = (ref) => secs + Math.max(ref, secs);
    const cap = rule.totalCap ?? prop(entry, 'duration')?.maximum ?? null;
    holdSeconds = cap !== null ? secs + Math.max(secs, cap) : null;
    out.basis.push(
      `With reference videos every billed second uses the reference-video rate ${usd(rate)}/s; billed seconds = output + reference length, the reference counted as at least the output.`
    );
  } else {
    rate = tier.perSecond;
    billed = (ref) => secs + ref;
    holdSeconds = rule.holdPerVideo !== null ? secs + rule.holdPerVideo * distinct : rule.holdFlat !== null ? secs + rule.holdFlat : null;
    out.basis.push(`Reference video length is added to the billed seconds at the same ${usd(rate)}/s.`);
  }
  if (holdSeconds !== null) {
    out.hold_usd = round6(holdSeconds * rate);
    out.upper_bound_usd = out.hold_usd;
    out.notes.push(
      `On submission ${holdSeconds} s (${usd(out.hold_usd)}) is held from the balance and the difference refunded when the task settles.`
    );
  }
  if (refSeconds === undefined) {
    out.status = 'needs_input';
    out.missing = ['reference_video_seconds: the total length of all reference videos (the charge depends on it)'];
    const minRef = rule.minEach !== null ? rule.minEach * distinct : 0;
    const maxRef = rule.totalCap ?? null;
    if (maxRef !== null) {
      out.range_usd = { min: round6(billed(minRef) * rate), max: round6(billed(maxRef) * rate) };
      out.basis.push(`Range over ${minRef}–${maxRef} s of reference video: ${usd(out.range_usd.min)} – ${usd(out.range_usd.max)}.`);
    }
    return out;
  }
  const total = billed(refSeconds);
  out.status = 'estimated';
  out.estimated_usd = round6(total * rate);
  out.basis.push(`${resVia}, ${durVia} output + ${refSeconds} s reference: ${total} billed s x ${usd(rate)}/s = ${usd(out.estimated_usd)}.`);
  out.notes.push('Settlement uses the reference length the model reports; reference images and audio are not billed separately.');
  return out;
}

function describeTier(t: PerSecondTier): string {
  return t.videoInputPerSecond != null
    ? `${t.name} ${usd(t.perSecond)}/s (with reference video ${usd(t.videoInputPerSecond)}/s for input+output seconds)`
    : `${t.name} ${usd(t.perSecond)}/s`;
}

// ── text ────────────────────────────────────────────────────────────────────

function estimateTokens(pricing: PublicPricing, out: CostEstimate): CostEstimate {
  if (pricing.inputPer1M == null && pricing.outputPer1M == null) {
    out.notes.push('No token price in the catalog for this model.');
    return out;
  }
  out.status = 'token_billed';
  out.basis.push(
    `Per 1M tokens: input ${usd(pricing.inputPer1M ?? 0)}, output ${usd(pricing.outputPer1M ?? 0)}` +
      (pricing.cachePer1M != null ? `, cached input ${usd(pricing.cachePer1M)}` : '') +
      '.'
  );
  for (const tier of pricing.contextTiers ?? []) {
    out.basis.push(
      `${tier.upTo === null ? 'Above the previous tier' : `Prompts up to ${tier.upTo.toLocaleString('en-US')} tokens`}: input ${usd(tier.inputPer1M)}, output ${usd(tier.outputPer1M)} per 1M.`
    );
  }
  out.notes.push('Text models are called with the OpenAI/Anthropic APIs directly, not through this MCP server; the charge follows real token usage.');
  return out;
}

/** One-line price summary for search results. */
export function priceSummary(pricing: PublicPricing | null | undefined): string | null {
  if (!pricing) return null;
  if (pricing.perSecondTiers?.length) return pricing.perSecondTiers.map(describeTier).join(', ');
  if (pricing.tokenImage) {
    const tiers = pricing.tiers ?? [];
    return `token-billed image; medium-quality sample ${tiers.map((t) => `${t.name} ~${usd(t.perCall)}`).join(', ')}`;
  }
  if (pricing.tiers?.length) return `${pricing.tiers.map((t) => `${t.name} ${usd(t.perCall)}`).join(', ')} per image`;
  if (pricing.perCall != null) return `${usd(pricing.perCall)} per image`;
  if (pricing.inputPer1M != null || pricing.outputPer1M != null) {
    return `${usd(pricing.inputPer1M ?? 0)} in / ${usd(pricing.outputPer1M ?? 0)} out per 1M tokens${pricing.contextTiers?.length ? ' (long-context tier higher)' : ''}`;
  }
  return null;
}
