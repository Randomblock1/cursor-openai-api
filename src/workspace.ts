import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { ProxyError } from "./errors.js";
import type { ChatCompletionRequest } from "./openai.js";
import type { SessionRequestHeaders } from "./session-keys.js";

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/**
 * Per-request workspace override, mirroring how session id is threaded through
 * metadata + headers. Precedence: explicit `cursor_cwd` field, then
 * `metadata.cursor_cwd` / `metadata.cursorCwd`, then the `x-cursor-cwd` header.
 * Falls back to the server default when nothing is supplied.
 */
function requestedCwd(
  request: ChatCompletionRequest,
  headers?: SessionRequestHeaders,
): string | undefined {
  const meta = request.metadata;
  return (
    trimmed(request.cursor_cwd) ??
    trimmed(meta?.["cursor_cwd"]) ??
    trimmed(meta?.["cursorCwd"]) ??
    trimmed(headers?.["x-cursor-cwd"])
  );
}

export function parseCwdAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A requested cwd is allowed when no allowlist is configured (unrestricted), or
 * when it equals / sits under the configured default or one of the allowlisted
 * roots. The default `CURSOR_CWD` is always implicitly permitted.
 */
export function isCwdAllowed(target: string, config: AppConfig): boolean {
  const roots = parseCwdAllowlist(config.CURSOR_CWD_ALLOWLIST);
  if (roots.length === 0) return true;
  const allowed = [path.resolve(config.CURSOR_CWD), ...roots];
  return allowed.some((root) => isWithinRoot(target, root));
}

// Strip `//` line and `/* */` block comments from JSONC while preserving any
// occurrences inside string literals. VS Code `.code-workspace` files are JSONC,
// so a plain JSON.parse can choke on comments; this is the fallback path.
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Read a `.code-workspace` file and resolve its `folders[].path` entries into
 * absolute roots, relative to the workspace file's own directory. Throws a 400
 * (caller error) when the file is unreadable, not JSON, or has no usable folders.
 */
function resolveWorkspaceFileRoots(workspaceFile: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(workspaceFile, "utf8");
  } catch (err) {
    throw new ProxyError(
      `Workspace file '${workspaceFile}' could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
      400,
      "invalid_request_error",
      "workspace_file_unreadable",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      throw new ProxyError(
        `Workspace file '${workspaceFile}' is not valid JSON`,
        400,
        "invalid_request_error",
        "workspace_file_invalid",
      );
    }
  }

  const folders =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["folders"]
      : undefined;
  if (!Array.isArray(folders)) {
    throw new ProxyError(
      `Workspace file '${workspaceFile}' has no 'folders' array`,
      400,
      "invalid_request_error",
      "workspace_file_invalid",
    );
  }

  const dir = path.dirname(workspaceFile);
  const roots = folders
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)["path"] === "string"
        ? path.resolve(dir, (entry as Record<string, string>)["path"]!)
        : undefined,
    )
    .filter((root): root is string => root !== undefined);

  if (roots.length === 0) {
    throw new ProxyError(
      `Workspace file '${workspaceFile}' 'folders' has no usable path entries`,
      400,
      "invalid_request_error",
      "workspace_file_invalid",
    );
  }
  return roots;
}

function rejectDisallowedCwd(target: string, config: AppConfig): void {
  if (isCwdAllowed(target, config)) return;
  throw new ProxyError(
    `Requested workspace cwd '${target}' is not permitted by CURSOR_CWD_ALLOWLIST`,
    400,
    "invalid_request_error",
    "cwd_not_allowed",
  );
}

/**
 * Resolve the workspace cwd for a turn. Returns a single absolute path, or — for
 * a multi-root `.code-workspace` file — the array of absolute roots it declares
 * (the SDK's `LocalAgentOptions.cwd` accepts `string | string[]`).
 *
 * Precedence: explicit `cursor_cwd` field, then `metadata.cursor_cwd` /
 * `metadata.cursorCwd`, then the `x-cursor-cwd` header, then `CURSOR_CWD`. Every
 * resolved root is validated against `CURSOR_CWD_ALLOWLIST`.
 */
export function resolveWorkspaceCwd(
  request: ChatCompletionRequest,
  headers: SessionRequestHeaders | undefined,
  config: AppConfig,
): string | string[] {
  const requested = requestedCwd(request, headers);
  // The operator-set default (`CURSOR_CWD`) is implicitly trusted; a per-request
  // override is not, and must clear the allowlist. Resolve both the same way:
  // normalize the path (cwd is part of an agent's identity — see `cwdMatches` in
  // session-cache.ts — so a raw, un-normalized value here would not string-equal
  // the `path.resolve()`d cwd a later turn supplies for the same workspace,
  // silently invalidating the keyed session and spawning a fresh agent each turn)
  // and expand a `.code-workspace` file into its declared folder roots.
  const isDefault = !requested;
  const resolved = path.resolve(requested ?? config.CURSOR_CWD);

  // A `.code-workspace` file expands to its declared folder roots so the SDK
  // indexes every root. This applies to the default CURSOR_CWD too — otherwise
  // pointing CURSOR_CWD at a workspace file would hand the SDK a file path, not
  // a directory set. Per-request overrides validate each root against the
  // allowlist; the trusted default skips that check (mirrors the single-dir
  // default always being permitted).
  if (resolved.endsWith(".code-workspace")) {
    const roots = resolveWorkspaceFileRoots(resolved);
    if (!isDefault) {
      for (const root of roots) rejectDisallowedCwd(root, config);
    }
    return roots;
  }

  if (isDefault) return resolved;

  rejectDisallowedCwd(resolved, config);
  return resolved;
}

/**
 * Collapse a resolved cwd into the single canonical string used to key the
 * session cache (see `cwdMatches` in session-cache.ts). A multi-root array is
 * identified by its FULL set of roots, sorted so declared-order differences
 * don't fork the identity, then joined. Two different `.code-workspace` files
 * that merely share a first root therefore get DISTINCT identities and cannot
 * reuse each other's cached agent. A single string is its own identity.
 *
 * Note: this only affects session-cache identity. `resolveWorkspaceCwd` returns
 * roots in their DECLARED order, which is what is handed to `Agent.create` — so
 * the SDK's primary/first root (e.g. the git repo) is preserved.
 */
export function cwdIdentity(cwd: string | string[]): string {
  if (!Array.isArray(cwd)) return cwd;
  if (cwd.length === 0) return "";
  if (cwd.length === 1) return cwd[0] ?? "";
  return [...cwd].sort().join("\n");
}
