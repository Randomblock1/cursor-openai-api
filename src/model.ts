import type {
  ModelListItem,
  ModelParameterValue,
  ModelSelection,
} from "@cursor/sdk";
import type { AppConfig } from "./config.js";
import type { ChatCompletionRequest } from "./openai.js";
import { ProxyError } from "./errors.js";
import {
  FAST_MODEL_PARAM_ID,
  type FastParamValue,
  requestedIdHasSpeedSuffix,
  resolveRequestedModelId,
  resolveSpeedAliasParams,
} from "./model-aliases.js";
import {
  parseVariantId,
  validateVariantParams,
} from "./model-variants.js";
import { listCachedModels } from "./model-catalog-cache.js";
import { resolveIncludeThinking } from "./turn-policy.js";

/** Proxy resolution of a request model id → SDK selection + client echo id. */
export type ResolvedModel = {
  /** Model id echoed on OpenAI responses (preserves `*-slow` / `*-fast` aliases). */
  clientModel: string;
  /** Cursor SDK model for `Agent.create` / `agent.send`. */
  sdk: ModelSelection;
};

function buildSdkModelSelection(
  id: string,
  params?: ModelParameterValue[],
): ModelSelection {
  return params ? { id, params } : { id };
}

export type MergeModelParamsInput = {
  explicit?: ModelParameterValue[];
  reasoningEffort?: string;
  effortParamId?: string;
  autoThinkingEffort?: string;
  aliasFastValue?: FastParamValue;
};

function paramIdLooksLikeThinkingEffort(
  id: string,
  displayName?: string,
): boolean {
  if (
    id === "thinking_effort" ||
    id === "thinking" ||
    id === "effort" ||
    id === "reasoning"
  ) {
    return true;
  }
  return displayName?.toLowerCase().includes("thinking") ?? false;
}

export function findThinkingEffortParamId(
  model: Pick<ModelListItem, "parameters" | "variants"> | undefined,
): string | undefined {
  if (!model) return undefined;

  const fromParameters = model.parameters?.find((p) =>
    paramIdLooksLikeThinkingEffort(p.id, p.displayName),
  )?.id;
  if (fromParameters) return fromParameters;

  for (const variant of model.variants ?? []) {
    for (const param of variant.params) {
      if (paramIdLooksLikeThinkingEffort(param.id)) return param.id;
    }
  }

  return undefined;
}

export function defaultThinkingEffortValue(
  model: ModelListItem,
  effortParamId: string,
): string {
  const fromDefaultVariant = model.variants?.find((v) => v.isDefault)?.params;
  const variantValue = fromDefaultVariant?.find((p) => p.id === effortParamId)?.value;
  if (variantValue) return variantValue;

  const param = model.parameters?.find((p) => p.id === effortParamId);
  return param?.values[0]?.value ?? "medium";
}

export function mergeModelParams(
  input: MergeModelParamsInput,
): ModelParameterValue[] | undefined {
  const {
    explicit,
    reasoningEffort,
    effortParamId,
    autoThinkingEffort,
    aliasFastValue,
  } = input;
  // Precedence (low → high): autoThinking → reasoningEffort → aliasFast → explicit.
  // resolveModel rejects explicit fast values that conflict with a speed alias.
  const byId = new Map<string, string>();
  if (effortParamId && autoThinkingEffort !== undefined) {
    byId.set(effortParamId, autoThinkingEffort);
  }
  if (effortParamId && reasoningEffort !== undefined) {
    byId.set(effortParamId, reasoningEffort);
  }
  if (aliasFastValue !== undefined) {
    byId.set(FAST_MODEL_PARAM_ID, aliasFastValue);
  }
  for (const param of explicit ?? []) {
    byId.set(param.id, param.value);
  }
  if (byId.size === 0) return undefined;
  return [...byId.entries()].map(([id, value]) => ({ id, value }));
}

export function requiresModelCatalog(
  requestedId: string,
  options: {
    reasoningEffort?: ChatCompletionRequest["reasoning_effort"];
    includeThinking: boolean;
  },
): boolean {
  return (
    options.reasoningEffort !== undefined ||
    options.includeThinking ||
    requestedIdHasSpeedSuffix(requestedId) ||
    parseVariantId(requestedId) !== undefined
  );
}

