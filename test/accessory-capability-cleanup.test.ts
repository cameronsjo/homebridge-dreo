import { describe, expect, it, vi } from 'vitest';
import {
  removeUnsupportedCharacteristic,
  removeUnsupportedService,
} from '../src/accessories/AccessoryCapabilities';

describe('cached accessory capability cleanup', () => {
  it('removes a stale optional characteristic when current state no longer supports it', () => {
    const staleCharacteristic = { displayName: 'Swing Mode' };
    const service = {
      getCharacteristic: vi.fn(() => staleCharacteristic),
      removeCharacteristic: vi.fn(),
    };

    removeUnsupportedCharacteristic(service, 'SwingMode', false);

    expect(service.removeCharacteristic).toHaveBeenCalledWith(staleCharacteristic);
  });

  it('removes a stale optional service when current state no longer supports it', () => {
    const staleService = { displayName: 'Light' };
    const accessory = {
      getService: vi.fn(() => staleService),
      removeService: vi.fn(),
    };

    removeUnsupportedService(accessory, 'Lightbulb', false);

    expect(accessory.removeService).toHaveBeenCalledWith(staleService);
  });

  it('preserves currently supported characteristics and services', () => {
    const service = {
      getCharacteristic: vi.fn(),
      removeCharacteristic: vi.fn(),
    };
    const accessory = {
      getService: vi.fn(),
      removeService: vi.fn(),
    };

    removeUnsupportedCharacteristic(service, 'SwingMode', true);
    removeUnsupportedService(accessory, 'Lightbulb', true);

    expect(service.getCharacteristic).not.toHaveBeenCalled();
    expect(service.removeCharacteristic).not.toHaveBeenCalled();
    expect(accessory.getService).not.toHaveBeenCalled();
    expect(accessory.removeService).not.toHaveBeenCalled();
  });
});
