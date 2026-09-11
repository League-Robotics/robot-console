---
status: done
sprint: '013'
tickets:
- 013-001
- 013-002
- 013-003
- 013-004
---

# Relay card must show its radio-connection state explicitly; a robot reached through the relay must be its own card

## What the stakeholder saw (2026-09-11)

With a radio relay (`V2t`) plugged in, the stakeholder picked `GoPiv` from
the relay card's robot pull-down on the front page and pressed Connect.
Afterwards:

- The relay card's connection line read "Linked". That looks like it might
  mean "connected to GoPiv", but it does not: "Linked" means the host has
  an open transport session to the relay itself (USB/WebUSB), nothing about
  whether the relay is bridging to a robot.
- `GoPiv` did not appear in the device list, even though the robot was on
  and the stakeholder had just connected to it through the relay.

## What must be true

1. **"Linked" keeps its meaning** -- an open transport session to that
   endpoint (USB today; WiFi/TCP likewise). It must never be read as
   "connected to a robot over the radio".
2. **The relay card states its radio-bridging state explicitly**, on the
   relay's own connection line (or a clearly labelled line next to it):
   - idle: not bridging (the plain "Linked"/"Not linked" of its own USB
     session is fine here, but must not be the *only* thing shown after a
     Connect press);
   - connecting: "Connecting to GoPiv…" while the host is resetting the
     relay, doing the boot delay, and running the radio handshake (this
     takes seconds; today the card shows nothing during that time);
   - connected: "Connected to GoPiv" (with channel/group) -- only when the
     host actually has an open session to the robot through this relay,
     i.e. the synthesized `-via-<name>` child exists and its session is
     open;
   - failed: a visible reason on the card ("GoPiv did not answer through
     V2t", the coordinator's exhaustion message) -- today an exhausted
     connect only goes to the relay's console log (`emitError`), which the
     front page never shows, so a failed Connect leaves the card looking
     exactly like an idle one that happens to say "Linked" (because the
     host reopens the relay's own USB session after a failure).
3. **A robot that is actually connected through the relay shows up in the
   device list as its own card** (named `GoPiv`, listing the "Radio via
   relay V2t" connection), exactly like a USB or WiFi robot. The host
   already synthesizes such a child endpoint on success; this issue is to
   make sure it is reliably visible and to cover it with tests, and to
   make the failure case distinguishable from the success case on the
   front page so "GoPiv is on but not in the list" is never a mystery.

## Where this lives

- `packages/ui/src/pages/FrontPage.tsx` -- `RobotCard`, `connectionState`
  ("Linked"/"Not linked"), `RelayQuickConnect` (the "Connected to …" line
  that only appears once a child exists; nothing for connecting/failed).
- `packages/ui/src/pages/RelayPage.tsx` -- same states on the relay's own
  page (`autoConnecting` only covers the no-pick failover case, and only
  by watching the console log).
- `packages/host/src/deviceRegistry.ts` -- `openRobotViaRelay` (exhaustion
  is reported via `emitError` only; the relay's `EndpointListEntry` carries
  no connect-attempt state), `toEntry`.
- `packages/host/src/wsMessages.ts` -- `EndpointListEntry` needs a way to
  carry the relay's bridging state (e.g. a present-only-when-relevant
  `relayBridge: { state: "connecting" | "failed", robotName, error? }`
  block on the relay's entry; "connected" stays derivable from the child).

## Acceptance

- Front page, relay card: pressing Connect shows "Connecting to <name>…"
  immediately; on success shows "Connected to <name>" and the robot's own
  card appears; on failure shows the failure reason on the card. "Linked"
  on the relay's row continues to describe only the relay's own session.
- Relay page: the same three states, driven by host state rather than by
  scanning the console log.
- Tests cover all three states in `FrontPage.test.tsx`, `RelayPage.test.tsx`,
  and `deviceRegistry.test.ts` (the relay entry carries the connecting
  and failed states across snapshots; the child appears on success).
