---
title: "Free-Tier Allowances and Model Strength"
version: 3.8.55
lastUpdated: 2026-11-21
---

# Free-Tier Allowances and Model Strength

This is the operator view of every zero-cost route currently connected to this
deployment: what the allowance is, what has been used, and which models are worth
reaching for first. It is a point-in-time snapshot with a live section describing
where to read the current numbers.

"Free" here means **no card / recurring free quota** or **an already-paid
subscription or allowance with no per-token charge**. Metered credit providers
(DeepSeek, YunWu) are listed only where they affect routing.

---

## Live sources

| Source                                    | What it returns                                                          | How to read it                                      |
| ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `GET /api/usage/provider-limits`          | Cached quotas per connection (OpenCode windows, DeepSeek balance, speed) | Dashboard → Usage → Provider Quota                  |
| `POST /api/usage/provider-limits`         | Forces an immediate refresh of every supported connection                | Called from the dashboard refresh button            |
| `GET /api/providers/quota-windows`        | Which quota windows a provider supports                                  | Reference only                                      |
| `GET https://opencode.ai/zen/go/v1/usage` | Official OpenCode rolling / weekly / monthly usage                       | Fetched by OmniRoute; `Authorization: Bearer <key>` |
| `GET /api/free-models`                    | Catalog quotas for free-tier models and pools                            | Dashboard → Free Tiers                              |
| `GET /api/usage/analytics?range=30d`      | Real per-model requests, tokens, success rate, cost                      | Dashboard → Usage → Analytics                       |

`PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES` controls the background refresh (this
deployment sets it to `5`; the shipped default is `70`). A successful OpenCode
fetch is cached for 60 seconds.

**Keeping the router current.** The `G-Bot OmniRoute Update` scheduled task runs
nightly and now merges `origin/release/v3.8.55` into the deployment branch,
installs when the lockfile moves, snapshots the data dir, builds with the
webpack backend, restarts the service, and rolls back on a failed build or
health check. A conflicted merge aborts and holds the previous release instead
of deploying half a merge; status lands in `omniroute-update-status.json` and
an `OMNIROUTE_UPDATE_WEBHOOK_URL` receives the reason. The task used to pull a
`local/main-v3.8.54` ref that no longer exists upstream — that is why the
router sat on an old build: every nightly run failed before reaching the
build.

**Why this matters:** an expired or legacy API-key row can still look "active" in
the UI. OpenCode quota fetches returned nothing until the stored key on
`opencode-go-api` was replaced and its legacy `auth_type` (`api_key`) was corrected
to `apikey` — `canUpdateProviderApiKey()` refuses key edits on the legacy value,
so the dashboard silently kept the old key. If OpenCode shows no quota, check
both the key and `provider_connections.auth_type`.

---

## Allowance snapshot (2026-11-21 14:37 UTC)

| Channel                                                           | Plan / type                                   | Allowance                                                          | Used                                                                                                                                                   | Remaining                                                      | Reset                                                             |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| **OpenCode Go** (`opencode-go-api`)                               | Console Go, $60/month                         | 5-hour: $12 · weekly: $30 · monthly: $60                           | 5h **$0.36** · weekly **$1.20** · monthly **$1.20**                                                                                                    | 5h **$11.64** · weekly **$28.80** · monthly **$58.80**         | 5h 19:01 UTC · weekly Nov 23 00:00 UTC · monthly Dec 16 04:03 UTC |
| **CLIProxyAPI** (`cliproxyapi-local`)                             | Subscription-backed (Grok/Kimi/Gemini/Claude) | Not metered by OmniRoute; upstream plan limits                     | 30d: **198 req · 54,000 tok · 91.4% ok** (≈ $0.096 list value)                                                                                         | Upstream plan                                                  | Upstream plan                                                     |
| **Ollama local** (`ollama-local-fallback`, `ollama-openai-local`) | Local GPU                                     | Unlimited                                                          | 30d: **1,108 req · 1,332 tok · 0.8% ok** (mostly fallback attempts)                                                                                    | Unlimited                                                      | —                                                                 |
| **OpenRouter free**                                               | 11 `:free` models; two accounts               | **50 req/day** (1,000/day after a one-time $10 top-up), 20 req/min | `openrouter-api-key`: **155/1,000 free requests used**; `OpenRouter (account 2)`: **$36.86 key limit left**, paid credits exhausted → free models only | 845 free requests on account 1 · $36.86 key limit on account 2 | Daily                                                             |

| **OpenCode Zen** (`opencode-zen`) | Free models | Free API quota exhausted for this account | **429 Free usage limit reached** on every free model | Daily/monthly (unknown) | Unknown |
| **DeepSeek** | One-time free credit | 5,000,000 tokens | **Exhausted** (`Insufficient Balance`) | — | — |

OpenCode Go percentages from the official endpoint at the same time were
**rolling 2% · weekly 4% · monthly 2%**; the dollar figures above are the exact
values OmniRoute records.

### What is actually usable

