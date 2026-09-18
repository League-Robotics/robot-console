---
id: '001'
title: Relay lease takeover for a direct session-open (sweeper-vs-session race)
status: open
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

## Acceptance Criteria

- [ ] The exact function that handles a direct relay `session-open` is
      identified (in `connect/connector.ts` or `server.ts`'s
      `session-open` handler) and documented in the implementation notes
      before any change is made.
- [ ] That path calls `relayLeaseRevocation`'s existing
      `register`/`get`/`clear` seam the same way `connect/relayBridger.ts`
      already does, taking over an in-flight sweep instead of racing it.
- [ ] With a USB relay attached and the sweeper actively probing, a
      direct `session-open {linkId: <relay usb link>}` succeeds within
      one probe's delay (≤ ~1 s) and never reports "Cannot lock port"
      for our own sweeper.
- [ ] When the port is held by a genuinely external OS process (simulate
      by holding the port open from a second process/script), the open
      fails with a reason naming external contention in plain language
      ("another app has this relay open"), never "Cannot lock port".
- [ ] `scripts/bench/run.sh`'s relay-open path is re-run against a
      physically attached USB relay and the report row is cited in this
      ticket's closing notes — or, if no relay is attached at execution
      time, this criterion is explicitly marked
      unverified-hardware-absent with the date, not silently skipped.

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
