/**
 * Hermes Agent Cost Tracker
 *
 * Extracts x-hermes-agent header from requests and logs cost/usage per agent.
 * Integrates with OmniRoute's existing call_logs table and provider cost tracking.
 *
 * Usage (in chatCore.ts or chatHelpers.ts, after model resolution):
 *
 *   import { trackAgentUsage } from "../hermes/costTracker";
 *   const agentSlug = extractAgentHeader(requestHeaders);
 *   // ... after response ...
 *   await recordAgentCost(agentSlug, provider, model, tokenCount, cost);
 */

// ── Header Extraction ──────────────────────────────────────────────────────

/** Known header names that carry the agent slug */
const AGENT_HEADER_NAMES = ["x-hermes-agent", "x-agent-slug", "x-buzz-agent"];

/**
 * Extract the Hermes agent slug from request headers.
 * Returns null if no agent header is present.
 */
export function extractAgentHeader(
  headers: Record<string, unknown> | null | undefined
): string | null {
  if (!headers || typeof headers !== "object") return null;

  for (const name of AGENT_HEADER_NAMES) {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lowerName) continue;
      const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
      const slug = raw.trim();
      if (slug) return slug;
    }
  }

  // Fallback: check user-agent for buzz agent patterns
  const ua = getHeaderValue(headers, "user-agent");
  if (ua) {
    const buzzMatch = ua.match(/buzz\/([\w-]+)/i);
    if (buzzMatch) return buzzMatch[1].toLowerCase();
  }

  return null;
}

function getHeaderValue(headers: Record<string, unknown> | null | undefined, name: string): string {
  if (!headers || typeof headers !== "object") return "";
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    return Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  return "";
}

// ── Cost Estimation ────────────────────────────────────────────────────────

/** Approximate cost per 1M tokens by model family (USD). For quick estimates. */
const COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-5.6-sol": { input: 0.4, output: 1.6 },
  "gpt-5.6-sol-max": { input: 0.8, output: 3.2 },
  "deepseek-v4-pro": { input: 0.0, output: 0.0 }, // free via YunWu pool
  "deepseek-v4-flash": { input: 0.0, output: 0.0 }, // free
  "grok-4.5": { input: 0.0, output: 0.0 }, // free via CLIProxyAPI
  "gpt-image-2": { input: 0.0, output: 0.04 }, // per image
};

export interface AgentCostEntry {
  agentSlug: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  timestamp: number;
}

/** In-memory buffer for aggregation (flushed periodically or on query) */
const costBuffer: AgentCostEntry[] = [];
const MAX_BUFFER_SIZE = 10_000;

/**
 * Estimate cost from model and token counts.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = COST_PER_1M_TOKENS[model];
  if (!pricing) {
    // Unknown model — assume $0.00 (free tier)
    return 0;
  }
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000; // 4 decimal places
}

/**
 * Record agent usage. Called after each chat completion.
 */
export function recordAgentCost(entry: AgentCostEntry): void {
  costBuffer.push(entry);
  if (costBuffer.length > MAX_BUFFER_SIZE) {
    costBuffer.splice(0, costBuffer.length - MAX_BUFFER_SIZE);
  }
}

/**
 * Get aggregated cost per agent since last query.
 */
export function getAgentCostSummary(): Record<
  string,
  {
    requests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedCost: number;
    models: Record<string, number>;
  }
> {
  const summary: Record<
    string,
    {
      requests: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      estimatedCost: number;
      models: Record<string, number>;
    }
  > = {};

  for (const entry of costBuffer) {
    if (!summary[entry.agentSlug]) {
      summary[entry.agentSlug] = {
        requests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        estimatedCost: 0,
        models: {} as Record<string, number>,
      };
    }
    const s = summary[entry.agentSlug];
    s.requests++;
    s.totalPromptTokens += entry.promptTokens;
    s.totalCompletionTokens += entry.completionTokens;
    s.estimatedCost += entry.estimatedCost;
    s.models[entry.model] = (s.models[entry.model] || 0) + 1;
  }

  return summary;
}

/**
 * Get cost summary for a specific agent.
 */
export function getAgentCost(agentSlug: string) {
  const entries = costBuffer.filter((e) => e.agentSlug === agentSlug);
  if (entries.length === 0) return null;

  return {
    agentSlug,
    requests: entries.length,
    totalPromptTokens: entries.reduce((s, e) => s + e.promptTokens, 0),
    totalCompletionTokens: entries.reduce((s, e) => s + e.completionTokens, 0),
    estimatedCost: entries.reduce((s, e) => s + e.estimatedCost, 0),
    models: entries.reduce(
      (acc, e) => {
        acc[e.model] = (acc[e.model] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
  };
}

/**
 * Clear the cost buffer (e.g., after persisting to DB).
 */
export function flushCostBuffer(): AgentCostEntry[] {
  return costBuffer.splice(0, costBuffer.length);
}
