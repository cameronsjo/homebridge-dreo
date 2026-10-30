import { describe, expect, it, vi } from 'vitest';
import {
  MAX_POLL_BACKOFF_MS,
  StatePoller,
  nextPollDelayMs,
  resolvePollIntervalMs,
  type StatePollerDependencies,
} from '../src/reliability/StatePoller';

type State = { poweron: { state: boolean } };

function makePoller(overrides: Partial<StatePollerDependencies<State>> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const apply = vi.fn();
  const dependencies: StatePollerDependencies<State> = {
    read: async () => ({ poweron: { state: true } }),
    apply,
    isBusy: () => false,
    commandEpoch: () => 0,
    intervalMs: 60_000,
    log,
    deviceName: 'Air Circulator',
    ...overrides,
  };
  return { poller: new StatePoller(dependencies), apply, log };
}

describe('Dreo state poll', () => {
  it('applies a poll result when no command raced it', async () => {
    const { poller, apply } = makePoller();

    expect(await poller.pollOnce()).toBe('applied');
    expect(apply).toHaveBeenCalledWith({ poweron: { state: true } });
  });

  it('discards a poll result when a command started during the read', async () => {
    let epoch = 0;
    const { poller, apply } = makePoller({
      commandEpoch: () => epoch,
      read: async () => {
        epoch += 1;
        return { poweron: { state: false } };
      },
    });

    expect(await poller.pollOnce()).toBe('discarded-stale');
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips the poll while a command is in flight', async () => {
    const read = vi.fn(async () => ({ poweron: { state: true } }));
    const { poller, apply } = makePoller({ isBusy: () => true, read });

    expect(await poller.pollOnce()).toBe('skipped-busy');
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('logs the first failure and the recovery, and per-poll failures at debug', async () => {
    let failing = true;
    const { poller, log } = makePoller({
      read: async () => {
        if (failing) {
          throw new Error('HTTP 503');
        }
        return { poweron: { state: true } };
      },
    });

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    failing = false;
    expect(await poller.pollOnce()).toBe('applied');

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      'State poll recovered after %s failures. Device: %s',
      3,
      'Air Circulator',
    );
    expect(poller.failures).toBe(0);
  });

  it('treats an empty state read as a failure', async () => {
    const { poller, apply } = makePoller({ read: async () => undefined });

    expect(await poller.pollOnce()).toBe('failed');
    expect(apply).not.toHaveBeenCalled();
  });

  it('backs off exponentially on consecutive failures, capped at ten minutes', () => {
    expect([0, 1, 2, 3, 4, 20].map((failures) => nextPollDelayMs(60_000, failures))).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      MAX_POLL_BACKOFF_MS,
      MAX_POLL_BACKOFF_MS,
    ]);
  });

  it('defaults the interval to 60 seconds and enforces a 30 second minimum', () => {
    expect(resolvePollIntervalMs(undefined)).toBe(60_000);
    expect(resolvePollIntervalMs('90')).toBe(60_000);
    expect(resolvePollIntervalMs(10)).toBe(30_000);
    expect(resolvePollIntervalMs(120)).toBe(120_000);
  });
});
