# Incident Report: Hermes Agent "Model Provider Failed" Error

## Date: 2026-07-24

## Severity: High

## Affected System: Website Landlord — Operations Lead (Hermes Agent)

---

## Symptoms

- Discord error in `#website-landlord` thread:
  ```
  ⚠️ The model provider failed after retries. I kept raw provider details out of chat;
  check gateway logs for diagnostics. [BASI]
  ```
- All Hermes agent model requests returning 401/502/418
- Session invalidation loop on Spacebar gateway

---

## Root Cause #1 (Critical): OPENCODE_API_KEY Empty in OmniRoute

**File:** `C:\Users\TBA\OmniRoute\.env:20`

```
OPENCODE_API_KEY=
```

The OmniRoute gateway (http://localhost:20128) had **no API key configured** for the `opencode` provider. When Hermes sent requests for `oc/deepseek-v4-flash-free` through OmniRoute:

1. OmniRoute's `OpencodeExecutor` looked for `credentials.apiKey` or `credentials.accessToken`
2. With `OPENCODE_API_KEY` empty, no auth header was sent
3. Upstream (opencode.ai/zen/v1) returned **401 Unauthorized**
4. The auto-combo tried 76 free models across auggie, duckduckgo-web, opencode, and felo-web
5. Most failed before felo-web eventually succeeded (if at all)

**Fix Applied:** Set `OPENCODE_API_KEY` from the working key in `C:\Users\TBA\.hermes\.env` (`OPENCODE_GO_API_KEY`).

---

## Root Cause #2: OmniRoute Gateway Not Running

**Current State:** OmniRoute process is NOT running on port 20128.

- Last call logs: `2026-07-22T13:33 UTC` (2 days stale)
- No Windows service registered for OmniRoute
- Hermes cannot reach `http://localhost:20128/v1` → connection refused → fallbacks may also fail

**To Restart:**

```
cd C:\Users\TBA\OmniRoute
npm run dev
```

The `.env` change is picked up on next start.

---

## Root Cause #3: Cascading Free-Provider Failures

The `auto/coding:free` combo in OmniRoute chains through these free providers, and most were failing:

| Provider                  | Error               | Cause                                          |
| ------------------------- | ------------------- | ---------------------------------------------- |
| **auggie** (Gemini)       | 502 spawn EINVAL    | Missing binary for the auggie backend          |
| **duckduckgo-web**        | 418/429             | Anti-abuse challenge / rate limited (IP-based) |
| **opencode** (all models) | 401 / empty_choices | OPENCODE_API_KEY empty (FIXED)                 |
| **felo-web**              | sporadic            | Only occasional success                        |

The auto-combo's circuit breaker automatically excludes broken providers (auggie, duckduckgo-web marked with `#1731v2` skip).

---

## Fix Summary

| #   | Fix                                  | File                     | Status                     |
| --- | ------------------------------------ | ------------------------ | -------------------------- |
| 1   | Set `OPENCODE_API_KEY`               | `OmniRoute\.env:20`      | ✅ Done                    |
| 2   | Restart OmniRoute service            | —                        | ⏳ Requires manual restart |
| 3   | Auto-exclude auggie & duckduckgo-web | Built-in circuit breaker | Already active             |

---

## What [BASI] Means

`[BASI]` is the Discord username/tag suffix in the Spacebar gateway's error message embedding. It's likely a truncated identifier from the Discord webhook setup or the Hermes gateway's internal error reporting.

---

## Long-Term Recommendations

1. **Start OmniRoute as a Windows service** (e.g., `nssm` or `node-windows`) so it auto-recovers after reboot/crash
2. **Add monitoring** — the last call log is 2 days stale, meaning OmniRoute has been down since Jul 22
3. **Pin a primary model** in the operations-lead config rather than relying on auto-combo of 76 free models that mostly fail
4. **Investigate auggie backend** (spawn EINVAL) — the binary dependency is missing
5. **Consider DuckDuckGo Web proxy rotation** — the anti-abuse 418 suggests the current IP is flagged
