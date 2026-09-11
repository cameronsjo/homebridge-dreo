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

  it('confirms sequence steps in strict order', async () => {
    const events: string[] = [];
    const send = vi.fn((_deviceSn: string, command: Readonly<Record<string, unknown>>) => {
      const key = Object.keys(command)[0];
      events.push(`send:${key}`);
      return `command-${key}`;
    });
    const getState = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('state:poweron');
        return { poweron: { state: true } };
      })
      .mockImplementationOnce(async () => {
        events.push('state:windlevel');
        return { windlevel: { state: 4 } };
      });
    const controller = new ConfirmedController({
      send,
      getState,
      sleep: vi.fn().mockResolvedValue(undefined),
      attempts: 1,
      confirmationDelayMs: 0,
    });

    await controller.executeSequence('fan-1', [
      { command: { poweron: true }, expectedState: { poweron: true } },
      { command: { windlevel: 4 }, expectedState: { windlevel: 4 } },
    ]);

    expect(events).toEqual([
      'send:poweron',
      'state:poweron',
      'send:windlevel',
      'state:windlevel',
    ]);
  });

  it('stops a sequence when power confirmation fails', async () => {
    const send = vi.fn().mockReturnValue('command-power');
    const controller = new ConfirmedController({
      send,
      getState: vi.fn().mockResolvedValue({ poweron: { state: false } }),
      sleep: vi.fn().mockResolvedValue(undefined),
      attempts: 1,
      confirmationDelayMs: 0,
    });

    await expect(controller.executeSequence('fan-1', [
      { command: { poweron: true }, expectedState: { poweron: true } },
      { command: { windlevel: 4 }, expectedState: { windlevel: 4 } },
    ])).rejects.toThrow('Dreo command command-power was not confirmed');

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('fan-1', { poweron: true });
  });

  it('does not interleave another command within a device sequence', async () => {
    let resolvePowerState: ((state: { poweron: { state: boolean } }) => void) | undefined;
    const powerState = new Promise<{ poweron: { state: boolean } }>((resolve) => {
      resolvePowerState = resolve;
    });
    const send = vi.fn()
      .mockReturnValueOnce('command-power')
      .mockReturnValueOnce('command-speed')
      .mockReturnValueOnce('command-swing');
    const getState = vi.fn()
      .mockReturnValueOnce(powerState)
      .mockResolvedValueOnce({ windlevel: { state: 4 } })
      .mockResolvedValueOnce({ shakehorizon: { state: true } });
    const controller = new ConfirmedController({
      send,
      getState,
      sleep: vi.fn().mockResolvedValue(undefined),
      attempts: 1,
      confirmationDelayMs: 0,
    });

    const speedSequence = controller.executeSequence('fan-1', [
      { command: { poweron: true }, expectedState: { poweron: true } },
      { command: { windlevel: 4 }, expectedState: { windlevel: 4 } },
    ]);
    const swing = controller.execute({
      deviceSn: 'fan-1',
      command: { shakehorizon: true },
      expectedState: { shakehorizon: true },
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    resolvePowerState?.({ poweron: { state: true } });
    await expect(speedSequence).resolves.toHaveLength(2);
    await expect(swing).resolves.toMatchObject({ commandId: 'command-swing' });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { poweron: true },
      { windlevel: 4 },
      { shakehorizon: true },
    ]);
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
