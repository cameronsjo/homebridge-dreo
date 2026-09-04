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

export type ConfirmedControlStep = Omit<ConfirmedControlRequest, 'deviceSn'>;

export class ConfirmedController {
  private readonly deviceQueues = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: ConfirmedControllerDependencies) {
    if (dependencies.attempts < 1) {
      throw new Error('Confirmation attempts must be at least one.');
    }
  }

  public execute(request: ConfirmedControlRequest): Promise<ConfirmedControlResult> {
    return this.enqueue(request.deviceSn, (): Promise<ConfirmedControlResult> =>
      this.executeNow(request),
    );
  }

  public executeSequence(
    deviceSn: string,
    steps: readonly ConfirmedControlStep[],
  ): Promise<readonly ConfirmedControlResult[]> {
    if (steps.length === 0) {
      return Promise.reject(new Error('A confirmed control sequence must contain at least one step.'));
    }

    return this.enqueue(deviceSn, async (): Promise<readonly ConfirmedControlResult[]> => {
      const results: ConfirmedControlResult[] = [];
      for (const step of steps) {
        results.push(await this.executeNow({ deviceSn, ...step }));
      }
      return results;
    });
  }

  private enqueue<Result>(deviceSn: string, execute: () => Promise<Result>): Promise<Result> {
    const previous = this.deviceQueues.get(deviceSn) ?? Promise.resolve();
    const operation = previous.catch((): void => undefined).then(execute);
    const settled = operation.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.deviceQueues.set(deviceSn, settled);
    void settled.finally((): void => {
      if (this.deviceQueues.get(deviceSn) === settled) {
        this.deviceQueues.delete(deviceSn);
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
      `Dreo command ${commandId} was not confirmed. ` +
      `Expected: ${JSON.stringify(request.expectedState)}, Actual: ${JSON.stringify(actualState)}`,
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
