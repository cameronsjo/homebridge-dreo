// Keeps a Dreo WebSocket alive and detects a dead one.
//
// Dreo's server never answers the '2' keepalive the mobile app sends, and an
// idle fan sends nothing, so message traffic cannot prove liveness. WebSocket
// protocol pings can: the server answers each with a pong (measured 2026-10-30,
// scripts/probe-ws-ping.cjs). '2' is still sent as a one-way keepalive.

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_MISSED_PONGS = 3;
export const APP_KEEPALIVE_FRAME = '2';
// WebSocket.OPEN, per the WebSocket spec and the ws package
export const SOCKET_OPEN = 1;

export interface HeartbeatSocket {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  on(event: 'pong' | 'message', listener: () => void): unknown;
  off(event: 'pong' | 'message', listener: () => void): unknown;
}

export type HeartbeatTickAction = 'ping' | 'terminate';

/** Decide a heartbeat tick from the number of pings sent since the last sign of life. */
export function decideHeartbeatTick(unansweredPings: number): HeartbeatTickAction {
  return unansweredPings >= MAX_MISSED_PONGS ? 'terminate' : 'ping';
}

export class SocketHeartbeat {
  private unansweredPings = 0;
  private timer?: NodeJS.Timeout;
  // Any pong or received message proves the socket is alive. Dreo's server
  // answers protocol pings but never the '2' keepalive.
  private readonly onSignOfLife = (): void => {
    this.unansweredPings = 0;
  };

  constructor(
    private readonly socket: HeartbeatSocket,
    private readonly onTerminate: (unansweredPings: number) => void,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {}

  public start(): void {
    this.stop();
    this.unansweredPings = 0;
    this.socket.on('pong', this.onSignOfLife);
    this.socket.on('message', this.onSignOfLife);
    this.timer = setInterval((): void => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    this.socket.off('pong', this.onSignOfLife);
    this.socket.off('message', this.onSignOfLife);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick(): void {
    if (this.socket.readyState !== SOCKET_OPEN) {
      return;
    }
    if (decideHeartbeatTick(this.unansweredPings) === 'terminate') {
      const missed = this.unansweredPings;
      this.stop();
      this.onTerminate(missed);
      this.socket.terminate();
      return;
    }
    this.unansweredPings += 1;
    this.socket.send(APP_KEEPALIVE_FRAME);
    this.socket.ping();
  }
}
