---
id: '011'
title: 'Bench fixes 2: relay bridging wiring, local flash, flash timeouts, relay link
  hold'
status: done
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

- [x] `runtime.ts` passes `mbregistryClient`/`mbregistryLabel`/
      `createMbregistryStream` to `relayBridger` (and `relaySweeper`, and
      any other mbregistry-stream-opening component); a runtime-level
      test with fakes fails if any such component is constructed without
      the client.
- [x] Flashing a local board through mbregistry succeeds when connected
      to a pre-existing registry (no spawned-instance `--ready-json`
      port available), using the local socket's `flash` op or a
      documented port-discovery fallback; a fake-backed test covers this.
- [x] Flashing a remote board still works via `send_hex`+`flash` over the
      owning instance's remote port; a fake-backed test covers this.
- [x] Remote flash against an unreachable host times out at ~10s (not
      the OS default) with a message naming host:port, and reports a
      "connecting" phase before the connection is established; a
      fake-backed test covers both the timeout and the phase.
- [x] The relay's-own-link-drop cause is diagnosed and recorded (bug fix,
      or UI change stating the link isn't held open outside bridging);
      whichever it is, there's a fake-backed test or a documented
      rationale entry for it.
- [x] The relay device page shows the same link-failure reason the
      front-page card shows, with a fake-backed test.
- [x] `npm run build` and the UI's `vite:build` both succeed at the end,
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

## Implementation Notes

**Finding 1 (relayBridger wiring gap)**: `runtime.ts`'s
`createRelayBridgerFn(...)` call never forwarded `mbregistryClient`/
`mbregistryLabel` into `relayBridgerDeps`, even though the same values
were already resolved and handed to `createConnectorFn` two lines above.
Fixed by adding them to the object literal. `relaySweeper` was audited
per the finding's own instruction and needs no such wiring: it only ever
opens a relay's raw `usb` serial port directly
(`resolveRelayPhysical(store, relayLinkId, "usb")` in
`watchers/relaySweeper.ts`), never an mbregistry stream. A new
`runtime.test.ts` assertion (`getCapturedRelayBridgerDeps()?.mbregistryClient`)
fails if this wiring regresses.

**Finding 2 (local flash against a pre-existing registry)**:
`MbregistryClient.remotePort` is only set when this console's own
`connect()` call spawned the instance and read its `--ready-json` line;
connecting to an already-running registry (the real-bench case) leaves
it `undefined`, so the old "always use 127.0.0.1:remotePort for a local
device" rule failed immediately. Per mbtools `docs/design/
registry-api.md` (read-only reference), the local Unix socket/pipe's own
`flash` op takes a `hex_path` already on this shared filesystem — no
`send_hex` staging step exists for it (that step exists specifically
because a *remote* TCP client has no such filesystem). Fix:
`link/adapters/mbregistryStream.ts#resolveFlashPlan` (replacing
`resolveFlashTarget`) now returns a `FlashPlan` — `{kind: "local",
endpoint}` when this console's own `MbregistryClient.resolvedEndpoint`
is itself a local Unix socket/pipe (the common case, and the only one
exercised on the bench), else the pre-011 `{kind: "remote", target:
{"127.0.0.1", remotePort}}` fallback (still requires `remotePort`,
documented as a narrow edge case: a console connected to mbregistry over
TCP with no remote port of its own). `mbregistry/remoteFlash.ts#
flashViaLocalSocket` stages the hex text to a real temp file
(`os.tmpdir()`) and drives `lock`(`flash`)/`flash` over that local
socket, cleaning the temp file up in `finally` regardless of outcome.
`connect/flasher.ts#flashMbregistry` now takes a `FlashPlan` and
dispatches to `flashViaLocalSocket` or `flashViaMbregistry` by
`plan.kind`.

**Finding 3 (remote flash connect timeout/phase)**: added a `"connecting"`
`FlashPhase` (`wsMessages.ts`, rendered by `deviceDisplay.ts`'s
`PHASE_LABEL`), reported by both `flashViaMbregistry` and
`flashViaLocalSocket` before their own connect attempt, and a shared
`FLASH_CONNECT_TIMEOUT_MS` (10s) bound on that connect (`remoteFlash.ts`'s
`openSocket`/`openLocalSocket`), replacing the OS's own ~75s SYN-retry
default. The timeout error names the target (`host:port` for remote,
the socket path for local).

