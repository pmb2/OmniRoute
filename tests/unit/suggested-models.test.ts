// Suggested-model ranking for the model picker: live providers first, then
// recent real usage. The local emergency fallback must never win by volume.
import test from "node:test";
import assert from "node:assert/strict";

const { rankSuggestedModels, normalizeModelKey } =
  await import("../../src/lib/models/suggestedModels.ts");

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function candidate(overrides = {}) {
  return {
    id: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
    rawModel: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isFree: false,
    live: true,
    totalScore: 70,
    ...overrides,
  };
}

function usage(overrides = {}) {
  return {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    requests: 40,
    successes: 38,
    lastUsedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

test("a recently used healthy model beats an unused higher-scored one", () => {
  const [top] = rankSuggestedModels(
    [
      candidate({
        id: "x/unused",
        provider: "x",
        rawModel: "unused",
        name: "Unused",
        totalScore: 80,
      }),
      candidate(),
    ],
    [usage()],
    { now: NOW, limit: 2 }
  );
  assert.equal(top.id, "deepseek/deepseek-v4-pro");
  assert.equal(top.reason, "recent");
  assert.equal(top.usage?.requests, 40);
});

test("stale usage within the window is labelled available, not recent", () => {
  const [top] = rankSuggestedModels(
    [candidate()],
    [usage({ lastUsedAt: new Date(NOW - 30 * 86_400_000).toISOString() })],
    { now: NOW, windowDays: 14 }
  );
  assert.equal(top.reason, "available");
});

test("models from exhausted providers are removed", () => {
  const ranked = rankSuggestedModels(
    [candidate(), candidate({ id: "openai/gpt-6", provider: "openai", rawModel: "gpt-6" })],
    [],
    { now: NOW, excludeProviders: ["openai"] }
  );
  assert.deepEqual(
    ranked.map((model) => model.provider),
    ["deepseek"]
  );
});

test("a non-live model is never suggested", () => {
  const ranked = rankSuggestedModels([candidate({ live: false })], [usage()], { now: NOW });
  assert.equal(ranked.length, 0);
});

test("the same model is not listed twice", () => {
  const ranked = rankSuggestedModels([candidate(), candidate()], [], { now: NOW, limit: 10 });
  assert.equal(ranked.length, 1);
});

test("results are capped at the requested limit", () => {
  const ranked = rankSuggestedModels(
    [
      candidate(),
      candidate({ id: "a/a", provider: "a", rawModel: "a" }),
      candidate({ id: "b/b", provider: "b", rawModel: "b" }),
      candidate({ id: "c/c", provider: "c", rawModel: "c" }),
    ],
    [],
    { now: NOW, limit: 3 }
  );
  assert.equal(ranked.length, 3);
});

test("display-name usage rows still match the upstream catalogue id", () => {
  const ranked = rankSuggestedModels(
    [
      candidate({
        id: "ollama-local/huihui_ai/qwen3.5-abliterated:27b",
        provider: "ollama-local",
        rawModel: "huihui_ai/qwen3.5-abliterated:27b",
        name: "Qwen 3.5 Abliterated 27B",
      }),
    ],
    [
      {
        provider: "ollama-local",
        model: "qwen3.5-abliterated:27b",
        requests: 12,
        successes: 9,
        lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
      },
    ],
    { now: NOW }
  );
  assert.equal(ranked[0]?.reason, "recent");
  assert.equal(ranked[0]?.usage?.requests, 12);
});

test("normalizeModelKey drops the provider prefix and whitespace", () => {
  assert.equal(normalizeModelKey("  OpenRouter / Z-AI / GLM-5 "), "z-ai/glm-5");
});
