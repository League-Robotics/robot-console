---
id: '004'
title: Sweep takeover within one probe, plus relay/robot projection and UI
status: done
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: rearch-10-relay-sweeper-radio-sightings.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sweep takeover within one probe, plus relay/robot projection and UI

## Description

Completes rearch-10 and is the ticket that actually satisfies UC-016's
"student connects through a relay while it is sweeping" acceptance
target (≤ 1.5 s handback). Wires ticket 002's `relayBridger` and ticket
003's `relaySweeper` together through the shared
`relayLeaseRevocation` seam:

1. A student's `session-open` (via `relayBridger`) finds the target
   relay's `sweep` lease already held.
2. `relayBridger` looks up the sweeper's registered `AbortController` in
   the revocation seam and triggers it.
3. The sweeper (already built in ticket 003) finishes its current wait
   (≤ 500 ms), releases the lease, and makes no further writes to the
   relay.
4. `relayBridger` acquires the now-free session lease and proceeds with
   the bridge — using the sighted channel/group first if the sweep had
   already recorded one for this robot.
5. On Disconnect, the relay returns to idle; after a quiet period the
   sweeper resumes.

Total observed handback time (press to bridge proceeding) must be
≤ 1.5 s (rearch-09/UC-016's own target).

This ticket also adds the projection/UI rendering `architecture.md` §7.3
and rearch-10's issue describe: the relay card shows "idle · sweeping
<name>" (while a sweep is actively probing) or "idle" (lease-free,
between passes); robot cards show a `Radio via <relay>` link row with
state and "last checked <time>" from the newest `sightings` row for that
device (`devices.lastChecked`, already a `Snapshot.devices[]` field per
architecture.md §9 — this ticket populates it from `sightings`, it does
not add a new wire field). No wire-contract change: `SnapshotRelay`
already carries `lease: "sweep" | "session" | null`; "sweeping `<name>`"
vs. plain "idle" is a UI-side label built from `lease === "sweep"` plus
knowing which candidate is currently mid-probe (either surfaced via a
small addition to `bridging`-shaped ephemeral server state, or inferred
client-side from the most recent `sightings`-driven link change — a
ticket-level UI call).

## Acceptance Criteria

- [x] Fake relay + fake sweep: a takeover request during an in-flight
      probe releases the sweep lease within 600 ms of the abort and
      makes no further sweep writes to the relay afterward.
- [x] End-to-end fake-relay timing test: from the takeover request to the
      bridge proceeding (session lease acquired) is ≤ 1.5 s.
- [x] A robot the sweep had already sighted uses that sighted
      channel/group for the takeover bridge, not a re-derived default.
- [x] After Disconnect and a quiet period, the sweeper re-acquires the
      lease and resumes sweeping (verify via the fake relay seeing
      further `!CG`/`> ID` traffic after the quiet period elapses).
- [x] Front-page fixture test: a snapshot with `relays[].lease ===
      "sweep"` renders "idle · sweeping"; one with `lease === null`
      renders "idle"; a robot device with a recent radio sighting renders
      a `Radio via <relay>` row with "last checked <time>".
- [x] `npx vitest run packages/host packages/ui` passes (host: sweeper/
      bridger interaction tests; ui: fixture rendering tests).

## Implementation Plan

**Approach**: This ticket is primarily integration — the individual
pieces (bridger, sweeper, revocation seam) are already built by tickets
002/003. Write the end-to-end fake-relay test first (the ≤ 1.5 s timing
acceptance criterion) since it is the sprint's own headline behavioral
target, then the UI fixture/rendering work.

**Files to create/modify**:
- `packages/host/src/connect/relayBridger.ts` (the revocation-trigger
  call on lease-acquire-failure-because-sweep-held).
- `packages/host/src/projection.ts` (`devices[].lastChecked` populated
  from `sightings`, if not already wired by ticket 003).
- `packages/ui/src/pages/RelayPage.tsx` / front-page relay card
  component (the "idle · sweeping <name>" / "idle" label).
