---
id: '001'
title: Relay lease takeover for a direct session-open (sweeper-vs-session race)
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: bench-relay-port-contention-sweeper-vs-session.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay lease takeover for a direct session-open (sweeper-vs-session race)

## Description

A direct console `session-open {linkId: <relay usb link>}` (opening a
relay's own console, not bridging through it to a robot) opens the raw
serial port independently of `relaySweeper.ts`'s periodic probe. When
the sweeper holds the port at that instant, the open fails with
"Cannot lock port" — even though nothing external contends for it (bench
evidence, 2026-09-13/17, `clasi/issues/bench-relay-port-contention-
sweeper-vs-session.md`).

016-004 already solved this for *bridging*: `session-open
{relayLinkId, name}` goes through `connect/relayLeaseRevocation.ts`'s
takeover seam (a `Map<relayLinkId, AbortController>`), which lets the
sweeper's in-flight pass be aborted (finishing within ≤ 1 s) before the
bridge proceeds. A *direct* relay open never calls into that seam — it
is a second code path that needs the same guarantee 016-004 already
gave the first one.

**Precondition — read before starting**: no USB relay was attached to
the Mac on 2026-09-17 (`/dev/cu.usbmodem*` empty, `ioreg` shows
`AppleUSBSerial = 0`). This defect is entirely unreproducible without a
physically attached USB relay (`vitut` and/or `vevav`). Before writing
any fix, plug one in and confirm the race still reproduces — both
`relaySweeper.ts` and `relayLeaseRevocation.ts` have been touched since
the issue was filed (018-009; 018-010's `clearDeadProcessState`, which
now resets stale `relay_leases`/`board_owner` rows on store open and may
already have changed this defect's shape). If no USB relay is available
when this ticket is worked, implement the fix from the seam's existing
contract and code the missing call, but mark the harness-verification
acceptance criterion explicitly unverified with the reason, rather than
checking it off.

## Implementation Notes (2026-09-17)

**Precondition check**: `ls /dev/cu.usbmodem*` was empty and no `npm run
dev` process was running at both the start and end of this ticket's
work — no USB relay was ever attached during this session. Per the
ticket's own precondition, the fix was implemented from the seam's
existing contract rather than reproduced live, and the hardware-bound
acceptance criteria below are marked accordingly.

**The exact function (AC1)**: a direct relay `session-open
{linkId: <relay usb link>}` reaches `server.ts`'s `session-open` handler
(the `"linkId" in message"` branch, `server.ts:990-1000`), which calls
`runtime.reconciler.requestOpen(linkId)` (`connect/reconciler.ts`). The
reconciler's job executor ultimately calls `connect/connector.ts`'s
`Connector.connectAndIdentify(link, signal)`, whose internal `attempt()`
function is the one that actually opens the raw port. For a relay's own
usb link, `resolveExclusivity()` (`connector.ts`) classifies the link's
exclusivity as `board_owner` (keyed by USB serial number) — a
*different* store-level lock than the one `watchers/relaySweeper.ts`'s
own `runOnePass()` acquires for the same relay (`relay_leases`, keyed by
the relay's own link id, owner `"sweep"`). Because these are two
unrelated locks, `acquireExclusivity()` always succeeds even while a
sweep pass is running — the store layer never sees the contention at
all. The actual race is entirely at the OS level: `attempt()`'s own
`createSerialStream(path)` call (via `link/adapters/serialStream.ts`,
`serialport`'s `SerialPort.open()`) fails with the native
`@serialport/bindings-cpp` `flock(LOCK_EX | LOCK_NB)` error — literal
text `"Cannot lock port"` (`serialport_unix.cpp`) — when the sweeper's
own directly-opened stream already holds the physical port. This is the
"second code path" the ticket describes: `attempt()` never consulted
`connect/relayLeaseRevocation.ts`'s seam at all before this ticket,
unlike `connect/relayBridger.ts`'s own `bridge()`, which already did
(016-004).

**The fix**: `connect/connector.ts` gained `isKnownRelayUsbLink()` (is
this `usb` link's already-known device a `kind='relay'` row?) and
`takeoverDirectOpenSweep()` (find any `relayLeaseRevocation`-registered
controller for this link, `.abort()` it, then poll — bounded by
`directOpenTakeoverMaxWaitMs`/`directOpenTakeoverPollMs`, defaults
1000ms/25ms mirroring `relayBridger.ts`'s own takeover constants — until
it is deregistered). `attempt()` now calls this before opening the raw
port for any `usb` link already known to be a relay, and reclassifies a
subsequent `"Cannot lock port"` failure into
`RELAY_EXTERNAL_LOCK_REASON` ("another app has this relay open") *only*
for that same known-relay case (never for a plain robot's own usb port —
see the code's own doc comment for why: the recorded MakeCode-holds-
the-board case must never be mislabeled "this relay"). `runtime.ts` now
constructs the shared `relayLeaseRevocation` seam before the connector
and hands it the same instance already shared with the bridger and
sweeper.

## Acceptance Criteria

- [x] The exact function that handles a direct relay `session-open` is
      identified (in `connect/connector.ts` or `server.ts`'s
      `session-open` handler) and documented in the implementation notes
      before any change is made. — see "Implementation Notes" above.
- [x] That path calls `relayLeaseRevocation`'s existing
      `register`/`get`/`clear` seam the same way `connect/relayBridger.ts`
      already does, taking over an in-flight sweep instead of racing it.
      — `takeoverDirectOpenSweep()` calls `revocation.get()`/`.abort()`
      exactly as `relayBridger.ts`'s own `takeoverSweepLease()` does;
      proven by `connector.test.ts`'s "direct relay session-open sweep
      takeover" suite (a fake sweep controller is aborted, then the
      raw port opens only once the seam deregisters it).
- [ ] **Unverified-hardware-absent, 2026-09-17.** With a USB relay
      attached and the sweeper actively probing, a direct
      `session-open {linkId: <relay usb link>}` succeeds within one
      probe's delay (≤ ~1 s) and never reports "Cannot lock port" for
      our own sweeper. No USB relay was attached at any point during
      this ticket's work (`/dev/cu.usbmodem*` empty throughout) — the
      takeover-then-open sequence and its ≤1s-class bound are covered
      only by `connector.test.ts`'s fake-relay-revocation unit tests
      (real timers, but a fake `ByteStream`, never a real OS-level
      `flock()`), not by a real physical port race.
- [ ] **Partially verified; unverified-hardware-absent for the full
      scenario, 2026-09-17.** When the port is held by a genuinely
      external OS process, the open fails with a reason naming external
      contention in plain language ("another app has this relay open"),
      never "Cannot lock port". The *classification logic* is verified
      directly: `connector.test.ts` scripts a fake stream's `open()`
      rejection with the exact native `@serialport/bindings-cpp` error
      text (`"Error Resource busy Cannot lock port"`, sourced from that
      package's own `serialport_unix.cpp`) and confirms it is
      reclassified to `RELAY_EXTERNAL_LOCK_REASON` for a known relay
      link, left unchanged for a non-relay usb link (the MakeCode-holds-
      the-board regression guard) and for a non-lock failure. What is
      **not** verified is the literal scenario this criterion names — a
      second real OS process/script genuinely `flock()`-holding a
      physical serial port — since no relay hardware was attached to
      exercise a real port at all.
- [ ] **Unverified-hardware-absent, 2026-09-17.** `scripts/bench/run.sh`'s
      relay-open path was not re-run: no USB relay was attached at any
      point during this ticket's work to run it against.

## Implementation Plan

**Approach**: locate the direct-relay-open code path, thread it through
`relayLeaseRevocation`'s existing takeover seam exactly as
`relayBridger.ts` does, and distinguish "our own sweeper held it" (no
error, transparent takeover) from "another process holds it" (a new,
distinct failure reason) at the point the raw port open fails.

**Files to modify**:
- `packages/host/src/connect/connector.ts` (or wherever the direct
  relay-link open is implemented — confirm exact location first) — add
  the takeover call before opening the raw port.
- `packages/host/src/connect/relayLeaseRevocation.ts` — reuse as-is
  unless the direct-open path needs a seam it doesn't yet expose (in
  which case, extend narrowly, don't redesign it).
- Wherever "Cannot lock port" is currently surfaced as `state_reason` —
  add the "another app has this relay open" branch, keyed on a
  port-lock failure occurring *after* a takeover attempt already found
  no sweep to take over from (i.e., genuinely external).

**Testing plan**:
- Scoped `vitest` run: `connect/connector.test.ts`,
  `connect/relayLeaseRevocation.test.ts`, and any test file covering the
  direct relay-open path — not the full suite (per
  `.claude/rules/source-code.md`; the full suite runs once at
  `close_sprint`).
- New unit test: a fake sweeper mid-probe + a direct `session-open` on
  the same relay link resolves without error, asserted against the
  existing fake-relay test harness `relayBridger.test.ts`/
  `relaySweeper.test.ts` already use.
- New unit test: a simulated externally-held port produces the new
  "another app has this relay open" reason, not "Cannot lock port".
- **Hardware verification** (bounded by the precondition above): with a
  USB relay physically attached, re-run
  `scripts/bench/run.sh` (or the relay-focused subset) and cite the
  resulting report row. If no relay is attached, state that plainly in
  the closing notes instead of claiming this criterion passed.

## Documentation Updates

- None beyond this ticket's own record — no `docs/design/*.md` change
  (no data-model or component-boundary change; `relayLeaseRevocation.ts`
  gains a caller, not a new seam).
