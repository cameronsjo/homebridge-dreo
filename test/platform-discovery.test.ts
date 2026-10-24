import { afterEach, describe, expect, it, vi } from 'vitest';

const webHelper = {
  authenticate: vi.fn(),
  getDevices: vi.fn(),
  getState: vi.fn(),
  startWebSocket: vi.fn(),
  server: 'us',
};

vi.mock('../src/DreoAPI', () => ({
  default: vi.fn(function DreoAPI() {
    return webHelper;
  }),
}));

const fanConstructor = vi.fn();
vi.mock('../src/accessories/FanAccessory', () => ({
  FanAccessory: vi.fn(function FanAccessory(_platform, accessory) {
    fanConstructor(accessory.context.device.sn);
    if (accessory.context.device.sn === 'BROKEN') {
      throw new TypeError("Cannot read properties of undefined (reading 'state')");
    }
  }),
}));
vi.mock('../src/accessories/HeaterAccessory', () => ({ HeaterAccessory: vi.fn() }));
vi.mock('../src/accessories/HumidifierAccessory', () => ({ HumidifierAccessory: vi.fn() }));

import { DreoPlatform } from '../src/platform';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createPlatform() {
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      Categories: { FAN: 3, AIR_HEATER: 20, AIR_HUMIDIFIER: 22 },
      uuid: { generate: (sn: string) => `uuid-${sn}` },
    },
    platformAccessory: vi.fn(function PlatformAccessory(displayName: string, UUID: string) {
      return { displayName, UUID, context: {} };
    }),
    on: vi.fn(),
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
  };
  const platform = new DreoPlatform(
    log as never,
    { options: { email: 'fan@example.com', password: 'secret' } } as never,
    api as never,
  );
  return { platform, api };
}

function fan(sn: string) {
  return { sn, deviceName: `Fan ${sn}`, model: 'DR-HAF003S', controlsConf: {} };
}

describe('device discovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
    webHelper.server = 'us';
  });

  it('keeps setting up later devices when one accessory constructor throws', async () => {
    webHelper.authenticate.mockResolvedValue({ region: 'NA', countryCode: 'US' });
    webHelper.getDevices.mockResolvedValue([fan('BROKEN'), fan('GOOD')]);
    webHelper.getState.mockResolvedValue({ poweron: { state: true } });
    const { platform, api } = createPlatform();

    await platform.discoverDevices();

    expect(fanConstructor).toHaveBeenCalledWith('BROKEN');
    expect(fanConstructor).toHaveBeenCalledWith('GOOD');
    const registered = api.registerPlatformAccessories.mock.calls.map((call) => call[2][0].UUID);
    expect(registered).toEqual(['uuid-GOOD']);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set up Dreo device'),
      'Fan BROKEN',
      'DR-HAF003S',
      expect.stringContaining('reading \'state\''),
    );
  });

  it('stops when re-authentication against the EU server fails', async () => {
    webHelper.authenticate
      .mockResolvedValueOnce({ region: 'EU', countryCode: 'DE' })
      .mockResolvedValueOnce(undefined);
    const { platform } = createPlatform();

    await platform.discoverDevices();

    expect(webHelper.server).toBe('eu');
    expect(webHelper.getDevices).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('EU server'));
  });
});