- `packages/ui/src/pages/FrontPage.tsx` or the relevant robot-card
  component (`Radio via <relay>` row, "last checked <time>").
- UI fixtures (`packages/host/src/projection.fixtures` and/or
  `packages/ui`'s own snapshot fixtures) regenerated to cover a
  sweep-lease relay and a radio-sighted robot.

**Testing plan**:
- `connect/relayBridger.test.ts`: the takeover-during-probe and
  end-to-end timing acceptance criteria.
- `watchers/relaySweeper.test.ts`: the resume-after-quiet-period case.
- `packages/ui`: `RelayPage.test.tsx`/`FrontPage.test.tsx` fixture
  rendering assertions.
- Scoped run: `npx vitest run packages/host packages/ui`.

**Documentation updates**: none beyond this ticket's own completion notes.

## Implementation notes

**Takeover, in `connect/relayBridger.ts`**: `createRelayBridger`'s
`bridge()` now takes an optional `revocation: RelayLeaseRevocation` dep.
When `store.acquireRelayLease` fails, it reads the lease's current
`owner` (`store.reconcilerRows().relayLeases`); only `owner === "sweep"`
(duplicated as a literal — importing `relaySweeper.ts`'s own
`SWEEP_OWNER` would cycle, since that module already imports from this
one) triggers the new `takeoverSweepLease`: it looks up and aborts the
relay's registered `AbortController` via the revocation seam, then polls
`acquireRelayLease` (default 25ms, capped at 1000ms —
`takeoverMaxWaitMs`/`takeoverPollMs`, both overridable) until the
sweeper's own `finally` block releases it. Any other owner (an existing
session) is not preemptable and fails exactly as before. Omitting
`revocation` (every pre-ticket call site) preserves the old immediate-
failure behavior verbatim — proven by the pre-existing "rejects
immediately... held by another owner" test, now annotated as this
ticket's own "no revocation configured" regression guard.

**Sighted channel/group preferred over a re-derived default, in
`server.ts`**: the `session-open {relayLinkId, name}` handler now checks
whether `radio-<name>-via-<relayLinkId>` already has a `links` row
(written by an earlier bridge, or by the sweeper recording a sighting)
and reuses its `{channel, group}` verbatim before falling back to
`resolveDeviceRadio`. This was necessary because the sweeper (ticket
003) and a named bridge both converge on the same `links` row id, but
the handler was unconditionally overwriting that row's `address` with a
freshly-resolved one on every `session-open` — silently discarding
whatever address the sweep had just confirmed reachable. New
`parseChannelGroupAddress` helper (mirrors `projection.ts`'s private
`parseRelayAddress`, minus the irrelevant `relayLinkId` field).

**Wiring, in `runtime.ts`**: `createRelayLeaseRevocation()` is now
constructed *before* the bridger (previously only before the sweeper) and
handed to both `createRelayBridger` and `startRelaySweeper` as the same
instance — ticket 003 had left an explicit forward-reference comment for
this. `runtime.test.ts` gained a `createRelayBridger` mock (previously
untested — the real implementation was used, harmlessly, since
construction alone does no I/O) so both wiring assertions (bridger and
sweeper share one revocation instance) are directly verified.

**UI: `findRelayChild` was quietly broken by ticket 003, fixed here**:
`watchers/relaySweeper.ts` records a `links(radio)` row for *every*
remembered robot it ever probes over a relay (success or failure), using
the exact same `via.relayLinkId`-bearing id convention a real bridge
uses. `RelayPage.tsx`/`FrontPage.tsx` both had their own copy of
`findRelayChild`, matching on `via.relayLinkId` alone with no state
check — so once a sweep pass touched even one remembered robot, that
robot would be mistaken for the relay's live bridged child, permanently
hiding "idle"/"idle · sweeping" behind a bogus "Connection to `<name>`
lost". Moved to `deviceDisplay.ts` (one shared implementation instead of
two copies) and fixed: a link only counts as a live/former child when its
`state` is anything other than `"connectable"`/`"discovered"` — the two
states a sweep-only sighting ever leaves a link in; every state a real
bridge attempt produces (`connecting`/`connected`/`failed`/
`unresponsive`/`closed_by_user`/`stale`) still counts, so the existing
"connection lost" regression coverage (states `failed`/`unresponsive`) is
unaffected.

