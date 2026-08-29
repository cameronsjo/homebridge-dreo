import { describe, expect, it, vi } from 'vitest';
import { ConfirmedController } from '../src/reliability/ConfirmedController';

describe('ConfirmedController', () => {
  it('resolves only after the authoritative state matches the command', async () => {
    const send = vi.fn().mockReturnValue('command-1');
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ poweron: { state: false } })
      .mockResolvedValueOnce({ poweron: { state: true } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const controller = new ConfirmedController({
      send,
      getState,
      sleep,
      attempts: 2,
      confirmationDelayMs: 10,
    });

    await expect(
      controller.execute({
        deviceSn: 'fan-1',
        command: { poweron: true },
        expectedState: { poweron: true },
      }),
    ).resolves.toEqual({ commandId: 'command-1', state: { poweron: { state: true } } });

    expect(send).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent commands for the same device', async () => {
    let resolvePowerState: ((state: { poweron: { state: boolean } }) => void) | undefined;
    const powerState = new Promise<{ poweron: { state: boolean } }>((resolve) => {
      resolvePowerState = resolve;
    });
    const send = vi
      .fn()
      .mockReturnValueOnce('command-power')
      .mockReturnValueOnce('command-speed');
    const getState = vi
      .fn()
      .mockReturnValueOnce(powerState)
      .mockResolvedValueOnce({ windlevel: { state: 4 } });
    const controller = new ConfirmedController({
      send,
      getState,
      sleep: vi.fn().mockResolvedValue(undefined),
      attempts: 1,
      confirmationDelayMs: 0,
    });

    const power = controller.execute({
      deviceSn: 'fan-1',
      command: { poweron: true },
      expectedState: { poweron: true },
    });
    const speed = controller.execute({
      deviceSn: 'fan-1',
      command: { windlevel: 4 },
      expectedState: { windlevel: 4 },
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    resolvePowerState?.({ poweron: { state: true } });
    await expect(power).resolves.toMatchObject({ commandId: 'command-power' });
    await expect(speed).resolves.toMatchObject({ commandId: 'command-speed' });
  });

  it('rejects with the requested and actual state when Dreo never applies the command', async () => {
    const controller = new ConfirmedController({
      send: vi.fn().mockReturnValue('command-2'),
      getState: vi.fn().mockResolvedValue({ windlevel: { state: 5 } }),
      sleep: vi.fn().mockResolvedValue(undefined),
      attempts: 2,
      confirmationDelayMs: 10,
    });

    await expect(
      controller.execute({
        deviceSn: 'fan-1',
        command: { windlevel: 4 },
        expectedState: { windlevel: 4 },
      }),
    ).rejects.toThrow(
      'Dreo command command-2 was not confirmed. Expected: {"windlevel":4}, Actual: {"windlevel":5}',
    );
  });
});
