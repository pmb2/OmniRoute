/**
 * Local Emergency Fallback - last-resort local model
 *
 * When every configured provider is unavailable/exhausted, OmniRoute can start
 * a local Ollama server and serve a local model (default:
 * huihui_ai/qwen3.5-abliterated:27b) through the normal OpenAI-compatible
 * endpoint. The model is advertised on `/v1/models` even while it is stopped so
 * clients can select it; selecting it starts Ollama on demand.
 *
 * Windows note: Ollama >= 0.40 resolves the models directory with
 * filepath.EvalSymlinks, which fails when OLLAMA_MODELS crosses a junction or
 * volume mount point (ollama/ollama#18921). We therefore resolve the configured
 * models directory to its final native path before spawning `ollama serve`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TRUE_ENV = new Set(["1", "true", "yes", "on"]);

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return TRUE_ENV.has(raw.trim().toLowerCase());
}

function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : defaultValue;
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : defaultValue;
}

export interface LocalFallbackConfig {
  enabled: boolean;
  provider: "ollama-local";
  model: string;
  host: string;
  baseUrl: string;
  ollamaBin: string;
  modelsDir: string;
  startTimeoutMs: number;
  pullIfMissing: boolean;
}

/**
 * Resolve the models directory to a path Ollama can read on Windows. A junction
 * or mount point (e.g. ~/.ollama -> D:\UserData\...\.ollama) makes every
 * manifest look corrupt on Ollama >= 0.40.
 */
export function resolveOllamaModelsDir(rawDir: string): string {
  if (process.platform !== "win32") return rawDir;
  try {
    return realpathSync.native(rawDir);
  } catch {
    return rawDir;
  }
}

export function getLocalFallbackConfig(): LocalFallbackConfig {
  const host = envString("OMNIROUTE_LOCAL_HOST", "127.0.0.1:11435");
  const baseUrl = envString("OMNIROUTE_LOCAL_BASE_URL", `http://${host}/v1`).replace(/\/+$/, "");
  const defaultModelsDir = envString("OLLAMA_MODELS", path.join(homedir(), ".ollama", "models"));
  const modelsDir = resolveOllamaModelsDir(
    envString("OMNIROUTE_LOCAL_MODELS_DIR", defaultModelsDir)
  );
  return {
    enabled: envFlag("OMNIROUTE_LOCAL_FALLBACK", true),
    provider: "ollama-local",
    model: envString("OMNIROUTE_LOCAL_MODEL", "huihui_ai/qwen3.5-abliterated:27b"),
    host,
    baseUrl,
    ollamaBin: envString("OMNIROUTE_OLLAMA_BIN", "ollama"),
    modelsDir,
    startTimeoutMs: envInt("OMNIROUTE_LOCAL_START_TIMEOUT_MS", 180_000),
    pullIfMissing: envFlag("OMNIROUTE_LOCAL_PULL_IF_MISSING", false),
  };
}

/** `provider/model` reference used on the wire and in combos. */
export function getLocalFallbackModelRef(config = getLocalFallbackConfig()): string {
  return `${config.provider}/${config.model}`;
}

export function isLocalFallbackProvider(provider: string | null | undefined): boolean {
  return provider === "ollama-local";
}

export function isLocalFallbackModel(
  provider: string | null | undefined,
  model: string | null | undefined,
  config = getLocalFallbackConfig()
): boolean {
  if (provider !== config.provider || !model) return false;
  return model === config.model || model === `${config.model}:latest`;
}

export interface LocalModelProbe {
  reachable: boolean;
  modelPresent: boolean;
  models: string[];
  error?: string;
}

function namesMatch(installed: string, wanted: string): boolean {
  if (installed === wanted) return true;
  const wantsTag = wanted.includes(":");
  if (!wantsTag && installed === `${wanted}:latest`) return true;
  if (wanted.endsWith(":latest") && installed === wanted.slice(0, -":latest".length)) return true;
  return false;
}

