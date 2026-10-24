export interface TemperatureRange {
  readonly startValue: number;
  readonly endValue: number;
}

// Fahrenheit, used when the device's control config has no eco range
export const DEFAULT_ECO_RANGE: TemperatureRange = { startValue: 41, endValue: 95 };

interface ScheduleMode {
  readonly value?: unknown;
  readonly controls?: readonly Partial<TemperatureRange>[];
}

/**
 * Read the eco-mode temperature range from a device's control config.
 * Some devices have no schedule, or a schedule without an eco mode;
 * those fall back to the default range instead of throwing.
 */
export function ecoTemperatureRange(controlsConf: unknown): TemperatureRange {
  const modes = (controlsConf as { schedule?: { modes?: unknown } } | undefined)?.schedule?.modes;
  if (!Array.isArray(modes)) {
    return DEFAULT_ECO_RANGE;
  }
  const control = (modes as ScheduleMode[]).find((mode) => mode?.value === 'eco')?.controls?.[0];
  if (typeof control?.startValue !== 'number' || typeof control?.endValue !== 'number') {
    return DEFAULT_ECO_RANGE;
  }
  return { startValue: control.startValue, endValue: control.endValue };
}

/**
 * Map a HomeKit heating threshold to Dreo's fixed heat level (1-3).
 * The bottom three 0.5 degree steps above minTemp are levels 1, 2, 3.
 * Always returns an integer in range: Dreo rejects anything else.
 */
export function heatLevelFromThreshold(threshold: number, minTemp: number): number {
  const level = Math.round((threshold - minTemp) * 2) + 1;
  return Math.min(Math.max(level, 1), 3);
}
