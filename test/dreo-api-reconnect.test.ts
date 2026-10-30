import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import DreoAPI from '../src/DreoAPI';
import type { DreoPlatform } from '../src/platform';

type Authentication = { access_token: string } | undefined;

// Points the socket at a local server and replaces the Dreo login with a
// promise the test controls
class LocalDreoAPI extends DreoAPI {
  public login: () => Promise<Authentication> = async () => ({ access_token: 'token' });

  constructor(private readonly url: string, openTimeoutMs = 2_000) {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    super({ log, config: { options: { email: 'e', password: 'p' } } } as unknown as DreoPlatform);
    this.forcedReconnectOpenTimeoutMs = openTimeoutMs;
  }

  public override authenticate(): Promise<Authentication> {
    return this.login();
  }

  protected override websocketUrl(): string {
    return this.url;
  }

  // The backoff path's entry point, reached directly so a test can overlap it
  public backoffConnect(): Promise<void> {
    return (this as unknown as { connectWebSocket(refresh: boolean): Promise<void> }).connectWebSocket(true);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('DreoAPI forced reconnect', () => {
  let server: WebSocketServer;
  let url: string;
  let api: LocalDreoAPI | undefined;

  const openClients = (): number =>
    [...server.clients].filter((client) => client.readyState === WebSocket.OPEN).length;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    api?.stopWebSocket();
    api = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('leaves one live socket when a forced reconnect overlaps a backoff reconnect', async () => {
    api = new LocalDreoAPI(url);
    const auth = deferred<Authentication>();
    api.login = () => auth.promise;

    const backoff = api.backoffConnect();
    const forced = api.requestReconnect('test overlap');
    auth.resolve({ access_token: 'token' });

    expect(await forced.done).toBe(true);
    await backoff;
    await settle();
    expect(openClients()).toBe(1);
  });

  it('replaces an open socket with exactly one new one', async () => {
    api = new LocalDreoAPI(url);
    await api.startWebSocket();
    await settle();
    expect(openClients()).toBe(1);

    expect(await api.requestReconnect('test replace').done).toBe(true);
    await settle();
    expect(openClients()).toBe(1);
    expect(api.isOpen()).toBe(true);
  });

  it('gives up at the deadline when the login hangs, and frees the gate', async () => {
    api = new LocalDreoAPI(url, 50);
    api.login = () => new Promise<Authentication>(() => undefined);

    const started = Date.now();
    expect(await api.requestReconnect('test hang').done).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(openClients()).toBe(0);
  });
});
