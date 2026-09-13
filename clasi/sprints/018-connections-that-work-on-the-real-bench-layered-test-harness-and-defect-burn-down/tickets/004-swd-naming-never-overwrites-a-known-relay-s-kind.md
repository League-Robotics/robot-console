---
id: '004'
title: SWD naming never overwrites a known relay's kind
status: open
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

- [ ] `usbWatcher.ts`'s SWD read no longer writes `kind: "robot"`
      unconditionally; it omits `kind` on first-seen boards and never
      overwrites an existing `kind` on a subsequent read.
- [ ] Only the connector's identify step (banner/ID reply) sets or
      changes a device's `kind`.
- [ ] Unit test: a device row seeded with `kind: "relay"` survives a
      fresh `usbWatcher` SWD read with `kind` unchanged.
- [ ] Unit test: a brand-new device (no prior row) gets a row with no
      `kind` asserted by the watcher alone.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real bench with a
      relay-flashed board that was previously misclassified (or a
      seeded state dir reproducing the `vevav` `kind: robot` row from
      the stakeholder's real database); the report shows that board's
      USB path passing Layer 2 (the "no relay has `kind: robot`"
      card-truthfulness assertion from ticket 002) and Layer 3 (the card
      renders it as a relay, Connect reaches Linked, `ID` answers).

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
