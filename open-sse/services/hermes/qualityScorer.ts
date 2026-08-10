/**
 * Hermes Response Quality Scorer
 *
 * Lightweight quality tracking per provider/model/agent.
 * Scores each response on finish_reason, token efficiency, and error rate.
 * Feeds back into routing decisions by promoting providers with better quality.
 *
 * Usage:
 *   import { scoreResponse, getQualityRankings } from "../hermes/qualityScorer";
 *   const score = scoreResponse({ provider, model, finishReason, ... });
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface QualityScoreInput {
  provider: string;
  model: string;
  agentSlug?: string;
  finishReason: string; // "stop", "length", "content_filter", "tool_calls", etc.
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  isError: boolean;
  errorCode?: number;
}

export interface QualityScore {
  score: number; // 0-100
  components: {
    finishQuality: number; // 0-40 — "stop" = 40, "length" = 20, error = 0
    tokenEfficiency: number; // 0-30 — higher completion/prompt ratio = better
    latencyScore: number; // 0-20 — faster = better
    errorPenalty: number; // -50 — penalty for errors
  };
}

export interface ProviderQuality {
  provider: string;
  model: string;
  avgScore: number;
  totalRequests: number;
  errorRate: number;
  avgLatencyMs: number;
}

// ── Scoring ────────────────────────────────────────────────────────────────

const FINISH_QUALITY: Record<string, number> = {
  stop: 40,
  tool_calls: 35,
  function_call: 35,
  content_filter: 10,
  length: 20,
  null: 15,
};

function getFinishQuality(finishReason: string): number {
  return FINISH_QUALITY[finishReason] ?? 10;
}

function getTokenEfficiency(promptTokens: number, completionTokens: number): number {
  if (promptTokens <= 0) return 15; // unknown, neutral
  const ratio = completionTokens / promptTokens;
  // Optimal: 0.5-2.0 ratio (healthy output relative to prompt)
  if (ratio >= 0.5 && ratio <= 2.0) return 30;
  if (ratio >= 0.2 && ratio <= 5.0) return 20;
  return 10;
}

function getLatencyScore(latencyMs: number): number {
  if (latencyMs <= 500) return 20;
  if (latencyMs <= 1500) return 15;
  if (latencyMs <= 5000) return 10;
  return 5;
}

export function scoreResponse(input: QualityScoreInput): QualityScore {
  const finishQuality = getFinishQuality(input.finishReason);
  const tokenEfficiency = getTokenEfficiency(input.promptTokens, input.completionTokens);
  const latencyScore = getLatencyScore(input.latencyMs);
  const errorPenalty = input.isError ? -50 : 0;

  const rawScore = finishQuality + tokenEfficiency + latencyScore + errorPenalty;
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    score,
    components: {
      finishQuality,
      tokenEfficiency,
      latencyScore,
      errorPenalty,
    },
  };
}

// ── Rolling Averages ───────────────────────────────────────────────────────

interface RollingEntry {
  provider: string;
  model: string;
  totalScore: number;
  totalRequests: number;
  totalErrors: number;
  totalLatencyMs: number;
  lastUpdated: number;
}

const rollingAverages = new Map<string, RollingEntry>();
const MAX_ENTRIES = 500;

function entryKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function recordQualityScore(input: QualityScoreInput): QualityScore {
  const score = scoreResponse(input);
  const key = entryKey(input.provider, input.model);

  let entry = rollingAverages.get(key);
  if (!entry) {
    if (rollingAverages.size >= MAX_ENTRIES) {
      // Evict oldest entry
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, e] of rollingAverages) {
        if (e.lastUpdated < oldestTime) {
          oldestTime = e.lastUpdated;
          oldestKey = k;
        }
      }
      if (oldestKey) rollingAverages.delete(oldestKey);
    }
    entry = {
      provider: input.provider,
      model: input.model,
      totalScore: 0,
      totalRequests: 0,
      totalErrors: 0,
      totalLatencyMs: 0,
      lastUpdated: 0,
    };
    rollingAverages.set(key, entry);
  }

  entry.totalScore += score.score;
  entry.totalRequests++;
  if (input.isError) entry.totalErrors++;
  entry.totalLatencyMs += input.latencyMs;
  entry.lastUpdated = Date.now();

  return score;
}

// ── Rankings ───────────────────────────────────────────────────────────────

export function getQualityRankings(): ProviderQuality[] {
  const rankings: ProviderQuality[] = [];

  for (const [, entry] of rollingAverages) {
    rankings.push({
      provider: entry.provider,
      model: entry.model,
      avgScore:
        entry.totalRequests > 0
          ? Math.round((entry.totalScore / entry.totalRequests) * 10) / 10
          : 0,
      totalRequests: entry.totalRequests,
      errorRate:
        entry.totalRequests > 0
          ? Math.round((entry.totalErrors / entry.totalRequests) * 1000) / 10
          : 0,
      avgLatencyMs:
        entry.totalRequests > 0 ? Math.round(entry.totalLatencyMs / entry.totalRequests) : 0,
    });
  }

  return rankings.sort((a, b) => b.avgScore - a.avgScore);
}

export function getQualityForModel(provider: string, model: string): ProviderQuality | null {
  const entry = rollingAverages.get(entryKey(provider, model));
  if (!entry) return null;

  return {
    provider: entry.provider,
    model: entry.model,
    avgScore:
      entry.totalRequests > 0 ? Math.round((entry.totalScore / entry.totalRequests) * 10) / 10 : 0,
    totalRequests: entry.totalRequests,
    errorRate:
      entry.totalRequests > 0
        ? Math.round((entry.totalErrors / entry.totalRequests) * 1000) / 10
        : 0,
    avgLatencyMs:
      entry.totalRequests > 0 ? Math.round(entry.totalLatencyMs / entry.totalRequests) : 0,
  };
}

/** Reset all quality data */
export function resetQualityData(): void {
  rollingAverages.clear();
}
