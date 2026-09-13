---
id: '017'
title: 'Leaves and hygiene: firmware availability watcher, flash/SWD hardening, shared
  UI components, specification fixes'
status: done
branch: sprint/017-leaves-and-hygiene-firmware-availability-watcher-flash-swd-hardening-shared-ui-components-specification-fixes
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
- SUC-008
- SUC-009
issues:
- rearch-13-firmware-availability-watcher-etag-backoff.md
- rearch-14-flash-swd-timeouts-platform-msd-fallback.md
- rearch-16-ui-shared-components-dedupe.md
- rearch-18-specification-stale-statements.md
- firmware-config-env-becomes-settings-importer.md
- relay-names-outside-five-letter-grammar-get-no-device-row.md
- placeholder-merge-for-non-usb-transports.md
- robot-page-shows-active-connection.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 017: Leaves and hygiene: firmware availability watcher, flash/SWD hardening, shared UI components, specification fixes

## Goals

Close out the rearchitecture arc's remaining leaves: turn firmware
availability polling into a well-behaved watcher, harden flash/SWD
against wedged transports and non-macOS platforms, extract the UI
components that three pages currently copy, and correct the
specification's statements that the code review found stale. This is
Sprint C of `docs/design/rearchitecture-plan.md`.

## Problem

Four mostly-independent pieces of "silently wrong" behaviour remain
after sprints 014-016 land the host core, relay ownership, and the
sweep: firmware-release polling has no `ETag`/backoff and a classroom
behind one NAT can exhaust GitHub's rate limit in under an hour; every
DAPLink/HID call in the flash path has no timeout, and MSD fallback
only works on macOS; three UI pages have quietly grown their own
copies of the same connect-controls, held-drive, calibration-table,
and dialog-shell logic; and `specification.md` still describes verbs,
transports, and a host device model (`deviceRegistry.ts`) that no
longer exist after this arc. None of these four touch each other's
code, and none introduce a new subsystem — they are leaves, closing
gaps the code review catalogued rather than adding new composition.

## Solution

Land the four issues; ordering here is about dependency readiness, not
a tight coupling chain — 13 and 14 can start as soon as sprint 015's
connector exists, 16 waits on 07's UI work, and 18 is parked here but
could genuinely land any time:

1. **rearch-13** — the firmware availability watcher: `ETag`/
   `If-None-Match` polling, `Retry-After` and exponential backoff on
   403/429, an `AbortSignal` timeout on every fetch, and a `no-asset`
   message that names the assets actually found. Depends on sprint
   015's projection reading from the `firmware` table.
2. **rearch-14** — flash/SWD hardening: every dapjs call wrapped in a
   timeout with a typed failure class; MSD volume listing made
   platform-aware (Linux `/media`/`/run/media`, Windows drive letters,
   not just macOS `/Volumes`); exclusivity between naming, session,
   and flash moved onto `board_owner` now that `deviceRegistry.ts` is
   gone. Depends on sprint 014's store and USB watcher, and sprint
   015's connector.
3. **rearch-16** — UI shared components: the relay connect-controls,
   `RobotSelect`, held-drive hook, calibration table, WiFi form, modal
   shell, and status-copy helpers that today are copy-pasted across
   `FrontPage`, `RelayPage`, `ConfigurationPage`, and others get one
   definition each. Depends on sprint 015's rearch-07 UI rewrite (do
   after, so this sweep isn't duplicating work already done there).
4. **rearch-18** — specification corrections: fix the stale `TLM HDR`,
   "11 verbs", and `WifiUdpLink` statements, point §4's host
   description at `architecture.md` instead of `deviceRegistry.ts`,
   and note the relay command-plane `>`/`<` fact and the break-reset
   path. Doc-only; no code dependency, but best done once the rest of
   the arc's behavior is settled so the doc describes the finished
   system.

## Success Criteria

- No known "silently wrong" behaviour remains in the leaves catalogued
  by the 2026-09-11 code review.
- `specification.md` is true of the code: every claim naming a file,
  verb, or service type matches what actually ships after this arc.
- Firmware polling survives a classroom-sized burst of hosts behind one
  NAT without every host reporting `network` and disabling flash.
- Flash/SWD operations degrade to a typed timeout failure instead of
  hanging, on every platform's MSD fallback path.
- Every UI duplicate row catalogued in `docs/reviews/2026-09-11/04-ui.md`
  §4 resolves to one definition.

## Scope

### In Scope

- Firmware availability watcher with ETag/backoff (rearch-13).
- Flash/SWD timeout hardening and platform-aware MSD fallback
  (rearch-14).
- Shared UI components deduping the relay/robot-select/drive/
  calibration/WiFi-form/modal duplication (rearch-16).
- Specification corrections and the `overview.md` roadmap pointer
  update (rearch-18).

- Carried from sprint 016 ticket 008: (1) WiFi leg — a robot advertising
  `_robotlink` connects and answers a command; (2) stakeholder physically
  drives a robot over USB and over radio via a relay. Bench needs a
  `_robotlink` robot and a healthy USB cable for the robot board.
- Follow-up issues linked to this sprint: firmware-config settings
  importer; relay names outside the five-letter grammar get no device
  row (torture); placeholder merge for non-USB transports (gopiv).

### Out of Scope

- Any new watcher, transport, or subsystem — this sprint touches only
  existing leaf modules and docs.
