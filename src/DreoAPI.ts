import axios from 'axios';
import MD5 from 'crypto-js/md5';
import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { Logger } from 'homebridge';
import type { DreoPlatform } from './platform';
import type { DreoCommand } from './reliability/ConfirmedController';

const USER_AGENT = 'dreo/2.8.1 (iPhone; iOS 18.0.0; Scale/3.00)';
const HEARTBEAT_INTERVAL_MS = 15_000;
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function describeApiError(error: unknown): string {
  const candidate = error as { message?: unknown; response?: { status?: unknown } };
  const status = candidate.response?.status;
  const message = candidate.message ?? String(error);
  return status === undefined ? String(message) : `${String(message)} (HTTP ${String(status)})`;
}

function getHttpStatus(error: unknown): unknown {
  return (error as { response?: { status?: unknown } }).response?.status;
}

export function emitOptionalError(events: EventEmitter, error: Error): void {
  if (events.listenerCount('error') > 0) {
    events.emit('error', error);
  }
}

export function isConnectionHealthyMessage(message: string): boolean {
  if (message === '3') {
    return true;
  }
  try {
    const data = JSON.parse(message) as { method?: unknown; devicesn?: unknown };
    const isDeviceReport = data.method === 'control-report' || data.method === 'report';
    return isDeviceReport && typeof data.devicesn === 'string';
  } catch {
    return false;
  }
}

export function getReconnectDelay(attempt: number): number {
  return Math.min(MIN_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_DELAY_MS);
}

export default class DreoAPI {
  private readonly email: string;
  private readonly password: string;
  private readonly log: Logger;
  private readonly events = new EventEmitter();
  private accessToken = '';
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private commandSequence = 0;
  private authenticationRefresh?: Promise<boolean>;
  private heartbeatAcknowledged = true;
  private stopped = false;
  public server = 'us';

  constructor(platform: DreoPlatform) {
    this.log = platform.log;
    this.email = platform.config.options?.email;
    this.password = platform.config.options?.password;
    process.once('SIGTERM', (): void => this.stopWebSocket());
  }

  public async authenticate() {
    try {
      const response = await axios.post(
        `https://app-api-${this.server}.dreo-tech.com/api/oauth/login`,
        {
          client_id: 'd8a56a73d93b427cad801116dc4d3188',
          client_secret: '2ac9b179f7e84be58bb901d6ed8bf374',
          email: this.email,
          encrypt: 'ciphertext',
          grant_type: 'email-password',
          himei: '463299817f794e52a228868167df3f34',
          password: MD5(this.password).toString(),
          scope: 'all',
        },
        {
          params: { timestamp: Date.now() },
          headers: {
            ua: USER_AGENT,
            lang: 'en',
            'content-type': 'application/json; charset=UTF-8',
            'accept-encoding': 'gzip',
            'user-agent': 'okhttp/4.9.1',
          },
        },
      );
      const payload = response.data;
      if (!payload.data?.access_token) {
        this.log.error('Error retrieving Dreo token. Message: %s', payload.msg);
        return undefined;
      }
      this.accessToken = payload.data.access_token;
      return payload.data;
    } catch (error) {
      this.log.error('Error retrieving Dreo token. Error: %s', describeApiError(error));
      return undefined;
    }
  }

  public async getDevices() {
    try {
      const response = await axios.get(
        `https://app-api-${this.server}.dreo-tech.com/api/app/index/family/room/devices`,
        { params: { timestamp: Date.now() }, headers: this.authorizedHeaders() },
      );
      return response.data.data.list;
    } catch (error) {
      this.log.error('Error retrieving Dreo device list. Error: %s', describeApiError(error));
      return undefined;
    }
  }

  public async getState(sn: string) {
    try {
      return await this.requestState(sn);
    } catch (error) {
      let finalError = error;
      if (getHttpStatus(error) === 401) {
        this.log.warn('Dreo state request was unauthorized; refreshing authentication once.');
        const refreshed = await this.refreshAuthentication();
        if (refreshed) {
          try {
            return await this.requestState(sn);
          } catch (retryError) {
            finalError = retryError;
          }
        }
      }
      this.log.error('Error retrieving Dreo device state. Error: %s', describeApiError(finalError));
      return undefined;
    }
  }

