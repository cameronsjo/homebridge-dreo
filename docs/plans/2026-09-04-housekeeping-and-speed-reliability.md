---
status: awaiting-merge
issue: https://github.com/cameronsjo/homebridge-dreo/issues/4
---

# Complete housekeeping and speed reliability work

## Goal

Restore lint coverage over accessory logic, prevent stale cached power state from swallowing the first fan-speed command, and replace deployment guidance that can damage the Homebridge installation.

## Chosen approach

Lint the complete `src` tree and type the exposed light handler without suppression. For every nonzero speed request, enqueue one atomic per-device sequence that confirms an idempotent power-on before sending and confirming `windlevel`; stop the sequence when power confirmation fails. Replace `npm install` deployment guidance with the established unpack-and-overlay procedure and durable tarball refresh.

## Alternatives declined

- A fresh state read before every speed command adds latency and a read/action race merely to avoid a harmless redundant power command.
- Sending power and speed together is rejected because some Dreo devices ignore bundled `windlevel` changes.
- Two separate queue entries allow another HomeKit operation to interleave between power and speed.

## Checklist

- [x] Correct the lint command and resolve the newly exposed type warning.
- [x] Add an atomic sequence operation to `ConfirmedController`.
- [x] Route nonzero speed changes through confirmed power-on then confirmed speed.
- [x] Test ordering, failure short-circuiting, and non-interleaving behavior.
- [x] Replace the unsafe deployment instructions with the overlay procedure.
- [x] Run lint, tests, build, and the complete prepublish gate.
- [ ] Merge pull request #6; issue #4 closes automatically.

## Next step

Merge [pull request #6](https://github.com/cameronsjo/homebridge-dreo/pull/6), deploy through the documented overlay procedure during an approved window, and smoke-test off-to-speed, on-to-speed, rapid speed changes, and speed-to-zero.
