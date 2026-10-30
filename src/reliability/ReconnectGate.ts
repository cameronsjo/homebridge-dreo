// Single-flight, rate-limited forced reconnects.
//
// Every accessory shares one Dreo socket, so a command failure on any device
// may ask for a reconnect. Concurrent asks join the reconnect already running,
// and a new one starts at most once per window so a dead cloud cannot turn
// command retries into a login storm.

export const FORCED_RECONNECT_WINDOW_MS = 5 * 60_000;

export type ReconnectDecision =
  | { readonly kind: 'join' }
  | { readonly kind: 'start' }
  | { readonly kind: 'rate-limited'; readonly retryInMs: number };

export interface ReconnectRequest {
  /** True when this call started a new reconnect rather than joining or skipping. */
  readonly started: boolean;
  /** True when a reconnect (started or joined) is under way. */
  readonly reconnecting: boolean;
  /** Resolves true once a fresh socket is open; false when skipped or failed. */
  readonly done: Promise<boolean>;
}

export interface ReconnectCounts {
  readonly started: number;
  readonly joined: number;
  readonly rateLimited: number;
}

export function decideReconnect(
  inFlight: boolean,
  lastStartedAt: number | undefined,
  now: number,
  windowMs: number = FORCED_RECONNECT_WINDOW_MS,
): ReconnectDecision {
  if (inFlight) {
    return { kind: 'join' };
  }
  if (lastStartedAt !== undefined && now - lastStartedAt < windowMs) {
    return { kind: 'rate-limited', retryInMs: windowMs - (now - lastStartedAt) };
  }
  return { kind: 'start' };
}

export class ReconnectGate {
  private inFlight?: Promise<boolean>;
  private lastStartedAt?: number;
  private counts = { started: 0, joined: 0, rateLimited: 0 };

  constructor(
    private readonly reconnect: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = FORCED_RECONNECT_WINDOW_MS,
  ) {}

  public request(): ReconnectRequest {
    const decision = decideReconnect(
      this.inFlight !== undefined,
      this.lastStartedAt,
      this.now(),
      this.windowMs,
    );
    if (decision.kind === 'join' && this.inFlight) {
      this.counts.joined += 1;
      return { started: false, reconnecting: true, done: this.inFlight };
    }
    if (decision.kind === 'rate-limited') {
      this.counts.rateLimited += 1;
      return { started: false, reconnecting: false, done: Promise.resolve(false) };
    }

    this.counts.started += 1;
    this.lastStartedAt = this.now();
    const attempt = this.reconnect()
      .catch((): boolean => false)
      .finally((): void => {
        this.inFlight = undefined;
      });
    this.inFlight = attempt;
    return { started: true, reconnecting: true, done: attempt };
  }

  /** Return the counts since the last drain and reset them. */
  public drainCounts(): ReconnectCounts {
    const snapshot = { ...this.counts };
    this.counts = { started: 0, joined: 0, rateLimited: 0 };
    return snapshot;
  }
}
