import { describe, expect, it } from 'vitest';
import {
  getFanCapabilities,
  isAuthoritativeDeviceReport,
} from '../src/accessories/FanCapabilities';
import { drHaf003sDevice, drHaf003sState } from './fixtures/dr-haf003s';

describe('getFanCapabilities', () => {
  it('exposes DR-HAF003S DPad oscillation through its oscmode state', () => {
    expect(getFanCapabilities(drHaf003sDevice, drHaf003sState)).toEqual({
      maxSpeed: 8,
      powerCommand: 'poweron',
      swingCommand: 'oscmode',
    });
  });

  it('accepts device reports but rejects command echoes as authoritative state', () => {
    expect(isAuthoritativeDeviceReport('control-report')).toBe(true);
    expect(isAuthoritativeDeviceReport('report')).toBe(true);
    expect(isAuthoritativeDeviceReport('control-reply')).toBe(false);
  });
});
