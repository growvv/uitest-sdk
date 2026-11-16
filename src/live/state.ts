/**
 * The live session's state machine, with no timers and no I/O.
 *
 * Every transition that matters for correctness is a rule here rather than an
 * `if` spread through the server: a session cannot claim to be streaming while
 * it is starting, a failure cannot be followed by a frame without a new start,
 * and a reconnect is counted where it happens.
 */

export type LiveStatus =
  | "idle"
  | "starting"
  | "live"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

const ALLOWED: Record<LiveStatus, LiveStatus[]> = {
  // `failed` is reachable from every state, idle included: opening the device
  // can fail before a session has started, and a failure must always be
  // representable rather than forced into a state that claims otherwise.
  idle: ["starting", "failed"],
  starting: ["live", "stopping", "failed"],
  // `stopping` is reachable from live because a person can close the page
  // while a stream is running; the server stops the cast, not the other way.
  live: ["reconnecting", "stopping", "failed"],
  reconnecting: ["live", "stopping", "failed"],
  stopping: ["stopped", "failed"],
  // A stopped session can be started again: the page reloads, the operator
  // restarts, and a terminal state that refuses a new run would strand the tab.
  stopped: ["starting", "failed"],
  failed: ["starting"],
};

export type ChangeListener = (next: LiveStatus, prev: LiveStatus) => void;

export class LiveState {
  private current: LiveStatus = "idle";
  private failure: string | undefined;
  private reconnectCount = 0;
  private readonly listeners = new Set<ChangeListener>();
  private readonly trail: LiveStatus[] = [];

  get state(): LiveStatus {
    return this.current;
  }

  /** Why the session failed, cleared on the next start. */
  get reason(): string | undefined {
    return this.failure;
  }

  /** Reconnects since the last clean stop. */
  get reconnects(): number {
    return this.reconnectCount;
  }

  /** Every accepted state, oldest first; the first entry is the first `to`. */
  get history(): LiveStatus[] {
    return [...this.trail];
  }

  /** Frames can only arrive in `live`; anything else is a bug to surface. */
  get streaming(): boolean {
    return this.current === "live";
  }

  /** A socket is (or is about to be) attached in these states. */
  get connected(): boolean {
    return this.current === "live" || this.current === "reconnecting";
  }

  /**
   * Applies a transition, throwing when the machine does not declare it.
   *
   * Re-asserting the current state is a no-op rather than an error: a caller
   * that learns a fact twice (two frames, two acks) should not have to check
   * first, and it must not produce a second event.
   */
  to(next: LiveStatus, reason?: string): void {
    if (next === this.current) return;
    const allowed = ALLOWED[this.current] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`live session cannot go from ${this.current} to ${next}`);
    }
    if (next === "reconnecting") this.reconnectCount++;
    if (next === "stopped") this.reconnectCount = 0;
    this.failure = next === "failed" ? (reason ?? "unknown failure") : undefined;
    this.commit(next);
  }

  /**
   * Sets the state without checking the graph. Only for tests and for a
   * restart that has already torn everything down.
   */
  force(next: LiveStatus, reason?: string): void {
    this.failure = next === "failed" ? (reason ?? "unknown failure") : undefined;
    if (next === "stopped") this.reconnectCount = 0;
    this.commit(next);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: LiveStatus): void {
    const prev = this.current;
    if (prev === next) return;
    this.current = next;
    this.trail.push(next);
    for (const listener of [...this.listeners]) {
      try {
        listener(next, prev);
      } catch {
        // A listener that throws must not wedge the session.
      }
    }
  }
}
