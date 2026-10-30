# Changelog

All notable changes to this fork are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [4.3.0]

### Fixed

- The WebSocket no longer drops every ~30 seconds. 4.2.0 expected a reply to the `'2'` keepalive, which Dreo's server never sends, so an idle fan's socket was terminated on the second heartbeat tick and pushes and commands sent in the gap were lost. Liveness now uses WebSocket protocol pings: three consecutive missed pongs (about 45 seconds) end the socket. `'2'` is still sent as a one-way keepalive.
- A power or speed change from HomeKit that cannot be confirmed now fails visibly in the Home app (`SERVICE_COMMUNICATION_FAILURE`) instead of leaving a value the fan never took.

### Added

- Periodic state poll: each fan re-reads power and speed from the Dreo API every `pollIntervalSeconds` (default 60, minimum 30) and pushes them to HomeKit, logging `Source: poll` when the value changed. Polls skip while a command is in flight, drop a result that raced a command, and back off up to 10 minutes while the API is failing.
- Background command recovery: after a failed power command, the plugin forces a fresh-auth reconnect (one at a time, at most one new reconnect per 5 minutes across all devices), resends the newest requested power state once, and reconciles. Forced-reconnect counts are logged hourly when nonzero.
- `SET Active` and `SET RotationSpeed` are logged at info with a `Device:` field.
- `debugHoldSocketClosed` config flag (debug only) and `scripts/probe-ws-ping.cjs`, which checks whether Dreo's server answers protocol pings.
