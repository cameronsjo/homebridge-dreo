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
├── DreoAPI.ts            # REST + WebSocket client (auth, commands, state)
└── accessories/
    ├── BaseAccessory.ts   # Shared accessory logic
    ├── FanAccessory.ts    # Tower fans, air circulators, ceiling fans
    ├── HeaterAccessory.ts # Space heaters
    └── HumidifierAccessory.ts  # Humidifiers (newest, best-written)
```

## Known Issues to Fix (Fork Priorities)

| Priority | Issue | File |
|----------|-------|------|
| **P0** | Replace `reconnecting-websocket` — throws uncaught errors that crash Homebridge | `DreoAPI.ts` |
| **P0** | Add token refresh on WebSocket reconnect — stale tokens cause silent permanent failure | `DreoAPI.ts` |
| **P1** | Fix device loop `return` → `continue` — one failed state fetch abandons all remaining devices | `platform.ts:148` |
| **P1** | Run `npm audit fix`, update axios, TypeScript toolchain | `package.json` |
| **P2** | Add try/catch to JSON.parse in Fan/Heater message handlers | `FanAccessory.ts`, `HeaterAccessory.ts` |
| **P2** | Add SIGTERM handler for graceful shutdown | `DreoAPI.ts` |
| **P2** | Enable `noImplicitAny: true` and type untyped parameters | `tsconfig.json` |

## Development

```bash
npm install
npm run build    # rimraf ./dist && tsc
npm run lint     # eslint
npm run watch    # tsc -w (dev mode)
```

## Deploy

```bash
npm run build && npm pack --pack-destination .
scp homebridge-dreo-*.tgz pi@192.168.1.222:/tmp/
ssh pi@192.168.1.222 "cd /var/lib/homebridge && sudo npm install /tmp/homebridge-dreo-*.tgz && sudo systemctl restart homebridge"
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
