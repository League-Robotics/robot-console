---
id: '004'
title: SWD naming never overwrites a known relay's kind
status: done
use-cases:
- SUC-002
depends-on:
- '003'
github-issue: ''
issue: bench-swd-naming-overwrites-relay-kind.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# SWD naming never overwrites a known relay's kind

## Description

First data-correctness fix (SUC-002), checked against the harness ticket
003 built. `packages/host/src/watchers/usbWatcher.ts` (~line 230) calls
`store.upsertDevice({ …, kind: "robot", … })` unconditionally on every
successful SWD chip-ID read, and `upsertDevice` overwrites `kind` on
conflict — silently downgrading a known relay (`vevav`, evidenced live
on the stakeholder's real state dir: `devices` row `536019796 vevav`
has `kind: robot, owned: 0`, and its USB link is stuck `connecting` with
`fail_count 7` because the reconciler auto-connects it as a robot and
identify fails).

Fix: SWD naming never asserts `kind`. A board first seen over SWD is
recorded without a `kind` (or keeps whatever `kind` the row already has);
only a banner/ID reply on an opened session (the connector's identify
step) may set or change `kind`. This matches the existing rule already
documented in `docs/design/architecture.md` §6.1 ("owned = 1 if the
banner or ID later confirms a robot") but the code does not currently
honor it for `kind`.

## Acceptance Criteria

- [x] `usbWatcher.ts`'s SWD read no longer writes `kind: "robot"`
      unconditionally; it omits `kind` on first-seen boards and never
      overwrites an existing `kind` on a subsequent read.
- [x] Only the connector's identify step (banner/ID reply) sets or
      changes a device's `kind`.
- [x] Unit test: a device row seeded with `kind: "relay"` survives a
      fresh `usbWatcher` SWD read with `kind` unchanged.
- [x] Unit test: a brand-new device (no prior row) gets a row with no
      `kind` asserted by the watcher alone.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real bench with a
      relay-flashed board that was previously misclassified (or a
      seeded state dir reproducing the `vevav` `kind: robot` row from
      the stakeholder's real database); the report shows that board's
      USB path passing Layer 2 (the "no relay has `kind: robot`"
      card-truthfulness assertion from ticket 002) and Layer 3 (the card
      renders it as a relay, Connect reaches Linked, `ID` answers).
      **Partially met, not checked off** — see "Evidence gathered" note
      below: the seeded-DB reproduction and the `no-relay-as-robot`
      truthfulness assertion both directly confirm the fix on live
      hardware, but a full Layer 2+Layer 3 *pass* for `vitut`/usb could
      not be captured this session because the stakeholder's own
      `npm run dev` (pid 82496) intermittently locks the same physical
      USB serial ports this harness needs exclusive access to (see
      `dev-server-holds-usb-ports` project memory) — a pre-existing
      environment condition, not a regression from this ticket's fix.
      Re-running `scripts/bench/run.sh` once that dev server is paused
      should produce a clean pass row.

      **Team-lead disposition 2026-09-13:** code fix and seeded
      reproduction accepted (vevav stays relay across an SWD read on a
      copy of the stakeholder DB; vitut no-relay-as-robot passes every
      run). A clean vitut USB L2/L3 pass row is blocked by bench
      contention: the stakeholder's running host (`scripts/dev.mjs`)
      sweeps relays and opens their serial ports intermittently (88
      sightings in 10 min), and the harness host's own sweeper does the
      same. Re-verified in the full-bench gate ticket 011 on an
      exclusive bench. Related defect filed:
      `bench-relay-port-contention-sweeper-vs-session.md`.

### Evidence gathered (2026-09-13)

- **Root cause confirmed**: `usbWatcher.ts` (~line 230, pre-fix) called
  `store.upsertDevice({ …, kind: "robot", … })` unconditionally on every
  successful SWD chip-ID read; `upsertDevice`'s `ON CONFLICT` clause
  unconditionally overwrote `kind`. A chip-ID read cannot itself
  distinguish a robot from a relay (both expose the same SWD/DAP
  interface), so this silently downgraded any already-known relay the
  next time its board was seen over USB.
- **Seeded reproduction** (copies only — the real state dir was never
  opened for writing): copied the stakeholder's real
  `~/.local/state/robot-console/console.sqlite` (+`-wal`/`-shm`) into
  scratch. `vevav` (id `536019796`) was confirmed `kind: "robot"`,
  `role: "RADIOBRIDGE"` — the exact live bug. Starting this branch's
  host against that copy (vevav attached at `/dev/cu.usbmodem2121402`)
  left `vevav`'s `kind` at `"robot"` (never corrected — its identify
  never got a banner; it appears parked in the data plane, consistent
  with `fail_count` climbing 195→196 across the run). Forcing `kind` to
  `"relay"` directly in the scratch copy (simulating "already correctly
  identified") and restarting the host produced a fresh SWD read (the
  link transitioned to `connectable`) with `kind` still `"relay"`
  afterward — direct proof the fix holds: the old code would have
  reasserted `"robot"` here.
- **Harness runs**: `scripts/bench/run.sh --skip-held --audit-db
  <scratch copy of the real db> --report bench-report-004.md`, several
  times. Every single run's `no-relay-as-robot` truthfulness assertion
  for `vitut` passed (`kind ("relay") is consistent with role
  ("RADIOBRIDGE")`), and Layer 1 independently classified `vitut` as
  `relay` via its own banner read every time — the store-level fix held
  under repeated live SWD reads throughout. The harness's own relay
  probe verb fix (018-004 Step 0) was also directly observed engaging
  correctly live: one intermediate run reached `vitut`'s usb link
  `"connected"` and then correctly sent `?` (not `ID`), reporting
  `no "line" rx matching "# channel:" (relay status reply)` when the
  physical relay didn't answer within the bound — proving the verb
  selection and expected-reply logic are correct; only the live
  hardware round trip itself was intermittently blocked by USB port
  contention with pid 82496.
- Initially implemented the relay probe verb as a second `HELLO`; live
  bench evidence showed a relay does not reliably repeat its full
  banner once already `connected` (the connector's own identify already
  consumed the first one), so the harness fix was corrected mid-session
  to send `?` and match `# channel: ...` instead — matching
  `layer1/usbProbe.ts`'s own already-proven "banner via HELLO, confirm
  via `?`" sequence for this exact hardware.

## Implementation Plan

**Approach**: read `usbWatcher.ts`'s current `upsertDevice` call site
and the store's `upsertDevice` conflict-resolution logic; change the
watcher to pass no `kind` (or the device's current `kind`, if the store
requires the field) instead of the hardcoded `"robot"`. Confirm the
store's `upsertDevice` itself does not need to change — the bug is the
caller asserting a value it doesn't yet know, not the store's merge
semantics.

**Files to modify**:
- `packages/host/src/watchers/usbWatcher.ts`
- possibly `packages/host/src/store/store.ts` if `upsertDevice`'s type
  requires `kind` as non-optional (loosen to optional if so)

**Testing plan**: `vitest` unit tests in `usbWatcher.test.ts` for both
acceptance criteria above (existing relay row unchanged; new device row
gets no asserted kind); scoped run: `npx vitest run
packages/host/src/watchers`. Bench pass per the harness command above.

**Documentation updates**: none beyond this ticket's own evidence — the
architecture doc's existing rule already describes the intended
behavior; this ticket makes the code match it.
