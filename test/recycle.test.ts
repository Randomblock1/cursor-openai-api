import { describe, expect, test } from "bun:test";
import { RecycleController } from "../src/recycle.js";

interface Harness {
  c: RecycleController;
  exits: number[];
  fireDeadline: () => void;
  fireGrace: () => void;
}

function harness(afterMs = 1000, graceMs = 500): Harness {
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const c = new RecycleController({
    afterMs,
    graceMs,
    onExit: (code) => exits.push(code),
    log: () => {},
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref() {} };
    },
  });
  c.start();
  // start() registers the deadline timer first, the grace timer second.
  return {
    c,
    exits,
    fireDeadline: () => timers[0]?.fn(),
    fireGrace: () => timers[1]?.fn(),
  };
}

describe("RecycleController", () => {
  test("exits(0) at the deadline when idle", () => {
    const { exits, fireDeadline } = harness();
    fireDeadline();
    expect(exits).toEqual([0]);
  });

  test("waits for in-flight turns to drain before exiting", () => {
    const { c, exits, fireDeadline } = harness();
    c.begin();
    fireDeadline();
    expect(c.isArmed).toBe(true);
    expect(exits).toEqual([]); // still busy
    c.end();
    expect(exits).toEqual([0]); // drained -> recycle
  });

  test("only recycles after the deadline, not on a normal end()", () => {
    const { c, exits } = harness();
    c.begin();
    c.end();
    expect(exits).toEqual([]); // deadline not reached yet
  });

  test("grace window forces an exit if turns never drain", () => {
    const { c, exits, fireDeadline, fireGrace } = harness();
    c.begin(); // never end()ed (stuck turn)
    fireDeadline();
    expect(exits).toEqual([]);
    fireGrace();
    expect(exits).toEqual([0]);
  });

  test("grace timer is a no-op once an idle deadline already exited", () => {
    const { exits, fireDeadline, fireGrace } = harness();
    fireDeadline(); // idle -> exit
    fireGrace(); // must not double-exit
    expect(exits).toEqual([0]);
  });

  test("exits exactly once even as more turns drain", () => {
    const { c, exits, fireDeadline } = harness();
    c.begin();
    c.begin();
    fireDeadline();
    c.end();
    expect(exits).toEqual([]); // one still in flight
    c.end();
    expect(exits).toEqual([0]);
    c.begin();
    c.end();
    expect(exits).toEqual([0]); // no second exit
  });

  test("disabled when afterMs <= 0: no timers, no exit", () => {
    const exits: number[] = [];
    let registered = 0;
    const c = new RecycleController({
      afterMs: 0,
      onExit: (code) => exits.push(code),
      log: () => {},
      setTimer: () => {
        registered += 1;
        return { unref() {} };
      },
    });
    c.start();
    c.begin();
    c.end();
    expect(registered).toBe(0);
    expect(exits).toEqual([]);
  });
});
