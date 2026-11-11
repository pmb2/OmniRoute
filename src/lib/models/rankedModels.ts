/**
 * Ranked model catalog.
 *
 * Unions every model the active provider connections actually expose, enriches
 * it with canonical metadata (release date, context, capabilities), pricing, and
 * connection health, then computes a composite usefulness score:
 *
 *   recency (newer is better) + size (larger params / context) + cost (cheaper
 *   is better) + availability (healthy connection).
 *
 * The result is intentionally computed on read (with a short cache) so it stays
 * current as model sync and credential health checks update the database.
 */

import { getProviderConnections } from "@/lib/db/providers";
import { getAllActiveSyncedModels } from "@/lib/db/models/activeSyncedCatalog";
import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import { getModelsDevPricing } from "@/lib/modelsDevSync";
import { getPricingForModel } from "@/shared/constants/pricing";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

export interface RankedModelScores {
  recency: number;
  size: number;
  cost: number;
  availability: number;
  total: number;
}

export interface RankedModel {
  id: string;
  /** Provider-relative model id (what a combo step stores). */
  rawModel: string;
  provider: string;
  providerAlias: string;
  name: string;
  releaseDate: string | null;
  ageDays: number | null;
  parameterSizeB: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  pricing: { input: number; output: number; cached: number | null } | null;
  costPerMillion: number | null;
  isFree: boolean;
  capabilities: {
    toolCalling: boolean;
    reasoning: boolean;
    vision: boolean;
    thinking: boolean;
  };
  live: boolean;
  testStatus: string | null;
  activeConnections: number;
  scores: RankedModelScores;
}

export type RankedSort =
  "score" | "newest" | "oldest" | "largest" | "cheapest" | "context" | "name" | "provider";

const DEAD_STATUSES = new Set([
  "banned",
  "credits_exhausted",
  "deactivated",
  "expired",
  "invalid",
  "rate_limited",
]);

const SORT_VALUES: RankedSort[] = [
  "score",
  "newest",
  "oldest",
  "largest",
  "cheapest",
  "context",
  "name",
  "provider",
];

export function normalizeRankedSort(raw: unknown): RankedSort {
  return typeof raw === "string" && (SORT_VALUES as string[]).includes(raw)
    ? (raw as RankedSort)
    : "score";
}

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Best-effort parameter size ("27b", "120b", "3.8b", "35b-a3b"). */
export function extractParameterSizeB(...values: Array<string | null | undefined>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const matches = value.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g);
    for (const match of matches) {
      const size = Number(match[1]);
      if (Number.isFinite(size) && size > 0 && size <= 2000) {
        best = best === null ? size : Math.max(best, size);
      }
    }
  }
  return best;
}

function findPricing(
  provider: string,
  alias: string,
  modelId: string,
  isFree: boolean | undefined
): { input: number; output: number; cached: number | null } | null {
  if (isFree) return { input: 0, output: 0, cached: 0 };
  let pricing: Record<string, unknown> | null = null;
  try {
    const synced = getModelsDevPricing() as Record<string, Record<string, Record<string, unknown>>>;
    pricing = synced?.[provider]?.[modelId] ?? synced?.[alias]?.[modelId] ?? null;
  } catch {
    // pricing is optional
  }
  if (!pricing) {
    pricing = getPricingForModel(provider, modelId) ?? getPricingForModel(alias, modelId) ?? null;
  }
  if (!pricing) return null;
  const input = Number(pricing.input);
  const output = Number(pricing.output);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cached: Number.isFinite(Number(pricing.cached)) ? Number(pricing.cached) : null,
  };
}

interface ProviderHealth {
  activeConnections: number;
  statuses: string[];
  live: boolean;
  testStatus: string | null;
}

function buildProviderHealth(
  connections: Array<Record<string, unknown>>,
  now: number
): Map<string, ProviderHealth> {
  const map = new Map<string, ProviderHealth>();
  for (const conn of connections) {
    const provider = typeof conn.provider === "string" ? conn.provider : null;
    if (!provider) continue;
    const status = String(conn.testStatus ?? "unknown").toLowerCase();
    const rateLimitedUntil = parseDate(conn.rateLimitedUntil);
    const rateLimited = rateLimitedUntil ? rateLimitedUntil.getTime() > now : false;
    const dead = DEAD_STATUSES.has(status) || rateLimited;
    const existing = map.get(provider);
    if (!existing) {
      map.set(provider, {
        activeConnections: 1,
        statuses: [status],
        live: !dead,
        testStatus: status,
      });
      continue;
    }
    existing.activeConnections += 1;
    existing.statuses.push(status);
    existing.live = existing.live || !dead;
    if (!dead) existing.testStatus = status;
  }
  return map;
}

