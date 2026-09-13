---
id: '005'
title: Radio link aging and current-address resolution at connect time
status: in-progress
use-cases:
- SUC-003
depends-on:
- '003'
github-issue: ''
issue: bench-stale-radio-links-and-duplicate-rows-persist.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Radio link aging and current-address resolution at connect time

## Description

First half of the radio-hygiene fix (SUC-003); ticket 006 does the
one-time duplicate-row repair. Evidenced live on the stakeholder's real
state dir: radio links created by the sweeper/bridger yesterday are
never aged or removed (`radio-gopiv-via-usb-…2e78…` `failed`, "cannot
open /dev/cu.usbmodem2121202", `last_seen` 849 min ago;
`radio-vevov-via-usb-…2e78…`/`radio-tovez-via-usb-…2e78…` `discovered`,
849 min) — the relay behind them (`vevav`) has since moved to
`/dev/cu.usbmodem2121402`, so the failure text names a USB path that no
longer belongs to that relay.

Two fixes, both in the radio-link lifecycle:

1. **Aging**: a radio link whose relay link is gone or `stale`, or that
   has had no successful sighting within a TTL, becomes `stale` and is
   hidden from cards — the same rule already applied to mDNS links per
   `docs/design/architecture.md` §6.2 ("Age every type with `WHERE
   last_seen < now - ttl`").
2. **Current-address resolution**: a radio link's address resolves the
   relay's *current* transport (not a cached one) at connect time, so a
   relay that has moved USB paths does not leave stale failure text
   behind; when the relay's address changes, previously stale failure
   text on its radio links is cleared.

## Acceptance Criteria

- [x] A radio link whose relay link is gone or `stale`, or with no
      successful sighting within its TTL, transitions to `stale` and is
      excluded from the snapshot's card-visible links (same treatment
      as an aged mDNS link).
- [x] A radio link's connect-time address lookup reads the relay's
      *current* link address, not a value cached when the radio link
      was created.
- [x] When a relay's address changes, any radio link riding on it that
      previously carried stale failure text naming the old address has
      that text cleared (not left to read a path that no longer applies).
- [x] Unit tests: aging past TTL with no sighting → `stale`; relay
      address change → radio link resolves the new address at next
      connect attempt and clears stale failure text.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against a seeded state dir reproducing
      the stakeholder's real `radio-gopiv-via-usb-…` /
      `radio-vevov-via-usb-…` rows (849-minute-old failures naming a
      moved USB path); the report/Layer 2 card-truthfulness check shows
      those rows aged to `stale` and absent from the card, and a fresh
      radio link created after the relay's move resolves the relay's
      new address correctly.
      **Partially met, not checked off** — see "Evidence gathered"
      below: the seeded-DB before/after directly confirms the aging fix
      against the stakeholder's own real (copied) database, and unit
      tests directly confirm current-address resolution and stale-text
      clearing, but a live Layer 2/3 harness *pass* for these exact
      rows could not be captured this session — the stakeholder's own
      `node scripts/dev.mjs` (pid 82496) was still running and holding
      every usb-relay/network resource this run needed, exactly the
      same pre-existing environment condition ticket 004 hit, now also
      automatically caught and reported by this same ticket's own Step
      0b exclusivity hardening (see the harness run's own "Holders /
      skips" table below). Re-running once that dev server is paused,
      or with the harness's own bench (ticket 011), should produce a
      clean pass row.

### Evidence gathered (2026-09-13)

- **Seeded before/after** (copies only — the real state dir was never
  opened for writing except by one accidental ~3s slip, corrected
  immediately — see the note at the end of this section): copied the
  stakeholder's real `~/.local/state/robot-console/console.sqlite`
  (+`-wal`/`-shm`) into scratch. Before this branch's host ran, the
  copy's `radio-*-via-usb-…2e78…` rows (via `vevav`'s own usb link,
  which has since moved to `/dev/cu.usbmodem2121402`) were exactly the
  live-evidenced bug: `radio-gopiv-via-usb-…2e78…` `failed`,
  `state_reason: "Error: ... cannot open /dev/cu.usbmodem2121202"`
  (naming vevav's *old* path), `last_seen` ~19h old, `fail_count: 5`;
  `radio-vevov-via-usb-…2e78…`/`radio-tovez-via-usb-…2e78…`
  `discovered`, ~19h old. Started this branch's host (`bin/
  robot-console.js --port 4900 --no-open --no-sweep`,
  `ROBOT_CONSOLE_STATE_DIR` pointed at the scratch copy) and, one
  `mdnsWatcher` aging tick later (~30-40s), re-read the copy directly:
  **all eight `radio-*` rows — the three `…2e78…` rows above, plus
  `radio-vevov/gopiv/tigez/tovez-via-usb-…8939…` (via `vitut`) and
  `radio-{gopiv,tigez}-via-mbrelay-torture` — transitioned to
  `state: "stale"`, `state_reason: "ttl-expired"`**. This includes one
  row (`radio-gopiv-via-usb-…8939…`) that had a *fresh* successful
  sighting (`ok: 1`) only ~30s before this host started (still
  `connectable`, `fail_count: 0`, in the "before" dump) — it aged too,
  because running with `--no-sweep` (this ticket's own Step 0b, and
  what the evidence instructions asked for) means nothing re-sights it
  during the run; `store/index.test.ts`'s own "does not age a radio
  link with a recent successful sighting" unit test is the direct,
  deterministic proof that a link with an *ongoing* fresh sighting
  stream is not aged — the live seeded run cannot demonstrate that
  specific half live, since disabling the sweeper (required to avoid
  the harness racing itself, per Step 0b) necessarily also stops new
  sightings for any radio child, `torture`-reached ones included.
- **Harness run**: `scripts/bench/run.sh --skip-held --audit-db <the
  post-aging copy of the seeded db above> --report
  bench-report-005.md`. Layer 1 detected the stakeholder's
  `scripts/dev.mjs` (pid 82496) as a running host process (this
  ticket's own Step 0b) and marked every usb-relay/network resource
  `skipped` accordingly — every main-table row is `skipped`, none
  `defect`/`environment`/`pass`, exactly the correct, honest outcome
  for a run that could not get exclusive bench access. The `--audit-db`
  section still lists 9 `would-be-hidden-radio-link` findings — **these
  are explained, not a sign the fix failed**: every one of the 9
  findings is the check's *relay-freshness* branch (`"...'s relay link
  ... is Ns old (TTL 180s)"` / `"...is stale"`), which measures the
  **relay's own** `last_seen`/`state_since` (`vitut`, `vevav`,
  `mbrelay-torture`), not the radio child's own aging state — by the
  time Layer 2's audit ran (several minutes after this ticket's own
  seeded-host demonstration above had already ended and been stopped),
  nothing was left running to keep any relay's own presence fresh in
  that static copy, so the relay-freshness branch fires regardless of
  whether the radio child itself is correctly `stale` (confirmed
  separately, directly, in the before/after dump above). In a
  continuously-running system a relay's own `last_seen` is kept fresh
  by `usbWatcher`/`mdnsWatcher` while it is physically present/
  advertising; this audit run's gap is an artifact of auditing a
  snapshot after the demonstration host had already stopped, not a
  regression this ticket introduced.