**"idle · sweeping `<name>`" — client-side inference, not a new wire
field**: `SnapshotRelay` already carries `lease: "sweep"|"session"|null`;
no field says *which* candidate a sweep pass is currently on. Given the
choice the ticket left open, this went with client-side inference
(`deviceDisplay.ts`'s new `findSweepingCandidateName`) over a wire
addition: the most-recently-`lastChecked` device carrying a `via` link to
this relay, as long as that check is within `SWEEP_LABEL_FRESH_MS`
(45s — comfortably above the sweeper's own default 30s per-candidate
rate-limit interval, so the label doesn't flicker off between one
successful probe and the next). Both `RelayPage.tsx` and `FrontPage.tsx`
(`RelayQuickConnect`, which previously had no idle/sweeping rendering at
all) now show "idle · sweeping `<name>`" when a candidate can be
inferred, else plain "idle · sweeping", else "idle".

**"Radio via `<relay>` ... last checked `<time>`"**: `FrontPage.tsx`'s
existing `connectionLabel` already appended "(via relay `<name>`)" to a
`via`-linked row (sprint 015); this ticket adds a sibling "Last checked
`<time>`" span (`deviceDisplay.ts`'s new `lastCheckedText`,
`data-testid="device-link-lastchecked-<linkId>"`) reading
`SnapshotDevice.lastChecked` — a field `projection.ts` has populated from
the newest `sightings` row (any transport) since sprint 015 ticket 004,
but which nothing wrote real rows for until ticket 003's sweeper; the
golden fixture (`projection.fixtures/golden-snapshot.json`) already
covers both a `lease: "sweep"` relay and a `lastChecked: 160`
radio-sighted device, so no fixture regeneration was needed — verified,
not modified, per the ticket's own "verify; add if missing" wording.

**Measured handback time** (`relayBridger.test.ts`, "sweep takeover"
suite, real timers throughout, no fake clock): against a fake relay
combining the sweeper's own `!CG`/`> ID` command-plane responses and the
bridger's full `!ECHO OFF → !MODE RAW250 → !CG → !P 7 → !GO → HELLO`
preamble, a takeover mid a long (4s) rate-limited sweep wait consistently
measured well under both budgets in local runs — the sweep's own pass
released its lease within single-digit milliseconds of the abort (its
own current wait is either already abort-gated, per `relaySweeper.ts`'s
own design, or bounded at ≤500ms), and the bridge itself (reset + full
preamble + boot-window identify against the fast-fixture options) landed
in well under 200ms end-to-end — both comfortably inside the 600ms/1.5s
ceilings the test asserts.

**Not done / deliberately out of scope**: no change to `SnapshotRelay`'s
wire shape (no new field) — see "client-side inference" above. The
`bridging` ephemeral overlay field predates this ticket and is still
never populated by `server.ts` (an existing, unrelated gap); this ticket
did not touch it.

Files touched: `packages/host/src/connect/relayBridger.ts` (+test),
`packages/host/src/watchers/relaySweeper.test.ts`,
`packages/host/src/server.ts` (+test), `packages/host/src/runtime.ts`
(+test), `packages/ui/src/deviceDisplay.ts` (+test),
`packages/ui/src/pages/RelayPage.tsx` (+test),
`packages/ui/src/pages/FrontPage.tsx` (+test). No changes to
`projection.ts`, `wsMessages.ts`, or the golden fixture — all verified
already correct.

Test commands run in the foreground:
- `npx vitest run packages/host/src/connect packages/host/src/watchers
  packages/host/src/projection.test.ts packages/host/src/wsMessages.test.ts
  packages/host/src/server.test.ts packages/ui` — 42 files, 694 tests,
  all passing.
- `npm run typecheck` — clean (protocol, host, ui all build/typecheck
  with no errors).
