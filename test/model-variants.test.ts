import { afterEach, describe, expect, test } from "bun:test";
import {
  parseVariantId,
  validateVariantParams,
  variantModelId,
} from "../src/model-variants.js";
import { resolveModel } from "../src/model.js";
import {
  clearModelCatalogCacheForTests,
  seedModelCatalogForTests,
} from "../src/model-catalog-cache.js";
import { testProxyConfig } from "./helpers/test-config.js";

const config = testProxyConfig();

afterEach(() => {
  clearModelCatalogCacheForTests();
});

describe("variantModelId / parseVariantId round-trip", () => {
  test("preserves hyphens and underscores reversibly", () => {
    const values = ["extra-high", "very_low", "high", "1m", "true", "false", "a-b_c"];
    for (const value of values) {
      const id = variantModelId("base", [{ id: "effort", value }]);
      const parsed = parseVariantId(id);
      expect(parsed?.params[0]?.value).toBe(value);
    }
  });

  test("does not collide distinct values that differ only by -/_", () => {
    const a = variantModelId("base", [{ id: "effort", value: "extra-high" }]);
    const b = variantModelId("base", [{ id: "effort", value: "extrahigh" }]);
    expect(a).not.toBe(b);
    expect(parseVariantId(a)?.params[0]?.value).toBe("extra-high");
    expect(parseVariantId(b)?.params[0]?.value).toBe("extrahigh");
  });

  test("round-trips a literal %2D without decoding it to '-'", () => {
    const id = variantModelId("base", [{ id: "effort", value: "%2D" }]);
    expect(parseVariantId(id)?.params[0]?.value).toBe("%2D");
  });

  test("returns undefined for non-variant ids", () => {
    expect(parseVariantId("composer-2.5")).toBeUndefined();
    expect(parseVariantId("composer-2.5-slow")).toBeUndefined();
  });
});

describe("validateVariantParams", () => {
  const variants = [
    { isDefault: true, params: [{ id: "context", value: "200k" }, { id: "fast", value: "false" }, { id: "effort", value: "low" }] },
    { params: [{ id: "context", value: "1m" }, { id: "fast", value: "true" }, { id: "effort", value: "low" }] },
  ];

  test("accepts a flattened projection (context x fast) of a catalog variant", () => {
    expect(() =>
      validateVariantParams(
        [{ id: "context", value: "1m" }, { id: "fast", value: "true" }],
        variants,
      ),
    ).not.toThrow();
  });

  test("rejects a combo no catalog variant offers", () => {
    expect(() =>
      validateVariantParams(
        [{ id: "context", value: "1m" }, { id: "fast", value: "false" }],
        variants,
      ),
    ).toThrow();
  });

  test("rejects an axis the model does not expose", () => {
    expect(() =>
      validateVariantParams(
        [{ id: "context", value: "1m" }, { id: "cyber", value: "true" }],
        variants,
      ),
    ).toThrow();
  });

  test("rejects when the model exposes no variants", () => {
    expect(() =>
      validateVariantParams([{ id: "fast", value: "true" }], undefined),
    ).toThrow();
  });
});

describe("resolveModel variant ids", () => {
  const thinker = {
    id: "opus",
    displayName: "Opus",
    parameters: [
      { id: "context", values: [{ value: "200k" }, { value: "1m" }] },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
      { id: "effort", values: [{ value: "low" }, { value: "high" }] },
    ],
    variants: [
      { isDefault: true, params: [{ id: "context", value: "200k" }, { id: "fast", value: "false" }, { id: "effort", value: "low" }] },
      { params: [{ id: "context", value: "1m" }, { id: "fast", value: "true" }, { id: "effort", value: "low" }] },
    ],
  };

  test("applies reasoning_effort to a variant-id request", async () => {
    seedModelCatalogForTests("k", [thinker]);
    const resolved = await resolveModel(
      { messages: [{ role: "user", content: "hi" }], model: "opus__ctx1m-fasttrue", reasoning_effort: "high" },
      { ...config, CURSOR_API_KEY: "k" },
      false,
    );
    expect(resolved.sdk.id).toBe("opus");
    expect(resolved.sdk.params).toContainEqual({ id: "effort", value: "high" });
    expect(resolved.sdk.params).toContainEqual({ id: "context", value: "1m" });
    expect(resolved.sdk.params).toContainEqual({ id: "fast", value: "true" });
  });

  test("rejects reasoning_effort on a variant id when the model lacks the axis", async () => {
    const noEffort = {
      id: "basic",
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [
        { isDefault: true, params: [{ id: "fast", value: "false" }] },
        { params: [{ id: "fast", value: "true" }] },
      ],
    };
    seedModelCatalogForTests("k2", [noEffort]);
    await expect(
      resolveModel(
        { messages: [{ role: "user", content: "hi" }], model: "basic__fasttrue", reasoning_effort: "high" },
        { ...config, CURSOR_API_KEY: "k2" },
        false,
      ),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_reasoning_effort" });
  });

  test("injects auto-thinking default when includeThinking is on", async () => {
    seedModelCatalogForTests("k", [thinker]);
    const resolved = await resolveModel(
      { messages: [{ role: "user", content: "hi" }], model: "opus__ctx1m-fasttrue" },
      { ...config, CURSOR_API_KEY: "k" },
      true,
    );
    // Default variant's effort is "low"; includeThinking injects it.
    expect(resolved.sdk.params).toContainEqual({ id: "effort", value: "low" });
  });

  test("rejects an unknown variant combo with unknown_variant", async () => {
    seedModelCatalogForTests("k", [thinker]);
    await expect(
      resolveModel(
        { messages: [{ role: "user", content: "hi" }], model: "opus__ctx1m-fastfalse" },
        { ...config, CURSOR_API_KEY: "k" },
        false,
      ),
    ).rejects.toMatchObject({ status: 400, code: "unknown_variant" });
  });
});
