import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getComboById, getComboByName, getCombos, updateCombo } from "@/lib/db/combos";
import { normalizeComboModels } from "@/lib/combos/steps";

const PRIORITY_COMBO_NAME = "hermes-workhorse-combo";

interface AddStepBody {
  provider?: string;
  providerId?: string;
  model?: string;
  comboId?: string;
  comboName?: string;
}

/**
 * POST /api/models/ranked/add-to-priority
 *
 * Appends a ranked model to the canonical priority combo (default id/name:
 * `hermes-workhorse-combo`) as the last step before the local fallback. This is
 * what the "Add" button in the ranked catalog calls, so selecting a model does
 * not require hand-building a combo.
 *
 * Body: { provider | providerId, model, comboId? | comboName? }
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: AddStepBody;
  try {
    body = (await request.json()) as AddStepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = (body.providerId || body.provider || "").trim();
  const model = (body.model || "").trim();
  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model are required" }, { status: 400 });
  }

  try {
    const combo =
      (body.comboId ? await getComboById(body.comboId) : null) ||
      (body.comboName ? await getComboByName(body.comboName) : null) ||
      (await getComboByName(PRIORITY_COMBO_NAME)) ||
      (await getCombos())[0] ||
      null;
    if (!combo) {
      return NextResponse.json({ error: "No priority combo found" }, { status: 404 });
    }

    const existing = Array.isArray(combo.models) ? combo.models : [];
    const duplicate = existing.some((step: Record<string, unknown>) => {
      const stepModel = typeof step.model === "string" ? step.model : "";
      const stepProvider =
        typeof step.providerId === "string"
          ? step.providerId
          : typeof step.provider === "string"
            ? step.provider
            : "";
      return stepModel === model && (!stepProvider || stepProvider === provider);
    });
    if (duplicate) {
      return NextResponse.json({ ok: true, alreadyPresent: true, combo });
    }

    const nextModels = [
      ...existing,
      {
        kind: "model",
        model,
        providerId: provider,
        provider,
        weight: 1,
      },
    ];
    const allCombos = await getCombos();
    const normalized = normalizeComboModels(nextModels, {
      comboName: String(combo.name),
      allCombos: allCombos as never,
    });
    const updated = await updateCombo(combo.id, {
      ...combo,
      models: normalized,
    });
    return NextResponse.json({ ok: true, alreadyPresent: false, combo: updated });
  } catch (error) {
    console.error("Error adding ranked model to priority combo:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update priority combo" },
      { status: 500 }
    );
  }
}
