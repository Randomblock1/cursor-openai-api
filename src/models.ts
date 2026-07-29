import type { SDKModel } from "@cursor/sdk";
import { listCachedModels } from "./model-catalog-cache.js";
import {
  variantModelId,
  variantDisplayName,
} from "./model-variants.js";
import type { ModelsListResponse, OpenAIModel } from "./openai.js";

const MODEL_CREATED = 1700000000;

// Axes flattened into their own model ids (selectable by model name).
const FLATTENED_AXES = new Set(["context", "fast"]);
// Thinking-control axes are left runtime-controllable via reasoning_effort /
// cursor_model_params, so they are NOT flattened into model ids.
const THINKING_AXES = new Set(["effort", "reasoning", "thinking"]);

function catalogModelToOpenAI(m: SDKModel): OpenAIModel {
  return {
    id: m.id,
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    ...(m.displayName ? { display_name: m.displayName } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(m.aliases?.length ? { cursor_aliases: m.aliases } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    ...(m.variants?.length ? { cursor_variants: m.variants } : {}),
  };
}

/**
 * Build one model entry per context × fast combo, leaving the thinking axis
 * (effort / reasoning / thinking) at the default variant's value so it stays
 * runtime-controllable via reasoning_effort. The base entry (default combo)
 * is always emitted first.
 */
function variantOpenAIModel(
  m: SDKModel,
  params: NonNullable<SDKModel["variants"]>[number]["params"],
  displayName: string,
): OpenAIModel {
  return {
    id: variantModelId(m.id, params),
    object: "model",
    created: MODEL_CREATED,
    owned_by: "cursor",
    display_name: displayName,
    ...(m.description ? { description: m.description } : {}),
    ...(m.parameters?.length ? { cursor_parameters: m.parameters } : {}),
    cursor_base_model: m.id,
    cursor_model_params: params,
  };
}

type Param = { id: string; value: string };

/** Keep only the axes we flatten (context, fast); drop thinking axes. */
function flattenedParams(params: Param[]): Param[] {
  return params.filter((p) => FLATTENED_AXES.has(p.id));
}

/** The default variant's thinking-axis values, for display labels. */
function defaultThinkingValues(variants: NonNullable<SDKModel["variants"]>): {
  [id: string]: string;
} {
  const def = variants.find((v) => v.isDefault) ?? variants[0];
  if (!def) return {};
  const out: { [id: string]: string } = {};
  for (const p of def.params) {
    if (THINKING_AXES.has(p.id)) out[p.id] = p.value;
  }
  return out;
}

export async function listModels(apiKey: string): Promise<ModelsListResponse> {
  const models = await listCachedModels(apiKey);
  const catalogIds = new Set(models.map((m) => m.id));
  const data: OpenAIModel[] = [];

  for (const m of models) {
    data.push(catalogModelToOpenAI(m));

    const variants = m.variants ?? [];
    if (variants.length === 0) continue;

    // Collapse variants to their context × fast projection and dedupe. The
    // thinking axis is dropped from the id so it stays runtime-controllable.
    const seen = new Set<string>();
    const defVariant = variants.find((v) => v.isDefault) ?? variants[0];
    const defaultKey = defVariant
      ? paramKey(flattenedParams(defVariant.params))
      : "";
    const thinkDefaults = defaultThinkingValues(variants);

    for (const v of variants) {
      const params = flattenedParams(v.params);
      const key = paramKey(params);
      // One entry per unique context × fast combo; skip the default combo
      // (the base entry already represents it).
      if (seen.has(key)) continue;
      seen.add(key);
      if (key === defaultKey) continue;

      const id = variantModelId(m.id, params);
      if (catalogIds.has(id)) continue;

      // Display only the flattened axes; thinking defaults stay implicit and
      // runtime-adjustable, so they do not clutter the model name.
      data.push(
        variantOpenAIModel(m, params, variantDisplayName(m.displayName, params)),
      );
    }
  }

  return { object: "list", data };
}

function paramKey(params: Param[]): string {
  return [...params]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}=${p.value}`)
    .join("|");
}