- Anything already covered by sprints 014-016 (store, connector,
  reconciler, relay leases, sweeper, network transports).
- The two remaining unchanged open issues noted in the plan
  (`wificred-provisioning-affordance...` and
  `wifi-drops-burst-lines-calibration-apply-lost.md`), which are not
  part of this arc.

## Test Strategy

Fake-fetch tests for the firmware watcher's 304/403/backoff/timeout
paths; fake-`fs`-per-platform tests for MSD volume listing; a fake
dapjs that never resolves, asserting the timeout failure and released
`board_owner`; existing FakeSocket UI tests updated to the shared
components with the duplicated assertions collapsed to one per
component. rearch-18 is verified by grep (`TLM HDR`, `11 verbs`,
`WifiUdpLink` absent) and a spot-check against the protocol review's
table — no new automated tests. No new hardware bench pass is required
beyond what sprints 014-016 already covered, since these are hardening
and hygiene changes to existing paths, not new behaviour.

## Dependencies and Rationale

This is Sprint C of `docs/design/rearchitecture-plan.md`. Per the
plan's dependency graph, rearch-13 and rearch-14 depend on sprint
015's connector; rearch-16 depends on rearch-07 (sprint 015); rearch-18
"could go any time but is parked here." Unlike sprints 014-016, this
sprint's four issues do not chain into each other — they are grouped
because they are the arc's remaining leaves, not because of a shared
dependency graph among themselves.

## Architecture

**Substantial** — by module count. Seven leaves are touched across four
mostly-unrelated areas (firmware watcher, flash/SWD, mDNS relay
identification and placeholder merge, UI dedupe) plus a doc-only fix,
well past the "one module" compact threshold. No data model change (the
`firmware` and `board_owner` tables architecture.md already defines cover
everything this sprint needs) and no new subsystem is introduced, so this
sizing is driven entirely by breadth, not by new composition — the same
shape as sprint 020. The one new module, `connect/flasher.ts`, formalizes
an *existing* implicit dependency (today's `reidentifyAfterFlash` already
duplicates connect-sequence logic after a flash) rather than adding a new
edge to the component graph.

### Step 1 — Problem

See Problem/Solution above: firmware availability polling has no
`ETag`/backoff and can exhaust a classroom's shared GitHub rate limit;
flash/SWD calls have no timeout and MSD fallback is macOS-only; three UI
pages have grown their own copies of the same widgets; two data-model
edge cases (non-five-letter relay names, non-USB first identification)
leave devices without a proper row; and `specification.md` describes
verbs, transports, and a device model that no longer exist.

### Step 2 — Responsibilities

1. **Firmware source configuration** — resolve `.env`/env-var firmware
   sources into `settings` once, idempotently, at bootstrap.
2. **Firmware availability polling** — turn `releases.ts`'s poll loop into
   a watcher task with `ETag`, backoff, timeout, and a useful `no-asset`
   message, writing `firmware` rows.
3. **Flash/SWD call safety** — bound every DAPLink/HID call in time and
   fail with a typed class instead of hanging.
4. **Flash exclusivity and handoff** — own `board_owner` acquisition,
   session close-first, and release around a flash operation, without
   coupling `flash.ts` itself to the store.
5. **Platform-aware MSD fallback** — find the mounted micro:bit volume on
   Linux and Windows, not only macOS, with correct settle/poll timing.
6. **mDNS relay identification for non-grammar names** — give every
   mDNS-discovered relay a device row regardless of whether its
   advertised name parses as a five-letter micro:bit name.
7. **Cross-transport placeholder merge** — collapse a known-robots
   placeholder into the real device row on first identification over
   *any* transport, not only USB.
8. **UI duplication removal** — one definition each for the widgets three
   pages currently copy, with no page exporting a component another page
   imports.
9. **Specification truthfulness** — correct `specification.md`/
   `overview.md` statements the code review found stale. Doc-only; not a
   code module.

Responsibilities 1–2 change together (the watcher depends on the importer
having run) and are grouped; 3–4 change together (both are about the
flash call path); 5 is separable from 3–4 (independent failure mode,
independent tests) but stays in the same file group; 6–7 are independent
data-model edge-case fixes in different existing modules (`mdnsWatcher.ts`,
`connector.ts`); 8 is a UI-only sweep; 9 is docs-only.

### Step 3 — Modules

