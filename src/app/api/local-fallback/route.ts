import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  ensureLocalModelServer,
  getLocalFallbackStatus,
} from "@omniroute/open-sse/services/localEmergencyFallback.ts";

/** GET /api/local-fallback - local emergency tier status (does not start it). */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json(await getLocalFallbackStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read local fallback status" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/local-fallback - start/ensure the local model.
 *
 * Body: { "action": "start" | "ensure" } (default "ensure"). Idempotent.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let action = "ensure";
  try {
    const body = await request.json();
    if (body && typeof body.action === "string") action = body.action.trim();
  } catch {
    // empty/malformed body is fine - default action
  }

  if (action !== "start" && action !== "ensure") {
    return NextResponse.json({ error: "action must be 'start' or 'ensure'" }, { status: 400 });
  }

  try {
    const result = await ensureLocalModelServer();
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start local fallback" },
      { status: 500 }
    );
  }
}
