import type { AppConfig } from "../config.js";
import { isRecord } from "./guards.js";
import type { ClientToolSpec } from "./types.js";

/**
 * Progressive disclosure for the client-tool inventory.
 *
 * Key realization: the model does not need a tool's full prose JSON schema to
 * emit a correct tool call — it only needs the tool name and its argument
 * names. The caller already holds the real schemas. So rarely-used
 * tools can be registered as a compact signature (`name(arg1, arg2?) — summary`)
 * instead of the full schema, end-to-end, with no upstream change and no
 * meta-tool round trip. Tiering is load-bearing for token parity on the native
 * customTools channel.
 *
 * Tiers:
 *  - `full`   : every tool gets its full JSON schema (legacy behavior).
 *  - `tiered` : resident tools get full schemas; the rest get brief signatures.
 *  - `brief`  : every tool gets a brief signature.
 *
 * Tier config is ENV-only (provider-neutral): `CURSOR_TOOL_TIER` /
 * `CURSOR_TOOL_RESIDENT`. There are intentionally no per-request tier fields so
 * the wire format stays a standard OpenAI request.
 */

export const TOOL_TIER_MODES = ["full", "tiered", "brief"] as const;
export type ToolTierMode = (typeof TOOL_TIER_MODES)[number];

// Default tier when config/env are silent. `tiered` keeps the high-frequency
// resident tools' full schemas and renders the long tail as compact signatures,
// cutting the injected inventory's token cost.
export const DEFAULT_TOOL_TIER_MODE: ToolTierMode = "tiered";

/**
 * Tools that stay resident (full schema) in `tiered` mode when
 * `CURSOR_TOOL_RESIDENT` is not set. Empty by default so the proxy stays
 * provider-neutral: with no opt-in, `tiered` mode renders every tool as a
 * compact signature. Deployments that know their high-frequency tools can list
 * them via `CURSOR_TOOL_RESIDENT` to keep those full-schema.
 */
export const DEFAULT_RESIDENT_TOOLS: readonly string[] = [];

export interface ToolTierPolicy {
  mode: ToolTierMode;
  resident: Set<string>;
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : undefined;
}

function parseTierMode(value: string | undefined): ToolTierMode | undefined {
  return (TOOL_TIER_MODES as readonly string[]).includes(value ?? "")
    ? (value as ToolTierMode)
    : undefined;
}

/**
 * Resolve the tier policy from config/env only (no request fields). Defaults to
 * `tiered` mode with an empty resident set (every tool compact) until a
 * deployment opts specific tools into full-schema via `CURSOR_TOOL_RESIDENT`.
 */
export function resolveToolTier(config: AppConfig): ToolTierPolicy {
  const mode = parseTierMode(config.CURSOR_TOOL_TIER) ?? DEFAULT_TOOL_TIER_MODE;
  const resident =
    parseList(config.CURSOR_TOOL_RESIDENT) ?? DEFAULT_RESIDENT_TOOLS;
  return { mode, resident: new Set(resident) };
}

/** First sentence of a description, whitespace-collapsed and length-capped. */
export function firstSentence(text: string, max = 160): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const period = trimmed.indexOf(". ");
  let sentence = period === -1 ? trimmed : trimmed.slice(0, period + 1);
  if (sentence.length > max) {
    sentence = `${sentence.slice(0, max - 1).trimEnd()}…`;
  }
  return sentence;
}

/** `name(req, opt?)` — argument names from the JSON schema, `?` = optional. */
export function toolSignature(spec: ClientToolSpec): string {
  const params = isRecord(spec.parameters) ? spec.parameters : undefined;
  const properties = isRecord(params?.properties) ? params.properties : undefined;
  if (!properties) return `${spec.name}()`;

  const required = new Set(
    Array.isArray(params?.required)
      ? (params.required as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
  );
  const args = Object.keys(properties).map((key) =>
    required.has(key) ? key : `${key}?`,
  );
  return `${spec.name}(${args.join(", ")})`;
}

/** Compact one-line catalog entry: `name(args) — first sentence`. */
export function briefToolLine(spec: ClientToolSpec): string {
  const signature = toolSignature(spec);
  const summary = spec.description ? firstSentence(spec.description) : "";
  return summary ? `${signature} — ${summary}` : signature;
}

/**
 * Minimal JSON Schema for a long-tail (brief-tier) tool registered on the
 * native `customTools` channel: the argument NAMES only (and which are
 * required), with no per-property prose/types/enums. The executor still holds
 * the real schema and validates on execution, so the model needs only the arg
 * names to emit a correct native call — this is the native-channel analog of
 * `briefToolLine`. Returns a plain JSON object (the bridge casts it to the
 * SDK's `SDKJsonValue` record).
 */
export function terseInputSchema(spec: ClientToolSpec): Record<string, unknown> {
  const params = isRecord(spec.parameters) ? spec.parameters : undefined;
  const properties = isRecord(params?.properties) ? params.properties : undefined;
  const schema: Record<string, unknown> = { type: "object" };
  if (properties) {
    const terseProps: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) terseProps[key] = {};
    schema.properties = terseProps;
    const required = Array.isArray(params?.required)
      ? (params.required as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    if (required.length > 0) schema.required = required;
  }
  return schema;
}

export interface ToolTierSplit {
  full: ClientToolSpec[];
  brief: ClientToolSpec[];
}

export function splitToolTiers(
  tools: ClientToolSpec[],
  tier: ToolTierPolicy,
): ToolTierSplit {
  if (tier.mode === "full") return { full: tools, brief: [] };
  if (tier.mode === "brief") return { full: [], brief: tools };
  const full: ClientToolSpec[] = [];
  const brief: ClientToolSpec[] = [];
  for (const tool of tools) {
    (tier.resident.has(tool.name) ? full : brief).push(tool);
  }
  return { full, brief };
}