| Module | Purpose (one sentence) | Boundary | Serves |
|---|---|---|---|
| `store/importers/firmwareConfig.ts` (new) | Resolves firmware source env vars into `settings` rows once at bootstrap. | Inside: env-then-`.env` precedence, idempotent `settings` writes. Outside: HTTP polling, hex fetch/verify. | SUC-001 |
| `watchers/firmwareWatcher.ts` (new) | Polls GitHub release availability per firmware kind and writes the result to `firmware`. | Inside: `ETag`/`Retry-After`/backoff/`AbortSignal` timeout, no-asset message construction. Outside: hex fetch/verify (stays in `releases.ts`), UI rendering. | SUC-002 |
| `flash.ts` / `swdName.ts` (modified) | Perform one bounded DAPLink/SWD operation and fail with a typed class if it doesn't finish in time. | Inside: `withTimeout` wrapper, typed `timeout` failure, `listVolumeNames(platform)`, MSD settle/poll timing, `flashViaDapLink`/`resetViaDapLink` naming. Outside: who owns the board, session lifecycle. | SUC-003, SUC-004 |
| `connect/flasher.ts` (new) | Owns board-owner exclusivity and session handoff around one flash operation. | Inside: acquire `board_owner='flash'`, close an open session first, invoke `flash.ts`, write `links.flash` phases, release. Outside: the DAPLink calls themselves, re-identification (left to the USB watcher's normal add/update event). | SUC-003 |
| `watchers/mdnsWatcher.ts` (modified) | Gives every mDNS-discovered relay a stable device row, whatever its advertised name looks like. | Inside: synthetic-id fallback (stable hash of `mbrelay:<instance>` into the negative id range) alongside the existing fast path for grammar-matching names. Outside: projection/UI rendering of `relays[]` (unchanged). | SUC-005 |
| `store/index.ts` (modified, added 2026-09-12 — see Revision) | Scopes `upsertDevice`'s name/id consistency check so a non-grammar relay name can be stored at all. | Inside: the `deviceIdToName(id) === name` assertion itself, narrowed to skip rows where `id < 0 && kind === 'relay'`. Outside: every other row shape (all `kind='robot'` rows, grammar-named `kind='relay'` rows) — unchanged, still asserted exactly as before. | SUC-005 |
| `connect/connector.ts` (modified) | Collapses a known-robots placeholder into the real device row on first identification over any transport. | Inside: name-matched single-placeholder merge via the existing `Store.mergeDevice`, no-op on name mismatch; the candidate query is scoped to `kind='robot'` so it can never pick a synthetic relay row (see Revision). Outside: `mergeDevice`'s own mechanics (already built, sprint 015). | SUC-006 |
| `ui/components/*`, `ui/hooks/useHeldDrive.ts`, `ui/lib/{calibration,lineClass,clipboard}.ts` (new/consolidated) | Each duplicated UI behavior gets exactly one definition, consumed by the pages that need it. | Inside: `RelayConnectControls`, `RobotSelect`, `useHeldDrive`+`clearEstop`, `CalibrationTable`+`lib/calibration.ts`, `WifiCredentialsForm`, `Modal`, `deviceDisplay.ts`'s `linkStateText`, `lib/lineClass.ts`, `lib/clipboard.ts`. Outside: page-level layout and page-specific state — pages still decide *what* to show. | SUC-007 |
| `docs/design/specification.md`, `docs/design/overview.md` (docs only) | Every claim in the spec naming a file, verb, or service type is true of the shipped code. | Inside: text edits pointing §4 at `architecture.md`, verb count, transport facts. Outside: no code. | SUC-008 |

Each module passes the cohesion test above (one sentence, no "and"). No
module in this list depends on another module in this list in a new
direction: `connect/flasher.ts` depends on `store` and `flash.ts`, the
same direction `connect/connector.ts` already depends on `store` and
`linelink`; `firmwareWatcher.ts` depends on `settings` (written by
`firmwareConfig.ts`) the same direction `mdnsWatcher.ts` already depends
on `settings`-adjacent config. Fan-out stays within the existing 4–5
bound at every layer.

### Step 4 — Diagrams

**No component diagram.** All eight modules above either already exist in
`architecture.md`'s component list (`firmwareWatcher` is explicitly named
in §6.4; `connect/*` and `watchers/*` are existing subsystems) or are a
small new leaf hung off an existing one with no new fan-in/fan-out
pattern (`connect/flasher.ts` sits exactly where `connector.ts` already
sits, calling `store` and a leaf module; UI components move code that
already exists somewhere in the tree into a shared location without
changing which layer talks to which). A diagram here would redraw
`architecture.md` §3's box list with two extra small boxes in already-
expected positions — it would not clarify a new relationship, so per the
sprint-020 precedent it is omitted.

**No ERD.** No table gains or loses a column: `firmware.etag` and every
`board_owner` field this sprint uses are already in `architecture.md` §4;
the synthetic relay id is a same-shape `INTEGER PRIMARY KEY` value picked
by a different formula, not a schema change.

**No dependency graph.** Dependency direction is unchanged (see Step 3);
nothing here reverses or adds an edge between existing layers.

### Step 5 — What Changed / Why / Impact / Migration

**What Changed:** Firmware availability moves from an ad hoc poller
mixing config/poll/projection concerns into a proper watcher task reading
`settings` and writing `firmware`, fed by a new bootstrap importer for
firmware source config. Flash/SWD calls gain timeouts and a real owner
handoff module; MSD fallback becomes platform-aware. Two data-model edge
cases (non-grammar relay names, non-USB first identification) get their
missing-row bugs fixed in the existing watcher/connector modules that
already own that logic — the relay-naming fix also requires narrowing
`Store.upsertDevice`'s name/id consistency check for negative-id relay
rows (2026-09-12 revision; see Design Rationale and Revision below).
Three UI pages' duplicated widgets collapse to one definition each.
`specification.md`/`overview.md` catch up to the code.

**Why:** Each of these is a "silently wrong" behavior the 2026-09-11 code
review catalogued: a classroom-scale failure mode (firmware rate
limiting), a hang risk (unbounded HID calls), lost bench visibility
(torture relay, gopiv duplicate row), copy-drift risk (UI), and a
documentation/code mismatch that will keep misleading the next reader of
`specification.md`.

