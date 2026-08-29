interface ControlItem {
  readonly text?: string;
  readonly value?: number;
}

interface DeviceControl {
  readonly type?: string;
  readonly cmd?: string;
  readonly items?: readonly ControlItem[];
}

interface FanDevice {
  readonly controlsConf?: {
    readonly control?: readonly DeviceControl[];
  };
}

interface StateValue {
  readonly state: unknown;
}

type FanState = Readonly<Record<string, StateValue | undefined>>;

export function isAuthoritativeDeviceReport(method: unknown): boolean {
  return method === 'control-report' || method === 'report';
}

export interface FanCapabilities {
  readonly maxSpeed: number;
  readonly powerCommand: 'poweron' | 'fanon';
  readonly swingCommand: 'shakehorizon' | 'hoscon' | 'oscmode' | 'none';
}

export function getFanCapabilities(device: FanDevice, state: FanState): FanCapabilities {
  const controls = device.controlsConf?.control ?? [];
  const speedControl = controls.find((control: DeviceControl) => control.type === 'Speed');
  const speedValues = speedControl?.items
    ?.map((item: ControlItem) => item.value ?? Number(item.text))
    .filter((value: number) => Number.isFinite(value));
  const maxSpeed = speedValues?.length ? Math.max(...speedValues) : undefined;
  if (!maxSpeed || maxSpeed < 1) {
    throw new Error('Dreo fan did not advertise a valid speed range.');
  }

  const powerCommand = state.poweron !== undefined ? 'poweron' : 'fanon';
  if (state[powerCommand] === undefined) {
    throw new Error('Dreo fan did not report a supported power state.');
  }

  const oscillationControl = controls.find(
    (control: DeviceControl) => control.type === 'Oscillation',
  );
  const advertisedCommand = oscillationControl?.cmd;
  const swingCommand =
    advertisedCommand === 'shakehorizon' ||
    advertisedCommand === 'hoscon' ||
    advertisedCommand === 'oscmode'
      ? advertisedCommand
      : state.oscmode !== undefined
        ? 'oscmode'
        : state.shakehorizon !== undefined
          ? 'shakehorizon'
          : state.hoscon !== undefined
            ? 'hoscon'
            : 'none';

  return { maxSpeed, powerCommand, swingCommand };
}
