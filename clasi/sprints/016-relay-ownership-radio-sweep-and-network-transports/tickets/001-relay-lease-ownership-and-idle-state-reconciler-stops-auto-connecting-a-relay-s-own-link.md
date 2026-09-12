---
id: '001'
title: 'Relay lease ownership and idle state: reconciler stops auto-connecting a relay''s
  own link'
status: in-progress
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: rearch-09-relay-lease-idle-state-reset-between-candidates.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay lease ownership and idle state: reconciler stops auto-connecting a relay's own link

## Description

Today `connect/reconciler.ts`'s `plan()` treats a relay's own `usb`-transport
link exactly like a robot's: its `AUTO_CONNECT_TRANSPORTS` per-device pass
has no `device.kind` check. The moment a RADIORELAY-flashed micro:bit
enumerates, `plan()` auto-connects it, `connector.ts` sends a plain `HELLO`
(the relay answers it while in its command plane with a banner,
`role: RADIOBRIDGE`), and the link is left `connected` with an open
`sessions` row — a standing "console session" no student ever asked for.
This is `docs/design/architecture.md` §7.2's "no auto-opened console
session on a relay any more" rule, currently violated, confirmed live in
sprint 015 ticket 011's own bench dump (`vevav`/`vitut` both showed
`connected, session` with nothing connected to them).

This ticket makes the relay's own identify a one-time event: `plan()`
gains a guard so a `kind === 'relay'` device is never auto-(re)connected
once its kind is known, and the session opened by its one-time identify
returns to idle (no open session, no `relay_leases` row) rather than
staying `connected`. Per sprint.md's Architecture Step 7 open question 2,
what link `state` a freshly-identified, now-idle relay sits in
(`connectable` with a reason, vs. some other representation) is this
ticket's own implementation call — the one hard constraint is that the
relay must never be re-identified over a data-plane port to get back to
"known" (rearch-09's own words: "it is never re-identified over a
data-plane port").

This ticket does **not** yet build `connect/relayBridger.ts`'s
multi-candidate failover loop or per-candidate reset (ticket 002) — it
only fixes the auto-connect/idle-state half of rearch-09. A relay that is
identified and idle after this ticket can still only be bridged to a
single, already-named child exactly as today (`connector.ts`'s existing
single-candidate radio/mbrelay handling, unchanged by this ticket).

## Acceptance Criteria

- [ ] `plan()`'s automatic per-device pass never produces a `connect` job
      for a `usb` link whose device is `kind === 'relay'` once that
      device's kind is known.
- [ ] A relay identified once (no lease, no further action) ends with no
      open `sessions` row and no `relay_leases` row — it is idle.
- [ ] The relay is never re-identified over a data-plane port after going
      idle (no `HELLO` sent to it again outside its one initial identify).
- [ ] A freshly-enumerated, not-yet-identified `usb` board (kind unknown)
      is still auto-connected exactly once to identify it, whether it
      turns out to be a robot or a relay — this ticket does not change
      first-identify behavior, only what happens after a relay is known.
- [ ] Existing `plan()`/`reconciler.test.ts` table-driven tests for
      non-relay devices (robots) are unaffected — add new cases rather
      than changing existing ones.
- [ ] `npx vitest run packages/host/src/connect` passes.

## Implementation Plan

**Approach**: Add a `device.kind !== 'relay'` guard to `plan()`'s
per-device loop in `connect/reconciler.ts`, alongside the existing
owned/backoff/closed-by-user checks (`isAutoConnectEligible`). Add the
"return to idle after identify" behavior at the point a relay's identify
completes — likely a small addition to the reconciler's executor
(`runConnect`) or `connector.ts`'s own post-identify step, whichever
keeps the "one-time identify, then idle" rule in one place rather than
duplicated. Read `connect/reconciler.ts` and `connect/connector.ts` in
full before choosing the seam — sprint.md's Architecture section documents
what is already there; this ticket implements Step 7's open question 2
however seems cleanest against the real code, not against a re-guess.

**Files to modify**:
- `packages/host/src/connect/reconciler.ts` (the `kind !== 'relay'` guard
  in `plan()`, and `ReconcilerRows`'s device row shape if `kind` is not
  already exposed there — check `store/index.ts`'s `ReconcilerDeviceRow`
  first).
- `packages/host/src/connect/connector.ts` and/or `reconciler.ts` (the
  return-to-idle step after a relay's one-time identify).
- `packages/host/src/store/index.ts` only if `reconcilerRows()` needs to
  start exposing `devices.kind` (check first — it may already).

**Testing plan**:
- `connect/reconciler.test.ts`: table-driven `plan()` cases — a
  `kind='relay'` device with a `connectable` usb link produces no job; a
  `kind='robot'` device with the same link shape still produces a
  connect job (regression guard); a device with `kind` not yet known
  (fresh identify) still gets a job.
- `connect/connector.test.ts` (or a new test file if the idle-return logic
  lands there): a fake relay identify completes, then no `sessions` row
  and no `relay_leases` row remain.
- Scoped run: `npx vitest run packages/host/src/connect`.

**Documentation updates**: none beyond this ticket's own completion notes
recording which seam ended up owning the idle-return behavior (per Step 7
open question 2) — useful context for ticket 002, which builds the actual
bridge on top of this idle state.