function scoreModel(input: {
  releaseDate: Date | null;
  parameterSizeB: number | null;
  contextLength: number | null;
  costPerMillion: number | null;
  live: boolean;
  now: number;
}): RankedModelScores {
  const ageDays = input.releaseDate
    ? Math.max(0, (input.now - input.releaseDate.getTime()) / 86_400_000)
    : null;
  const recency = ageDays === null ? 40 : clamp(100 * Math.exp(-ageDays / 365), 0, 100);

  let sizeValue: number;
  if (input.parameterSizeB !== null) {
    sizeValue = 100 * (Math.log10(1 + input.parameterSizeB) / Math.log10(1 + 700));
  } else if (input.contextLength !== null) {
    sizeValue = 100 * (Math.log10(1 + input.contextLength / 1000) / Math.log10(1 + 2000));
  } else {
    sizeValue = 40;
  }
  const size = clamp(sizeValue, 0, 100);

  let cost: number;
  if (input.costPerMillion === null) {
    cost = 50;
  } else if (input.costPerMillion <= 0) {
    cost = 100;
  } else {
    cost = clamp(100 * Math.exp(-input.costPerMillion / 25), 0, 100);
  }

  const availability = input.live ? 100 : 0;
  const total = clamp(0.35 * recency + 0.25 * size + 0.25 * cost + 0.15 * availability, 0, 100);
  return {
    recency: Math.round(recency * 10) / 10,
    size: Math.round(size * 10) / 10,
    cost: Math.round(cost * 10) / 10,
    availability,
    total: Math.round(total * 10) / 10,
  };
}

export interface RankedModelsQuery {
  provider?: string;
  q?: string;
  sort?: string;
  liveOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface RankedModelsResult {
  models: RankedModel[];
  total: number;
  generatedAt: string;
  providers: Array<{ id: string; alias: string; models: number; live: boolean }>;
}

let cache: { at: number; rows: RankedModel[]; providers: RankedModelsResult["providers"] } | null =
  null;
const CACHE_TTL_MS = 15_000;

export async function getRankedModels(query: RankedModelsQuery = {}): Promise<RankedModelsResult> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    cache = await buildRankedModels(now);
  }
  const sort = normalizeRankedSort(query.sort);
  const needle = (query.q ?? "").trim().toLowerCase();
  const providerFilter = (query.provider ?? "").trim().toLowerCase();

  let rows = cache.rows.slice();
  if (needle) {
    rows = rows.filter(
      (row) =>
        row.id.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        row.provider.toLowerCase().includes(needle) ||
        row.providerAlias.toLowerCase().includes(needle)
    );
  }
  if (providerFilter) {
    rows = rows.filter(
      (row) =>
        row.provider.toLowerCase() === providerFilter ||
        row.providerAlias.toLowerCase() === providerFilter
    );
  }
  if (query.liveOnly) rows = rows.filter((row) => row.live);

  rows.sort((a, b) => compareRanked(a, b, sort));

  const total = rows.length;
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 100)));
  return {
    models: rows.slice(offset, offset + limit),
    total,
    generatedAt: new Date(now).toISOString(),
    providers: cache.providers,
  };
}

