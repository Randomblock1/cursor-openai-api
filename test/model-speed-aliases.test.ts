import { afterEach, describe, expect, test } from "bun:test";
import {
  buildRelaySendOptions,
  InteractionRelay,
} from "../src/client-tools/relay.js";
import {
  clearModelCatalogCacheForTests,
  seedModelCatalogForTests,
} from "../src/model-catalog-cache.js";
import {
  FAST_MODEL_PARAM_ID,
  fastParamValueForSpeedAlias,
  modelSupportsSpeedAliases,
  resolveRequestedModelId,
  resolveSpeedAliasParams,
  speedAliasModelId,
} from "../src/model-aliases.js";
import { mergeModelParams, resolveModel } from "../src/model.js";
import { listModels } from "../src/models.js";
import { createStreamState } from "../src/stream.js";
import { resolveTurnStreamContext } from "../src/turn-stream.js";
import {
  composerCatalogEntry,
  noFastCatalogEntry,
  testProxyConfig,
} from "./helpers/test-config.js";

const config = testProxyConfig();

afterEach(() => {
  clearModelCatalogCacheForTests();
});

describe("resolveRequestedModelId", () => {
  const catalog = new Set(["composer-2.5", "claude-opus-4-7"]);

  test("keeps exact catalog ids", () => {
    expect(resolveRequestedModelId("composer-2.5", catalog)).toEqual({
      baseId: "composer-2.5",
    });
  });

  test("parses -slow suffix", () => {
    expect(resolveRequestedModelId("composer-2.5-slow", catalog)).toEqual({
      baseId: "composer-2.5",
      speedAlias: "slow",
    });
  });

  test("parses -fast suffix", () => {
    expect(resolveRequestedModelId("claude-opus-4-7-fast", catalog)).toEqual({
      baseId: "claude-opus-4-7",
      speedAlias: "fast",
    });
  });

  test("prefers exact id over suffix when in catalog", () => {
    const ids = new Set(["weird-fast"]);
    expect(resolveRequestedModelId("weird-fast", ids)).toEqual({ baseId: "weird-fast" });
  });
});

describe("modelSupportsSpeedAliases", () => {
  test("requires both fast param values on catalog model", () => {
    expect(
      modelSupportsSpeedAliases({
        parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      }),
    ).toBe(true);
    expect(
      modelSupportsSpeedAliases({
        parameters: [{ id: "fast", values: [{ value: "true" }] }],
      }),
    ).toBe(false);
    expect(
      modelSupportsSpeedAliases({ parameters: [{ id: "max_mode", values: [] }] }),
    ).toBe(false);
  });
});

describe("resolveSpeedAliasParams", () => {
  const composer = {
    id: "composer-2.5",
    parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
  };

  test("returns alias fast value", () => {
    expect(
      resolveSpeedAliasParams({
        requestedId: "composer-2.5-slow",
        baseId: "composer-2.5",
        speedAlias: "slow",
        catalogModel: composer,
        validateAgainstCatalog: true,
      }),
    ).toBe("false");
  });

  test("rejects unknown base when validating", () => {
    expect(() =>
      resolveSpeedAliasParams({
        requestedId: "missing-slow",
        baseId: "missing",
        speedAlias: "slow",
        catalogModel: undefined,
        validateAgainstCatalog: true,
      }),
    ).toThrow();
  });

  test("rejects alias when model has no fast param", () => {
    expect(() =>
      resolveSpeedAliasParams({
        requestedId: "legacy-slow",
        baseId: "legacy",
        speedAlias: "slow",
        catalogModel: { id: "legacy", parameters: [{ id: "max_mode", values: [] }] },
        validateAgainstCatalog: true,
      }),
    ).toThrow();
  });

  test("rejects alias when fast param does not support both values", () => {
    expect(() =>
      resolveSpeedAliasParams({
        requestedId: "one-way-slow",
        baseId: "one-way",
        speedAlias: "slow",
        catalogModel: {
          id: "one-way",
          parameters: [{ id: "fast", values: [{ value: "true" }] }],
        },
        validateAgainstCatalog: true,
      }),
    ).toThrow();
  });
});

describe("mergeModelParams speed alias", () => {
  test("keeps explicit params as highest-precedence merge input", () => {
    const params = mergeModelParams({
      explicit: [{ id: FAST_MODEL_PARAM_ID, value: "true" }],
      aliasFastValue: "false",
    });
    expect(params).toEqual([{ id: "fast", value: "true" }]);
  });

  test("applies speed alias when no explicit fast param", () => {
    const params = mergeModelParams({
      aliasFastValue: "false",
    });
    expect(params).toEqual([{ id: "fast", value: "false" }]);
  });
});

