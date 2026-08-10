/**
 * Hermes Health-Aware Routing Pre-Filter
 *
 * Runs BEFORE combo target iteration to proactively skip targets whose
 * providers/connections are already known unhealthy. Avoids wasted dispatch
 * attempts (and their latency cost) on circuit-open, quota-exhausted, or
 * connection-dead providers.
 *
 * The stock OmniRoute combo already has reactive exhaustion tracking (#1731):
 * after a target fails, its provider is marked exhausted for the rest of the
 * request. This module adds PROACTIVE filtering — before the first attempt,
 * check circuit breakers, connection testStatus, and provider cooldowns.
 *
 * Usage (in combo.ts target iteration loop, right before the semaphore acquire):
 *
 *   import { healthPreFilter } from "../hermes/healthFilter";
 *   const skipReason = await healthPreFilter(target, opts);
 *   if (skipReason) { log.info("COMBO-RR", skipReason); continue; }
 */

import { getCircuitBreaker } from "@/shared/utils/circuitBreaker";
import { isProviderInCooldown } from "../providerCooldownTracker";
import type { ResolvedComboTarget } from "../combo/types.ts";
import { getCachedProviderConnections } from "@/lib/db/readCache";
import type { ResilienceSettings } from "@/lib/resilience/settings";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthPreFilterOptions {
  /** Connection testStatus → skip reason (null = healthy) */
  connectionStatuses?: Map<string, string>;
  /** Provider-level circuit breaker state cache */
  breakerCache?: Map<string, BreakerState>;
  /** Resilience settings (for cooldown thresholds) */
  resilienceSettings?: ResilienceSettings;
}

export interface BreakerState {
  open: boolean;
  retryAfterMs: number;
}

export interface HealthSkipResult {
  skip: boolean;
  reason: string;
  /** Millis until this target is worth retrying (0 = permanent) */
  retryAfterMs: number;
}

// ── Internal caches (per-process, shared across requests) ───────────────────

/** Connection testStatus cache — refreshed on miss or after 30s */
const connectionStatusCache = new Map<string, { status: string; ts: number }>();
const CONNECTION_CACHE_TTL_MS = 30_000;

/** Circuit breaker state cache — refreshed every 5s */
const breakerStateCache = new Map<string, BreakerState>();
const BREAKER_CACHE_TTL_MS = 5_000;
let lastBreakerRefresh = 0;

// ── Connection Status Lookup ───────────────────────────────────────────────

async function getConnectionStatus(connectionId: string | undefined): Promise<string | null> {
  if (!connectionId) return null;

  const cached = connectionStatusCache.get(connectionId);
  if (cached && Date.now() - cached.ts < CONNECTION_CACHE_TTL_MS) {
    return cached.status;
  }

  try {
    // getCachedProviderConnections has its own internal cache
    const connections = (await getCachedProviderConnections({
      isActive: true,
    })) as Array<Record<string, unknown>>;
    for (const conn of connections) {
      if (conn && typeof conn === "object" && conn.id === connectionId) {
        const status = String(conn.testStatus || "unknown").toLowerCase();
        connectionStatusCache.set(connectionId, { status, ts: Date.now() });
        return status;
      }
    }
  } catch {
    // cache miss — don't block routing
  }

  return null;
}

// ── Circuit Breaker Check ──────────────────────────────────────────────────

function getBreakerState(provider: string): BreakerState {
  const now = Date.now();

  // Refresh cache if stale
  if (now - lastBreakerRefresh > BREAKER_CACHE_TTL_MS) {
    breakerStateCache.clear();
    lastBreakerRefresh = now;
  }

  const cached = breakerStateCache.get(provider);
  if (cached) return cached;

  try {
    const breaker = getCircuitBreaker(provider);
    const state: BreakerState = {
      open: !breaker.canExecute(),
      retryAfterMs: breaker.getRetryAfterMs(),
    };
    breakerStateCache.set(provider, state);
    return state;
  } catch {
    return { open: false, retryAfterMs: 0 };
  }
}