function compareRanked(a: RankedModel, b: RankedModel, sort: RankedSort): number {
  switch (sort) {
    case "newest":
      return (
        (b.releaseDate ? Date.parse(b.releaseDate) : 0) -
        (a.releaseDate ? Date.parse(a.releaseDate) : 0)
      );
    case "oldest":
      return (
        (a.releaseDate ? Date.parse(a.releaseDate) : Number.MAX_SAFE_INTEGER) -
        (b.releaseDate ? Date.parse(b.releaseDate) : Number.MAX_SAFE_INTEGER)
      );
    case "largest":
      return (
        (b.parameterSizeB ?? 0) - (a.parameterSizeB ?? 0) ||
        (b.contextLength ?? 0) - (a.contextLength ?? 0)
      );
    case "cheapest":
      return (
        (a.costPerMillion ?? Number.MAX_SAFE_INTEGER) -
        (b.costPerMillion ?? Number.MAX_SAFE_INTEGER)
      );
    case "context":
      return (b.contextLength ?? 0) - (a.contextLength ?? 0);
    case "name":
      return a.name.localeCompare(b.name);
    case "provider":
      return a.providerAlias.localeCompare(b.providerAlias) || a.name.localeCompare(b.name);
    case "score":
    default:
      return b.scores.total - a.scores.total || a.name.localeCompare(b.name);
  }
}

async function buildRankedModels(
  now: number
): Promise<{ at: number; rows: RankedModel[]; providers: RankedModelsResult["providers"] }> {
  const [synced, connections] = await Promise.all([
    getAllActiveSyncedModels(),
    getProviderConnections({ isActive: true }),
  ]);
  const health = buildProviderHealth(connections as Array<Record<string, unknown>>, now);
  const rows: RankedModel[] = [];
  const seen = new Set<string>();
  const providerCounts = new Map<string, { alias: string; count: number; live: boolean }>();

  for (const [provider, models] of Object.entries(synced)) {
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
    const providerHealth = health.get(provider);
    const providerLive = providerHealth?.live ?? false;
    const providerEntry = providerCounts.get(provider) ?? {
      alias,
      count: 0,
      live: providerLive,
    };

    for (const model of models) {
      if (!model?.id) continue;
      if (model.modelType && model.modelType !== "chat") continue;
      const id = `${alias}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      providerEntry.count += 1;

      const metadata = (() => {
        try {
          return getCanonicalModelMetadata({ provider, model: model.id });
        } catch {
          return null;
        }
      })();
      const releaseDate =
        parseDate(metadata?.metadata?.releaseDate) ??
        parseDate((model as { created?: unknown }).created) ??
        null;
      const parameterSizeB = extractParameterSizeB(model.id, model.name, metadata?.displayName);
      const contextLength =
        metadata?.limits?.contextWindow ?? model.contextWindow ?? model.inputTokenLimit ?? null;
      const maxOutputTokens = metadata?.limits?.maxOutputTokens ?? model.outputTokenLimit ?? null;
      const pricing = findPricing(provider, alias, model.id, model.isFree);
      const costPerMillion = pricing ? pricing.input + pricing.output : null;
      const live = providerLive || (providerHealth?.live ?? false);
      const scores = scoreModel({
        releaseDate,
        parameterSizeB,
        contextLength,
        costPerMillion,
        live,
        now,
      });
      const ageDays = releaseDate
        ? Math.max(0, Math.round((now - releaseDate.getTime()) / 86_400_000))
        : null;

      rows.push({
        id,
        rawModel: model.id,
        provider,
        providerAlias: alias,
        name: model.name || model.id,
        releaseDate: releaseDate ? releaseDate.toISOString() : null,
        ageDays,
        parameterSizeB,
        contextLength,
        maxOutputTokens,
        pricing,
        costPerMillion,
        isFree: Boolean(model.isFree) || costPerMillion === 0,
        capabilities: {
          toolCalling: metadata?.capabilities?.toolCalling ?? model.supportsTools === true,
          reasoning: metadata?.capabilities?.reasoning ?? false,
          vision: metadata?.capabilities?.vision ?? model.supportsVision === true,
          thinking: metadata?.capabilities?.supportsThinking ?? model.supportsThinking === true,
        },
        live,
        testStatus: providerHealth?.testStatus ?? null,
        activeConnections: providerHealth?.activeConnections ?? 0,
        scores,
      });
    }
    providerCounts.set(provider, providerEntry);
  }

  const providers = Array.from(providerCounts.entries())
    .map(([id, entry]) => ({ id, alias: entry.alias, models: entry.count, live: entry.live }))
    .sort((a, b) => b.models - a.models || a.alias.localeCompare(b.alias));

  return { at: now, rows, providers };
}

/** Test-only cache reset. */
export function resetRankedModelsCache(): void {
  cache = null;
}
