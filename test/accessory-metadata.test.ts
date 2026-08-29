import { describe, expect, it } from 'vitest';
import { refreshAccessoryMetadata } from '../src/accessories/AccessoryMetadata';
import { drHaf003sDevice } from './fixtures/dr-haf003s';

describe('refreshAccessoryMetadata', () => {
  it('replaces stale cached device capabilities on every discovery', () => {
    const accessory = {
      context: {
        device: {
          model: 'DR-HAF003S',
          deviceName: 'Old name',
          controlsConf: { control: [{ type: 'Speed', items: [{ value: 1 }, { value: 6 }] }] },
        },
      },
    };

    refreshAccessoryMetadata(accessory, drHaf003sDevice);

    expect(accessory.context.device).toBe(drHaf003sDevice);
  });
});