  public async startWebSocket(): Promise<void> {
    await this.connectWebSocket(false);
  }

  public addEventListener(event: 'open' | 'close' | 'error' | 'message', listener): void {
    this.events.on(event, listener);
  }

  public control(sn: string, command: DreoCommand): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Dreo WebSocket is not open; command was not sent. ' +
          `ReadyState: ${this.ws?.readyState ?? 'uninitialized'}, ` +
          `Command: ${JSON.stringify(command)}`,
      );
    }

    this.commandSequence += 1;
    const timestamp = Date.now();
    const commandId = `${timestamp}-${this.commandSequence}`;
    this.log.info(
      'Sending Dreo control command. CommandId: %s, Command: %s',
      commandId,
      JSON.stringify(command),
    );
    this.ws.send(
      JSON.stringify({ deviceSn: sn, method: 'control', params: command, timestamp }),
    );
    return commandId;
  }

  public stopWebSocket(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close(1000, 'Homebridge shutting down');
    this.ws = undefined;
  }

  private async requestState(sn: string) {
    const response = await axios.get(
      `https://app-api-${this.server}.dreo-tech.com/api/user-device/device/state`,
      {
        params: { deviceSn: sn, timestamp: Date.now() },
        headers: this.authorizedHeaders(),
      },
    );
    return response.data.data.mixed;
  }

  private async refreshAuthentication(): Promise<boolean> {
    if (!this.authenticationRefresh) {
      this.authenticationRefresh = this.authenticate()
        .then((authentication): boolean => Boolean(authentication))
        .finally((): void => {
          this.authenticationRefresh = undefined;
        });
    }
    return this.authenticationRefresh;
  }

  private authorizedHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      ua: USER_AGENT,
      lang: 'en',
      'accept-encoding': 'gzip',
      'user-agent': 'okhttp/4.9.1',
    };
  }

  private async connectWebSocket(refreshAuthentication: boolean): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (refreshAuthentication) {
      const authenticated = await this.refreshAuthentication();
      if (!authenticated) {
        this.log.error('Unable to refresh Dreo authentication before reconnecting WebSocket.');
        this.scheduleReconnect();
        return;
      }
    }
    if (this.stopped) {
      return;
    }

    const query = new URLSearchParams({
      accessToken: this.accessToken,
      timestamp: String(Date.now()),
    });
    const url = `wss://wsb-${this.server}.dreo-tech.com/websocket?${query.toString()}`;
    const socket = new WebSocket(url, {
      handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = socket;

    socket.on('open', (): void => {
      if (socket !== this.ws) {
        return;
      }
      this.heartbeatAcknowledged = true;
      this.log.info('WebSocket connection opened. Server: %s', this.server);
      this.startHeartbeat(socket);
      this.events.emit('open');
    });
    socket.on('message', (data: RawData): void => {
      if (socket === this.ws) {
        const message = data.toString();
        this.heartbeatAcknowledged = true;
        if (isConnectionHealthyMessage(message)) {
          this.reconnectAttempt = 0;
        }
        this.events.emit('message', { data: message });
      }
    });
    socket.on('error', (error: Error): void => {
      this.log.error('WebSocket error. Server: %s, Error: %s', this.server, error.message);
      emitOptionalError(this.events, error);
    });
    socket.on('close', (code: number): void => {
      if (socket !== this.ws) {
        return;
      }
      this.clearHeartbeat();
      this.ws = undefined;
      this.log.info(
        'WebSocket connection closed; reconnect will use fresh authentication. Server: %s, Code: %s',
        this.server,
        code,
      );
      this.events.emit('close', { code });
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval((): void => {
      if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.heartbeatAcknowledged) {
        this.log.warn('Dreo WebSocket heartbeat timed out; terminating stale connection.');
        socket.terminate();
        return;
      }
      this.heartbeatAcknowledged = false;
      socket.send('2');
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay = getReconnectDelay(this.reconnectAttempt);
    this.log.info(
      'Scheduling Dreo WebSocket reconnect. Attempt: %s, DelayMs: %s',
      this.reconnectAttempt,
      delay,
    );
    this.reconnectTimer = setTimeout((): void => {
      this.reconnectTimer = undefined;
      void this.connectWebSocket(true);
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
