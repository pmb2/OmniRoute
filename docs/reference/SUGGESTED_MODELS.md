---
title: "Suggested Models"
version: 3.8.54
lastUpdated: 2026-11-21
---

# Suggested Models

Model pickers start with a **Suggested** section: up to three models the
deployment can run right now, chosen from what has actually run recently. The
section re-ranks itself while open, so a model that goes into cooldown drops out
and the next healthy one takes its place.

## Endpoint

```
GET /api/models/suggested?limit=3&windowDays=14&includeLocal=false
```

Management authentication is required (`cookie: auth_token=…` or a manage-scope
API key).

| Param          | Default | Meaning                                                        |
| -------------- | ------- | -------------------------------------------------------------- |
| `limit`        | `3`     | Rows to return (1–10).                                         |
| `windowDays`   | `14`    | How far back "recently used" reaches.                          |
| `includeLocal` | `false` | Keep local providers (Ollama, LM Studio, vLLM, …) in the pool. |

### Response

```json
{
  "checkedAt": "2026-11-21T14:21:42.595Z",
  "windowDays": 14,
  "suggestions": [
    {
      "id": "opencode-go/glm-5.3-flash",
      "provider": "opencode-go",
      "rawModel": "glm-5.3-flash",
      "name": "glm-5.3-flash",
      "isFree": false,
      "live": true,
      "score": 68.7,
      "reason": "recent",
      "usage": {
        "requests": 4,
        "successes": 3,
        "successRatePct": 75,
        "lastUsedAt": "2026-11-21T14:06:47.806Z"
      }
    }
  ],
  "exhaustedProviders": [{ "provider": "openai-compatible-yunwu", "reason": "403" }],
  "excludedProviders": ["ollama-local", "openrouter", "deepseek"]
}
```

## How a model is chosen

1. **Eligibility** — only models from live providers with a usable connection.
   Providers are excluded when every active connection is in a terminal state
   (`banned`, `credits_exhausted`, `expired`, `invalid`, `rate_limited`) or has a
   recent `401/402/403`. The local emergency fallback is excluded by default so
   the shortcut row never quietly becomes "your Ollama box".
2. **Catalogue score (50%)** — the ranked-model composite score (recency,
   parameter size / context, cost, availability).
3. **Real usage (50%)** — from the usage ledger over the window: 55% recency,
   30% relative volume, 15% success rate. A model with no recent use contributes
   zero usage score and is labelled `available`; one used inside the window is
   labelled `recent`.
4. **Dedupe and cap** — one row per provider + model, sorted by score, then
   catalogue score, then name.

## Exhaustion and switching

The endpoint is read-only. It reports what the router already knows:

- Provider circuit breaker and connection cooldown state.
- Terminal connection statuses and recent credit/authorisation failures.
- Model lockouts are enforced at request time by the router's fallback chain.

Request-time failover is unchanged: a request that hits an exhausted model still
moves to the next combo target or the local fallback. The Suggested section only
keeps the _choice_ in front of the operator current.

## Where it appears

- **OmniRoute dashboard** — `ModelSelectModal` renders the section above Combos,
  refreshes every 30 seconds while the modal is open, lists exhausted provider
  names, and removes suggested rows from the provider groups to avoid duplicates.
- **G-Bot** — the `models.suggested` RPC applies the same idea to the member's own
  connections (`packages/core/src/model-suggestions.ts`), derived from the
  `runs` table over 14 days. The web `ChatModelPicker` shows the group first and
  de-duplicates the provider groups.

## Tests

- `tests/unit/suggested-models.test.ts` (ranking, exclusion, dedupe, cap, name
  matching).
- G-Bot: `packages/core/src/model-suggestions.test.ts`,
  `apps/api/src/model-suggestions.test.ts`,
  `apps/web/src/pages/shell/chat-model-picker.test.tsx`.
