import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getRankedModels } from "@/lib/models/rankedModels";

/**
 * GET /api/models/ranked
 *
 * Every model exposed by an active provider connection, enriched with release
 * date / age, parameter size, context, pricing, health, and a composite score.
 *
 * Query params:
 *   q          free-text filter (id/name/provider)
 *   provider   provider id or alias
 *   sort       score | newest | oldest | largest | cheapest | context | name | provider
 *   live       true = only providers with a healthy active connection
 *   limit      default 100, max 500
 *   offset     default 0
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const result = await getRankedModels({
      q: searchParams.get("q") ?? undefined,
      provider: searchParams.get("provider") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
      liveOnly: searchParams.get("live") === "true",
      limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
      offset: searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error building ranked models:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rank models" },
      { status: 500 }
    );
  }
}
