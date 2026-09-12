---
id: '003'
title: 'Relay sweeper: probe remembered robots over radio, sightings, rate limiting'
status: open
use-cases:
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: rearch-10-relay-sweeper-radio-sightings.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay sweeper: probe remembered robots over radio, sightings, rate limiting

## Description

Build `packages/host/src/watchers/relaySweeper.ts` (new): the stakeholder's
headline ask. For each idle, `usb`-transport, `kind='relay'` link (idle
per ticket 001's rule — no lease held), acquire the `sweep` lease and
probe remembered robots over the relay's command plane, never entering
the data plane and never sending `HELLO`:

- Candidate list: owned robots with no `connected` `usb`/`wifi`/
  `mbserial` link, ordered oldest `sightings.at` first. Back off names
  that fail several consecutive sweeps.
- Per candidate: resolve address via the same `override → registry →
  derived` order as everywhere else (this ticket does not yet thread a
  real registry location through — see ticket 006 — so this degrades to
  `override → derived` until then, same as `session-open` does today).
  `!CG ch grp` (via `RelayCommandPlane.ts`'s already-exported
  `setChannelGroup`) → wait ≤ 500 ms for confirmation. `> ID` (build via
  `buildRadioSendLine("ID")`) → wait ≤ 500 ms for a `< id …` reply
  matching the candidate's name (parse with `@robot-console/protocol`'s
  existing `parseIdReply`).
- Record `sightings(radio, via_link_id=relay, ok, detail)`; on success
  upsert `links(radio, state=connectable, address={relayLinkId, channel,
  group})`; on failure, leave any existing radio link and bump its
  `fail_count`.
- Rate limit: at most one `!CG` per relay per `SWEEP_MIN_INTERVAL_MS`
  (default 30 s) until ticket 007's capability detection lands (that
  ticket drops this to 2 s once a relay advertises it — this ticket
  builds the rate-limit mechanism itself, gated on a capability flag
  ticket 007 will set).
- After the candidate list is exhausted: release the lease, sleep a quiet
  period, re-acquire.
- If the relay does not answer `?` on lease acquisition (parked in the
  data plane by a prior crash), perform ticket 002's reset step once,
  then continue.
- Register the sweep's `AbortController` with the shared revocation seam
  (`connect/relayLeaseRevocation.ts`, new — a small
  `Map<relayLinkId, AbortController>` both this module and ticket 004's
  takeover logic depend on; see sprint.md's Design Rationale for why this
  is an in-process seam, not a schema column). Between probes, check the
  abort signal; on abort, finish the current wait (≤ 500 ms), release the
  lease, and return without a further write.
- Heartbeat a `tasks` row per probe pass (architecture.md §3 rule 5:
  every long-lived task has a heartbeat).

This ticket builds the probe loop and its rate limiting; it does **not**
yet cover the takeover-within-one-probe end-to-end scenario (ticket 004)
or the projection/UI rendering of "idle · sweeping"/"Radio via <relay>"
(also ticket 004) — this ticket's own acceptance criteria are the probe
mechanics and the revocation registration, testable with a fake relay and
no UI involved.

## Acceptance Criteria

- [ ] Fake relay answering `!CG` with the echo line and `> ID` for a
      subset of names: after one pass, `sightings` has one row per
      candidate; answering names get a `links(radio, connectable)` row;
      non-answering names show `fail_count = 1`.
- [ ] The sweep never sends `!GO` or `HELLO` to the fake relay — assert
      this directly against the fake's received-lines log, not just the
      absence of a failure.
- [ ] With the default rate limit, the fake relay sees no two `!CG`
      writes closer together than `SWEEP_MIN_INTERVAL_MS`.
- [ ] A relay found parked in the data plane on lease acquisition gets
      one reset (ticket 002's reset step) before sweeping resumes.
- [ ] The sweeper registers its `AbortController` with
      `relayLeaseRevocation` for the duration of each pass and
      deregisters it on release (verifiable directly against the seam's
      own map, independent of ticket 004's end-to-end takeover test).
- [ ] Names that fail several consecutive sweeps are probed less often
      than ones that answer (a concrete backoff, table-tested).
- [ ] `npx vitest run packages/host/src/watchers packages/host/src/connect`
      passes.

## Implementation Plan

**Approach**: Build the pure candidate-ordering/backoff function first
(table-testable, no I/O), then the per-candidate probe step (a thin
wrapper over `RelayCommandPlane.ts`'s `setChannelGroup` plus a new
`sendAndWaitForIdReply`-shaped helper — check whether this belongs in
`RelayCommandPlane.ts` itself, alongside `sync`/`setChannelGroup`/`go`,
or in `relaySweeper.ts` directly; it is protocol-adjacent enough that
`RelayCommandPlane.ts` is the more consistent home), then the task
loop (start/stop/heartbeat, mirroring `watchers/usbWatcher.ts`'s/
`watchers/mdnsWatcher.ts`'s own task shape).

**Files to create/modify**:
- `packages/host/src/watchers/relaySweeper.ts` (new).
- `packages/host/src/connect/relayLeaseRevocation.ts` (new — the shared
  seam; small enough to build here since ticket 002's `relayBridger.ts`
  only needs to *read* it, not populate it, until ticket 004).
- `packages/host/src/link/RelayCommandPlane.ts` (a probe-and-wait-for-id
  step, if that is where it belongs per the Approach note above).
- `packages/host/src/runtime.ts` (wire the sweeper into the composition
  root, started/stopped alongside the existing watchers).

**Testing plan**:
- `watchers/relaySweeper.test.ts` (new): fake relay with a scripted
  `!CG`/`> ID` reply set; the rate-limit, no-`!GO`/`HELLO`, and backoff
  acceptance criteria above.
- `connect/relayLeaseRevocation.test.ts` (new): register/lookup/clear
  semantics, independent of any relay fake.
- Scoped run: `npx vitest run packages/host/src/watchers
  packages/host/src/connect`.

**Documentation updates**: none beyond this ticket's own completion notes.
