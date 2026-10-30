// Periodic REST re-read of a device's state.
//
// The WebSocket push is the fast path but not a guaranteed one: a push sent
// while the socket is down is lost, and HomeKit keeps the old value. A poll
// bounds how long that staleness can last.

export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const MIN_POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_BACKOFF_MS = 10 * 60_000;

export function resolvePollIntervalMs(configured: unknown): number {
  const seconds =
    typeof configured === 'number' && Number.isFinite(configured)
      ? configured
      : DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.max(seconds, MIN_POLL_INTERVAL_SECONDS) * 1000;
}

/** Delay before the next poll: the interval, doubled per consecutive failure, capped. */
export function nextPollDelayMs(intervalMs: number, consecutiveFailures: number): number {
  return Math.min(intervalMs * 2 ** Math.max(0, consecutiveFailures), MAX_POLL_BACKOFF_MS);
}

export type PollOutcome = 'applied' | 'skipped-busy' | 'discarded-stale' | 'failed';

export interface StatePollerDependencies<State> {
  readonly read: () => Promise<State | undefined>;
  readonly apply: (state: State) => void;
  /** True while a command for this device is queued or awaiting confirmation. */
  readonly isBusy: () => boolean;
  /** Bumped by every command the user starts; a moved epoch makes a read stale. */
  readonly commandEpoch: () => number;
  readonly intervalMs: number;
  readonly log: {
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    debug(message: string, ...parameters: unknown[]): void;
  };
  readonly deviceName: string;
}

export class StatePoller<State> {
  private consecutiveFailures = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dependencies: StatePollerDependencies<State>) {}

  public start(): void {
    this.stopped = false;
    this.schedule(this.dependencies.intervalMs);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  public get failures(): number {
    return this.consecutiveFailures;
  }

  /** Run one poll. Exposed for tests; the timer calls it in normal operation. */
  public async pollOnce(): Promise<PollOutcome> {
    const { deviceName, log } = this.dependencies;
    if (this.dependencies.isBusy()) {
      log.debug('Skipping state poll while a command is in flight. Device: %s', deviceName);
      return 'skipped-busy';
    }

    const epochBefore = this.dependencies.commandEpoch();
    let state: State | undefined;
    let failureReason = 'no state returned';
    try {
      state = await this.dependencies.read();
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    if (state === undefined || state === null) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 1) {
        log.warn(
          'State poll failed; backing off until it recovers. Device: %s, Reason: %s',
          deviceName,
          failureReason,
        );
      } else {
        log.debug(
          'State poll failed again. Device: %s, ConsecutiveFailures: %s, Reason: %s',
          deviceName,
          this.consecutiveFailures,
          failureReason,
        );
      }
      return 'failed';
    }

    if (this.consecutiveFailures > 0) {
      log.info(
        'State poll recovered after %s failures. Device: %s',
        this.consecutiveFailures,
        deviceName,
      );
      this.consecutiveFailures = 0;
    }

    if (this.dependencies.commandEpoch() !== epochBefore || this.dependencies.isBusy()) {
      log.debug('Discarding state poll that raced a command. Device: %s', deviceName);
      return 'discarded-stale';
    }

    this.dependencies.apply(state);
    return 'applied';
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout((): void => {
      void this.pollOnce()
        .catch((error: unknown): PollOutcome => {
          this.dependencies.log.warn(
            'State poll threw unexpectedly. Device: %s, Error: %s',
            this.dependencies.deviceName,
            error instanceof Error ? error.message : String(error),
          );
          return 'failed';
        })
        .finally((): void =>
          this.schedule(nextPollDelayMs(this.dependencies.intervalMs, this.consecutiveFailures)),
        );
    }, delayMs);
    this.timer.unref?.();
  }
}