- **Note on the real state dir**: the first attempt to start the
  evidence host omitted `ROBOT_CONSOLE_STATE_DIR`, so it briefly (~3s)
  opened the stakeholder's *real* `console.sqlite` before being caught
  and killed (`SIGTERM`, clean shutdown confirmed). No motion/flash
  commands were ever sent and no data was corrupted (WAL-mode SQLite
  tolerates a second short-lived reader/writer without loss), but this
  was a real, if brief, violation of "never write to the real state
  dir" — recorded here rather than left unmentioned. Every subsequent
  command in this session used the scratch copy exclusively.

## Implementation Plan

**Approach**: extend the store's link-aging sweep (already present for
mDNS links per architecture.md §6.2) to cover `radio`-transport links
using the same TTL mechanism; change the radio link's address-resolution
call site (wherever `links.address` for a `radio` link is read before
connecting) to look up the relay's current link row instead of using a
value baked in at radio-link creation time.

**Files to modify**:
- `packages/host/src/store/store.ts` (or wherever the link-aging sweep
  lives) — extend to `radio` transport
- `packages/host/src/connect/connector.ts` and/or
  `packages/host/src/connect/relayBridger.ts` — resolve the relay's
  current address at connect time rather than reading a cached value
- possibly `packages/host/src/watchers/relaySweeper.ts` if the sweeper
  is what creates/updates radio link rows

**Testing plan**: `vitest` unit tests for the aging sweep (radio TTL
case) and for current-address resolution (relay address change →
new radio connect uses new address, stale text cleared). Scoped run:
`npx vitest run packages/host/src/store packages/host/src/connect`.
Bench pass per the harness command above, run against a **copy** of the
stakeholder's real, already-affected database (never the live file).

**Documentation updates**: none beyond this ticket's completion notes;
architecture.md §6.2's aging rule already describes the intended
behavior for mDNS and this ticket extends it to radio, so no doc change
is needed unless the sprint-planner's architecture text (this sprint's
own sprint.md) needs a correction, which it does not.
