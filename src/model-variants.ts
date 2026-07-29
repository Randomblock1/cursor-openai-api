import type { ModelParameterValue, ModelVariant } from "@cursor/sdk";
import { ProxyError } from "./errors.js";

/**
 * Full-variant model IDs.
 *
 * The catalog's `cursor_variants` array is the deduplicated product of a
 * model's parameters (context × fast × effort × thinking × reasoning × cyber,
 * only the axes the model exposes). Each variant is a distinct, valid combo.
 * We expose every variant as its own model id so clients can select any combo
 * by model name, the way Cursor's own picker does.
 *
 * Variant id shape:  <baseId>__<shortKey><value>-<shortKey><value>...
 * params are sorted by id so the id is stable. The `__` separator is chosen
 * because no catalog id contains it (verified), so it cannot collide with a
 * real model id and does not trip the legacy `-fast` / `-slow` suffix parser.
 */

export const VARIANT_SEPARATOR = "__";

const SHORT_KEYS: Readonly<Record<string, string>> = {
  context: "ctx",
  effort: "eff",
  thinking: "think",
  reasoning: "reason",
  fast: "fast",
  cyber: "cyber",
};

const LONG_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHORT_KEYS).map(([long, short]) => [short, long]),
);

/** Params sorted by id, matching the order variant ids are built in. */
export function sortParams(
  params: ModelParameterValue[],
): ModelParameterValue[] {
  return [...params].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function encodeParam(p: ModelParameterValue): string {
  const key = SHORT_KEYS[p.id];
  if (!key) {
    throw new ProxyError(
      `Cannot encode unknown catalog param "${p.id}" into a variant id`,
      500,
      "invalid_request_error",
      "unknown_variant_param",
    );
  }
  // Strip characters that would break the `-` segment separator.
  const value = String(p.value).replace(/[-_]/g, "");
  return `${key}${value}`;
}

function decodeSegment(segment: string): ModelParameterValue | null {
  // Longest short key first so "think" wins over a hypothetical "t..." prefix.
  for (const shortKey of Object.keys(LONG_KEYS).sort(
    (a, b) => b.length - a.length,
  )) {
    if (segment.startsWith(shortKey)) {
      const longKey = LONG_KEYS[shortKey];
      if (!longKey) return null;
      return { id: longKey, value: segment.slice(shortKey.length) };
    }
  }
  return null;
}

/** Build a stable variant model id from a base id and its param set. */
export function variantModelId(
  baseId: string,
  params: ModelParameterValue[],
): string {
  const suffix = sortParams(params)
    .map(encodeParam)
    .join("-");
  return suffix ? `${baseId}${VARIANT_SEPARATOR}${suffix}` : baseId;
}

export type ParsedVariantId = {
  baseId: string;
  params: ModelParameterValue[];
};

/**
 * Parse a `base__...` variant id back to its base id and param set.
 * Returns undefined when the id is not a variant id (no `__`, or a segment
 * failed to decode), so callers can fall through to other resolution paths.
 */
export function parseVariantId(requestedId: string): ParsedVariantId | undefined {
  const sep = requestedId.indexOf(VARIANT_SEPARATOR);
  if (sep < 0) return undefined;
  const baseId = requestedId.slice(0, sep);
  const tail = requestedId.slice(sep + VARIANT_SEPARATOR.length);
  if (!baseId || !tail) return undefined;

  const params: ModelParameterValue[] = [];
  for (const segment of tail.split("-")) {
    const param = decodeSegment(segment);
    if (!param) return undefined;
    params.push(param);
  }
  if (params.length === 0) return undefined;
  return { baseId, params };
}

/**
 * Validate that a parsed param set is one the catalog model actually offers.
 * Cursor's `cursor_variants` is the source of truth for valid combos; rejecting
 * anything outside it keeps clients from selecting a combo Cursor would reject.
 */
export function validateVariantParams(
  params: ModelParameterValue[],
  variants: ModelVariant[] | undefined,
): void {
  if (!variants || variants.length === 0) {
    throw new ProxyError(
      "Model does not expose any variants",
      400,
      "invalid_request_error",
      "no_variants",
    );
  }
  const requested = sortParams(params)
    .map((p) => `${p.id}=${p.value}`)
    .join("|");
  const known = new Set(
    variants.map((v) =>
      sortParams(v.params)
        .map((p) => `${p.id}=${p.value}`)
        .join("|"),
    ),
  );
  if (!known.has(requested)) {
    throw new ProxyError(
      `Model variant not found for params "${requested}"`,
      400,
      "invalid_request_error",
      "unknown_variant",
    );
  }
}

/** Human-readable label for a variant, e.g. "Opus 5 · 1m · high · fast". */
export function variantDisplayName(
  baseName: string | undefined,
  params: ModelParameterValue[],
): string {
  const parts: string[] = [];
  for (const p of sortParams(params)) {
    // Show only the values that represent a real choice. Skip binary flags
    // at their inactive value (cyber/thinking=false) and keep fast=true as
    // "fast" and thinking=true as "thinking" for compact labels.
    if (p.id === "cyber" && p.value === "false") continue;
    if (p.id === "thinking" && p.value === "false") continue;
    if (p.id === "fast" && p.value === "false") continue;
    if (p.id === "fast" && p.value === "true") {
      parts.push("fast");
      continue;
    }
    if (p.id === "thinking" && p.value === "true") {
      parts.push("thinking");
      continue;
    }
    parts.push(p.value);
  }
  const suffix = parts.length ? ` · ${parts.join(" · ")}` : "";
  return `${baseName ?? "Model"}${suffix}`;
}
