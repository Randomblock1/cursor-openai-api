/**
 * Proactive pre-expiry recycle.
 *
 * Why this exists: the Cursor access token the long-lived proxy derives from
 * `CURSOR_API_KEY` expires roughly hourly, and the SDK does not refresh it
 * in-process. Once it lapses every completion fails with `[unauthenticated]`
 * until the *process* restarts (the auth-wedge failure class — see
 * `auth-health.ts`). `auth-health` is the reactive backstop (exit *after* a
 * wedge is observed); this controller is the proactive complement: it exits
 * cleanly a bit BEFORE the expiry window so a process supervisor relaunches with
 * a fresh token and a live turn never hits an expired one.
 *
 * It drains first: when the uptime deadline is reached it waits for in-flight
 * turns to finish before exiting, so no streaming request is cut off. A grace
 * window bounds that wait so a single stuck turn can't pin a soon-to-be-stale
 * process open indefinitely.
 *
 * Exit code 0 — a clean, intended recycle, not a crash; a supervisor configured
 * to restart on exit relaunches the process regardless of exit code.
 */
export interface RecycleOptions {
  /** Recycle once process uptime exceeds this (ms). `<= 0` disables recycling. */
  afterMs: number;
  /**
   * Hard cap after `afterMs`: if in-flight turns never drain, force the exit
   * this long after the deadline anyway. Defaults to 5 min.
   */
  graceMs?: number;
  /** Exit seam (overridable in tests so a run doesn't kill the test runner). */
  onExit?: (code: number) => void;
  /** Log seam. */
  log?: (message: string) => void;
  /** Timer seam (overridable in tests to drive timing deterministically). */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export class RecycleController {
  private inFlight = 0;
  private armed = false;
  private exited = false;
  private started = false;
  private readonly afterMs: number;
  private readonly graceMs: number;
  private readonly onExit: (code: number) => void;
  private readonly log: (message: string) => void;
  private readonly setTimer: (
    fn: () => void,
    ms: number,
  ) => { unref?: () => void };

  constructor(options: RecycleOptions) {
    this.afterMs = options.afterMs;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.onExit = options.onExit ?? ((code) => process.exit(code));
    this.log = options.log ?? ((message) => console.error(message));
    this.setTimer =
      options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /**
   * Arm the uptime + grace timers. No-op when disabled (`afterMs <= 0`) or
   * already started. Timers are unref'd so they never by themselves keep the
   * process alive — the HTTP server does that.
   */
  start(): void {
    if (this.started || this.afterMs <= 0) return;
    this.started = true;
    this.setTimer(() => this.arm(), this.afterMs).unref?.();
    this.setTimer(
      () => this.forceExit(),
      this.afterMs + this.graceMs,
    ).unref?.();
  }

  /** Mark a turn as started (count it toward the drain check). */
  begin(): void {
    this.inFlight += 1;
  }

  /** Mark a turn as finished; recycle now if the deadline already passed. */
  end(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.armed && this.inFlight <= 0) {
      this.exit("in-flight turns drained after recycle deadline");
    }
  }

  /** Whether the uptime deadline has passed and we're waiting to drain. */
  get isArmed(): boolean {
    return this.armed;
  }

  private arm(): void {
    if (this.exited) return;
    this.armed = true;
    if (this.inFlight <= 0) {
      this.exit("idle at recycle deadline");
      return;
    }
    this.log(
      `[cursor-openai-api] recycle: uptime deadline reached with ` +
        `${this.inFlight} turn(s) in flight; will restart once they drain.`,
    );
  }

  private forceExit(): void {
    // Only relevant once past the deadline; if `arm` already exited (idle), this
    // is a no-op via the `exited` guard in `exit`.
    if (this.exited || !this.armed) return;
    this.exit(
      `grace window elapsed with ${this.inFlight} turn(s) still in flight`,
    );
  }

  private exit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.log(
      `[cursor-openai-api] recycle: restarting to refresh Cursor auth before ` +
        `token expiry (${reason}); the process supervisor will relaunch it.`,
    );
    this.onExit(0);
  }
}

// Process-wide controller, wired in index.ts via startRecycle(). Turn handlers
// call beginTurn()/endTurn() which no-op until a controller is installed (so
// importing them in tests of createApp has no side effects).
let controller: RecycleController | null = null;

export function startRecycle(options: RecycleOptions): RecycleController {
  controller = new RecycleController(options);
  controller.start();
  return controller;
}

export function beginTurn(): void {
  controller?.begin();
}

export function endTurn(): void {
  controller?.end();
}
