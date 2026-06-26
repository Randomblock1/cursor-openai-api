/**
 * Tracks consecutive stale-auth ("auth-wedge") completion failures and recovers
 * the only way that works: by exiting the process so a supervisor relaunches it
 * with a fresh Cursor auth session.
 *
 * Why a process exit rather than in-process self-heal: a wedged auth session is
 * held by the long-lived SDK transport, so evicting and recreating an `Agent`
 * reuses the same poisoned session and keeps failing (observed as an endless
 * self-heal loop in the proxy log). A fresh process re-authenticates with the
 * same valid `CURSOR_API_KEY` and recovers. Supervised restarts are silent and
 * fast (seconds), so this also stops the "wedged + auto-restarted" alarm for
 * this failure class.
 *
 * A threshold guards against exiting on a single transient blip, and any
 * successful turn resets the streak.
 */
const DEFAULT_AUTH_WEDGE_EXIT_THRESHOLD = 3;

export interface AuthHealthOptions {
  /** Consecutive auth-wedge failures before the process exits. */
  threshold?: number;
  /** Exit seam (overridable in tests so a run doesn't kill the test runner). */
  onExit?: (code: number) => void;
  /** Log seam. */
  log?: (message: string) => void;
}

export class AuthHealthMonitor {
  private consecutive = 0;
  private exited = false;
  private readonly threshold: number;
  private readonly onExit: (code: number) => void;
  private readonly log: (message: string) => void;

  constructor(options: AuthHealthOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_AUTH_WEDGE_EXIT_THRESHOLD;
    this.onExit = options.onExit ?? ((code) => process.exit(code));
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Record a healthy turn; clears any accumulated auth-wedge streak. */
  recordSuccess(): void {
    this.consecutive = 0;
  }

  /**
   * Record an auth-wedge failure. Once `threshold` consecutive failures
   * accumulate, log and exit(1) so a supervisor restarts the process with fresh
   * auth. Returns true when the exit path was taken.
   */
  recordAuthWedge(): boolean {
    this.consecutive += 1;
    if (this.consecutive < this.threshold) {
      this.log(
        `[cursor-openai-api] auth-wedge: completion failed with stale Cursor ` +
          `auth (${this.consecutive}/${this.threshold}); a fresh in-process ` +
          `agent reuses the same poisoned session, only a restart refreshes it.`,
      );
      return false;
    }
    if (this.exited) return true;
    this.exited = true;
    this.log(
      `[cursor-openai-api] auth-wedge: ${this.consecutive} consecutive ` +
        `unauthenticated failures — exiting so a supervisor restarts the ` +
        `process with fresh Cursor auth.`,
    );
    this.onExit(1);
    return true;
  }

  /** Current consecutive auth-wedge count (test/diagnostic seam). */
  get streak(): number {
    return this.consecutive;
  }
}

/** Process-wide monitor shared across turns. */
export const authHealth = new AuthHealthMonitor();
