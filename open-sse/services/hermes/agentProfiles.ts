/**
 * Hermes Per-Agent Routing Profiles
 *
 * Maps agent slugs to preferred combo cascades. Injects into the routing path
 * via model_combo_mappings so each agent routes through its optimal provider tier.
 *
 * Usage:
 *   import { resolveAgentCombo, getAgentProfile } from "../hermes/agentProfiles";
 *   const comboId = resolveAgentCombo("forge"); // → "hermes-coding-combo"
 *
 * Profiles defined in seeds/agent-profiles.json, synced to OmniRoute DB.
 */

// ── Agent → Combo Mapping ──────────────────────────────────────────────────

/** Agent slugs that should use the powerful/expensive tier */
const POWERFUL_AGENTS = new Set(["forge", "architect", "development-lead"]);

/** Agent slugs that should use the free-only tier (never spend credits) */
const FREE_ONLY_AGENTS = new Set(["scribe", "skillmate"]);

/** Agent slugs that should use the code-optimized tier */
const CODING_AGENTS = new Set(["forge", "codex", "opencode"]);

/** Agent slugs that should use the security/minimal tier */
const SECURITY_AGENTS = new Set(["sentry"]);

// ── Combo Selection ────────────────────────────────────────────────────────

export interface AgentProfile {
  slug: string;
  category: "powerful" | "workhorse" | "free-only" | "coding" | "security";
  primaryCombo: string;
  fallbackCombo: string;
}

const PROFILES: Record<string, AgentProfile> = {
  forge: {
    slug: "forge",
    category: "coding",
    primaryCombo: "hermes-coding-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  "development-lead": {
    slug: "development-lead",
    category: "powerful",
    primaryCombo: "hermes-primary-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  architect: {
    slug: "architect",
    category: "powerful",
    primaryCombo: "hermes-primary-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  sentry: {
    slug: "sentry",
    category: "security",
    primaryCombo: "hermes-security-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  scribe: {
    slug: "scribe",
    category: "free-only",
    primaryCombo: "hermes-free-combo",
    fallbackCombo: "hermes-free-combo",
  },
  skillmate: {
    slug: "skillmate",
    category: "free-only",
    primaryCombo: "hermes-free-combo",
    fallbackCombo: "hermes-free-combo",
  },
  weaver: {
    slug: "weaver",
    category: "workhorse",
    primaryCombo: "hermes-workhorse-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  codex: {
    slug: "codex",
    category: "coding",
    primaryCombo: "hermes-coding-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
  opencode: {
    slug: "opencode",
    category: "coding",
    primaryCombo: "hermes-coding-combo",
    fallbackCombo: "hermes-workhorse-combo",
  },
};

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve which combo a given agent should use.
 *
 * Resolution order:
 * 1. Check profiling agentProfiles lookup table
 * 2. Check the agent category sets (powerful/free-only/coding/security)
 * 3. Default to hermes-workhorse-combo
 */
export function resolveAgentCombo(agentSlug: string | null | undefined): string {
  if (!agentSlug) return "hermes-workhorse-combo";

  const normalized = agentSlug.toLowerCase().trim();

  // Exact profile match
  const profile = PROFILES[normalized];
  if (profile) return profile.primaryCombo;

  // Category-based fallback
  if (POWERFUL_AGENTS.has(normalized)) return "hermes-primary-combo";
  if (FREE_ONLY_AGENTS.has(normalized)) return "hermes-free-combo";
  if (CODING_AGENTS.has(normalized)) return "hermes-coding-combo";
  if (SECURITY_AGENTS.has(normalized)) return "hermes-security-combo";

  return "hermes-workhorse-combo";
}

/**
 * Get the full agent profile, including category and fallback combo.
 */
export function getAgentProfile(agentSlug: string | null | undefined): AgentProfile {
  if (!agentSlug) {
    return {
      slug: "unknown",
      category: "workhorse",
      primaryCombo: "hermes-workhorse-combo",
      fallbackCombo: "hermes-workhorse-combo",
    };
  }

  const normalized = agentSlug.toLowerCase().trim();
  const profile = PROFILES[normalized];
  if (profile) return profile;

  // Generate a synthetic profile from category
  const combo = resolveAgentCombo(agentSlug);
  let category: AgentProfile["category"] = "workhorse";
  if (POWERFUL_AGENTS.has(normalized)) category = "powerful";
  else if (FREE_ONLY_AGENTS.has(normalized)) category = "free-only";
  else if (CODING_AGENTS.has(normalized)) category = "coding";
  else if (SECURITY_AGENTS.has(normalized)) category = "security";

  return {
    slug: normalized,
    category,
    primaryCombo: combo,
    fallbackCombo: "hermes-workhorse-combo",
  };
}

/**
 * List all configured agent profiles (for dashboard/debugging).
 */
export function listAgentProfiles(): AgentProfile[] {
  return Object.values(PROFILES).sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Given a request's x-hermes-agent header, return the model string to use for routing.
 *
 * Maps hermes/forge → hermes/coding, hermes/sentry → hermes/security, etc.
 * The underlying model_combo_mappings then resolve these to the correct combo.
 */
export function resolveAgentModelStr(
  agentSlug: string | null | undefined,
  originalModelStr: string
): string {
  if (!agentSlug) return originalModelStr;

  const profile = getAgentProfile(agentSlug);

  // If the original model is already a specific hermes/* model, don't override
  if (originalModelStr.startsWith("hermes/")) {
    // But if it's just "hermes/workhorse" or "hermes/powerful", upgrade it
    // to the agent-specific profile
    if (
      originalModelStr === "hermes/workhorse" ||
      originalModelStr === "hermes/powerful" ||
      originalModelStr === "hermes/default"
    ) {
      // Map agent category to hermes/* model string
      switch (profile.category) {
        case "coding":
          return "hermes/coding";
        case "security":
          return "hermes/security";
        case "free-only":
          return "hermes/free";
        case "powerful":
          return "hermes/powerful";
        default:
          return "hermes/workhorse";
      }
    }
    return originalModelStr;
  }

  // Non-hermes model — keep as-is (direct provider routing)
  return originalModelStr;
}
