export const drHaf003sDevice = {
  model: 'DR-HAF003S',
  deviceName: 'Air Circulator',
  controlsConf: {
    control: [
      {
        type: 'Mode',
        items: [
          { text: 'device_fans_mode_straight', value: 1 },
          { text: 'device_control_mode_auto', value: 4 },
          { text: 'device_control_mode_sleep', value: 3 },
          { text: 'device_fans_mode_natural', value: 2 },
        ],
      },
      {
        type: 'Speed',
        items: [
          { text: '1', value: 1 },
          { text: '8', value: 8 },
        ],
      },
      { type: 'DPad' },
    ],
  },
} as const;

export const drHaf003sState = {
  poweron: { state: true },
  windlevel: { state: 4 },
  mode: { state: 1 },
  oscmode: { state: 0 },
} as const;
