/**
 * KS-9 - the global kill switch.
 *
 * The latch is checked at G1 AND re-checked immediately before spawn, which
 * closes the time-of-check-to-time-of-use window between admission and
 * execution. Re-arming is an explicit operator action; nothing clears it
 * automatically.
 */

export interface LatchState {
  readonly armed: boolean;
  readonly reason: string;
  readonly since: string | null;
}

export class KillLatch {
  private armed = false;
  private reason = "";
  private since: string | null = null;

  get isArmed(): boolean {
    return this.armed;
  }

  state(): LatchState {
    return { armed: this.armed, reason: this.reason, since: this.since };
  }

  arm(reason: string): LatchState {
    if (!this.armed) {
      this.armed = true;
      this.since = new Date().toISOString();
    }
    this.reason = reason;
    return this.state();
  }

  disarm(): LatchState {
    this.armed = false;
    this.reason = "";
    this.since = null;
    return this.state();
  }
}
