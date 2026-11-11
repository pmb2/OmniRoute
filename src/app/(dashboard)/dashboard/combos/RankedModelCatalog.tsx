"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import type { RankedModel, RankedModelsResult } from "@/lib/models/rankedModels";

type SortKey = "score" | "newest" | "oldest" | "largest" | "cheapest" | "context" | "name";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "score", label: "Best overall" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "largest", label: "Largest" },
  { value: "cheapest", label: "Cheapest" },
  { value: "context", label: "Longest context" },
  { value: "name", label: "Name" },
];

const AUTO_REFRESH_MS = 60_000;

function scoreTone(score: number): string {
  if (score >= 70) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (score >= 45) return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return "bg-black/5 dark:bg-white/10 text-text-muted";
}

function formatCost(model: RankedModel): string {
  if (model.isFree) return "Free";
  if (model.costPerMillion === null) return "—";
  if (model.costPerMillion === 0) return "Free";
  return `$${model.costPerMillion.toFixed(2)}`;
}

function formatSize(model: RankedModel): string {
  if (model.parameterSizeB !== null) return `${model.parameterSizeB}B`;
  if (model.contextLength) return `${Math.round(model.contextLength / 1000)}K ctx`;
  return "—";
}

function formatAge(model: RankedModel): string {
  if (model.ageDays === null) return "—";
  if (model.ageDays < 1) return "today";
  if (model.ageDays < 30) return `${model.ageDays}d`;
  if (model.ageDays < 365) return `${Math.round(model.ageDays / 30)}mo`;
  return `${(model.ageDays / 365).toFixed(1)}y`;
}

export default function RankedModelCatalog() {
  const [data, setData] = useState<RankedModelsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [liveOnly, setLiveOnly] = useState(true);
  const [addingId, setAddingId] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: "40",
        sort,
      });
      if (query.trim()) params.set("q", query.trim());
      if (provider) params.set("provider", provider);
      if (liveOnly) params.set("live", "true");
      const response = await fetch(`/api/models/ranked?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Ranked catalog request failed (${response.status})`);
      }
      const payload = (await response.json()) as RankedModelsResult;
      if (mounted.current) setData(payload);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [query, provider, sort, liveOnly]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load();
      }
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const providers = useMemo(() => data?.providers ?? [], [data]);

  const addToPriority = async (model: RankedModel) => {
    setAddingId(model.id);
    setNotice("");
    try {
      const response = await fetch("/api/models/ranked/add-to-priority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: model.provider, model: model.rawModel }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Add failed (${response.status})`);
      }
      setNotice(
        payload?.alreadyPresent
          ? `${model.id} is already in the priority combo.`
          : `${model.id} appended to the priority combo.`
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingId("");
    }
  };

  const copyId = async (model: RankedModel) => {
    try {
      await navigator.clipboard.writeText(model.id);
      setNotice(`Copied ${model.id}`);
    } catch {
      setNotice(model.id);
    }
  };

  return (
    <Card padding="sm">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[18px]">
                leaderboard
              </span>
              <h2 className="text-sm font-semibold">Ranked model catalog</h2>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                auto-ranked
              </span>
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              Every model from your active providers, scored by recency, size, cost and health.
              Auto-refreshes every 60s.
              {data?.generatedAt
                ? ` Last built ${new Date(data.generatedAt).toLocaleTimeString()}.`
                : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="add"
              onClick={() => {
                setQuery("");
                setProvider("");
                setLiveOnly(true);
                void load();
              }}
            >
              Reset
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search model id or name…"
            className="h-9 min-w-[220px] flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 text-sm outline-none focus:border-primary/40"
          />
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="h-9 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 text-sm outline-none focus:border-primary/40"
          >
            <option value="">All providers</option>
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.alias} ({entry.models})
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="h-9 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 text-sm outline-none focus:border-primary/40"
          >
            {SORT_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 px-3 text-sm">
            <input
              type="checkbox"
              checked={liveOnly}
              onChange={(event) => setLiveOnly(event.target.checked)}
              className="accent-primary"
            />
            Healthy only
          </label>
        </div>

        {notice && (
          <p className="text-xs text-primary" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium">Provider</th>
                <th className="py-2 pr-3 font-medium">Score</th>
                <th className="py-2 pr-3 font-medium">Age</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">$/1M</th>
                <th className="py-2 pr-3 font-medium">Ctx</th>
                <th className="py-2 pr-3 font-medium">Health</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.models ?? []).map((model) => (
                <tr
                  key={model.id}
                  className="border-t border-black/5 dark:border-white/5 align-middle"
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium text-text-main">{model.name}</div>
                    <div className="text-[11px] text-text-muted font-mono">{model.id}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-text-muted">{model.providerAlias}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-flex min-w-[44px] justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${scoreTone(
                        model.scores.total
                      )}`}
                      title={`recency ${model.scores.recency} · size ${model.scores.size} · cost ${model.scores.cost} · health ${model.scores.availability}`}
                    >
                      {model.scores.total.toFixed(0)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs">{formatAge(model)}</td>
                  <td className="py-2 pr-3 text-xs">{formatSize(model)}</td>
                  <td className="py-2 pr-3 text-xs">{formatCost(model)}</td>
                  <td className="py-2 pr-3 text-xs">
                    {model.contextLength ? `${Math.round(model.contextLength / 1000)}K` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 ${
                        model.live ? "text-emerald-600 dark:text-emerald-400" : "text-text-muted"
                      }`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          model.live ? "bg-emerald-500" : "bg-black/20 dark:bg-white/20"
                        }`}
                      />
                      {model.testStatus || (model.live ? "active" : "unknown")}
                    </span>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="add"
                      onClick={() => void addToPriority(model)}
                      disabled={addingId === model.id}
                    >
                      Add
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="content_copy"
                      onClick={() => void copyId(model)}
                    >
                      Copy
                    </Button>
                  </td>
                </tr>
              ))}
              {!loading && (data?.models?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-sm text-text-muted">
                    No models match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && (
          <p className="text-xs text-text-muted" role="status">
            Loading ranked models…
          </p>
        )}
        {data && (
          <p className="text-[11px] text-text-muted">
            Showing {data.models.length} of {data.total} models. Scores blend release age (35%),
            size (25%), cost (25%) and connection health (15%). “Add” appends to the canonical
            priority combo.
          </p>
        )}
      </div>
    </Card>
  );
}
