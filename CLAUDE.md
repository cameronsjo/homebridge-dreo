# homebridge-dreo (Fork)

Fork of [zyonse/homebridge-dreo](https://github.com/zyonse/homebridge-dreo) for Dreo smart fan control via HomeKit.

**Why forked**: The upstream plugin has a WebSocket crash-loop bug ([#82](https://github.com/zyonse/homebridge-dreo/issues/82)) caused by the unmaintained `reconnecting-websocket` library. The crash can brick an entire Homebridge instance. This fork stabilizes the WebSocket layer and adds resilience.

## Architecture

- **Cloud-only** — no local control path. All commands and state go through Dreo's cloud
- **REST API** for auth + device discovery (`app-api-{region}.dreo-tech.com`)
- **WebSocket** for real-time commands and state updates (`wsb-{region}.dreo-tech.com`)
- Mimics the Dreo mobile app — same endpoints, hardcoded `client_id`/`client_secret`

## Source Layout

```
src/
├── index.ts              # Plugin registration
├── platform.ts           # Platform plugin — device discovery and accessory creation
├── settings.ts           # Constants (plugin name, platform name)
├── DreoAPI.ts            # REST + WebSocket client (auth, commands, state, forced reconnect)
├── accessories/
│   ├── BaseAccessory.ts   # Shared accessory logic
│   ├── FanAccessory.ts    # Tower fans, air circulators, ceiling fans
│   ├── HeaterAccessory.ts # Space heaters
│   └── HumidifierAccessory.ts  # Humidifiers (newest, best-written)
└── reliability/
    ├── ConfirmedController.ts  # Per-device command queue; send, then confirm via REST
    ├── SocketHeartbeat.ts      # '2' keepalive + protocol-ping liveness (3 missed pongs → terminate)
    ├── ReconnectGate.ts        # Single-flight forced reconnect, at most one per 5 min
    ├── StatePoller.ts          # Periodic REST re-read with epoch race guard and backoff
    └── PowerRecovery.ts        # Background recovery after a failed power/speed command
```

Dreo's server answers WebSocket protocol pings but never the `'2'` keepalive; `scripts/probe-ws-ping.cjs` re-checks that from the Homebridge host.

## Fork Priorities

Done: `reconnecting-websocket` replaced with `ws` plus backoff reconnect, token refresh on reconnect, per-device discovery isolation, guarded `JSON.parse` in every message handler, SIGTERM shutdown, `npm audit` clean, protocol-ping heartbeat, periodic state poll, background command recovery (4.3.0).

| Priority | Open item | File |
|----------|-----------|------|
| **P2** | Enable `noImplicitAny: true` and type untyped parameters | `tsconfig.json` |
| **P2** | Smoke-test on Homebridge 2.x (issue #3) | — |

## Development

```bash
npm install
npm run build    # rimraf ./dist && tsc
npm run lint     # eslint
npm run watch    # tsc -w (dev mode)
npm test         # vitest
```

## Deploy

Homebridge pins this plugin to a durable tarball. Deploy with `deploy-dreo.sh` from the parent homebridge repo (`../scripts/deploy-dreo.sh`), never `npm install`: it can rewrite the wider Homebridge dependency tree. The script backs up the module dir, pin, and pinned tarball, overlays the package, repins, and verifies version and dist hash. Build from merged `main`.

```bash
npm ci && npm test && npm run build
mkdir -p /tmp/dreo-pack && npm pack --pack-destination /tmp/dreo-pack
../scripts/deploy-dreo.sh /tmp/dreo-pack/homebridge-dreo-X.Y.Z.tgz --restart   # restarts Homebridge: every accessory drops for a few seconds
../scripts/deploy-dreo.sh --rollback          # prints the newest backup stamp; changes nothing
../scripts/deploy-dreo.sh --rollback <stamp> --restart
```

## Syncing with Upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts, test, push
```

## Config

```json
{
  "platform": "DreoPlatform",
  "name": "Dreo Platform",
  "options": {
    "email": "your@email.com",
    "password": "your-password"
  }
}
```

Credentials are sent to Dreo's cloud API (password is MD5'd before transmission — Dreo's requirement, not a plugin choice).
