import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  emitOptionalError,
  getReconnectDelay,
  isConnectionHealthyMessage,
} from '../src/DreoAPI';

describe('Dreo WebSocket reconnect policy', () => {
  it('backs off exponentially and caps reconnect delay at 30 seconds', () => {
    expect([1, 2, 3, 6, 20].map(getReconnectDelay)).toEqual([
      1_000,
      2_000,
      4_000,
      30_000,
      30_000,
    ]);
  });

  it('does not throw when a socket error has no consumer listener', () => {
    const events = new EventEmitter();

    expect(() => emitOptionalError(events, new Error('connection reset'))).not.toThrow();
  });

  it('resets backoff only for heartbeats and authoritative device reports', () => {
    expect(isConnectionHealthyMessage('3')).toBe(true);
    expect(isConnectionHealthyMessage(JSON.stringify({
      method: 'control-report',
      devicesn: 'fan-1',
    }))).toBe(true);
    expect(isConnectionHealthyMessage(JSON.stringify({
      method: 'report',
      devicesn: 'fan-1',
    }))).toBe(true);
    expect(isConnectionHealthyMessage(JSON.stringify({
      method: 'auth-rejected',
    }))).toBe(false);
    expect(isConnectionHealthyMessage('not-json')).toBe(false);
  });

  it('forwards socket errors when a consumer registered a listener', () => {
    const events = new EventEmitter();
    const listener = vi.fn();
    events.on('error', listener);
    const error = new Error('connection reset');

    emitOptionalError(events, error);

    expect(listener).toHaveBeenCalledWith(error);
  });
});
