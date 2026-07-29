import type { SDKModel } from "@cursor/sdk";
import { listCachedModels } from "./model-catalog-cache.js";
import {
  variantModelId,
  variantDisplayName,
} from "./model-variants.js";
import type { ModelsListResponse, OpenAIModel } from "./openai.js";

const MODEL_CREATED = 1700000000;

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
 * Build one model entry per catalog variant, so clients can select any valid
 * param combo by model id (e.g. `claude-opus-5__ctx1m-effhigh-fasttrue`).
 * The base entry (no params) is always emitted first and uses the proxy's
 * default variant, so clients that want "just the model" still work.
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

export async function listModels(apiKey: string): Promise<ModelsListResponse> {
  const models = await listCachedModels(apiKey);
  const catalogIds = new Set(models.map((m) => m.id));
  const data: OpenAIModel[] = [];

  for (const m of models) {
    data.push(catalogModelToOpenAI(m));

    const variants = m.variants ?? [];
    // A single variant that is the default adds no selectable choice beyond the
    // base entry, so skip it to avoid a redundant id equal to the base.
    if (variants.length <= 1) continue;

    const defaultKey = variantSignature(
      variants.find((v) => v.isDefault)?.params ?? [],
    );
    for (const v of variants) {
      // Skip the default variant: the base entry already represents it.
      if (variantSignature(v.params) === defaultKey) continue;
      const id = variantModelId(m.id, v.params);
      // Defensive: never shadow a real catalog id.
      if (catalogIds.has(id)) continue;
      data.push(
        variantOpenAIModel(m, v.params, variantDisplayName(m.displayName, v.params)),
      );
    }
  }

  return { object: "list", data };
}

function variantSignature(
  params: { id: string; value: string }[],
): string {
  return [...params]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}=${p.value}`)
    .join("|");
}
