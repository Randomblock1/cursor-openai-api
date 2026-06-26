import { afterEach, describe, expect, test } from "bun:test";
import { AuthenticationError, type SDKAgent } from "@cursor/sdk";
import {
  isActiveRunError,
  isAuthWedgeError,
  mapCursorError,
} from "../src/errors.js";
import { SessionStore } from "../src/session-store.js";

describe("isActiveRunError", () => {
  test("matches the SDK's raw 'already has active run' error", () => {
    const err = new Error("Agent agent-5e6ea7ec already has active run");
    expect(isActiveRunError(err)).toBe(true);
  });

  test("still matches after mapCursorError wrapping (message preserved)", () => {
    const wrapped = mapCursorError(
      new Error("Agent agent-abc already has active run"),
    );
    expect(isActiveRunError(wrapped)).toBe(true);
  });

  test("matches a bare string", () => {
    expect(isActiveRunError("already has active run")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isActiveRunError(new Error("Agent run failed"))).toBe(false);
    expect(isActiveRunError(undefined)).toBe(false);
    expect(isActiveRunError({ nope: 1 })).toBe(false);
  });
});

describe("isAuthWedgeError", () => {
  test("matches the SDK's raw ConnectError unauthenticated", () => {
    expect(isAuthWedgeError(new Error("ConnectError: [unauthenticated]"))).toBe(
      true,
    );
  });

  test("matches ERROR_NOT_LOGGED_IN (underscored)", () => {
    expect(isAuthWedgeError(new Error("ERROR_NOT_LOGGED_IN"))).toBe(true);
  });

  test("survives mapCursorError wrapping (message preserved)", () => {
    const wrapped = mapCursorError(new Error("rpc failed: unauthenticated"));
    expect(isAuthWedgeError(wrapped)).toBe(true);
  });

  test("matches the SDK's AuthenticationError by class/name", () => {
    expect(isAuthWedgeError(new AuthenticationError("bad key"))).toBe(true);
  });

  test("matches a bare string", () => {
    expect(isAuthWedgeError("not logged in")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isAuthWedgeError(new Error("already has active run"))).toBe(false);
    expect(isAuthWedgeError(new Error("Agent run failed"))).toBe(false);
    expect(isAuthWedgeError(undefined)).toBe(false);
    expect(isAuthWedgeError({ nope: 1 })).toBe(false);
  });
});

describe("evictSession", () => {
  const store = new SessionStore();
  afterEach(() => store.clearForTests());

  test("drops and disposes a poisoned cached agent so reuse is gone", () => {
    let disposed = false;
    const agent = {
      agentId: "agent-poisoned",
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    } as unknown as SDKAgent;

    store.registerTestSession("sess:wedged", {
      agent,
      agentId: "agent-poisoned",
      modelId: "composer-2.5",
      messageCount: 2,
      messagesSnapshot: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      lastAccess: Date.now(),
    });

    const followUp = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
      { role: "user" as const, content: "again" },
    ];
    expect(
      store.findMatchingSessionEntry("composer-2.5", followUp)?.key,
    ).toBe("sess:wedged");

    store.evictSession("sess:wedged");

    expect(
      store.findMatchingSessionEntry("composer-2.5", followUp),
    ).toBeUndefined();
    expect(disposed).toBe(true);
  });

  test("evicting an unknown key is a no-op", () => {
    expect(() => store.evictSession("sess:does-not-exist")).not.toThrow();
  });
});