- **OpenCode Go** — working; `glm-5.3-flash`, `grok-4.7`, `kimi-k3`, `qwen3.8-flash` verified this session. `deepseek-v4-pro` and `deepseek-v4.1-flash` return reasoning-only content at small budgets and fall through to the local fallback. The working key is the `oc_sk_...` credential; the supplied `sk-1UXV...` key is rejected as `Invalid credential` and the older `sk-3Ihav...` key is expired.
- **CLIProxyAPI** — working for `grok-4.5`, `gemini-3-flash`, `claude-sonnet-4-6`; `kimi-k3` was cooling down at last check.
- **Ollama local** — working, but slow (~16s for the 27B models) and prone to empty reasoning-only replies at low token caps.
- **OpenCode Zen** — connected and kept inactive; re-enable when the free window resets.
- **OpenRouter** — two accounts connected and re-enabled; the combo now leaves the account unpinned so priority fallback can use either. Both serve `:free` models; paid models return `402 Insufficient credits` on both accounts.
- **DeepSeek / YunWu / Maya vLLM** — not usable (balance, 403 group permission, wrong base URL respectively).

---

## Model strength tiers

Strength is a family/version judgment (reasoning, vision, context, generation),
not the router's cost-weighted score. All models below are reachable on a
free/zero-marginal-cost route.

### S — frontier-class

`claude-opus-4-6-thinking` · `claude-sonnet-4-6` (CLIProxy)  
`gemini-4-argon` · `gpt-6-luna` · `qwen4-max` · `kimi-k3.1-pro` · `grok-4.7` ·
`qwen3.8-max` · `deepseek-v4-pro` · `gpt-5.6-luna` · `glm-5.3` (OpenCode Go)

### A — strong generalists / specialists

`kimi-k3` · `kimi-k2.7-code` · `minimax-m3` · `minimax-m3.1-flash` ·
`mimo-v2.6-pro` · `claude-haiku-5-5` · `hunyuan4-preview` · `qwen3.7-plus` ·
`muse-spark-1.3-contributor` · `glm-5.3-flash` · `step-5-preview` ·
`longcat-2.0` · `deepseek-v4.1-flash` (Go)  
`gpt-oss-120b-medium` · `gemini-3.6-flash-high` · `gemini-pro-agent` ·
`grok-4.5` · `grok-4.3` · `grok-4.20-0309-reasoning` (CLIProxy)

### B — fast, light, or previous generation

`qwen3.8-flash` · `mimo-v2.6-flash` · `hy4` · `hy3` · `muse-spark-1.2-contributor`
(Go)  
`kimi-k2.7-code-highspeed` · `kimi-k2.6` · `kimi-k2.5` · `kimi-k2` ·
`kimi-k2-thinking` · `kimi-k3-256k` · `gemini-3.5-flash-low` ·
`gemini-3.5-flash-extra-low` · `gemini-3.1-pro-low` · `gemini-3.1-flash-lite` ·
`gemini-3.1-flash-image` · `gemini-3-flash` · `gemini-3-flash-agent` ·
`grok-4.20-0309-non-reasoning` · `grok-4.20-multi-agent-0309` ·
`grok-composer-2.5-fast` · `grok-3-mini` · `grok-3-mini-fast` ·
`grok-build-0.1` (CLIProxy)

### C — free-tier IDs and local models

`beam-free` · `hy4-flash-free` · `iceman-contributor-free` ·
`longcat-2.5-free` (Go)  
`qwen3.8-27b:q4_k_m` · `qwen3.8-27b-uncensored:q4_k_m` · `qwen38u:latest` ·
`qwen38u-fast:latest` · `qwen3.5-abliterated` aliases (Ollama)

### Disabled free inventory

OpenRouter `:free` (11): `nvidia/nemotron-3-ultra-550b-a55b:free`,
`nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3.5-super-vl:free`,
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`,
`google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free`,
`particle-ai/particle-1:free`, `inclusionai/ling-3.2-flash:free`,
`liquid/lfm-3-1.7b:free`, `recursive/flint-v1.0:free`,
`baidu/ernie-5.5-flash-preview:free`.

---

## Thirty-day usage by model

| Model                               | Channel       | Requests | Tokens | Success |
| ----------------------------------- | ------------- | -------: | -----: | ------: |
| `huihui_ai/qwen3.5-abliterated:27b` | Ollama local  |    1,107 |  1,271 |   0.81% |
| `grok-4.5`                          | CLIProxy      |      198 | 54,000 |  91.41% |
| `deepseek-v4.1-flash`               | OpenCode Go   |       47 |  1,169 |  53.19% |
| `beam-free`                         | OpenCode Go   |       13 |  1,216 |    100% |
| `glm-5.3-flash`                     | OpenCode Go   |        4 |    170 |     75% |
| `grok-4.7`                          | OpenCode Go   |        1 |  2,182 |    100% |
| `kimi-k3`                           | OpenCode Go   |        1 |    348 |    100% |
| `qwen3.8-flash`                     | OpenCode Go   |        1 |    255 |    100% |
| `qwen3.8-27b:q4_k_m`                | Ollama direct |        1 |     61 |    100% |

Every other available model recorded **zero requests** in the window.

---

## Keeping it current

1. The dashboard refreshes provider limits every five minutes; press **Refresh** in
   Usage → Provider Quota for an immediate pull.
2. `POST /api/usage/provider-limits` is the same refresh without the UI.
3. OpenCode's own endpoint always has the authoritative percentages:
   `GET https://opencode.ai/zen/go/v1/usage`.
4. Record a new snapshot here when a quota resets or a channel is reconnected.
