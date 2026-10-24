import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ECO_RANGE,
  ecoTemperatureRange,
  heatLevelFromThreshold,
} from '../src/accessories/HeaterMapping';

describe('heater eco temperature range', () => {
  it('reads the eco range from the schedule controls', () => {
    const controlsConf = {
      schedule: {
        modes: [
          { value: 'hotair', controls: [{ startValue: 1, endValue: 3 }] },
          { value: 'eco', controls: [{ startValue: 45, endValue: 86 }] },
        ],
      },
    };

    expect(ecoTemperatureRange(controlsConf)).toEqual({ startValue: 45, endValue: 86 });
  });

  it.each([
    ['no control config', undefined],
    ['no schedule', {}],
    ['a schedule without modes', { schedule: {} }],
    ['a schedule without an eco mode', { schedule: { modes: [{ value: 'hotair', controls: [] }] } }],
    ['an eco mode without controls', { schedule: { modes: [{ value: 'eco' }] } }],
    ['an eco control missing a bound', { schedule: { modes: [{ value: 'eco', controls: [{ startValue: 41 }] }] } }],
  ])('falls back to the default range for %s', (_label, controlsConf) => {
    expect(ecoTemperatureRange(controlsConf)).toEqual(DEFAULT_ECO_RANGE);
  });
});

describe('heater fixed heat level', () => {
  it('maps the three lowest half-degree steps to levels 1-3', () => {
    expect(heatLevelFromThreshold(5, 5)).toBe(1);
    expect(heatLevelFromThreshold(5.5, 5)).toBe(2);
    expect(heatLevelFromThreshold(6, 5)).toBe(3);
  });

  it('clamps thresholds above the third step to level 3', () => {
    expect(heatLevelFromThreshold(30, 5)).toBe(3);
  });

  it('clamps thresholds below the minimum to level 1', () => {
    expect(heatLevelFromThreshold(4, 5)).toBe(1);
  });

  it('always returns an integer when minTemp is not on a half-degree boundary', () => {
    // 42F is 5.555...C, so HomeKit's 0.5 steps do not line up with it
    const minTemp = (42 - 32) * 5 / 9;
    for (const threshold of [5.5, 6, 6.5]) {
      expect(Number.isInteger(heatLevelFromThreshold(threshold, minTemp))).toBe(true);
    }
  });
});
