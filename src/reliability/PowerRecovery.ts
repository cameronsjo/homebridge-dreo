// Recovery for a power or speed command that failed, run off the HomeKit
// request path.
//
// The HomeKit set handler fails fast so the Home app shows the failure. This
// then asks for a fresh socket if the current one is down, resends the newest
// requested power state (power commands only; up to twice if the request
// changes mid-resend), and reconciles HomeKit against the REST state whatever
// happened.

import { ConfirmationError } from './ConfirmedController';
import { forLog } from './forLog';
import type { ReconnectRequest } from './ReconnectGate';

export interface PowerRecoveryDependencies {
  readonly deviceName: string;
  readonly requestReconnect: (reason: string) => ReconnectRequest;
  readonly isSocketOpen: () => boolean;
  /** Send the power state and wait for confirmation; throws when unconfirmed. */
  readonly resend: (active: boolean) => Promise<void>;
  /** The newest power state the user asked for. */
  readonly latestRequested: () => boolean;
  readonly reconcile: () => void;
  readonly log: {
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
  };
}

export type ReconnectOutcome =
  | 'started'
  | 'joined'
  | 'rate-limited'
  | 'not-needed'
  | 'recovery-already-running';

// One resend for the failed request, plus one more if the user asked for a
// different state while that resend was in flight
const MAX_RESENDS = 2;

interface PendingReconnect {
  readonly outcome: ReconnectOutcome;
  readonly done: Promise<boolean>;
}

/**
 * power: recovery resends the newest requested power state.
 * speed: recovery reconnects if needed and reconciles, but resends nothing;
 * the user's next slider move is the retry, and a stale speed resend could
 * override a newer one.
 */
export type RecoveredCommandKind = 'power' | 'speed';

export interface RecoveredCommand {
  readonly kind: RecoveredCommandKind;
  readonly requested: boolean | number;
  /** State key whose observed value goes in the error text. */
  readonly observedKey: string;
}

export class PowerCommandFailure extends Error {
  constructor(
    public readonly deviceName: string,
    public readonly command: RecoveredCommand,
    public readonly observed: unknown,
    public readonly reconnect: ReconnectOutcome,
    public readonly cause: unknown,
  ) {
    super(
      `Dreo ${command.kind} command failed. Device: ${deviceName}, Requested: ${command.requested}, ` +
        `Observed: ${forLog(observed)}, Reconnect: ${reconnect}, ` +
        `Error: ${forLog(cause instanceof Error ? cause.message : cause)}`,
    );
    this.name = 'PowerCommandFailure';
  }
}

export function observedPower(error: unknown, powerKey: string): unknown {
  if (error instanceof ConfirmationError) {
    return error.actualState[powerKey] ?? 'unknown';
  }
  return 'unknown';
}

export class PowerRecovery {
  private running?: Promise<void>;

  constructor(private readonly dependencies: PowerRecoveryDependencies) {}

  /**
   * Run a power or speed command. On failure, start background recovery and
   * throw a PowerCommandFailure naming the device, the requested and observed
   * state, and what happened to the reconnect.
   */
  public async run<Result>(command: RecoveredCommand, execute: () => Promise<Result>): Promise<Result> {
    try {
      return await execute();
    } catch (error) {
      const reconnect = this.start(command, error);
      const failure = new PowerCommandFailure(
        this.dependencies.deviceName,
        command,
        observedPower(error, command.observedKey),
        reconnect,
        error,
      );
      this.dependencies.log.error('%s', failure.message);
      throw failure;
    }
  }

  /** Exposed for tests; resolves once any running recovery has finished. */
  public settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private start(command: RecoveredCommand, error: unknown): ReconnectOutcome {
    if (this.running) {
      return 'recovery-already-running';
    }
    const reconnect = this.reconnectIfClosed(command, error);
    this.running = this.recover(reconnect, command).finally((): void => {
      this.running = undefined;
    });
    return reconnect.outcome;
  }

  // A command can fail with the socket healthy (the device rejected it, or
  // confirmation timed out); a fresh login would only open a gap in pushes
  private reconnectIfClosed(command: RecoveredCommand, error: unknown): PendingReconnect {
    if (this.dependencies.isSocketOpen()) {
      return { outcome: 'not-needed', done: Promise.resolve(false) };
    }
    const reason = `${command.kind} command failed for ${this.dependencies.deviceName}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const request: ReconnectRequest = this.dependencies.requestReconnect(reason);
    const outcome: ReconnectOutcome = request.started
      ? 'started'
      : request.reconnecting
        ? 'joined'
        : 'rate-limited';
    return { outcome, done: request.done };
  }

  private async recover(reconnect: PendingReconnect, command: RecoveredCommand): Promise<void> {
    const { deviceName, log } = this.dependencies;
    try {
      const reconnected = await reconnect.done;
      if (command.kind === 'speed') {
        log.info(
          'Reconciling after a failed speed command; speed is not resent. Device: %s, Requested: %s, Reconnected: %s',
          deviceName,
          command.requested,
          reconnected,
        );
        return;
      }
      if (!this.dependencies.isSocketOpen()) {
        log.warn(
          'Skipping power resend: no open Dreo socket after recovery. Device: %s, Requested: %s',
          deviceName,
          command.requested,
        );
        return;
      }
      let target = this.dependencies.latestRequested();
      await this.dependencies.resend(target);
      for (let resends = 1; resends < MAX_RESENDS && this.dependencies.latestRequested() !== target; resends += 1) {
        target = this.dependencies.latestRequested();
        await this.dependencies.resend(target);
      }
      const newest = this.dependencies.latestRequested();
      if (newest !== target) {
        log.warn(
          'Power resend limit reached before the newest request was sent. Device: %s, Confirmed: %s, Newest: %s',
          deviceName,
          target,
          newest,
        );
        return;
      }
      log.info(
        'Recovered power command after failure. Device: %s, Confirmed: %s, Reconnected: %s',
        deviceName,
        target,
        reconnected,
      );
    } catch (error) {
      log.error(
        'Power resend during recovery failed. Device: %s, Error: %s',
        deviceName,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.dependencies.reconcile();
    }
  }
}
