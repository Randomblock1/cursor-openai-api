import { describe, expect, test } from "bun:test";
import { AuthHealthMonitor } from "../src/auth-health.js";

function monitor(threshold: number) {
  const exits: number[] = [];
  const m = new AuthHealthMonitor({
    threshold,
    onExit: (code) => exits.push(code),
    log: () => {},
  });
  return { m, exits };
}

describe("AuthHealthMonitor", () => {
  test("does not exit before the threshold of consecutive failures", () => {
    const { m, exits } = monitor(3);
    expect(m.recordAuthWedge()).toBe(false);
    expect(m.recordAuthWedge()).toBe(false);
    expect(exits).toEqual([]);
    expect(m.streak).toBe(2);
  });

  test("exits(1) on the Nth consecutive failure", () => {
    const { m, exits } = monitor(3);
    m.recordAuthWedge();
    m.recordAuthWedge();
    expect(m.recordAuthWedge()).toBe(true);
    expect(exits).toEqual([1]);
  });

  test("a success between failures resets the streak (no exit)", () => {
    const { m, exits } = monitor(3);
    m.recordAuthWedge();
    m.recordAuthWedge();
    m.recordSuccess();
    expect(m.streak).toBe(0);
    m.recordAuthWedge();
    m.recordAuthWedge();
    expect(exits).toEqual([]);
    expect(m.recordAuthWedge()).toBe(true);
    expect(exits).toEqual([1]);
  });

  test("exit fires exactly once even if more failures arrive after", () => {
    const { m, exits } = monitor(2);
    m.recordAuthWedge();
    expect(m.recordAuthWedge()).toBe(true);
    m.recordAuthWedge();
    m.recordAuthWedge();
    expect(exits).toEqual([1]);
  });
});