function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export async function probeLocalModel(
  config = getLocalFallbackConfig(),
  timeoutMs = 2_500
): Promise<LocalModelProbe> {
  try {
    const response = await fetch(`${apiRoot(config.baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        reachable: false,
        modelPresent: false,
        models: [],
        error: `HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const models = (payload.models ?? [])
      .map((entry) => entry.name ?? entry.model ?? "")
      .filter((name): name is string => Boolean(name));
    return {
      reachable: true,
      modelPresent: models.some((name) => namesMatch(name, config.model)),
      models,
    };
  } catch (error) {
    return {
      reachable: false,
      modelPresent: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface EnsureLocalModelResult {
  ok: boolean;
  started: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  modelRef: string;
  baseUrl: string;
  modelsDir: string;
  error?: string;
  models?: string[];
}

let startInFlight: Promise<EnsureLocalModelResult> | null = null;

function spawnOllamaServe(config: LocalFallbackConfig): {
  child: ChildProcess;
  spawnError: Error | null;
} {
  const env = {
    ...process.env,
    OLLAMA_HOST: config.host,
    // Resolved path - see the junction note at the top of this file.
    OLLAMA_MODELS: config.modelsDir,
    OLLAMA_NO_CLOUD: process.env.OLLAMA_NO_CLOUD ?? "1",
  };
  try {
    const child = spawn(config.ollamaBin, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
      env,
    });
    child.unref();
    return { child, spawnError: null };
  } catch (error) {
    return {
      child: null as unknown as ChildProcess,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForModel(
  config: LocalFallbackConfig,
  deadline: number
): Promise<LocalModelProbe> {
  let last: LocalModelProbe = { reachable: false, modelPresent: false, models: [] };
  while (Date.now() < deadline) {
    last = await probeLocalModel(config);
    if (last.reachable && last.modelPresent) return last;
    await sleep(1_000);
  }
  return last;
}

async function doEnsureLocalModelServer(
  config: LocalFallbackConfig
): Promise<EnsureLocalModelResult> {
  const base = {
    model: config.model,
    modelRef: getLocalFallbackModelRef(config),
    baseUrl: config.baseUrl,
    modelsDir: config.modelsDir,
  };
  if (!config.enabled) {
    return {
      ok: false,
      started: false,
      reachable: false,
      modelPresent: false,
      ...base,
      error: "local fallback disabled",
    };
  }

  const initial = await probeLocalModel(config);
  if (initial.reachable && initial.modelPresent) {
    return {
      ok: true,
      started: false,
      reachable: true,
      modelPresent: true,
      ...base,
      models: initial.models,
    };
  }

  // A server is already listening but lacks the model. Starting a second one
  // cannot help; report the actionable state instead.
  if (initial.reachable && !initial.modelPresent) {
    console.warn(
      `[local-fallback] ${config.baseUrl} is up but model ${config.model} is not installed ` +
        `(models: ${initial.models.join(", ") || "none"}).`
    );
    return {
      ok: false,
      started: false,
      reachable: true,
      modelPresent: false,
      ...base,
      models: initial.models,
      error: `model ${config.model} is not installed in ${config.modelsDir}`,
    };
  }

  console.warn(
    `[local-fallback] starting Ollama on ${config.host} with OLLAMA_MODELS=${config.modelsDir}`
  );
  const { spawnError } = spawnOllamaServe(config);
  if (spawnError) {
    return {
      ok: false,
      started: false,
      reachable: false,
      modelPresent: false,
      ...base,
      error: spawnError.message,
    };
  }

  const deadline = Date.now() + config.startTimeoutMs;
  let probe = await waitForModel(config, deadline);
  let started = true;

  if (probe.reachable && !probe.modelPresent && config.pullIfMissing) {
    console.warn(`[local-fallback] pulling missing model ${config.model} (this can take a while)`);
    await new Promise<void>((resolve) => {
      const pull = spawn(config.ollamaBin, ["pull", config.model], {
        stdio: "ignore",
        windowsHide: true,
        shell: process.platform === "win32",
        env: { ...process.env, OLLAMA_HOST: config.host, OLLAMA_MODELS: config.modelsDir },
      });
      pull.on("exit", () => resolve());
      pull.on("error", () => resolve());
    });
    probe = await waitForModel(config, Date.now() + config.startTimeoutMs);
  }

  return {
    ok: probe.reachable && probe.modelPresent,
    started,
    reachable: probe.reachable,
    modelPresent: probe.modelPresent,
    ...base,
    models: probe.models,
    error:
      probe.reachable && probe.modelPresent
        ? undefined
        : (probe.error ?? "local model did not become ready"),
  };
}

/**
 * Idempotently ensure the local fallback model is running. Concurrent callers
 * share one start attempt so a burst of requests cannot spawn several servers.
 */
export async function ensureLocalModelServer(
  config = getLocalFallbackConfig()
): Promise<EnsureLocalModelResult> {
  if (startInFlight) return startInFlight;
  startInFlight = doEnsureLocalModelServer(config).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}

/** Status for the dashboard / Hermes picker without starting anything. */
export async function getLocalFallbackStatus(config = getLocalFallbackConfig()) {
  const probe = await probeLocalModel(config);
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    modelRef: getLocalFallbackModelRef(config),
    baseUrl: config.baseUrl,
    modelsDir: config.modelsDir,
    reachable: probe.reachable,
    modelPresent: probe.modelPresent,
    models: probe.models,
    error: probe.error,
  };
}
