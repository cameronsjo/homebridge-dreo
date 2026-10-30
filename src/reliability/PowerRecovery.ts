// Recovery for a power command that failed, run off the HomeKit request path.
//
// The HomeKit set handler fails fast so the Home app shows the failure. This
// then asks for a fresh socket, resends the newest requested power state once,
// and reconciles HomeKit against the REST state whatever happened.

import { ConfirmationError } from './ConfirmedController';
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

export type ReconnectOutcome = 'started' | 'joined' | 'rate-limited' | 'recovery-already-running';

export class PowerCommandFailure extends Error {
  constructor(
    public readonly deviceName: string,
    public readonly requested: boolean,
    public readonly observed: unknown,
    public readonly reconnect: ReconnectOutcome,
    public readonly cause: unknown,
  ) {
    super(
      `Dreo power command failed. Device: ${deviceName}, Requested: ${requested}, ` +
        `Observed: ${String(observed)}, Reconnect: ${reconnect}, ` +
        `Error: ${cause instanceof Error ? cause.message : String(cause)}`,
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
   * Run a power command. On failure, start background recovery and throw a
   * PowerCommandFailure naming the device, the requested and observed state,
   * and what happened to the reconnect.
   */
  public async run<Result>(
    requested: boolean,
    powerKey: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await execute();
    } catch (error) {
      const reconnect = this.start(requested, error);
      const failure = new PowerCommandFailure(
        this.dependencies.deviceName,
        requested,
        observedPower(error, powerKey),
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

  private start(requested: boolean, error: unknown): ReconnectOutcome {
    if (this.running) {
      return 'recovery-already-running';
    }
    const reason = `power command failed for ${this.dependencies.deviceName}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const reconnect = this.dependencies.requestReconnect(reason);
    const outcome: ReconnectOutcome = reconnect.started
      ? 'started'
      : reconnect.reconnecting
        ? 'joined'
        : 'rate-limited';

    this.running = this.recover(reconnect, requested).finally((): void => {
      this.running = undefined;
    });
    return outcome;
  }

  private async recover(reconnect: ReconnectRequest, failedRequest: boolean): Promise<void> {
    const { deviceName, log } = this.dependencies;
    try {
      const reconnected = await reconnect.done;
      if (!reconnected && !this.dependencies.isSocketOpen()) {
        log.warn(
          'Skipping power resend: no open Dreo socket after recovery. Device: %s, Requested: %s',
          deviceName,
          failedRequest,
        );
        return;
      }
      const target = this.dependencies.latestRequested();
      await this.dependencies.resend(target);
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