**Finding 4 (relay's own link drops after Connect) — REAL BUG, fixed**:
diagnosed live against the bench's own running mbregistry
(`~/Library/Application Support/mbregistry/api.sock`, local relay
`getez`, per this ticket's own dispatch instructions). Static review
first ruled out a UI affordance calling `session-open` on a relay's own
link directly — `FrontPage.tsx`'s per-link Connect button was already
suppressed for `device.kind === "relay"` by ticket 017-012, and
`RelayPage.tsx` has no such button either. Bridging `getez` to a real
robot (`gitev`) through the running UI reproduced the finding exactly:
the bridge appeared to connect ("Connected to gitev via getez on channel
21, group 185"), then a few seconds later showed "Connection to gitev
lost: transport closed" — traced to `harvester.ts`'s `link.onClose((reason)
=> fail(reason ? reason.message : "link closed"))` firing with no
`reason` at all (a plain transport close, not the missed-poll watchdog,
which would have carried a "no reply to N STATUS polls" reason instead).
Root cause: `connect/relayBridger.ts`'s `chooseResetMethod`/
`mbregistryResetSequence`, added by ticket 007, sent an unconditional
`BREAK` frame over the mbregistry-owned relay connection before *every*
bridge candidate, regardless of whether the relay needed resetting —
ticket 007's own doc comment had already flagged this as "genuinely
unresolved... ticket 009 (bench verification) must confirm this actually
resets a DAPLink board... before this is treated as settled." This
finding's bench pass is that verification, and its result is negative: a
raw `lock`+`stream` client confirmed the relay was already healthy
(receiving `< PING` heartbeats, answering its command plane fine) before
any bridge attempt, yet the bridge still sent it a `BREAK` unconditionally.
The most likely mechanism (not independently confirmed against
mbregistry's own server-side logs, which this ticket had no access to):
a raw serial `BREAK` is also how some USB-CDC bridge chips signal a
target-MCU reset, so an already-healthy relay's own microcontroller
physically reboots; a directly-opened local serial port (the legacy
`usb`-transport `"break"` branch, unaffected by this finding) tolerates
its target disappearing/reappearing, but the *remote*, pyserial-backed
port mbregistry itself owns does not, and mbregistry closes its end of
the connection without telling this client why. Fix: `mbregistryResetSequence`
now mirrors `watchers/relaySweeper.ts`'s own `ensureCommandPlaneReady`
pattern — a quick `sync()` (`?`/status round trip, ~400ms worst case)
first; a relay that already answers gets no `BREAK` at all, and only one
that fails to answer (genuinely parked mid a prior session — the
scenario the reset exists for) falls back to it. Which raw primitive is
correct for that fallback case remains the same open question ticket
007 flagged (`sendBreak()` vs. an untried `SET_DTR`/`SET_RTS` sequence);
this finding narrows and resolves the more urgent half of it: never
reset a relay that was never broken in the first place.
`relayBridger.test.ts`'s existing "candidate 1 ... candidate 2 succeeds
only because the relay was reset first" test now also asserts candidate
1's own (already-healthy) reset step sent zero `BREAK`s, and two new
`mbregistryResetSequence` unit tests cover the skip-when-healthy and
fall-back-when-parked cases directly.

**Finding 5 (relay device page doesn't show the link-failure reason)**:
root cause was `components/AppHeader.tsx#connectionStatusText`, the
shared header every device page (including `RelayPage.tsx`, via
`AppHeader`) renders for a link with `session === undefined` — a relay's
own connectivity link never has a session of its own
(`RelayPage.tsx`'s own doc comment), so this is the branch that always
ran for it. That branch returned the fixed literal "No open session on
this link" unconditionally, discarding `link.reason` entirely, while
`FrontPage.tsx`'s device card (via `deviceDisplay.ts#linkStateText`)
read the same field and showed "Couldn't connect: in use by bench-raw".
Fixed by having `connectionStatusText` delegate to `linkStateText` (the
exact same front-page copy) when the link is `failed`/`unresponsive`
*and* carries a `reason`; a link with no reason at all still shows the
plain "No open session on this link" text (nothing gained by switching
copy when there is nothing more to say). Two new `AppHeader.test.tsx`
cases cover both branches.

**Verification**: `npm run build` and `npm run vite:build -w
@robot-console/ui` both succeeded (see commit). All fake-backed tests
for this ticket's five findings pass; finding 4's diagnosis used real
hardware (the bench's own running mbregistry/relay/robot) per this
ticket's own dispatch instructions, with no board flashed and no
`unlock --force` run.
