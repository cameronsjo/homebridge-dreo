import { describe, expect, it, vi } from 'vitest';
import { ConfirmedController, type DreoState } from '../src/reliability/ConfirmedController';
import { ReconnectGate, decideReconnect } from '../src/reliability/ReconnectGate';
import { PowerCommandFailure, PowerRecovery } from '../src/reliability/PowerRecovery';

const NOT_OPEN = 'Dreo WebSocket is not open; command was not sent. ReadyState: 3';

function controllerWith(send: () => string, state?: DreoState): ConfirmedController {
  return new ConfirmedController({
    send,
    getState: async () => state,
    sleep: async () => undefined,
    attempts: 1,
    confirmationDelayMs: 0,
  });
}

describe('ConfirmedController busy flag', () => {
  it('is busy while a command is in flight and clear after it throws', async () => {
    let release: (state: DreoState | undefined) => void = () => undefined;
    const stateRead = new Promise<DreoState | undefined>((resolve) => {
      release = resolve;
    });
    const controller = new ConfirmedController({
      send: () => 'cmd-1',
      getState: () => stateRead,
      sleep: async () => undefined,
      attempts: 1,
      confirmationDelayMs: 0,
    });

    const pending = controller.execute({
      deviceSn: 'fan-1',
      command: { poweron: true },
      expectedState: { poweron: true },
    });
    await Promise.resolve();
    expect(controller.isBusy('fan-1')).toBe(true);

    release(undefined);
    await expect(pending).rejects.toThrow('was not confirmed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.isBusy('fan-1')).toBe(false);
  });

  it('is clear after send throws synchronously', async () => {
    const controller = controllerWith(() => {
      throw new Error(NOT_OPEN);
    });

    await expect(
      controller.execute({ deviceSn: 'fan-1', command: { poweron: true }, expectedState: { poweron: true } }),
    ).rejects.toThrow('not open');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.isBusy('fan-1')).toBe(false);
  });
});

describe('forced reconnect gate', () => {
  it('joins a reconnect already in flight instead of starting a second one', async () => {
    let finish: (opened: boolean) => void = () => undefined;
    const reconnect = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const gate = new ReconnectGate(reconnect, () => 0);

    const first = gate.request();
    const second = gate.request();
    finish(true);

    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, reconnecting: true });
    expect(await second.done).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('allows one new reconnect per five minutes', async () => {
    let now = 0;
    const reconnect = vi.fn(async () => true);
    const gate = new ReconnectGate(reconnect, () => now);

    await gate.request().done;
    now = 4 * 60_000;
    const limited = gate.request();
    now = 5 * 60_000;
    const allowed = gate.request();

    expect(limited).toMatchObject({ started: false, reconnecting: false });
    expect(await limited.done).toBe(false);
    expect(allowed.started).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(gate.drainCounts()).toEqual({ started: 2, joined: 0, rateLimited: 1 });
    expect(gate.drainCounts()).toEqual({ started: 0, joined: 0, rateLimited: 0 });
  });

  it('settles a reconnect that throws as not reconnected', async () => {
    const gate = new ReconnectGate(async () => {
      throw new Error('login failed');
    });

    expect(await gate.request().done).toBe(false);
  });

  it('decides join, rate-limit, and start from the gate state', () => {
    expect(decideReconnect(true, 0, 10)).toEqual({ kind: 'join' });
    expect(decideReconnect(false, 0, 60_000)).toEqual({ kind: 'rate-limited', retryInMs: 240_000 });
    expect(decideReconnect(false, undefined, 10)).toEqual({ kind: 'start' });
  });
});

function makeRecovery(options: {
  reconnected: boolean;
  socketOpen: boolean;
  latest?: boolean;
  resend?: () => Promise<void>;
  latestRequested?: () => boolean;
}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let socketOpen = options.socketOpen;
  const requestReconnect = vi.fn(() => ({
    started: true,
    reconnecting: true,
    done: Promise.resolve(options.reconnected).then((opened) => {
      socketOpen = opened;
      return opened;
    }),
  }));
  const resend = vi.fn(options.resend ?? (async () => undefined));
  const reconcile = vi.fn();
  const recovery = new PowerRecovery({
    deviceName: 'Air Circulator',
    requestReconnect,
    isSocketOpen: () => socketOpen,
    resend,
    latestRequested: options.latestRequested ?? (() => options.latest ?? true),
    reconcile,
    log,
  });
  return { recovery, requestReconnect, resend, reconcile, log };
}

