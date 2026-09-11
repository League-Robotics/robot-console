---
status: pending
---

# WIFICRED provisioning affordance for a USB-connected robot

## Description

Extension v1.20260910.1 / template v0.20260910.3 provision WiFi over the
wire: `HELLO`, `WIFICRED SET <slot> <ssid> <password> #1`, `WIFICRED #2`
(sequenced; `wificred <slot> <ssid> <haspw>` enumerates; picked up at the
next boot). Verified on gopiv 2026-09-10 via `mbdeploy connect --remote`.

The console has no way to do this. Sprint 010's planner deferred it
deliberately: a "Set WiFi" form must render only for a USB-connected
robot (sending `WIFICRED` through a relay or an existing WiFi session is
meaningless), and `RobotPage.transportBlind.test.ts` forbids anything
under `RobotPage` from branching on transport. So the affordance cannot
be a `RobotPage` panel.

## Proposed resolution

- Add `WIFICRED` to `@robot-console/protocol`'s `SEQUENCED_VERBS` (it is
  sequenced on the firmware side; unsequenced it is silently nacked).
- Mount a small provisioning form OUTSIDE `RobotPage`, on the USB device
  page wrapper (`DevicePage.tsx` knows the transport; `RobotPage` does
  not), with SSID + password fields, a slot selector (0..7), "Save" that
  sends the two sequenced lines and shows the enumeration reply, and a
  note that a power-cycle is required for pickup.
- Prefill the SSID/password from the host's config (`.env`
  `WIFI_SSID`/`WIFI_PASSWORD`) via a new, opt-in server message that
  never sends the password to a client it did not come from — or keep it
  client-typed only. Decide at planning time.
- Password is never readable back (`haspw` only); the UI must not
  pretend otherwise.
