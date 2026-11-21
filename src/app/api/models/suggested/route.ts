import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import { getProviderConnections } from "@/lib/db/providers";
import { buildUnifiedSource, getModelUsageRows } from "@/lib/db/usageAnalytics";
import { getRankedModels } from "@/lib/models/rankedModels";
import {
  rankSuggestedModels,
  type RecentModelUsage,
  type SuggestedModelCandidate,
} from "@/lib/models/suggestedModels";
import { LOCAL_PROVIDERS } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/** Provider statuses that mean "nothing on this connection can serve right now". */
const EXHAUSTED_STATUSES = new Set([
  "banned",
  "credits_exhausted",
  "deactivated",
  "expired",
  "invalid",
  "rate_limited",
]);

/** Credit/access failures that leave a connection unusable until the operator tops up. */
const EXHAUSTED_ERROR_CODES = new Set(["401", "402", "403"]);

const DEFAULT_WINDOW_DAYS = 14;
const MAX_LIMIT = 10;

function errorCodeOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  // Upstream codes arrive as "402.0" / "402" — keep the class, not the decimal.
  return text.split(".")[0];
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ProviderHealth {
  total: number;
  usable: number;
  reason: string | null;
}

/**
 * A provider is exhausted only when it has an active connection and none of
 * them can serve: one healthy sibling keeps the provider in play.
 */
function providerExhaustion(
  connections: Array<Record<string, unknown>>,
  now: number
): Map<string, ProviderHealth> {
  const byProvider = new Map<string, ProviderHealth>();
  for (const connection of connections) {
    const provider = typeof connection.provider === "string" ? connection.provider : "";
    if (!provider) continue;
    if (connection.isActive === false) continue;

    const status = String(connection.testStatus ?? "").toLowerCase();
    const rateLimitedUntil = parseTime(connection.rateLimitedUntil);
    const isRateLimited = rateLimitedUntil !== null && rateLimitedUntil > now;
    const code = errorCodeOf(connection.errorCode);
    const lastErrorAt = parseTime(connection.lastErrorAt);
    const recentFailure =
      lastErrorAt !== null && now - lastErrorAt <= DEFAULT_WINDOW_DAYS * 86_400_000;
    const isCredentialFailure = code !== null && EXHAUSTED_ERROR_CODES.has(code) && recentFailure;
    const dead = EXHAUSTED_STATUSES.has(status) || isRateLimited || isCredentialFailure;

    const current = byProvider.get(provider) ?? { total: 0, usable: 0, reason: null };
    current.total += 1;
    if (dead) {
      current.reason ??=
        status ||
        (isRateLimited ? "rate_limited" : "") ||
        (code ? `error_${code}` : "") ||
        "unavailable";
    } else {
      current.usable += 1;
    }
    byProvider.set(provider, current);
  }
  return byProvider;
}

function recentUsageWindow(days: number): RecentModelUsage[] {
  const now = Date.now();
  const sinceIso = new Date(now - days * 86_400_000).toISOString();
  const settings = getUserDatabaseSettings();
  const rawRetentionDays = settings.retention?.usageHistory ?? 30;
  const rawCutoff = new Date(now - rawRetentionDays * 86_400_000).toISOString().split("T")[0]!;

  const { unifiedSource, unifiedParams } = buildUnifiedSource({
    sinceIso,
    untilIso: null,
    rawCutoffDate: rawCutoff,
    apiKeyWhere: "",
    apiKeyParams: {},
  });

  const rows = getModelUsageRows(unifiedSource, unifiedParams);
  const merged = new Map<string, RecentModelUsage>();
  for (const row of rows) {
    const provider = String(row.provider ?? "").toLowerCase();
    const model = String(row.model ?? "");
    if (!provider || !model) continue;
    const key = `${provider}\0${model.toLowerCase()}`;
    const requests = Number(row.requests ?? 0);
    const successes = Number(row.successfulRequests ?? 0);
    const lastUsedAt = typeof row.lastUsed === "string" && row.lastUsed ? row.lastUsed : null;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { provider, model, requests, successes, lastUsedAt });
      continue;
    }
    const newest =
      current.lastUsedAt && lastUsedAt
        ? Date.parse(current.lastUsedAt) >= Date.parse(lastUsedAt)
          ? current.lastUsedAt
          : lastUsedAt
        : (current.lastUsedAt ?? lastUsedAt);
    merged.set(key, {
      provider,
      model: current.model,
      requests: current.requests + requests,
      successes: current.successes + successes,
      lastUsedAt: newest,
    });
  }
  return [...merged.values()];
}

/**
 * GET /api/models/suggested?limit=3
 *
 * The picker's "Suggested" section: live models from usable providers, ranked
 * by recent real usage first and catalogue quality second. The local emergency
 * fallback is only eligible when the operator asks for it, so the suggestion
 * list never quietly becomes "your Ollama box".
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitParam)))
      : 3;
    const includeLocal = url.searchParams.get("includeLocal") === "true";
    const windowDays = Math.min(
      90,
      Math.max(1, Number(url.searchParams.get("windowDays")) || DEFAULT_WINDOW_DAYS)
    );

    const [ranked, connections] = await Promise.all([
      getRankedModels({ liveOnly: true, sort: "score", limit: 500 }),
      getProviderConnections(),
    ]);

    const now = Date.now();
    const health = providerExhaustion(connections as Array<Record<string, unknown>>, now);
    const exhaustedProviders = [...health.entries()]
      .filter(([, entry]) => entry.total > 0 && entry.usable === 0)
      .map(([provider, entry]) => ({ provider, reason: entry.reason ?? "unavailable" }));

    const excludedProviders = new Set<string>();
    for (const { provider } of exhaustedProviders) excludedProviders.add(provider);
    if (!includeLocal) {
      for (const providerId of Object.keys(LOCAL_PROVIDERS)) excludedProviders.add(providerId);
    }

    const candidates: SuggestedModelCandidate[] = ranked.models.map((model) => ({
      id: model.id,
      provider: model.provider,
      providerAlias: model.providerAlias,
      rawModel: model.rawModel,
      name: model.name || model.rawModel,
      isFree: model.isFree,
      live: model.live,
      contextLength: model.contextLength,
      totalScore: model.scores?.total ?? 0,
    }));

    const suggestions = rankSuggestedModels(candidates, recentUsageWindow(windowDays), {
      limit,
      now,
      windowDays,
      excludeProviders: excludedProviders,
    });

    return NextResponse.json({
      checkedAt: new Date(now).toISOString(),
      windowDays,
      suggestions,
      exhaustedProviders,
      excludedProviders: [...excludedProviders],
    });
  } catch (error) {
    console.error("Error building suggested models:", error);
    return NextResponse.json({ error: "Failed to build suggested models" }, { status: 500 });
  }
}
