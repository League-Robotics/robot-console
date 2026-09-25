---
id: '011'
title: 'Bench fixes 2: relay bridging wiring, local flash, flash timeouts, relay link
  hold'
status: open
use-cases:
- SUC-001
- SUC-004
- SUC-005
- SUC-007
- SUC-008
depends-on:
- '010'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench fixes 2: relay bridging wiring, local flash, flash timeouts, relay link hold

## Description

Second round of fixes from real-bench runs of ticket 009 against
mbregistry v0.20260924.7 (console connected to a pre-existing user
registry via its local socket; local relay `getez`, local robot
`vevov`, remote hosts). Five findings, in priority order:

1. **relayBridger not wired to mbregistry (blocker)**: bridging a robot
   through an mbregistry relay fails immediately with "relayBridger:
   mbregistry transport requires RelayBridgerDeps.mbregistryClient (or
   an overriding createMbregistryStream)". Ticket 007 added
   `RelayBridgerDeps.mbregistryClient`/`mbregistryLabel`/
   `createMbregistryStream`, but `runtime.ts` (ticket 006) never passes
   them through to the bridger. Audit `relaySweeper` and any other
   component that opens mbregistry streams for the same gap. Add a
   runtime-level test that fails if any mbregistry-capable component is
   constructed without the client.
2. **Local flash fails against a pre-existing registry**: "mbregistry:
   no remote TCP port known for local device … flash/send_hex require
   the owning instance's own remote port, and none was reported". The
   console currently only learns the local instance's remote port from
   `--ready-json`, which is only emitted when the console spawned the
   instance itself. Fix by using the local socket's own `flash` op for
   local devices (check `docs/design/registry-api.md` in the mbtools
   repo, read-only, for the exact request shape — hex path vs. inline
   hex, and lock interaction) and keep `send_hex`+`flash` over the
   remote port for remote devices. If the local `flash` op cannot take
   inline hex content, discover the local instance's remote port
   another way (an op that reports ports) and document the choice made.
3. **Remote flash has no connect timeout and reports the wrong phase**:
   flashing a board on an unreachable peer sat at "Flashing relay:
   verifying…" for ~75s (OS SYN timeout) before failing with "could not
   connect … ETIMEDOUT". Add an explicit connect timeout (~10s) and
   report a "connecting" phase until the connection is actually up; the
   timeout message must name the host:port.
4. **A relay's own link drops right after Connect**: clicking Connect
   on a local relay's page locks it (label "gala / robot-console"),
   releases it ~1s later, and ends "unresponsive: link closed" (harvester
   `onClose` with no reason). A raw lock+stream client on the same relay
   holds the link fine and receives "< PING" lines, so the registry side
   is healthy. Diagnose whether this is a real bug in the
   mbregistryStream/connector/reconciler path (fix it) or the sprint-016
   design where a relay's own link isn't held open outside bridging (in
   that case, change the UI to say so instead of offering a Connect that
   silently drops). Record which it was.
5. **Relay page doesn't show the link failure reason**: when a connect
   failed with "in use by bench-raw", the front-page card showed
   "Couldn't connect: in use by bench-raw", but the relay's device page
   only showed "No open session on this link". Show the same failure
   reason on the device page.

## Acceptance Criteria

- [ ] `runtime.ts` passes `mbregistryClient`/`mbregistryLabel`/
      `createMbregistryStream` to `relayBridger` (and `relaySweeper`, and
      any other mbregistry-stream-opening component); a runtime-level
      test with fakes fails if any such component is constructed without
      the client.
- [ ] Flashing a local board through mbregistry succeeds when connected
      to a pre-existing registry (no spawned-instance `--ready-json`
      port available), using the local socket's `flash` op or a
      documented port-discovery fallback; a fake-backed test covers this.
- [ ] Flashing a remote board still works via `send_hex`+`flash` over the
      owning instance's remote port; a fake-backed test covers this.
- [ ] Remote flash against an unreachable host times out at ~10s (not
      the OS default) with a message naming host:port, and reports a
      "connecting" phase before the connection is established; a
      fake-backed test covers both the timeout and the phase.
- [ ] The relay's-own-link-drop cause is diagnosed and recorded (bug fix,
      or UI change stating the link isn't held open outside bridging);
      whichever it is, there's a fake-backed test or a documented
      rationale entry for it.
- [ ] The relay device page shows the same link-failure reason the
      front-page card shows, with a fake-backed test.
- [ ] `npm run build` and the UI's `vite:build` both succeed at the end,
      so the bench can re-run ticket 009's cases 4 (relay reset) and 6
      (local flash).

## Implementation Plan

- **Approach**: fix each finding independently with unit tests against
  fakes (per this sprint's Test Strategy — no real mbregistry required
  for these tests); ticket 009 remains the only ticket that exercises
  real hardware. Re-verify wiring end-to-end via `npm run build` +
  `vite:build`.
- **Files to create/modify**: `runtime.ts` (wiring), the relay-bridging
  and relay-sweeping modules, the mbregistry flash path (local vs.
  remote), the remote-flash connect/timeout logic, the
  mbregistryStream/connector/reconciler path for the relay's own link,
  and the relay device-page/front-page-card failure-reason display.
- **Testing plan**: fake-backed unit/integration tests per finding (see
  Acceptance Criteria); no bench access required for this ticket.
- **Documentation updates**: a one-line architecture note in
  `sprint.md`'s Architecture section recording the relay-link-drop
  diagnosis (bug vs. by-design) and the local-flash port-discovery
  choice, if either isn't already implied by the existing text. No
  broader architecture revision.
