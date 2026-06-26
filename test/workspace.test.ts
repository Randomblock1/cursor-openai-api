import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cwdIdentity,
  isCwdAllowed,
  parseCwdAllowlist,
  resolveWorkspaceCwd,
} from "../src/workspace.js";
import { testProxyConfig } from "./helpers/test-config.js";

describe("resolveWorkspaceCwd", () => {
  test("falls back to CURSOR_CWD when no override is supplied", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd({ messages: [{ role: "user", content: "hi" }] }, undefined, config),
    ).toBe("/srv/sandbox");
  });

  test("normalizes the default CURSOR_CWD so it matches resolved overrides", () => {
    // A non-normalized default (trailing slash here) must resolve to the same
    // string a later turn produces from `path.resolve`, otherwise cwd-aware
    // session reuse breaks and a new agent is spawned every turn.
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox/" });
    const fromDefault = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }] },
      undefined,
      config,
    );
    const fromOverride = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/sandbox" },
      undefined,
      config,
    );
    expect(fromDefault).toBe("/srv/sandbox");
    expect(fromDefault).toBe(fromOverride);
  });

  test("reads the cursor_cwd request field", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/repo" },
        undefined,
        config,
      ),
    ).toBe("/srv/repo");
  });

  test("reads metadata.cursor_cwd", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], metadata: { cursor_cwd: "/srv/repo" } },
        undefined,
        config,
      ),
    ).toBe("/srv/repo");
  });

  test("reads the x-cursor-cwd header", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }] },
        { "x-cursor-cwd": "/srv/header" },
        config,
      ),
    ).toBe("/srv/header");
  });

  test("field beats metadata beats header", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        {
          messages: [{ role: "user", content: "hi" }],
          cursor_cwd: "/srv/field",
          metadata: { cursor_cwd: "/srv/meta" },
        },
        { "x-cursor-cwd": "/srv/header" },
        config,
      ),
    ).toBe("/srv/field");
  });

  test("resolves relative overrides to absolute paths", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "./nested" },
        undefined,
        config,
      ),
    ).toBe(path.resolve("./nested"));
  });

  test("rejects a cwd outside the allowlist", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/repo,/srv/repos",
    });
    expect(() =>
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/etc" },
        undefined,
        config,
      ),
    ).toThrow(/not permitted/);
  });

  test("allows a cwd nested under an allowlisted root", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/repo",
    });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/repo/sub" },
        undefined,
        config,
      ),
    ).toBe("/srv/repo/sub");
  });

  test("the default CURSOR_CWD is always allowed even when not listed", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/repo",
    });
    expect(
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: "/srv/sandbox" },
        undefined,
        config,
      ),
    ).toBe("/srv/sandbox");
  });
});

