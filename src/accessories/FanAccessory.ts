import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';
import {
  getFanCapabilities,
  isAuthoritativeDeviceReport,
} from './FanCapabilities';
import {
  removeUnsupportedCharacteristic,
  removeUnsupportedService,
} from './AccessoryCapabilities';
import {
  ConfirmedController,
  type DreoCommand,
  type DreoState,
} from '../reliability/ConfirmedController';

// How long to let commands settle before re-reading authoritative state. Long
// enough for the device to actually apply and report a change (observed at
// roughly 300-500ms, worst case 1.3s), and debounced so a burst of commands
// costs one REST call rather than one per command.
const STATE_RECONCILE_DELAY_MS = 3000;

// Cap for any remote-supplied value that reaches the log. The socket accepts
// very large frames and every accessory listens on the same one, so an
// unbounded log of remote content is both a disk-fill risk and, via embedded
// newlines, a way to forge log lines.
const MAX_LOGGED_REMOTE_CHARS = 200;

function forLog(value: unknown): string {
  const text = String(value).slice(0, MAX_LOGGED_REMOTE_CHARS);
  let sanitized = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return sanitized;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FanAccessory extends BaseAccessory {
  private service: Service;
  private temperatureService?: Service;
  private lightService?: Service;
  private readonly confirmedController: ConfirmedController;

  // Debounce handle for the post-command reconciliation read
  private reconcileTimer?: NodeJS.Timeout;

  // Incremented on every scheduled reconcile so an in-flight read that resolves
  // after a newer command can detect that it is stale and discard its result
  private reconcileGeneration = 0;

  // Cached copy of latest fan states
  private currState = {
    on: false,
    powerCMD: 'none', // Command used to control power (poweron, fanon)
    speed: 1,
    swing: false,
    swingCMD: 'none', // Command used to control oscillation (shakehorizon, hoscon, oscmode)
    autoMode: false,
    lockPhysicalControls: false,
    maxSpeed: 1,
    temperature: 0,
    lightOn: false,
    brightness: 100,
  };

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    // Call base class constructor
    super(platform, accessory);

    this.confirmedController = new ConfirmedController({
      send: (deviceSn: string, command: DreoCommand): string =>
        this.platform.webHelper.control(deviceSn, command),
      getState: (deviceSn: string): Promise<DreoState | undefined> =>
        this.platform.webHelper.getState(deviceSn),
      sleep: (milliseconds: number): Promise<void> =>
        new Promise((resolve: () => void) => setTimeout(resolve, milliseconds)),
      attempts: 2,
      confirmationDelayMs: 1500,
    });

    const capabilities = getFanCapabilities(accessory.context.device, state);
    this.currState.maxSpeed = capabilities.maxSpeed;
    this.currState.powerCMD = capabilities.powerCommand;
    this.currState.swingCMD = capabilities.swingCommand;
    this.currState.speed =
      (state.windlevel.state * 100) / this.currState.maxSpeed;
    this.currState.on = Boolean(state[this.currState.powerCMD].state);

    // Get the Fanv2 service if it exists, otherwise create a new Fanv2 service
    // You can create multiple services for each accessory
    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // Set the service name, this is what is displayed as the default name on the Home app
    // In this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.deviceName,
    );

    // Each service must implement at-minimum the "required characteristics" for the given service type
    // See https://developers.homebridge.io/#/service/Fanv2
    // Register handlers for the Active Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // Register handlers for the RotationSpeed Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        // Setting minStep defines fan speed steps in HomeKit
        minStep: 100 / this.currState.maxSpeed,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Check whether fan supports oscillation. Air circulators advertise this as
    // DPad while reporting the actual boolean/mode through oscmode.
    if (this.currState.swingCMD !== 'none') {
      // Register handlers for Swing Mode (oscillation)
      this.service
        .getCharacteristic(this.platform.Characteristic.SwingMode)
        .onSet(this.setSwingMode.bind(this))
        .onGet(this.getSwingMode.bind(this));
      this.currState.swing = state[this.currState.swingCMD].state;
    } else {
      removeUnsupportedCharacteristic(
        this.service,
        this.platform.Characteristic.SwingMode,
        false,
      );
    }

    // Check if mode control is supported
    if (state.mode !== undefined) {
      // Register handlers for Target Fan State
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onSet(this.setMode.bind(this))
        .onGet(this.getMode.bind(this));
      this.currState.autoMode = this.convertModeToBoolean(state.mode.state);
    } else {
      removeUnsupportedCharacteristic(
        this.service,
        this.platform.Characteristic.TargetFanState,
        false,
      );
    }

    // Check if child lock is supported
    if (state.childlockon !== undefined) {
      // Register handlers for Lock Physical Controls
      this.service
        .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
        .onSet(this.setLockPhysicalControls.bind(this))
        .onGet(this.getLockPhysicalControls.bind(this));
      this.currState.lockPhysicalControls = Boolean(state.childlockon.state);
    } else {
      removeUnsupportedCharacteristic(
        this.service,
        this.platform.Characteristic.LockPhysicalControls,
        false,
      );
    }

    const shouldHideTemperatureSensor =
      this.platform.config.hideTemperatureSensor || false; // default to false if not defined

    // If temperature is defined and we are not hiding the sensor
    if (state.temperature !== undefined && !shouldHideTemperatureSensor) {
      this.currState.temperature = this.correctedTemperature(
        state.temperature.state,
      );

      // Check if the Temperature Sensor service already exists, if not create a new one
      this.temperatureService = this.accessory.getService(
        this.platform.Service.TemperatureSensor,
      );

      if (!this.temperatureService) {
        this.temperatureService = this.accessory.addService(
          this.platform.Service.TemperatureSensor,
          'Temperature Sensor',
        );
      }

      // Bind the get handler for temperature to this service
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getTemperature.bind(this));
    } else {
      const existingTemperatureService = this.accessory.getService(
        this.platform.Service.TemperatureSensor,
      );
      if (existingTemperatureService) {
        platform.log.debug('Hiding Temperature Sensor');
        this.accessory.removeService(existingTemperatureService);
      }
    }

    if (state.lighton !== undefined && state.brightness !== undefined) {
      this.currState.lightOn = state.lighton.state;
      this.currState.brightness = state.brightness.state;

      // Initialize Lightbulb service
      this.lightService =
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      this.lightService.setCharacteristic(
        this.platform.Characteristic.Name,
        accessory.context.device.deviceName + ' Light',
      );

      this.lightService
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this))
        .onGet(this.getLightOn.bind(this));

      this.lightService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setBrightness.bind(this))
        .onGet(this.getBrightness.bind(this));
    } else {
      removeUnsupportedService(
        this.accessory,
        this.platform.Service.Lightbulb,
        false,
      );
    }

    // Update values from Dreo app
    platform.webHelper.addEventListener('message', (message) => {
      // The socket payload is untrusted input; an unguarded parse throws inside
      // the listener, where nothing catches it
      let data;
      try {
        data = JSON.parse(message.data);
      } catch (error) {
        // Log the size and the reason, never the payload: frames carry the
        // device serial (which platform.ts masks elsewhere), the socket accepts
        // up to 100 MiB per frame, and every accessory listens on the same
        // socket, so echoing a bad frame multiplies into the log
        platform.log.error(
          'Failed to parse incoming WebSocket message, discarding it. Bytes: %s, Error: %s',
          String(message.data).length,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      // Check if message applies to this device
      if (data.devicesn === accessory.context.device.sn) {
        platform.log.debug('Incoming %s', message.data);

        // A control-reply only echoes the value that was requested; it is not
        // evidence the hardware complied. Only the device's own report is.
        const isDeviceReport = isAuthoritativeDeviceReport(data.method);

        // Check if we need to update fan state in homekit
        if (
          (isDeviceReport || data.method === 'control-reply') &&
          typeof data.reported === 'object' &&
          data.reported !== null
        ) {
          Object.keys(data.reported).forEach((key) => {
            const isErrorDetail = key === 'error_code' || key === 'error_msg';
            if (!isDeviceReport && !isErrorDetail) {
              return;
            }
            switch (key) {
              case 'poweron':
                this.currState.on = data.reported.poweron;
                this.service
                  .getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.currState.on);
                this.platform.log.debug('Fan power:', data.reported.poweron);
                break;
              case 'fanon':
                this.currState.on = data.reported.fanon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.currState.on);
                this.platform.log.debug('Fan power:', data.reported.fanon);
                break;
              case 'windlevel':
                this.currState.speed =
                  (data.reported.windlevel * 100) / this.currState.maxSpeed;
                this.service
                  .getCharacteristic(this.platform.Characteristic.RotationSpeed)
                  .updateValue(this.currState.speed);
                this.platform.log.debug('Fan speed:', data.reported.windlevel);
                break;
              case 'shakehorizon':
                this.currState.swing = data.reported.shakehorizon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.shakehorizon,
                );
                break;
              case 'hoscon':
                this.currState.swing = data.reported.hoscon;
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.hoscon,
                );
                break;
              case 'oscmode':
                this.currState.swing = Boolean(data.reported.oscmode);
                this.service
                  .getCharacteristic(this.platform.Characteristic.SwingMode)
                  .updateValue(this.currState.swing);
                this.platform.log.debug(
                  'Oscillation mode:',
                  data.reported.oscmode,
                );
                break;
              case 'mode':
                this.currState.autoMode = this.convertModeToBoolean(
                  data.reported.mode,
                );
                this.service
                  .getCharacteristic(
                    this.platform.Characteristic.TargetFanState,
                  )
                  .updateValue(this.currState.autoMode);
                this.platform.log.debug('Fan mode:', data.reported.mode);
                break;
              case 'childlockon':
                this.currState.lockPhysicalControls = Boolean(
                  data.reported.childlockon,
                );
                this.service
                  .getCharacteristic(
                    this.platform.Characteristic.LockPhysicalControls,
                  )
                  .updateValue(this.currState.lockPhysicalControls);
                this.platform.log.debug(
                  'Child lock:',
                  data.reported.childlockon,
                );
                break;
              case 'temperature':
                if (
                  this.temperatureService !== undefined &&
                  !shouldHideTemperatureSensor
                ) {
                  this.currState.temperature = this.correctedTemperature(
                    data.reported.temperature,
                  );
                  this.temperatureService
                    .getCharacteristic(
                      this.platform.Characteristic.CurrentTemperature,
                    )
                    .updateValue(this.currState.temperature);
                }
                this.platform.log.debug(
                  'Temperature:',
                  data.reported.temperature,
                );
                break;
              case 'lighton':
                this.currState.lightOn = data.reported.lighton;
                this.lightService
                  ?.getCharacteristic(this.platform.Characteristic.On)
                  .updateValue(this.currState.lightOn);
                this.platform.log.debug('Light on:', data.reported.lighton);
                break;
              case 'brightness':
                this.currState.brightness = data.reported.brightness;
                this.lightService
                  ?.getCharacteristic(this.platform.Characteristic.Brightness)
                  .updateValue(this.currState.brightness);
                this.platform.log.debug(
                  'Brightness:',
                  data.reported.brightness,
                );
                break;
              case 'error_code':
                // Dreo answers a rejected command with an error frame rather
                // than a state change, and still emits a normal-looking reply
                // echoing the requested value. Without this case the rejection
                // falls through to the unknown-key branch below and is logged
                // at debug, so HomeKit keeps whatever the echo implied.
                // Guarded on a truthy code so a success-shaped error_code: 0
                // would not log at error and trigger a needless REST read.
                if (data.reported.error_code) {
                  this.platform.log.error(
                    'Dreo rejected a control command, the device state did not change. Code: %s, Message: %s',
                    forLog(data.reported.error_code),
                    forLog(data.reported.error_msg),
                  );
                  this.scheduleStateReconciliation();
                }
                break;
              case 'error_msg':
                // Normally accompanies error_code, which carries the log above;
                // on its own it would otherwise vanish silently
                if (data.reported.error_code === undefined) {
                  this.platform.log.warn(
                    'Dreo reported an error with no code. Message: %s',
                    forLog(data.reported.error_msg),
                  );
                }
                break;
              default:
                platform.log.debug('Unknown command received:', key);
            }
          });
        }
      }
    });

    platform.webHelper.addEventListener('open', () => {
      this.platform.log.info(
        'Refreshing fan state after Dreo WebSocket connection opened. Device: %s',
        this.accessory.context.device.deviceName,
      );
      this.scheduleStateReconciliation();
    });
  }

  private async controlAndConfirm(
    command: DreoCommand,
    expectedState: Readonly<Record<string, boolean | number | string>>,
  ): Promise<DreoState> {
    try {
      const result = await this.confirmedController.execute({
        deviceSn: this.sn,
        command,
        expectedState,
      });
      this.platform.log.info(
        'Confirmed Dreo control command. CommandId: %s, Expected: %s',
        result.commandId,
        JSON.stringify(expectedState),
      );
      return result.state;
    } catch (error) {
      this.platform.log.error(
        'Dreo control command failed confirmation. Command: %s, Error: %s',
        JSON.stringify(command),
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  // Handle requests to set the "Active" characteristic
  async setActive(value) {
    const active = Boolean(value);
    this.platform.log.debug('Triggered SET Active:', active);
    await this.controlAndConfirm(
      { [this.currState.powerCMD]: active },
      { [this.currState.powerCMD]: active },
    );
    this.currState.on = active;
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .updateValue(active);
  }

  // Handle requests to get the current value of the "Active" characteristic
  getActive() {
    return this.currState.on;
  }

  // Handle requests to set the fan speed
  async setRotationSpeed(value) {
    const converted = Math.round((value * this.currState.maxSpeed) / 100);
    if (converted === 0) {
      await this.setActive(false);
      return;
    }

    this.platform.log.debug('Setting fan speed:', converted);
    if (!this.currState.on) {
      this.platform.log.debug('Fan is off, powering on before setting speed');
      await this.controlAndConfirm(
        { [this.currState.powerCMD]: true },
        { [this.currState.powerCMD]: true },
      );
      this.currState.on = true;
    }
    await this.controlAndConfirm(
      { windlevel: converted },
      { windlevel: converted },
    );
    this.currState.speed = (converted * 100) / this.currState.maxSpeed;
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .updateValue(this.currState.speed);
  }

  // Dreo answers a command with control-reply, which only echoes back the value
  // that was requested; it is not proof the hardware complied. Re-read the
  // authoritative REST state once the dust settles and push that instead.
  //
  // Debounced so a slider drag, or an automation firing several commands at
  // once, costs a single read rather than one per command.
  private scheduleStateReconciliation() {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
    }
    // Clearing the timer cannot cancel a read that has already been dispatched,
    // so bump a generation counter too — a read that resolves after a newer
    // command arrived is stale and must not be written back
    this.reconcileGeneration += 1;
    this.reconcileTimer = setTimeout(
      () => this.reconcileState(this.reconcileGeneration),
      STATE_RECONCILE_DELAY_MS,
    );
    // Do not hold the event loop open for a pending reconcile during shutdown
    this.reconcileTimer.unref?.();
  }

  private async reconcileState(generation: number) {
    let state;
    try {
      state = await this.platform.webHelper.getState(this.sn);
    } catch (error) {
      // getState already handles its own errors, but a throw here would land in
      // a floating promise and take the whole Homebridge process down with it
      this.platform.log.error(
        'Failed to re-read device state to reconcile. Device: %s, Error: %s',
        this.accessory.context.device.deviceName,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    // A newer command landed while this read was in flight; writing its result
    // now would visibly revert the user's change in the Home app
    if (generation !== this.reconcileGeneration) {
      return;
    }

    // Nullish rather than strictly undefined: the API returns response.data
    // .data.mixed, which can be null, and null would pass an undefined check
    // and then throw on property access
    if (!state) {
      this.platform.log.warn(
        'Could not re-read device state to reconcile, HomeKit may be showing a stale value. Device: %s',
        this.accessory.context.device.deviceName,
      );
      return;
    }

    // Power and speed only: these are the values automations act on, and the
    // ones observed to drift when the device ignores a command
    // Push unconditionally rather than only when our own cache disagrees.
    // HomeKit keeps its own copy of every characteristic, and it can be stale
    // even when ours is correct — in which case an automation whose target
    // state HomeKit believes is already met may never send a command at all.
    // The comparison below gates the log line, not the push.
    const powerState = state[this.currState.powerCMD]?.state;
    if (powerState !== undefined) {
      if (powerState !== this.currState.on) {
        this.platform.log.info(
          'Reconciled fan power against the Dreo API. Cached: %s, Actual: %s',
          this.currState.on,
          powerState,
        );
      }
      this.currState.on = powerState;
      this.service
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(this.currState.on);
    }

    const windlevel = state.windlevel?.state;
    if (windlevel !== undefined) {
      const speed = (windlevel * 100) / this.currState.maxSpeed;
      if (speed !== this.currState.speed) {
        this.platform.log.info(
          'Reconciled fan speed against the Dreo API. Cached: %s, Actual: %s',
          this.currState.speed,
          speed,
        );
      }
      this.currState.speed = speed;
      this.service
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.currState.speed);
    }
  }

  async getRotationSpeed() {
    return this.currState.speed;
  }

  // Turn oscillation on/off
  async setSwingMode(value) {
    const swingValue =
      this.currState.swingCMD === 'oscmode' ? Number(value) : Boolean(value);
    await this.controlAndConfirm(
      { [this.currState.swingCMD]: swingValue },
      { [this.currState.swingCMD]: swingValue },
    );
    this.currState.swing = Boolean(value);
  }

  async getSwingMode() {
    return this.currState.swing;
  }

  // Set fan mode
  async setMode(value) {
    const mode = value === this.platform.Characteristic.TargetFanState.AUTO ? 4 : 1;
    await this.controlAndConfirm({ mode }, { mode });
    this.currState.autoMode = this.convertModeToBoolean(mode);
  }

  async getMode() {
    return this.currState.autoMode;
  }

  // Turn child lock on/off
  async setLockPhysicalControls(value) {
    const childlockon = Number(value);
    await this.controlAndConfirm({ childlockon }, { childlockon });
    this.currState.lockPhysicalControls = Boolean(value);
  }

  getLockPhysicalControls() {
    return this.currState.lockPhysicalControls;
  }

  async getTemperature() {
    return this.currState.temperature;
  }

  correctedTemperature(temperatureFromDreo) {
    const offset = this.platform.config.temperatureOffset || 0; // default to 0 if not defined
    // Dreo response is always Fahrenheit - convert to Celsius which is what HomeKit expects
    return ((temperatureFromDreo + offset - 32) * 5) / 9;
  }

  convertModeToBoolean(value: number) {
    // Show all non-automatic modes as "Manual"
    return value === 4;
  }

  async setLightOn(value: any) {
    const lighton = Boolean(value);
    this.platform.log.debug('Triggered SET Light On:', lighton);
    await this.controlAndConfirm({ lighton }, { lighton });
    this.currState.lightOn = lighton;
  }

  getLightOn() {
    return this.currState.lightOn;
  }

  async setBrightness(value) {
    const brightness = Number(value);
    this.platform.log.debug('Triggered SET Brightness:', brightness);
    await this.controlAndConfirm({ brightness }, { brightness });
    this.currState.brightness = brightness;
  }

  getBrightness() {
    return this.currState.brightness;
  }
}