export async function resolveModel(
  request: ChatCompletionRequest,
  config: AppConfig,
  includeThinking = resolveIncludeThinking(request, config),
): Promise<ResolvedModel> {
  const requestedId = request.model ?? config.DEFAULT_MODEL;
  const explicit = request.cursor_model_params;

  if (explicit?.some((p) => !p.id?.trim())) {
    throw new ProxyError(
      "cursor_model_params entries require a non-empty id",
      400,
      "invalid_request_error",
      "invalid_cursor_model_params",
    );
  }

  const needsCatalog = requiresModelCatalog(requestedId, {
    reasoningEffort: request.reasoning_effort,
    includeThinking,
  });

  const catalog = needsCatalog
    ? await listCachedModels(config.CURSOR_API_KEY)
    : undefined;
  const catalogIds = catalog ? new Set(catalog.map((m) => m.id)) : undefined;

  // Full-variant ids (`base__ctx1m-effhigh-fasttrue`) resolve to their base
  // model with the encoded params injected as explicit params. This path takes
  // precedence over speed aliases and auto-thinking so the selected combo wins.
  const variant = parseVariantId(requestedId);
  if (variant) {
    const catalogModel = catalog?.find((m) => m.id === variant.baseId);
    if (needsCatalog && !catalogModel) {
      throw new ProxyError(
        `Model "${requestedId}" is unknown (resolved base id "${variant.baseId}")`,
        400,
        "invalid_request_error",
        "model_not_found",
      );
    }
    validateVariantParams(variant.params, catalogModel?.variants);

    // Variant ids encode only context × fast; the thinking/effort axis stays
    // runtime-controllable via reasoning_effort and includeThinking, identical
    // to the non-variant path. Run the same validation + auto-thinking flow so
    // variant-id requests don't silently drop reasoning_effort.
    const effortParamId = findThinkingEffortParamId(catalogModel);

    if (request.reasoning_effort !== undefined && !effortParamId) {
      throw new ProxyError(
        `Model "${requestedId}" does not support reasoning_effort`,
        400,
        "invalid_request_error",
        "unsupported_reasoning_effort",
      );
    }

    const reasoningEffort =
      request.reasoning_effort !== undefined && effortParamId
        ? request.reasoning_effort
        : undefined;

    const combinedExplicit = [...variant.params, ...(explicit ?? [])];
    const explicitHasEffort =
      effortParamId != null && combinedExplicit.some((p) => p.id === effortParamId);

    const autoThinkingEffort =
      includeThinking &&
      effortParamId &&
      !explicitHasEffort &&
      request.reasoning_effort === undefined &&
      catalogModel
        ? defaultThinkingEffortValue(catalogModel, effortParamId)
        : undefined;

    const merged = mergeModelParams({
      explicit: combinedExplicit,
      reasoningEffort,
      effortParamId,
      autoThinkingEffort,
    });
    return {
      clientModel: requestedId,
      sdk: buildSdkModelSelection(variant.baseId, merged),
    };
  }

  const { baseId, speedAlias } = resolveRequestedModelId(requestedId, catalogIds);
  const catalogModel = catalog?.find((m) => m.id === baseId);

  const aliasFastValue = resolveSpeedAliasParams({
    requestedId,
    baseId,
    speedAlias,
    catalogModel,
    validateAgainstCatalog: needsCatalog,
  });
  const explicitFastValue = explicit?.find((p) => p.id === FAST_MODEL_PARAM_ID)?.value;
  if (
    aliasFastValue !== undefined &&
    explicitFastValue !== undefined &&
    explicitFastValue !== aliasFastValue
  ) {
    throw new ProxyError(
      `Model "${requestedId}" conflicts with cursor_model_params fast=${explicitFastValue}`,
      400,
      "invalid_request_error",
      "conflicting_speed_alias",
    );
  }

  const effortParamId = findThinkingEffortParamId(catalogModel);

  if (request.reasoning_effort !== undefined && !effortParamId) {
    throw new ProxyError(
      `Model "${requestedId}" does not support reasoning_effort`,
      400,
      "invalid_request_error",
      "unsupported_reasoning_effort",
    );
  }

  const reasoningEffort =
    request.reasoning_effort !== undefined && effortParamId
      ? request.reasoning_effort
      : undefined;

  const explicitHasEffort =
    effortParamId != null && explicit?.some((p) => p.id === effortParamId);

  const autoThinkingEffort =
    includeThinking &&
    effortParamId &&
    !explicitHasEffort &&
    request.reasoning_effort === undefined &&
    catalogModel
      ? defaultThinkingEffortValue(catalogModel, effortParamId)
      : undefined;

  const params = mergeModelParams({
    explicit,
    reasoningEffort,
    effortParamId,
    autoThinkingEffort,
    aliasFastValue,
  });

  return {
    clientModel: requestedId,
    sdk: buildSdkModelSelection(baseId, params),
  };
}