// ── Quota/Connection Exhaustion Check ──────────────────────────────────────

const QUOTA_BLOCKING_STATUSES = new Set([
  "banned",
  "credits_exhausted",
  "deactivated",
  "expired",
  "rate_limited",
]);

function isConnectionDead(status: string | null): boolean {
  if (!status) return false;
  return QUOTA_BLOCKING_STATUSES.has(status.toLowerCase());
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Check whether a combo target should be skipped BEFORE attempting dispatch.
 *
 * Checks (in order, cheapest first):
 * 1. Circuit breaker — is the provider's breaker OPEN?
 * 2. Provider global cooldown — did this provider just fail? (existing tracker)
 * 3. Connection testStatus — is this connection quota_exhausted/banned/expired?
 *
 * Returns `null` if the target is healthy and should be attempted.
 * Returns a skip reason string if the target should be skipped.
 */
export async function healthPreFilter(
  target: ResolvedComboTarget,
  opts: HealthPreFilterOptions = {}
): Promise<string | null> {
  const { provider, modelStr, connectionId } = target;

  // 1. Circuit breaker check
  if (provider && provider !== "unknown") {
    const breaker = getBreakerState(provider);
    if (breaker.open) {
      const retrySec = Math.ceil(breaker.retryAfterMs / 1000);
      return (
        `Skipping ${modelStr} — circuit breaker OPEN for ${provider} ` + `(retry in ${retrySec}s)`
      );
    }
  }

  // 2. Provider global cooldown (reuse existing tracker)
  if (
    provider &&
    provider !== "unknown" &&
    opts.resilienceSettings?.providerCooldown?.enabled !== false &&
    isProviderInCooldown(provider, connectionId as string | undefined, opts.resilienceSettings)
  ) {
    return `Skipping ${modelStr} — provider ${provider} in global cooldown`;
  }

  // 3. Connection testStatus (quota exhausted, banned, expired, etc.)
  if (connectionId) {
    const status = await getConnectionStatus(connectionId);
    if (isConnectionDead(status)) {
      return (
        `Skipping ${modelStr} — connection ${connectionId} ` +
        `has status '${status}' (quota blocked)`
      );
    }
  }

  return null;
}

/**
 * Warm the health filter caches. Call once at startup or periodically.
 * Fetches all active connections and pre-populates the status cache.
 */
export async function warmHealthCache(): Promise<void> {
  try {
    const connections = (await getCachedProviderConnections({
      isActive: true,
    })) as Array<Record<string, unknown>>;
    let warmed = 0;
    for (const conn of connections) {
      if (conn && typeof conn === "object" && typeof conn.id === "string") {
        const status = String(conn.testStatus || "unknown").toLowerCase();
        connectionStatusCache.set(conn.id, { status, ts: Date.now() });
        warmed++;
      }
    }
    console.log(`[hermes:health] Warmed ${warmed} connection statuses`);
  } catch (err) {
    console.warn("[hermes:health] Failed to warm cache:", err);
  }
}

/**
 * Get a summary of the current health state for dashboard/reporting.
 */
export async function getHealthSummary(): Promise<{
  connections: Record<string, { status: string; ageMs: number }>;
  breakers: Record<string, BreakerState>;
}> {
  // Refresh breakers
  for (const key of breakerStateCache.keys()) {
    try {
      const breaker = getCircuitBreaker(key);
      breakerStateCache.set(key, {
        open: !breaker.canExecute(),
        retryAfterMs: breaker.getRetryAfterMs(),
      });
    } catch {
      // leave stale
    }
  }

  const connections: Record<string, { status: string; ageMs: number }> = {};
  for (const [id, entry] of connectionStatusCache) {
    connections[id] = { status: entry.status, ageMs: Date.now() - entry.ts };
  }

  const breakers: Record<string, BreakerState> = {};
  for (const [provider, state] of breakerStateCache) {
    breakers[provider] = state;
  }

  return { connections, breakers };
}
