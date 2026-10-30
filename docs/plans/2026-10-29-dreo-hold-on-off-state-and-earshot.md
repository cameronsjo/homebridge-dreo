---
status: "in-flight"
next: "Part B: deploy 4.3.0 to the Pi on Cameron's restart OK, then the 1 h heartbeat check. Part C waits until the laptop is back in front of the fan."
updated: "2026-10-29"
session_id: "70add917-c392-4fe3-9a12-9efac3d9afde"
model: "claude-opus-5-5"
harness: "claude-code 2.1.312"
machine: "cf6e768835c7"
approved_session_id: "b29b0280-0a5a-4e1c-84d5-8cb065e0cc37"
tier: substantial
repos:
  - cameronsjo/homebridge-dreo (fork, ~/Projects/smart-home/homebridge/dreo)
  - cameronsjo/earshot (new, private, ~/Projects/smart-home/earshot)
---

# Dreo fan: hold on/off state, with a mic witness on the Mac

## Context

The Dreo "Air Circulator" in front of the M3 Air (sjomba) loses on/off state in HomeKit. Cameron sees the fan running while HomeKit shows it off, and toggling in Home does nothing. Speed is out of scope.

**Root cause (found 2026-10-29 from the Pi log).** The Pi runs the fork build deployed 2026-08-29 (`tarballs/homebridge-dreo-4.2.0.tgz`, PR #5). PR #5 added a heartbeat to `DreoAPI.startHeartbeat`: every 15 s it sends `'2'` and expects a message back before the next tick, and it treats `'3'` as the healthy reply. Dreo's server does not reply, and an idle fan sends nothing. On the second tick the plugin calls `socket.terminate()` and reconnects. The socket lasts about 30 s, all day: 290 forced disconnects in today's log since 15:34, and 587 in the previous log. Commands sent while the socket is closed fail. State pushes sent while it is closed are lost, and HomeKit keeps the old value.

Before PR #5 the plugin sent `'2'` every 15 s as a one-way keepalive with no reply expected (`5d3137c:src/DreoAPI.ts:165`), so the reply expectation is the regression.

Goal: the socket stays up. HomeKit's Active value matches the fan within about 60 s even when a push is missed. A HomeKit on/off reaches the fan or fails visibly. earshot gives an independent check and a bounded correction while the laptop is parked there.

## Approach

### Part A: diagnose. Done.

Findings above. The deployed `dist` has the PR #5 heartbeat code. Whether PRs #6 and #7 are deployed doesn't matter: the Part B deploy supersedes them.

### Part B: plugin fix (fork, worktree off a fresh `origin/main`, branch `fix/heartbeat-and-poll`, one PR), about 2 h

1. **Heartbeat fix (the main fix).** Keep sending `'2'` every 15 s as a one-way keepalive. Check liveness with WebSocket protocol pings instead: `socket.ping()` each tick, and `socket.on('pong')` marks the socket alive. Terminate only after 3 consecutive missed pongs (about 45 s). Any received message also counts as alive. First, a temporary build logs pong receipt for 10 minutes on the Pi to prove that Dreo's server answers protocol pings. If it doesn't, fall back to "terminate after 5 minutes of total silence, and let item 2's poll cover state". Record which variant shipped in `## Deviations`.
2. **Periodic state poll.** Every `pollIntervalSeconds` (config, default 60, min 30), each fan re-reads REST state and pushes Active and RotationSpeed, logging `source=poll` at info when the state changed.
   - Race guard: `setActive` and `setRotationSpeed` bump a per-device `commandEpoch` when they start. A poll records the epoch before its read and discards the result if the epoch has moved. Add `ConfirmedController.isBusy(deviceSn): boolean` and skip polls while it is true; it is derived from the queue, so it cannot stick after a throw.
   - Outage behavior: exponential backoff on consecutive failures, capped at 10 min. Log the first failure and the recovery ("poll recovered after n failures"); per-poll lines go at debug.
3. **Command recovery off the HAP path.** `onSet` keeps the existing confirm (about 3 s) and throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` on failure, including when `control()` throws "WebSocket is not open". Recovery runs in the background: `DreoAPI.forceReconnect()`, single-flight, at most one fresh-auth reconnect per 5 min across all devices, with a counter logged hourly. Then resend the last requested power state once and reconcile. The error text carries the device, the requested state, the observed state, and whether a reconnect ran.
4. **SET logging at info** with a `Device:` field, so an earshot correction can be matched to the command it caused.
5. **Tests:**
   - heartbeat: no reply to `'2'` → socket stays open; 3 missed pongs → terminate
   - poll result discarded after an epoch bump
   - poll skipped while busy, and not stuck after a throw
   - backoff
   - recovery single-flight and rate limit
   - the "not open" path starts recovery

   Stage the heartbeat test red once: restore the `'3'` expectation and confirm the test fails.
6. Bump the version to `4.3.0`; add `pollIntervalSeconds` to `config.schema.json` and README; create `CHANGELOG.md` with an `[Unreleased]` entry.
7. **Deploy script** `homebridge/scripts/deploy-dreo.sh`:
   - back up the current module dir and tarball to `tarballs/homebridge-dreo-prev-<timestamp>.tgz`
   - overlay the new package
   - copy the new tarball and update the `file:./tarballs/...` pin in `/var/lib/homebridge/package.json` in the same step
   - check the deployed version and the `dist` hash
   - `--rollback` restores the backup and the pin

   Run a rollback round-trip once before the real deploy. Deploy the merged SHA after Cameron OKs the restart, which drops all accessories for a few seconds.

### Part C: `earshot`, a mic witness and bounded enforcer on the Air, about half a day

A Swift CLI plus LaunchAgent in a new private repo `cameronsjo/earshot` (name and location are my call).

**Control path: macOS Shortcuts, not the Homebridge UI API.** The UI API needs Homebridge in insecure mode (`-I`, unauthenticated HAP on the LAN), and its login can control every accessory on the bridge, SimpliSafe included. Instead, earshot runs `shortcuts run` against three shortcuts Cameron creates once in the Shortcuts app: "Dreo On", "Dreo Off", and "Dreo State" (returns the fan's power state). These go through Cameron's own HomeKit, which needs no credential and no change to the Pi, and can reach only the fan. **Step 1 of Part C checks that macOS Shortcuts can read the accessory's state.** If it can't, earshot ships in witness mode only (log plus notification, no actuation) and the enforcement question comes back to Cameron.

**Listening.**
- Built-in mic pinned by device UID, so AirPods are never captured. Verdict is `unknown` if the built-in mic is unavailable or the input is near-silent (clamshell mode).
- Listens in bursts of 15 s out of every 60 s, so the orange mic indicator is mostly off and keeps its meaning.
- Runs only while `192.168.1.222` is reachable on the home LAN.
- Each frame is reduced to about 20 band energies plus spectral flatness inside the tap callback. No buffer is copied, kept, or written; `profile.json` holds aggregate spectra only. A test greps the source for `AVAudioFile`, file writes in the audio path, and any network client.

**Calibration.**
- `earshot calibrate` (run via launchd so the grant belongs to earshot, not the terminal) records fan off, fan at the lowest speed, and the Hatch white-noise machine plus HVAC if available as negative samples.
- Verdict is `on`, `off`, or `unknown`. It is `on` only when the match to the fan profile beats both the off profile and the negative samples by a set margin.
- A state must hold through 2 consecutive bursts before it counts.

**Enforcing.** Enforcement stays off for the first 48 h, so earshot first witnesses Part B on its own. After that:

| Situation | Action |
|---|---|
| HomeKit changed (by someone other than earshot) in the last 3 min, and the heard state still shows the old value after settling | Re-run the shortcut for HomeKit's value once |
| Heard `off`, HomeKit `on` for more than 3 min | Run "Dreo Off". Safe direction: the command matches what's heard |
| Heard `on`, HomeKit `off` for more than 3 min | Notify only, never actuate. Steady broadband noise (HVAC, Hatch) can look like a fan |

- Budget: 3 actions per 30 min, persisted in `~/Library/Application Support/earshot/state.json`, so a restart doesn't reset it. After a restart earshot is witness-only until it has 3 min of state history.
- Out of budget: a macOS notification ("earshot gave up: heard X, HomeKit Y, last 3 actions…"), then witness-only until the two states agree.

**Running.**
- LaunchAgent `com.cameronsjo.earshot`. Signed with a stable identity (Apple Development, or a local self-signed code-signing cert) with an embedded `Info.plist` carrying `NSMicrophoneUsageDescription`, so the mic grant survives rebuilds.
- Holds a no-idle-sleep assertion only on AC power.
- Commands: `earshot install`, `earshot uninstall` (unloads the agent and deletes its state, profile, and logs), `earshot status` (verdict, confidence vs threshold, mic auth, last action), `earshot report --since 48h` (exits non-zero on summary gaps or on mismatches unresolved for more than 2 min).
- Log: JSON lines in `~/Library/Logs/earshot.log` with ISO time, verdict, confidence, HomeKit value, action, result, and budget left. Also an hourly summary line (minutes on/off/unknown, mismatches, actions). Capped at 1 MB with one rotation.
- Before `earshot install`, an Opus security review covers the earshot source (audio path, Shortcuts invocation, LaunchAgent, log writer) and the Part B reconnect path.

## Loop

| Thing created | Opened by | Closed by | Who closes |
|---|---|---|---|
| LaunchAgent + AC-only sleep assertion | `earshot install` | `earshot uninstall` | Cameron, if the laptop moves |
| Mic TCC grant | First launchd run | System Settings → Privacy → Microphone | Cameron |
| Three Shortcuts | Cameron, once | Delete in Shortcuts app (`uninstall` prints the names) | Cameron |
| "gave up" state | earshot | Notification to Cameron; clears itself when states agree | earshot / Cameron |
| PR on homebridge-dreo | Part B | Merge | Cameron |
| Pi deploy | `deploy-dreo.sh` | `deploy-dreo.sh --rollback` if needed; backup tarball pruned after 2 weeks stable | Claude, on Cameron's OK |
| Temporary pong-logging build | Part B item 1 | Replaced by the real deploy | Claude |

## Concessions

Concessions: 4 platform limits accepted, none fixed first.

| Platform limit | Real? | Workaround | Disposition |
|---|---|---|---|
| Dreo is cloud-only; no local control | Real | REST poll plus mic witness | accept |
| Dreo doesn't answer the `'2'` keepalive | Real (log) | Protocol pings, or silence tolerance | accept |
| Homebridge UI accessory API needs insecure mode and a whole-bridge credential | Real | Shortcuts through the user's own HomeKit | accept |
| The mic only works while the laptop is parked there; a fan sounds like other steady noise | Real | Part B stands alone; earshot never turns the fan on by itself, and goes `unknown` when it can't tell | accept |

## Alternatives declined

- **Mic as witness only** / **skip the mic**: Cameron chose witness + enforcer. Enforcement still starts after a 48 h witness-only soak.
- **Homebridge UI REST API for control**: needs insecure mode plus a credential that can disarm SimpliSafe (panel).
- **Fan-only HTTP endpoint inside the plugin**: new port and auth surface on the Pi; Shortcuts needs neither.
- **Python audio daemon**: venv plus native wheels, and the mic grant attaches to the Python binary.

## Verification

- Part B: `npm run lint && npm test && npm run build`; heartbeat test staged red. After deploy: `ssh pi@192.168.1.222 'grep -c "heartbeat timed out" /var/lib/homebridge/homebridge.log'` stays at 0 for 1 h. Physical-button test with the socket held closed (debug flag) shows a `source=poll` line within 60 s. 10 Home toggles, all confirmed in the log.
- Part C: `earshot status` tracks the fan at its lowest speed. Hatch white noise and HVAC with the fan off produce no `on`. In clamshell mode the verdict is `unknown`. Killing the daemon mid-correction leaves the budget intact.
- Done bar: `earshot report --since 48h` exits 0 in witness-only mode, with zero mismatches lasting more than 2 min from Part B alone. Then enforcement goes on.

## Orchestrator

**Driver:** opus

Part B items 2, 5, 6, and 7 are Sonnet-drivable once item 1's ping test settles. earshot's enforcement logic and its security review stay on Opus.

## Panel

Panel: plan-reviewer, red-team, operability, security-posture ran — 50 findings, 47 folded in, 3 declined

Seats delivered findings as replies (plan mode, no report files).

## Panel review — findings declined

- **operability #11: script the Part A diagnosis**: Part A is done; the deploy script's version and hash check covers the repeat need.
- **security: TLS and a pinned cert for the Homebridge UI**: moot; earshot no longer uses the UI API.
- **red-team: "Part A recipe can't tell the builds apart"**: moot; the log content identified the build directly.

## Deviations

- **Part B item 1, pong test (improvement).** A standalone probe (`scripts/probe-ws-ping.cjs`) ran on the Pi next to the installed plugin instead of a temporary plugin build, so no Homebridge restart was needed. Result on 2026-10-30: 39 of 39 protocol pings answered over 10 minutes (latency 31–41 ms), zero replies to `'2'`, one server message. **Shipped variant: protocol pings, terminate after 3 consecutive missed pongs.** The 5-minute-silence fallback was not built.
- **Part B item 1, timing.** The socket is terminated on the tick after the third unanswered ping: about 45 s after the first missed ping, up to about 60 s after the last pong.
- **Part B item 3, naming and scope.** `DreoAPI.forceReconnect()` shipped as `requestReconnect(reason)` backed by `ReconnectGate`. From the Opus review: recovery reconnects only when the socket is not open (a confirmation miss on a healthy socket resends and reconciles without a fresh login), resends a second time if the newest HomeKit request changed during the first resend, and the 20 s open deadline covers the login too (axios calls now time out at 15 s).
- **Part B item 1, backoff (review).** A pong or device report resets reconnect backoff only after the socket has been open 2 minutes, so a server that accepts and drops connections cannot hold backoff at 1 s.
- **Part B item 1, socket race (review, Critical).** A forced reconnect overlapping the backoff reconnect could leave two live sockets. Fixed with a connect-generation token and by terminating the current socket before opening another; pinned by `test/dreo-api-reconnect.test.ts` (staged red).
- **Part B item 7, deploy script shape.** `deploy-dreo.sh` (local driver) plus `deploy-dreo-remote.sh` (Pi side). The backup is the whole module dir as `tarballs/homebridge-dreo-prev-<stamp>.tgz` plus a `.pin` file holding the previous pin. Restart runs only with `--restart`. The remote half is about 160 lines of bash, over the 100-line bash limit; kept in bash to match the repo's other deploy scripts. Rollback round-trip without restart on 2026-10-30: module dir hash, pin, and `package.json` identical before and after.