describe('power command recovery', () => {
  it('starts recovery when the socket is not open, then resends and reconciles', async () => {
    const { recovery, requestReconnect, resend, reconcile } = makeRecovery({
      reconnected: true,
      socketOpen: false,
    });
    const controller = controllerWith(() => {
      throw new Error(NOT_OPEN);
    });

    const attempt = recovery.run(true, 'poweron', () =>
      controller.execute({ deviceSn: 'fan-1', command: { poweron: true }, expectedState: { poweron: true } }),
    );

    await expect(attempt).rejects.toBeInstanceOf(PowerCommandFailure);
    await expect(attempt).rejects.toThrow(
      'Device: Air Circulator, Requested: true, Observed: unknown, Reconnect: started',
    );
    await recovery.settled();
    expect(requestReconnect).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledWith(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reports the observed state from an unconfirmed command', async () => {
    const { recovery } = makeRecovery({ reconnected: true, socketOpen: true });
    const controller = controllerWith(() => 'cmd-1', { poweron: { state: false } });

    await expect(
      recovery.run(true, 'poweron', () =>
        controller.execute({ deviceSn: 'fan-1', command: { poweron: true }, expectedState: { poweron: true } }),
      ),
    ).rejects.toThrow('Requested: true, Observed: false');
    await recovery.settled();
  });

  it('resends the newest requested state, not the one that failed', async () => {
    const { recovery, resend } = makeRecovery({ reconnected: true, socketOpen: false, latest: false });

    await expect(
      recovery.run(true, 'poweron', async () => {
        throw new Error(NOT_OPEN);
      }),
    ).rejects.toThrow();
    await recovery.settled();

    expect(resend).toHaveBeenCalledWith(false);
  });

  it('skips the resend but still reconciles when no socket is open', async () => {
    const { recovery, resend, reconcile, log } = makeRecovery({ reconnected: false, socketOpen: false });

    await expect(
      recovery.run(false, 'poweron', async () => {
        throw new Error(NOT_OPEN);
      }),
    ).rejects.toThrow();
    await recovery.settled();

    expect(resend).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('runs one recovery at a time per device', async () => {
    const { recovery, requestReconnect } = makeRecovery({ reconnected: true, socketOpen: false });
    const fail = async (): Promise<never> => {
      throw new Error(NOT_OPEN);
    };

    const first = recovery.run(true, 'poweron', fail);
    const second = recovery.run(true, 'poweron', fail);

    await expect(first).rejects.toThrow('Reconnect: started');
    await expect(second).rejects.toThrow('Reconnect: recovery-already-running');
    await recovery.settled();
    expect(requestReconnect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect a healthy socket; resends and reconciles only', async () => {
    const { recovery, requestReconnect, resend, reconcile } = makeRecovery({
      reconnected: true,
      socketOpen: true,
    });
    const controller = controllerWith(() => 'cmd-1', { poweron: { state: false } });

    await expect(
      recovery.run(true, 'poweron', () =>
        controller.execute({ deviceSn: 'fan-1', command: { poweron: true }, expectedState: { poweron: true } }),
      ),
    ).rejects.toThrow('Reconnect: not-needed');
    await recovery.settled();

    expect(requestReconnect).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledWith(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('resends again when the user asks for a different state during the resend', async () => {
    let latest = true;
    const { recovery, resend } = makeRecovery({
      reconnected: true,
      socketOpen: false,
      latestRequested: () => latest,
      resend: async () => {
        latest = false;
      },
    });

    await expect(
      recovery.run(true, 'poweron', async () => {
        throw new Error(NOT_OPEN);
      }),
    ).rejects.toThrow();
    await recovery.settled();

    expect(resend.mock.calls).toEqual([[true], [false]]);
  });
});
