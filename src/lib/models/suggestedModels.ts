/**
 * Suggested model ranking.
 *
 * Pure scoring used by `/api/models/suggested` and covered directly by unit
 * tests: a model has to be live first, then recent use (what the operator has
 * actually been running) beats an unused model with a higher catalogue score.
 * Exhausted providers are removed by the caller, and the local emergency
 * fallback is excluded here so it only shows up when it is the last resort.
 */

export interface SuggestedModelCandidate {
  /** Full id (`provider/rawModel`) — also the value a picker stores. */
  id: string;
  provider: string;
  providerAlias?: string;
  rawModel: string;
  name: string;
  isFree: boolean;
  live: boolean;
  contextLength?: number | null;
  /** Composite catalogue score (0-100) from the ranked-model builder. */
  totalScore: number;
}

export interface RecentModelUsage {
  provider: string;
  model: string;
  requests: number;
  successes: number;
  lastUsedAt: string | null;
}

export interface RankSuggestedOptions {
  limit?: number;
  now?: number;
  /** Providers to keep out of the suggestions (e.g. the local emergency fallback). */
  excludeProviders?: Iterable<string>;
  /** A use older than this no longer counts as "recent". */
  windowDays?: number;
}

export interface SuggestedModel extends SuggestedModelCandidate {
  /** 0-100 blend of catalogue score and real usage. */
  score: number;
  reason: "recent" | "available";
  usage: {
    requests: number;
    successes: number;
    successRatePct: number;
    lastUsedAt: string | null;
  } | null;
}

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Lowercase, drop a provider prefix and normalise separators for matching. */
export function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^[a-z0-9._-]+\//, "");
}

function usageKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}\0${normalizeModelKey(model)}`;
}

/**
 * Older usage rows store a display model (`qwen3.5-abliterated:27b`) while the
 * catalogue knows the upstream id (`huihui_ai/qwen3.5-abliterated:27b`). Try
 * the exact key, then the normalised id, then a suffix match either way.
 */
function findUsage(
  index: Map<string, RecentModelUsage>,
  candidate: SuggestedModelCandidate
): RecentModelUsage | undefined {
  const provider = candidate.provider.trim().toLowerCase();
  const exact = index.get(`${provider}\0${normalizeModelKey(candidate.rawModel)}`);
  if (exact) return exact;
  const target = normalizeModelKey(candidate.rawModel);
  if (!target) return undefined;
  for (const [key, usage] of index) {
    if (!key.startsWith(`${provider}\0`)) continue;
    const known = key.slice(provider.length + 1);
    if (known.endsWith(target) || target.endsWith(known)) return usage;
  }
  return undefined;
}

function usageScore(
  usage: RecentModelUsage | undefined,
  now: number,
  windowDays: number,
  maxRequests: number
): { score: number; successRate: number; recent: boolean } {
  if (!usage || usage.requests <= 0) {
    return { score: 0, successRate: 0, recent: false };
  }
  const lastUsed = usage.lastUsedAt ? Date.parse(usage.lastUsedAt) : NaN;
  const ageDays = Number.isFinite(lastUsed) ? Math.max(0, (now - lastUsed) / DAY_MS) : Infinity;
  const recent = ageDays <= windowDays;
  const successRate = usage.requests > 0 ? usage.successes / usage.requests : 0;
  if (!recent) {
    // Outside the window the row is history, not a reason to suggest the model.
    return { score: 0, successRate, recent: false };
  }
  // Linear decay: a use today scores 1, one at the window edge scores 0.
  const recency = 1 - ageDays / windowDays;
  const frequency = Math.log1p(usage.requests) / Math.log1p(Math.max(1, maxRequests));
  return {
    // Usage dominates the ranking; recency matters more than raw volume.
    score: 100 * (0.55 * recency + 0.3 * frequency + 0.15 * successRate),
    successRate,
    recent,
  };
}

/**
 * Rank live, non-exhausted models for the picker's "Suggested" section.
 * Catalogue quality contributes half the score, real recent usage the other
 * half — so the three shown are both healthy and familiar.
 */
export function rankSuggestedModels(
  candidates: readonly SuggestedModelCandidate[],
  recentUsage: readonly RecentModelUsage[],
  options: RankSuggestedOptions = {}
): SuggestedModel[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, options.limit ?? 3);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const excluded = new Set(
    [...(options.excludeProviders ?? [])].map((provider) => provider.trim().toLowerCase())
  );

  const index = new Map<string, RecentModelUsage>();
  for (const usage of recentUsage) {
    const key = usageKey(usage.provider, usage.model);
    const current = index.get(key);
    if (!current) {
      index.set(key, usage);
      continue;
    }
    index.set(key, {
      ...usage,
      requests: current.requests + usage.requests,
      successes: current.successes + usage.successes,
      lastUsedAt:
        current.lastUsedAt && usage.lastUsedAt
          ? Date.parse(current.lastUsedAt) >= Date.parse(usage.lastUsedAt)
            ? current.lastUsedAt
            : usage.lastUsedAt
          : (current.lastUsedAt ?? usage.lastUsedAt),
    });
  }

  const maxRequests = Math.max(
    1,
    ...[...index.values()].filter((usage) => usage.provider).map((usage) => usage.requests)
  );

  const seen = new Set<string>();
  const scored: SuggestedModel[] = [];
  for (const candidate of candidates) {
    if (!candidate.live) continue;
    if (excluded.has(candidate.provider.trim().toLowerCase())) continue;
    const dedupeKey = `${candidate.provider.toLowerCase()}\0${normalizeModelKey(candidate.rawModel)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const usage = findUsage(index, candidate);
    const usageResult = usageScore(usage, now, windowDays, maxRequests);
    const base = clamp100(candidate.totalScore);
    scored.push({
      ...candidate,
      score: Math.round((0.5 * base + 0.5 * usageResult.score) * 10) / 10,
      reason: usageResult.recent ? "recent" : "available",
      usage: usage
        ? {
            requests: usage.requests,
            successes: usage.successes,
            successRatePct: Math.round(usageResult.successRate * 1000) / 10,
            lastUsedAt: usage.lastUsedAt,
          }
        : null,
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      clamp100(right.totalScore) - clamp100(left.totalScore) ||
      left.name.localeCompare(right.name)
  );
  return scored.slice(0, limit);
}
