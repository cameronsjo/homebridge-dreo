export type DreoCommand = Readonly<Record<string, boolean | number | string>>;

export interface DreoStateValue {
  readonly state: unknown;
}

export type DreoState = Readonly<Record<string, DreoStateValue | undefined>>;

export interface ConfirmedControllerDependencies {
  readonly send: (deviceSn: string, command: DreoCommand) => string;
  readonly getState: (deviceSn: string) => Promise<DreoState | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly attempts: number;
  readonly confirmationDelayMs: number;
}

export interface ConfirmedControlRequest {
  readonly deviceSn: string;
  readonly command: DreoCommand;
  readonly expectedState: Readonly<Record<string, boolean | number | string>>;
}

export interface ConfirmedControlResult {
  readonly commandId: string;
  readonly state: DreoState;
}

export class ConfirmedController {
  private readonly deviceQueues = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: ConfirmedControllerDependencies) {
    if (dependencies.attempts < 1) {
      throw new Error('Confirmation attempts must be at least one.');
    }
  }

  public execute(request: ConfirmedControlRequest): Promise<ConfirmedControlResult> {
    const previous = this.deviceQueues.get(request.deviceSn) ?? Promise.resolve();
    const operation = previous
      .catch((): void => undefined)
      .then((): Promise<ConfirmedControlResult> => this.executeNow(request));
    const settled = operation.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.deviceQueues.set(request.deviceSn, settled);
    void settled.finally((): void => {
      if (this.deviceQueues.get(request.deviceSn) === settled) {
        this.deviceQueues.delete(request.deviceSn);
      }
    });
    return operation;
  }

  private async executeNow(request: ConfirmedControlRequest): Promise<ConfirmedControlResult> {
    const commandId = this.dependencies.send(request.deviceSn, request.command);

    let latestState: DreoState | undefined;
    for (let attempt = 1; attempt <= this.dependencies.attempts; attempt += 1) {
      await this.dependencies.sleep(this.dependencies.confirmationDelayMs);
      latestState = await this.dependencies.getState(request.deviceSn);
      if (latestState && this.matchesExpectedState(latestState, request.expectedState)) {
        return { commandId, state: latestState };
      }
    }

    const actualState = Object.fromEntries(
      Object.keys(request.expectedState).map((key: string) => [key, latestState?.[key]?.state]),
    );
    throw new Error(
      `Dreo command ${commandId} was not confirmed. Expected: ${JSON.stringify(request.expectedState)}, Actual: ${JSON.stringify(actualState)}`,
    );
  }

  private matchesExpectedState(
    state: DreoState,
    expectedState: ConfirmedControlRequest['expectedState'],
  ): boolean {
    return Object.entries(expectedState).every(
      ([key, expectedValue]) => state[key]?.state === expectedValue,
    );
  }
}
