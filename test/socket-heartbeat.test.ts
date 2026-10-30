import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_PONGS,
  SOCKET_OPEN,
  SocketHeartbeat,
  decideHeartbeatTick,
} from '../src/reliability/SocketHeartbeat';

// Behaves like Dreo's server: answers protocol pings, never answers '2'
class FakeDreoSocket extends EventEmitter {
  public readyState = SOCKET_OPEN;
  public readonly sent: string[] = [];
  public terminated = false;

  constructor(private readonly answersPings: boolean) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    if (this.answersPings) {
      queueMicrotask((): void => {
        this.emit('pong');
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('Dreo WebSocket heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the socket open when the server answers pings but never the keepalive', async () => {
    vi.useFakeTimers();
    const socket = new FakeDreoSocket(true);
    const onTerminate = vi.fn();
    const heartbeat = new SocketHeartbeat(socket, onTerminate);

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 20);
    heartbeat.stop();

    expect(socket.terminated).toBe(false);
    expect(onTerminate).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(20);
    expect(new Set(socket.sent)).toEqual(new Set(['2']));
  });

  it('terminates after three consecutive missed pongs', async () => {
    vi.useFakeTimers();
    const socket = new FakeDreoSocket(false);
    const onTerminate = vi.fn();
    const heartbeat = new SocketHeartbeat(socket, onTerminate);

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * MAX_MISSED_PONGS);
    expect(socket.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(socket.terminated).toBe(true);
    expect(onTerminate).toHaveBeenCalledWith(MAX_MISSED_PONGS);
  });

  it('counts any received message as a sign of life', async () => {
    vi.useFakeTimers();
    const socket = new FakeDreoSocket(false);
    const heartbeat = new SocketHeartbeat(socket, vi.fn());

    heartbeat.start();
    for (let tick = 0; tick < 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      socket.emit('message');
    }
    heartbeat.stop();

    expect(socket.terminated).toBe(false);
  });

  it('decides to terminate only once the missed-pong limit is reached', () => {
    expect([0, 1, 2, 3, 4].map(decideHeartbeatTick)).toEqual([
      'ping',
      'ping',
      'ping',
      'terminate',
      'terminate',
    ]);
  });

  it('stays alive against a real ws server that ignores the keepalive frame', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const received: string[] = [];
    server.on('connection', (connection) => {
      connection.on('message', (data) => received.push(data.toString()));
    });
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => client.once('open', () => resolve()));

    const onTerminate = vi.fn();
    const heartbeat = new SocketHeartbeat(client, onTerminate, 20);
    heartbeat.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    heartbeat.stop();

    expect(onTerminate).not.toHaveBeenCalled();
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(received.length).toBeGreaterThan(5);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
