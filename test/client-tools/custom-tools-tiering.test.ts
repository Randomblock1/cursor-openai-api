import { describe, expect, test } from "bun:test";
import {
  ClientToolCaptureSink,
  buildClientToolCustomTools,
} from "../../src/client-tools/custom-tools-bridge.js";
import {
  briefToolLine,
  DEFAULT_RESIDENT_TOOLS,
  DEFAULT_TOOL_TIER_MODE,
  resolveToolTier,
  type ToolTierPolicy,
} from "../../src/client-tools/catalog.js";
import type { AppConfig } from "../../src/config.js";
import type { ClientToolSpec } from "../../src/client-tools/types.js";

// A representative tool set: a couple of high-frequency resident tools plus a
// long tail of rarely-used tools with verbose prose schemas (the kind of thing
// that bloats the native customTools channel if registered full).
const resident: ClientToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file from the workspace. Supports reading a " +
      "specific line range via offset and limit, and returns numbered lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file." },
        offset: { type: "number", description: "1-indexed start line." },
        limit: { type: "number", description: "Number of lines to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace. Accepts the command string and " +
      "an optional timeout, and returns combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds." },
      },
      required: ["command"],
    },
  },
];

const longTail: ClientToolSpec[] = [
  {
    name: "search_docs",
    description:
      "Search across the indexed documents for relevant passages. Supports " +
      "full-text queries, date filters, and a configurable result limit. " +
      "Returns ranked snippets with document identifiers so the caller can " +
      "open or cite the originating source.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query." },
        limit: { type: "number", description: "Max results to return." },
        since: { type: "string", description: "ISO date lower bound." },
      },
      required: ["query"],
    },
  },
  {
    name: "store_note",
    description:
      "Durable note store. Use the action field to add, update, remove, or " +
      "list notes. Keep each note to roughly one line; longer detail belongs " +
      "in a linked document.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "remove", "list"],
          description: "Which mutation to perform.",
        },
        entry: { type: "string", description: "The note text." },
        id: { type: "string", description: "Target entry id." },
      },
      required: ["action"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch the contents of a URL and return it as readable markdown. Does " +
      "not support authentication and will not fetch binary content. Useful " +
      "for reading documentation and articles referenced in a task.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Fully-formed URL to fetch." },
      },
      required: ["url"],
    },
  },
];

const allSpecs = [...resident, ...longTail];

const tieredPolicy: ToolTierPolicy = {
  mode: "tiered",
  resident: new Set(["read_file", "run_command"]),
};

// Stable serialization of a customTool map for size comparison. JSON.stringify
// drops the `execute` function automatically, leaving just description +
// inputSchema — exactly the bytes injected onto the native channel.
function serialize(tools: Record<string, unknown>): string {
  return JSON.stringify(tools);
}

describe("buildClientToolCustomTools tiering (Spike C)", () => {
  test("resident tools keep full description + inputSchema", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(allSpecs, sink, tieredPolicy);

    expect(tools.read_file.description).toBe(resident[0].description);
    expect(tools.read_file.inputSchema).toEqual(
      resident[0].parameters as Record<string, unknown>,
    );
    expect(tools.run_command.description).toBe(resident[1].description);
    expect(tools.run_command.inputSchema).toEqual(
      resident[1].parameters as Record<string, unknown>,
    );
  });

  test("long-tail tools get a terse one-line description + arg-names-only schema", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(allSpecs, sink, tieredPolicy);

    for (const spec of longTail) {
      const entry = tools[spec.name];
      // Terse description equals the compact catalog line and is shorter than
      // the original verbose prose.
      expect(entry.description).toBe(briefToolLine(spec));
      expect((entry.description ?? "").length).toBeLessThan(
        (spec.description ?? "").length,
      );

      // Schema lists arg NAMES only — no per-property prose/types/enums.
      const schema = entry.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;
      const originalProps = (spec.parameters as { properties: object })
        .properties;
      expect(Object.keys(props).sort()).toEqual(
        Object.keys(originalProps).sort(),
      );
      for (const key of Object.keys(props)) {
        expect(props[key]).toEqual({});
      }
      // The terse schema is strictly smaller than the original.
      expect(serialize({ s: schema }).length).toBeLessThan(
        serialize({ s: spec.parameters as Record<string, unknown> }).length,
      );
    }
  });

  test("long-tail tools remain present and callable (still in the map)", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(allSpecs, sink, tieredPolicy);

    // Every spec — resident and long tail — is registered with a valid name.
    expect(Object.keys(tools).sort()).toEqual(
      allSpecs.map((s) => s.name).sort(),
    );

    // A long-tail tool still routes through execute into the capture sink.
    const result = tools.search_docs.execute(
      { query: "native routing", limit: 5 },
      {},
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("routed-to-client");
    expect([...sink.captured]).toEqual([
      {
        name: "search_docs",
        arguments: { query: "native routing", limit: 5 },
      },
    ]);
  });

  test("token/char win: tiered map is materially smaller than all-full", () => {
    const fullTools = buildClientToolCustomTools(
      allSpecs,
      new ClientToolCaptureSink(),
    );
    const tieredTools = buildClientToolCustomTools(
      allSpecs,
      new ClientToolCaptureSink(),
      tieredPolicy,
    );

    const fullChars = serialize(fullTools).length;
    const tieredChars = serialize(tieredTools).length;
    const savedChars = fullChars - tieredChars;

    // The tiered map must be a real reduction, not noise.
    expect(tieredChars).toBeLessThan(fullChars);
    expect(savedChars).toBeGreaterThan(0);
  });

  test("no tier (explicit full tier) is byte-for-byte the legacy full build", () => {
    const a = buildClientToolCustomTools(allSpecs, new ClientToolCaptureSink());
    const b = buildClientToolCustomTools(allSpecs, new ClientToolCaptureSink(), {
      mode: "full",
      resident: new Set(),
    });
    // Both omit-or-include description/inputSchema identically and never go terse.
    expect(serialize(a)).toBe(serialize(b));
    for (const spec of allSpecs) {
      expect(a[spec.name].description).toBe(spec.description);
      expect(a[spec.name].inputSchema).toEqual(
        spec.parameters as Record<string, unknown>,
      );
    }
  });
});

describe("resolveToolTier defaults (provider-neutral)", () => {
  test("unset config resolves to tiered mode with an empty resident set", () => {
    const policy = resolveToolTier({} as AppConfig);
    expect(policy.mode).toBe(DEFAULT_TOOL_TIER_MODE);
    expect(policy.mode).toBe("tiered");
    expect(DEFAULT_RESIDENT_TOOLS).toEqual([]);
    expect(policy.resident.size).toBe(0);
  });

  test("with no resident opt-in, tiered mode renders every tool compact", () => {
    const sink = new ClientToolCaptureSink();
    const tools = buildClientToolCustomTools(
      allSpecs,
      sink,
      resolveToolTier({} as AppConfig),
    );
    // Every tool — including the would-be high-frequency ones — is terse.
    for (const spec of allSpecs) {
      expect(tools[spec.name].description).toBe(briefToolLine(spec));
    }
  });

  test("CURSOR_TOOL_RESIDENT opt-in keeps the listed tools full-schema", () => {
    const policy = resolveToolTier({
      CURSOR_TOOL_RESIDENT: "read_file, run_command",
    } as AppConfig);
    expect(policy.mode).toBe("tiered");
    expect([...policy.resident].sort()).toEqual(["read_file", "run_command"]);
  });
});