describe("resolveWorkspaceCwd multi-root (.code-workspace)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
    fs.mkdirSync(path.join(tmpDir, "repo-a"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "repo-b"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWorkspaceFile(name: string, contents: string): string {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, contents);
    return file;
  }

  test("expands folders[].path into an array of absolute roots", () => {
    const file = writeWorkspaceFile(
      "roots.code-workspace",
      JSON.stringify({
        folders: [{ path: "./repo-a" }, { path: "./repo-b" }],
      }),
    );
    const config = testProxyConfig({ CURSOR_CWD: tmpDir });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
      undefined,
      config,
    );
    expect(result).toEqual([
      path.join(tmpDir, "repo-a"),
      path.join(tmpDir, "repo-b"),
    ]);
  });

  test("expands a `.code-workspace` set as the default CURSOR_CWD (no override)", () => {
    const file = writeWorkspaceFile(
      "default.code-workspace",
      JSON.stringify({
        folders: [{ path: "./repo-a" }, { path: "./repo-b" }],
      }),
    );
    const config = testProxyConfig({ CURSOR_CWD: file });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }] },
      undefined,
      config,
    );
    expect(result).toEqual([
      path.join(tmpDir, "repo-a"),
      path.join(tmpDir, "repo-b"),
    ]);
  });

  test("default workspace roots are trusted — not validated against the allowlist", () => {
    // The operator-set default is implicitly permitted (mirrors single-dir
    // default behavior), so its expanded roots must not be rejected even when an
    // allowlist that excludes them is configured for per-request overrides.
    const file = writeWorkspaceFile(
      "trusted-default.code-workspace",
      JSON.stringify({
        folders: [{ path: "./repo-a" }, { path: "./repo-b" }],
      }),
    );
    const config = testProxyConfig({
      CURSOR_CWD: file,
      CURSOR_CWD_ALLOWLIST: "/some/other/root",
    });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }] },
      undefined,
      config,
    );
    expect(result).toEqual([
      path.join(tmpDir, "repo-a"),
      path.join(tmpDir, "repo-b"),
    ]);
  });

  test("resolves '..'-relative folder paths against the workspace file dir", () => {
    const file = writeWorkspaceFile(
      "nested.code-workspace",
      JSON.stringify({ folders: [{ path: "../repo-a" }] }),
    );
    const config = testProxyConfig({ CURSOR_CWD: tmpDir });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
      undefined,
      config,
    );
    expect(result).toEqual([path.resolve(tmpDir, "../repo-a")]);
  });

  test("tolerates JSONC comments in the workspace file", () => {
    const file = writeWorkspaceFile(
      "commented.code-workspace",
      `{
        // first root
        "folders": [
          { "path": "./repo-a" }, /* second root */
          { "path": "./repo-b" }
        ]
      }`,
    );
    const config = testProxyConfig({ CURSOR_CWD: tmpDir });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
      undefined,
      config,
    );
    expect(result).toEqual([
      path.join(tmpDir, "repo-a"),
      path.join(tmpDir, "repo-b"),
    ]);
  });

  test("validates EACH root against the allowlist", () => {
    const file = writeWorkspaceFile(
      "mixed.code-workspace",
      JSON.stringify({ folders: [{ path: "./repo-a" }, { path: "/etc" }] }),
    );
    const config = testProxyConfig({
      CURSOR_CWD: tmpDir,
      CURSOR_CWD_ALLOWLIST: tmpDir,
    });
    expect(() =>
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
        undefined,
        config,
      ),
    ).toThrow(/not permitted/);
  });

  test("accepts a multi-root workspace when every root is allowlisted", () => {
    const file = writeWorkspaceFile(
      "allowed.code-workspace",
      JSON.stringify({
        folders: [{ path: "./repo-a" }, { path: "./repo-b" }],
      }),
    );
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: tmpDir,
    });
    const result = resolveWorkspaceCwd(
      { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
      undefined,
      config,
    );
    expect(result).toEqual([
      path.join(tmpDir, "repo-a"),
      path.join(tmpDir, "repo-b"),
    ]);
  });

  test("rejects an unreadable workspace file with a 400", () => {
    const config = testProxyConfig({ CURSOR_CWD: tmpDir });
    expect(() =>
      resolveWorkspaceCwd(
        {
          messages: [{ role: "user", content: "hi" }],
          cursor_cwd: path.join(tmpDir, "missing.code-workspace"),
        },
        undefined,
        config,
      ),
    ).toThrow(/could not be read/);
  });

  test("rejects a workspace file with no folders array", () => {
    const file = writeWorkspaceFile(
      "empty.code-workspace",
      JSON.stringify({ settings: {} }),
    );
    const config = testProxyConfig({ CURSOR_CWD: tmpDir });
    expect(() =>
      resolveWorkspaceCwd(
        { messages: [{ role: "user", content: "hi" }], cursor_cwd: file },
        undefined,
        config,
      ),
    ).toThrow(/no 'folders' array/);
  });
});

describe("cwdIdentity", () => {
  test("returns a single string unchanged", () => {
    expect(cwdIdentity("/work/a")).toBe("/work/a");
  });

  test("a single-root array is identified by that root", () => {
    expect(cwdIdentity(["/work/a"])).toBe("/work/a");
  });

  test("returns empty string for an empty array", () => {
    expect(cwdIdentity([])).toBe("");
  });

  test("identifies a multi-root workspace by its full sorted root set", () => {
    expect(cwdIdentity(["/work/a", "/work/b"])).toBe("/work/a\n/work/b");
  });

  test("is order-independent (declared order does not fork identity)", () => {
    expect(cwdIdentity(["/work/b", "/work/a"])).toBe(
      cwdIdentity(["/work/a", "/work/b"]),
    );
  });

  test("two workspaces sharing a first root get DISTINCT identities (no collision)", () => {
    const first = cwdIdentity(["/repo", "/work/a"]);
    const second = cwdIdentity(["/repo", "/work/b"]);
    expect(first).not.toBe(second);
  });
});

describe("isCwdAllowed", () => {
  test("unrestricted when no allowlist is configured", () => {
    const config = testProxyConfig({ CURSOR_CWD: "/srv/sandbox" });
    expect(isCwdAllowed("/anywhere/at/all", config)).toBe(true);
  });

  test("a root equal to an allowlisted entry is permitted", () => {
    const config = testProxyConfig({
      CURSOR_CWD: "/srv/sandbox",
      CURSOR_CWD_ALLOWLIST: "/srv/repo",
    });
    expect(isCwdAllowed("/srv/repo", config)).toBe(true);
    expect(isCwdAllowed("/srv/repo-evil", config)).toBe(false);
  });
});

describe("parseCwdAllowlist", () => {
  test("splits, trims, and resolves entries", () => {
    expect(parseCwdAllowlist(" /srv/a , /srv/b ")).toEqual([
      path.resolve("/srv/a"),
      path.resolve("/srv/b"),
    ]);
  });

  test("returns an empty list for undefined/empty input", () => {
    expect(parseCwdAllowlist(undefined)).toEqual([]);
    expect(parseCwdAllowlist("  ")).toEqual([]);
  });
});