**Impact on Existing Components:** `releases.ts`'s pure functions are
unchanged and reused by both the watcher and the flash path.
`FirmwareAvailabilityCache` is deleted; the projection already reads
`firmware` (sprint 015), so no projection change is needed. `flash.ts`
loses its board-owner/session coupling to `connect/flasher.ts`, becoming
easier to test with a fake `dapjs` alone. The USB watcher's existing
add/update event becomes the sole re-identification path after a flash,
retiring `reidentifyAfterFlash`'s copy of the connect sequence. No
watcher, transport, or table is added.

**Migration Concerns:** None for the data model (no schema change). The
firmware-config importer must run before `firmwareWatcher` reads
`settings`; ticket ordering below enforces that. Deleting
`FirmwareAvailabilityCache` removes its config hot-reload path — the
importer becomes the only way `settings`' firmware keys change short of a
host restart, which is an intentional simplification (§9 open question
below flags it for confirmation, not a blocker).

### Design Rationale

**Decision: synthetic relay id via stable hash, not a new `id_source`
column.** Context: `mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` throws
today when a relay's mDNS instance name (e.g. `torture`) doesn't parse as
a five-letter micro:bit name, per the issue's proposed resolution.
Alternatives: (a) a stable hash of `mbrelay:<instance>` into the negative
id range, reusing the existing `devices.id INTEGER PRIMARY KEY` shape and
the synthetic-id convention sprint 016 ticket 005 already established;
(b) a dedicated `devices.id_source` column making id provenance explicit.
Why (a): no schema change, and the codebase already has a synthetic-id
convention this fits into cleanly. Consequences: id provenance ("was this
a real chip id or a synthetic one") is inferable only by sign, not by a
labeled column — acceptable since the only current consumer that cares
(the projection, when deciding whether a relay can be flashed/named over
SWD) already keys off `kind='relay'` and transport, not off id sign.

**Decision: scope `Store.upsertDevice`'s name/id invariant to exclude
negative-id relay rows, not add a `devices.id_source` column.** Context
(2026-09-12 revision, thrown as a ticket-005 exception): the decision
above never checked its chosen id scheme against `Store.upsertDevice`
(`store/index.ts:424-428`), which unconditionally asserts
`deviceIdToName(id) === name` and throws `DeviceNameMismatchError`
otherwise — a deliberate invariant from ticket 014-003
(`docs/reviews/2026-09-11/05-protocol.md` §2 item 6), which exists to
catch a real name/id corruption bug. `deviceIdToName` always produces a
well-formed five-letter grammar name for *any* integer, so no id choice
can ever make it equal a non-grammar name like `torture`: as specified,
the negative-hash fallback throws on every single non-grammar relay name
it exists to fix. Alternatives: (a) scope the existing check to skip rows
where `id < 0 && kind === 'relay'`, documenting the id-range convention
that a negative id is never a real chip id (`FICR.DEVICEID[1]` is an
unsigned 32-bit value, so every genuine chip id is non-negative — a
negative id is unambiguously synthetic) — the negative range is already
reserved for exactly this fallback (Design Rationale above) and used
nowhere else; (b) add a nullable `devices.id_source` column
(`chip | name | mdns`) via a new migration `0002`, and apply the
consistency check only when `id_source in ('chip', 'name')`. Why (a):
(b) is a real schema/migration change this sprint's sizing paragraph and
Step 4 explicitly state does not happen ("no data-model change... same-
shape `INTEGER PRIMARY KEY` value picked by a different formula, not a
schema change") — introducing one here would also require an ERD per
Step 4's own rule and would touch every `upsertDevice` caller's
understanding of the row shape, not just this one fallback. (a) is a
narrower, purely additive scoping of one existing check, expressed
entirely in terms of a convention (negative id ⇒ synthetic) the codebase
already relies on informally. Consequences: the invariant still holds
for every `kind='robot'` row (chip id or `nameToValue` placeholder alike)
and every grammar-named `kind='relay'` row (the existing `nameToValue`
fast path, unchanged) — it is relaxed *only* for the exact new row shape
this ticket introduces. This narrows, not removes, the protection the
2026-09-11 review's finding put in place: a robot row (the class that
finding's own corruption bug involved) can never bypass the check. A
name-based merge elsewhere in the codebase must still never treat one of
these negative-id relay rows as a robot placeholder — ticket 006's
placeholder-match query is scoped to `kind='robot'` for exactly this
reason (see that ticket and the Modules table row above).

**Decision: `connect/flasher.ts` as a new small module, not inlined
ownership logic in `flash.ts`.** Context: the code review explicitly
calls `flash.ts` a "clean leaf... kept" and flags that exclusivity today
lives only in `deviceRegistry.ts`'s `KeyedMutex`, which is gone.
Alternatives: (a) give `flash.ts` direct store access to acquire/release
`board_owner`; (b) a new small orchestrator beside `connector.ts`. Why
(b): keeps `flash.ts` testable with a fake `dapjs` and no store fixture,
consistent with architecture.md's rule that watchers/leaves never touch
another component's rows directly and only the connector-layer owns
cross-cutting exclusivity. Consequences: one more small file, but the
ownership/handoff logic is exercised by the same kind of fake-store table
tests the reconciler and connector already use, rather than a bespoke
fixture inside `flash.test.ts`.

**Decision: directory-listing MSD fallback per platform, not a
diskutil-equivalent external tool per OS.** Context: today's fallback
hardcodes `readdir("/Volumes")`. Alternatives: (a) enumerate
`/media/<user>`, `/run/media/<user>`, `/mnt` on Linux and drive letters on
Windows via plain `fs`/`readdir`, matching `DETAILS.TXT` as today; (b)
shell out to a platform disk-listing utility for a more "official" volume
list. Why (a): preserves the "no external process" property the current
code already has, and keeps the unit tests fake-`fs`-only (no per-OS CI
runner needed to test it). Consequences: Windows support is written and
unit-tested but has no bench hardware to validate against this sprint
(flagged below).

### Migration Concerns

None beyond the sequencing note in Step 5 (importer before watcher). No
existing row shape changes; nothing requires a one-time backfill.

### Open Questions

1. **Windows MSD fallback has no bench hardware.** It ships unit-tested
   against a fake `fs` only. Flagging for stakeholder awareness, not
   blocking — Linux is the platform with actual unverified bench gap
   (macOS is covered today; Windows was never covered).
2. **`GITHUB_TOKEN` storage location.** rearch-13 allows either `env` or
   `settings`. This sprint reads it from either if present (env wins, same
   precedence as the firmware-source importer) rather than forcing one;
   flag for stakeholder confirmation that this is the desired precedence
   long-term.
3. **`usecases.md` UC-009 repeats the stale `TLM HDR` claim** that
   rearch-18 corrects in `specification.md` ("The host issues `TLM HDR`...").
   rearch-18's scope is `specification.md`/`overview.md` only; `usecases.md`
   is not listed. Flagging rather than silently expanding scope — the
   ticket for rearch-18 will note this and ask whether to fix it in the
   same PR or as a follow-up issue.
4. **Synthetic relay-id collision.** Two mDNS relay instances hashing to
   the same negative id would merge into one row. Considered low-
   probability (mbrelay instance names are operator-assigned and expected
   unique per physical device) and deferred rather than adding collision
   detection now; flagged for the stakeholder to confirm that's
   acceptable. **Update (2026-09-12 revision):** before this revision the
   question was theoretical — the fallback threw on every non-grammar
   name, so no row with a hash-derived negative id ever reached the
   store. Scoping `Store.upsertDevice`'s invariant to skip negative-id
   relay rows (Design Rationale above) is what makes the fallback work at
   all, and it is also what makes a collision's consequence concrete: two
   colliding names now silently overwrite each other's `devices.name` via
   the existing `ON CONFLICT ... SET name = excluded.name` upsert, with
   no error raised (the check that would have caught a mismatch is
   exactly the one this revision narrows). This does not change the
   probability assessment above, only confirms what "merge into one row"
   concretely means now that the path is live. Still deferred, not
   blocking; still flagged for stakeholder confirmation, now with the
   sharper framing.

## Revision

**Date:** 2026-09-12
**Cause:** Ticket 005 exception (thrown by programmer, surface
`internal`): the sprint's own Design Rationale chose a negative-hash
synthetic relay id for a non-grammar mDNS name, but never reconciled
that choice with `Store.upsertDevice`'s unconditional
`deviceIdToName(id) === name` assertion (ticket 014-003,
`docs/reviews/2026-09-11/05-protocol.md` §2 item 6). Since
`deviceIdToName` always yields a well-formed five-letter name for any
integer, no id choice can satisfy the invariant for a name like
`torture` — the fallback as specified threw on every case it was meant
to fix.
**Decision:** Scope `Store.upsertDevice`'s name/id consistency check to
skip rows where `id < 0 && kind === 'relay'`, rather than adding a
`devices.id_source` column. Documents the convention that a negative id
is never a real chip id (`FICR.DEVICEID[1]` is unsigned 32-bit) and is
therefore unambiguously synthetic. `store/index.ts` is added to the Step
3 Modules table for SUC-005. See the new Design Rationale entry above for
the full alternatives analysis, and the updated Open Question 4 for the
collision-risk consequence this makes concrete rather than theoretical.
**Consequences:** No schema change and no ERD needed — the sizing
paragraph's "no data-model change" statement still holds. The invariant
still fully applies to every `kind='robot'` row and every grammar-named
`kind='relay'` row; it is narrowed only for the new hash-fallback shape.
Ticket 006's placeholder-merge query must exclude `kind='relay'` rows so
it can never mistake a synthetic relay row for a robot placeholder — a
bullet was added to that ticket's acceptance criteria to make this
explicit and testable, rather than relying on the structural argument
alone (a robot's identified name is always five-letter-grammar-shaped,
so it cannot collide with a non-grammar relay name today, but the query
should not depend on that fact holding forever).
**Ticket 005 disposition:** Reopened by the team-lead via
`reopen_ticket`; its Description/Acceptance Criteria/Implementation Plan
are rewritten below to include the `store/index.ts` change.

**Revision (2026-09-12): SUC-009 — connection visibility in
`AppHeader`.** New issue linked mid-sprint
(`robot-page-shows-active-connection.md`, 2026-09-12 bench: a student
cannot tell which connection the robot page is using, and the page must
never present a connection it cannot use). UI-only addition, no change
to the module boundaries Step 3 already describes: `AppHeader.tsx`
(mounted once outside `RobotPage`'s route element, per its own doc
comment) is extended to render the routed link's `connectionLabel(link)`
+ `linkStateText(link)` under the device name and, when `link.session`
is undefined, a "No open session on this link" notice with a Connect
action (`session-open`, gated by `useSendable`, mirroring
`DeviceConsole.tsx`'s existing pattern) and, if a sibling link on the
same device has an open session, a plain navigation link to it — no
client-side auto-connect or switch policy, matching this sprint's
existing rule that the client never re-implements host connection
decisions. `connectionLabel` moves out of `FrontPage.tsx` (today a
page-local function) into `deviceDisplay.ts`, alongside `linkStateText`
(already moved there by ticket 017-007), so both pages read one shared
definition — consistent with SUC-007's UI-dedupe goal, not a new
duplication. `RobotPage.tsx` and everything it mounts are untouched: the
transport text lives entirely in the header, preserving the
transport-blindness property `RobotPage.transportBlind.test.ts` enforces
on the page body. No new module, no new cross-module dependency, no
data-model change — compact-scoped, single-module-family (UI) addition;
scoped self-review below covers cohesion and boundary only, not the full
five-category review.

**Self-review (scoped, compact addition):** `AppHeader.tsx`'s added
responsibility ("show the routed link's identity, state, and
recovery/switch affordance") is a one-sentence, no-"and"-free extension
of its existing "route-aware app header" purpose (it already renders
per-link actions such as `FlashDialog`/`RadioAddressDialog`); it does
not introduce a dependency `AppHeader.tsx` didn't already have
(`useLink`, `useDeviceForLink`, `useSendable`, `useWsActions().send` are
all pre-existing imports/hooks). `deviceDisplay.ts` gains one function
(`connectionLabel`, relocated) with the same boundary its existing
`linkStateText` already has (presentational, no side effects, no store
access) — no silent cross-module dependency is introduced. Verdict:
passed.

## Use Cases

Substantial sprint; full use cases below, each parented to the closest
existing use case in `docs/design/usecases.md` (or marked doc-only where
no behavior changes).

### SUC-001: Firmware source configuration works from a packaged install or a checkout
Parent: UC-002

- **Actor**: robot-console host (automatic, at bootstrap)
- **Preconditions**: Either `ROBOT_CONSOLE_RELAY_FIRMWARE`/
  `ROBOT_CONSOLE_ROBOT_FIRMWARE` env vars are set, or a `.env` in the
  state dir/repo root sets them, or neither.
- **Main Flow**:
  1. On store bootstrap, the importer reads `process.env` first, then the
     `.env` file.
  2. Resolved values are written to `settings` keys `firmware.relay.source`
     / `firmware.robot.source`, idempotently; an env var always wins over
     a stale row.
  3. `getFirmwareConfig` reads `settings`, not the file, from then on.
- **Postconditions**: A packaged install with only env vars set, and a
  checkout with only `.env` set, both show both flash sources configured.
- **Acceptance Criteria**:
  - [ ] Env-only install resolves both firmware kinds.
  - [ ] `.env`-only checkout resolves both firmware kinds.
  - [ ] Changing `.env` and restarting updates `settings`; a stale row
        never overrides a present env var.
  - [ ] No `.env` file read anywhere outside the importer.

### SUC-002: Firmware availability polling survives a classroom-scale NAT burst
Parent: UC-002

- **Actor**: robot-console host (automatic)
- **Preconditions**: `settings` has a firmware source for at least one
  kind (SUC-001); many hosts share one outbound IP.
- **Main Flow**:
  1. `firmwareWatcher` polls each firmware kind with `If-None-Match`.
  2. A `304` response leaves the `firmware` row untouched and parses no
     body.
  3. A `403`/`429` response with `Retry-After` schedules the next poll no
     earlier than that value, backing off exponentially up to 1 hour on
     repeated failures.
  4. A `200` with a new tag updates the row once and includes a
     `no-asset` message naming the assets actually found, when the
     expected assets are absent.
  5. A hung fetch aborts at a 10 s timeout without blocking any other
     task.
- **Postconditions**: `firmware` rows reflect availability without a
  classroom of hosts all reporting `network` and disabling flash.
- **Acceptance Criteria**:
  - [ ] Fake fetch returning 304 → no row change, no body parse.
  - [ ] Fake fetch returning 403 + `Retry-After: 120` → next poll not
        before 120 s.
  - [ ] Fake fetch returning 200 with new tag → row updated once.
  - [ ] Fetch that never resolves → aborted at timeout, `reason='network'`,
        no other task blocked.
  - [ ] `no-asset` fixture with an unexpected asset → message names it.
  - [ ] Token present → `Authorization` header set and never logged; token
        absent → header not set.

### SUC-003: A wedged flash/SWD call fails instead of hanging, and ownership releases cleanly
Parent: UC-002

- **Actor**: Student; robot-console host (automatic on timeout)
- **Preconditions**: A board is connected and a flash or naming operation
  is requested; the underlying HID transport is wedged.
- **Main Flow**:
  1. `connect/flasher.ts` acquires `board_owner='flash'`, closing an open
     session first if one exists.
  2. `flash.ts`/`swdName.ts` wrap every DAPLink/HID call in `withTimeout`.
  3. On timeout, the call disconnects best-effort and returns a typed
     `timeout` failure.
  4. `connect/flasher.ts` releases `board_owner` regardless of outcome.
  5. The USB watcher's next add/update event re-identifies the board;
     no separate re-identification code path runs.
- **Postconditions**: The student sees a typed timeout failure within the
  configured budget, not a hang; the board is available for the next
  operation.
- **Acceptance Criteria**:
  - [ ] Fake `dapjs` that never resolves `flash()` → `timeout` failure
        within budget, HID handle closed, `board_owner` released.
  - [ ] A flash requested while a session is open closes the session
        first (visible in the store) and the link returns to `connected`
        after the watcher re-identifies the board.
  - [ ] Existing `flash.test.ts` cases pass under the renamed
        `flashViaDapLink`/`resetViaDapLink`.

### SUC-004: MSD fallback finds the micro:bit volume on Linux, not only macOS
Parent: UC-002

- **Actor**: robot-console host (automatic, after a failed SWD flash)
- **Preconditions**: SWD flash failed; a micro:bit MSD volume is mounted
  under a platform-appropriate path.
- **Main Flow**:
  1. `listVolumeNames(platform)` enumerates `/Volumes` (darwin),
     `/media/<user>`, `/run/media/<user>`, `/mnt` (linux), or drive
     letters (win32).
  2. A volume matching `DETAILS.TXT` is selected.
  3. The host waits a 500 ms settle before copying, then polls for the
     volume to disappear/reappear (up to 10 s) before reporting done.
- **Postconditions**: MSD fallback succeeds on Linux exactly as it does
  today on macOS; enumeration failures are logged, not swallowed.
- **Acceptance Criteria**:
  - [ ] `listVolumeNames` unit tests per platform with a fake `fs`.
  - [ ] A completed MSD copy is not reported done until the settle/poll
        sequence finishes.
  - [ ] An enumeration failure produces a log line, not a silent skip.

### SUC-005: A relay whose mDNS name isn't a valid five-letter name still gets a device row
Parent: UC-008

- **Actor**: robot-console host (automatic)
- **Preconditions**: An `_mbrelay._tcp` advertisement's instance name does
  not parse as a five-letter micro:bit name (e.g. `torture`).
- **Main Flow**:
  1. `mdnsWatcher.ts` tries the existing fast path (name matches an
     already-identified USB relay).
  2. If that fails, it falls back to a stable hash of `mbrelay:<instance>`
     into the negative id range instead of throwing.
  3. The device row is written with `kind='relay'`; the projection lists
     it under `relays[]` with `transport: mbrelay`.
- **Postconditions**: The relay appears as a card, can be bridged through,
  leased, swept, and aged out like any other relay.
- **Acceptance Criteria**:
  - [ ] A fake `_mbrelay._tcp` advertisement named `torture` produces a
        relay device + card.
  - [ ] A bridge through it still works; aging removes it after last-seen
        expires.
  - [ ] A five-letter-named relay still takes the existing fast path
        (table test covering both cases).

### SUC-006: A robot identified over mbserial or WiFi merges into its USB placeholder, not a duplicate
Parent: UC-001

- **Actor**: robot-console host (automatic)
- **Preconditions**: A `known-robots.json`-seeded placeholder row exists
  (synthetic id, `owned=1`, no `usb_serial`) for a robot subsequently
  identified over `mbserial` or `wifi`.
- **Main Flow**:
  1. On first identification over any transport, the connector checks for
     exactly one placeholder row sharing the banner's name.
  2. If found and the name matches, `Store.mergeDevice` collapses the
     placeholder into the real row, carrying `owned` across.
  3. If names differ, no merge happens (the vevov/vevav case).
- **Postconditions**: One row per physical robot regardless of which
  transport identified it first; no orphaned links or sightings.
- **Acceptance Criteria**:
  - [ ] Seeded placeholder `gopiv` + fake `mbserial` identify of `gopiv`
        → one row, `owned=1`, no orphaned links/sightings.
  - [ ] Table tests for usb, mbserial, wifi identification paths.
  - [ ] Differing names → no merge (no-op case tested).

### SUC-007: UI pages read as pages — each shared widget has exactly one definition
Parent: UC-003

- **Actor**: Student / Instructor (observes no behavior change); a future
  maintainer (benefits directly)
- **Preconditions**: `FrontPage`, `RelayPage`, `ConfigurationPage`,
  `CalibrationPage`, `DriveControls`/`DriveTab`, and the dialog components
  currently duplicate the widgets catalogued in `docs/reviews/2026-09-11/
  04-ui.md` §4.
- **Main Flow**:
  1. Each duplicated behavior (relay connect controls, `RobotSelect`,
     held-drive engine, e-stop clear, calibration table + merge,
     WiFi form, modal shell, connection-state/name-display copy, radio
     validation, line-prefix sniffing, copy-to-clipboard) is extracted to
     one shared component/hook/lib module.
  2. Every page imports the shared module instead of defining its own
     copy or importing from another page.
  3. Existing FakeSocket UI tests are updated to the shared components;
     duplicated assertions collapse to one test on the shared component.
- **Postconditions**: The pages behave identically to a user; a grep for
  any of the catalogued duplicate literals finds exactly one site.
- **Acceptance Criteria**:
  - [ ] Every duplicate row in `04-ui.md` §4 resolves to one definition.
  - [ ] No page module exports a component imported by another page or
        component.
  - [ ] Existing FakeSocket tests pass with fixtures updated; duplicated
        assertions collapse to the shared component's test.

### SUC-008: `specification.md` is true of the shipped code
Parent: None — documentation correction, no behavior change

- **Actor**: A developer reading `specification.md` after this arc lands
- **Preconditions**: Sprints 014–017 have landed the SQLite store,
  connector, watchers, and this sprint's leaf fixes.
- **Main Flow**:
  1. §3.5 is corrected to 13 verbs (listed); §3.6 drops `TLM HDR` and
     states the 20-frame auto-refresh as the only recovery path; §3.7
     moves the `<`-strip attribution to `host/link/lineStream.ts`.
  2. §4.3 corrects WiFi to TCP with `NODELAY`; §4.4 lists five service
     types including `_mbflash._tcp`.
  3. §4's host description is replaced with a pointer to
     `architecture.md`, keeping only transport traps and leaf modules.
  4. §6 gains the break-reset and relay command-plane `>`/`<` sentences.
  5. `overview.md`'s "Roadmap" section is replaced with a pointer to the
     sprint arc.
- **Postconditions**: Every claim in `specification.md` §3–§4 naming a
  file, verb, or service type matches the code on the branch.
- **Acceptance Criteria**:
  - [ ] `grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/specification.md
        packages/protocol/src` finds nothing.
  - [ ] §9 items 3(a)/3(d) carry an explicit stakeholder confirm-or-close
        note in the same change.
  - [ ] Spot-check against `docs/reviews/2026-09-11/05-protocol.md` §2's
        table passes.

### SUC-009: A student always sees which connection the robot page is using and its state
Parent: UC-018

- **Actor**: Student
- **Preconditions**: A device page (`/d/:linkId`) is open for a routed
  link, whether or not the owning device has more than one link.
- **Main Flow**:
  1. `AppHeader` resolves the routed link (`useLink`) and renders, under
     the device name, `connectionLabel(link)` (the host-built label,
     relay-qualified when `via` is present) followed by
     `linkStateText(link)`.
  2. If `link.session` is undefined, the header instead shows "No open
     session on this link" plus a Connect button, gated by
     `useSendable`, that sends `{ type: "session-open", linkId: link.id }`.
  3. If the owning device has another link with an open session, the
     header additionally offers a "Use `<label>` instead" link to
     `/d/<thatLinkId>` — plain navigation, no client-side connect/switch
     policy.
  4. The text updates live as the link's snapshot state changes (state
     transition, session open/close).
- **Postconditions**: A student can always tell, from the header alone,
  which physical connection they are on, whether it currently has an
  open session, and how to get one (connect or switch) — the page never
  silently presents a connection it cannot use.
- **Acceptance Criteria**:
  - [ ] Opening a USB, mbserial, or via-relay link with an open session
        shows its `connectionLabel` + `linkStateText` under the name.
  - [ ] Opening a link with no open session shows "No open session on
        this link" and a Connect button that sends `session-open`.
  - [ ] When a sibling link on the same device has an open session, a
        "Use `<label>` instead" link to `/d/<thatLinkId>` appears;
        otherwise it does not.
  - [ ] State text updates live on a snapshot change, with no page
        reload.

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On | Issue | Completes Issue |
|---|-------|------------|-------|------------------|
| 001 | Firmware config: settings importer for env/.env firmware sources | — | firmware-config-env-becomes-settings-importer.md | Yes |
| 002 | Firmware availability watcher: ETag, backoff, timeout, no-asset message | 001 | rearch-13-firmware-availability-watcher-etag-backoff.md | Yes |
| 003 | Flash/SWD timeouts, typed failure class, board_owner exclusivity via connect/flasher.ts | — | rearch-14-flash-swd-timeouts-platform-msd-fallback.md | No (see 004) |
| 004 | Flash/SWD: platform-aware MSD fallback with settle/poll timing | 003 | rearch-14-flash-swd-timeouts-platform-msd-fallback.md | Yes |
| 005 | mDNS relay identification: synthetic device id for non-five-letter names | — | relay-names-outside-five-letter-grammar-get-no-device-row.md | Yes |
| 006 | Connector: merge known-robots placeholder on first non-USB identification | — | placeholder-merge-for-non-usb-transports.md | Yes |
| 007 | UI shared components I: relay connect controls, robot select, held-drive, modal shell, display/line/clipboard helpers | — | rearch-16-ui-shared-components-dedupe.md | No (see 008) |
| 008 | UI shared components II: calibration table, WiFi credentials form, radio validation consolidation | 007 | rearch-16-ui-shared-components-dedupe.md | Yes |
| 009 | Specification corrections: verbs, TLM HDR, WiFi transport, service types, host-model pointer | — | rearch-18-specification-stale-statements.md | Yes |
| 010 | Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving | 001, 002, 003, 004, 005, 006, 007, 008, 009 | (none — carried scope item) | — |
| 011 | Robot page: header shows active connection label + state, with connect/switch when no open session | — | robot-page-shows-active-connection.md | Yes |

Tickets execute serially in the order listed. 001→002 and 003→004 and
007→008 are true dependency chains (settings before watcher, timeout
infra before MSD fallback, `Modal`/helpers before the components that
use them); 005, 006, and 009 have no dependency on this sprint's other
tickets and could run in any order relative to them, but are listed in
the order above for a single serial executor. 010 is the sprint's
closing gate and depends on every other ticket.

Ticket 011 was added mid-sprint (issue
`robot-page-shows-active-connection.md`, linked 2026-09-12, after 010
had already started) and has no `depends-on` — it touches only
`AppHeader.tsx`/`deviceDisplay.ts`/`FrontPage.tsx`, disjoint from every
other ticket's files. It is **not** added to 010's `depends-on` (010 is
already in progress); instead, 011's own ticket file notes that the
stakeholder's ticket-010 drive check should be re-run once 011 lands, as
a sprint-close confirmation rather than a new dependency edge.