describe("speedAliasModelId", () => {
  test("builds predictable ids", () => {
    expect(speedAliasModelId("composer-2.5", "slow")).toBe("composer-2.5-slow");
    expect(speedAliasModelId("gpt-5.5", "fast")).toBe("gpt-5.5-fast");
    expect(fastParamValueForSpeedAlias("slow")).toBe("false");
    expect(fastParamValueForSpeedAlias("fast")).toBe("true");
  });
});

describe("resolveModel speed aliases", () => {
  test("composer-2.5-slow disables fast mode", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    const resolved = await resolveModel(
      { messages: [{ role: "user", content: "hi" }], model: "composer-2.5-slow" },
      config,
      false,
    );
    expect(resolved.clientModel).toBe("composer-2.5-slow");
    expect(resolved.sdk).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
  });

  test("composer-2.5-fast enables fast mode", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    const resolved = await resolveModel(
      { messages: [{ role: "user", content: "hi" }], model: "composer-2.5-fast" },
      config,
      false,
    );
    expect(resolved.sdk.params).toEqual([{ id: "fast", value: "true" }]);
  });

  test("matching explicit cursor_model_params are allowed with alias", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    const resolved = await resolveModel(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "composer-2.5-slow",
        cursor_model_params: [{ id: "fast", value: "false" }],
      },
      config,
      false,
    );
    expect(resolved.sdk.params).toEqual([{ id: "fast", value: "false" }]);
  });

  test("conflicting explicit cursor_model_params reject alias", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    await expect(
      resolveModel(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "composer-2.5-slow",
          cursor_model_params: [{ id: "fast", value: "true" }],
        },
        config,
        false,
      ),
    ).rejects.toMatchObject({ status: 400, code: "conflicting_speed_alias" });
  });

  test("unknown base id for alias returns 400", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    await expect(
      resolveModel(
        { messages: [{ role: "user", content: "hi" }], model: "no-such-model-slow" },
        config,
        false,
      ),
    ).rejects.toMatchObject({ status: 400, code: "model_not_found" });
  });

  test("speed alias on model without fast param returns 400", async () => {
    seedModelCatalogForTests("test-key", [noFastCatalogEntry]);
    await expect(
      resolveModel(
        { messages: [{ role: "user", content: "hi" }], model: "legacy-model-slow" },
        config,
        false,
      ),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_speed_alias" });
  });
});

describe("buildRelaySendOptions", () => {
  test("includes per-send SDK model from resolved alias", async () => {
    seedModelCatalogForTests("test-key", [composerCatalogEntry]);
    const request = {
      messages: [{ role: "user", content: "hi" }],
      model: "composer-2.5-slow",
    };
    const resolved = await resolveModel(request, config, false);
    const state = createStreamState(resolved.clientModel);
    resolveTurnStreamContext(request, config);

    const options = buildRelaySendOptions(new InteractionRelay(), resolved.sdk);

    expect(options.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(state.model).toBe("composer-2.5-slow");
    expect(typeof options.onDelta).toBe("function");
    expect("local" in options).toBe(false);
  });
});

describe("listModels speed aliases", () => {
  test("expands fast-capable models with slow and fast rows", async () => {
    seedModelCatalogForTests("list-key", [composerCatalogEntry, noFastCatalogEntry]);
    const { data } = await listModels("list-key");

    expect(data.map((m) => m.id)).toEqual([
      "composer-2.5",
      "composer-2.5-slow",
      "composer-2.5-fast",
      "legacy-model",
    ]);

    const slow = data.find((m) => m.id === "composer-2.5-slow");
    expect(slow).toMatchObject({
      cursor_base_model: "composer-2.5",
      cursor_speed_alias: "slow",
      cursor_model_params: [{ id: "fast", value: "false" }],
      display_name: "Composer 2.5 (Slow)",
    });
    expect(slow?.cursor_variants).toBeUndefined();

    const fast = data.find((m) => m.id === "composer-2.5-fast");
    expect(fast).toMatchObject({
      cursor_base_model: "composer-2.5",
      cursor_speed_alias: "fast",
      cursor_model_params: [{ id: "fast", value: "true" }],
      display_name: "Composer 2.5 (Fast)",
    });
    expect(fast?.cursor_variants).toBeUndefined();
  });

  test("does not emit speed alias rows that collide with real catalog ids", async () => {
    seedModelCatalogForTests("list-key", [
      composerCatalogEntry,
      {
        id: "composer-2.5-fast",
        displayName: "Real Composer Fast",
        parameters: [{ id: "max_mode", values: [{ value: "on" }] }],
      },
    ]);
    const { data } = await listModels("list-key");

    const fastRows = data.filter((m) => m.id === "composer-2.5-fast");
    expect(fastRows).toHaveLength(1);
    expect(fastRows[0]).toMatchObject({ display_name: "Real Composer Fast" });
    expect(fastRows[0]?.cursor_base_model).toBeUndefined();
    expect(data.map((m) => m.id)).toEqual([
      "composer-2.5",
      "composer-2.5-slow",
      "composer-2.5-fast",
    ]);
  });
});
