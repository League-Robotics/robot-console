---
id: '003'
title: Hardware bring-up and flash verification
status: done
branch: sprint/003-hardware-bring-up-and-flash-verification
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
- sprint-002-flash-path-unverified-against-hardware.md
- sprint-001-hardware-criteria-unverified-no-announcing-board.md
- msd-fallback-volume-matching-heuristic-unimplemented.md
- device-list-shows-tty-path-not-cu-path.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 003: Hardware bring-up and flash verification

## Goals

Turn the silent bench board into an announcing relay and prove, against real
hardware for the first time, that the flash path built in sprint 002 actually
programs a board. This is sprint 3 of the 8-sprint arc in
`clasi/issues/robot-console-two-level-ui-and-multi-transport-roadmap.md`
("Sprint 3 — Hardware bring-up (first)"). It is deliberately first in the arc:
it is the only sprint whose value decays with time, and a flashed relay is
simultaneously the announcing board sprint 1 needed, the flash proof sprint 2
needs, the first real colon-dialect banner, and groundwork the later relay
sprint (arc position 7) is built on.

This sprint produces **no new architecture**. It closes verification gaps and
fixes two small, previously-deferred/mis-surfaced pieces of the existing flash
and device-list code. Nothing it touches should need to be thrown away when
the device-model/navigation sprint (arc position 4) restructures the app.

## Problem

Sprints 1 and 2 both closed with hardware-dependent criteria explicitly
deferred, because no cooperating micro:bit was available:

- Sprint 1 verified names over SWD but never verified `role`, and never got a
  reply to `HELLO`/`?`/`STATUS`, because the only board on the bench is silent
  on serial (`sprint-001-hardware-criteria-unverified-no-announcing-board.md`).
- Sprint 2 built the entire flash path (release fetch, sha256 verify,
  universal-hex v2 extraction, SWD flash, registry orchestration, UI) and
  proved everything test-provable, but the actual DAPLink attach → erase →
  write → reset sequence has never run against a physical board
  (`sprint-002-flash-path-unverified-against-hardware.md`).
- The MSD fallback's volume-matching function, `defaultResolveVolumePath` in
  `packages/host/src/flash.ts`, is a documented placeholder never exercised by
  any test — in production the fallback cannot find a volume at all
  (`msd-fallback-volume-matching-heuristic-unimplemented.md`).
- The Devices tab displays the raw `/dev/tty.*` path from `serialport`, not the
  `/dev/cu.*` callout path `UsbSerialLink` actually opens internally — a user
  who copies the displayed path into a terminal will hang
  (`device-list-shows-tty-path-not-cu-path.md`).
- `vendor/pxt-nezha-diffdrive` is pinned at a commit that predates upstream's
  `d4d8e4e`, which replaced the cleartext `RUN:` carve-out with a sequenced
  `RUN` verb and added `FUNCS`. Fixtures sourced from that submodule are stale.
- `docs/design/specification.md` has accumulated several factual errors
  discovered during roadmap planning (stale sprint numbering in §7, wrong WiFi
  mDNS service names and TXT record format in §4.4/§7/UC-010, an
  under-documented mutation in the mbrelay registry's GET affecting §6/UC-004)
  that will mislead every future planning pass if left uncorrected.

A third consecutive sprint closing with "hardware deferred" would be a process
failure, not just a gap.

## Solution

A bench session, not a build: attach real hardware, run the existing flash
path against it, and fix whatever breaks. Concretely:

1. Flash relay firmware onto a real board via the sprint-2 SWD path and fix
   whatever the real DAPjs/`node-hid` attach → erase → write → reset sequence
   exposes that fixtures couldn't. Confirm the board reboots and re-announces
   with the expected role, closing both the sprint 1 role-verification gap and
   the sprint 2 end-to-end gap in one motion.
2. Implement `defaultResolveVolumePath` for real, joining DAPLink's
   `DETAILS.TXT` unique id against the device's USB serial (not a bare
   volume-name match), using `radio_relay/scripts/flash-local.js` from the
   microbit-radio-relay project as the named template
   (`specification.md` §4.5). This needs **two boards attached
   simultaneously** — the hard part is picking the *right* volume among
   several mounted, which is untestable with one board. If only one board is
   available on the bench day, defer this piece again rather than fake it;
   that is an acceptable, explicit outcome for this ticket, not a sprint
   failure.
3. Fix the tty/cu display path in `packages/host/src/devices.ts` so the
   Devices tab and link-error text show the `/dev/cu.*` path that
   `UsbSerialLink` actually opens, on the host side so every consumer agrees.
4. Bump the `vendor/pxt-nezha-diffdrive` submodule pin past `d4d8e4e` and
   re-run every fixture-sourced test that reads from it.
5. Correct `docs/design/specification.md`: §7's sprint numbering against the
   roadmap issue's table; §4.4/§7/UC-010's WiFi facts (`_robotlink._tcp` AND
   `._udp`, TXT `link=v6` not `link=v6-udp`); §6/UC-004's note that the
   mbrelay registry's GET mutates and can return a locally-derived guess; and
   a new §9 open question recording that no radio-enabled robot hex is
   currently obtainable (zero `pxt-nezha-diffdrive` releases,
   `BOOT_RADIO_LINK = false` by default).
6. If a robot board (not just a relay) is available on the bench, spend the
   ten minutes to run `FUNCS` against it — this de-risks the calibration
   wizard sprint's (arc position 10) largest unknown at near-zero cost, since
   it only requires the board to be present, not any new code.

**Time-box on the SWD work.** If SWD flashing cannot be made to work on this
platform (DAPjs over `node-hid`, macOS HID entitlement/permission issues)
within the session, that is a **finding** to record, not a sprint failure:
MSD becomes the primary flash path pending further investigation. The trigger
for escalating to that finding is explicit: if attach/erase/write cannot be
made to succeed against at least one real board after reasonable
troubleshooting within the bench session, stop iterating on SWD, record the
finding with what was tried and what failed, and let the MSD path (ticket 2
above, if two boards are present) carry the sprint's hardware-flash proof
instead.

## Success Criteria

Split explicitly into what unit tests can prove and what needs a physical
board, per the roadmap issue's verification discipline — sprints 1 and 2 both
closed with criteria that silently required hardware, and that gap is now two
tracked issues. Nothing below should be checked off without having actually
been exercised the way it claims.

**Provable without hardware:**
- [ ] The MSD resolver's `DETAILS.TXT`-to-serial join logic is unit-tested
      against fixture `DETAILS.TXT` content covering: unique match, no match,
      and multiple candidate volumes.
- [ ] The tty→cu path translation is unit-tested in `devices.ts` (or wherever
      it lands) independent of a real serial port.
- [ ] Every test that reads fixtures sourced from
      `vendor/pxt-nezha-diffdrive` passes against the bumped pin, and any
      fixture content that changed under `RUN`/`FUNCS` is updated to match.
- [ ] `docs/design/specification.md`'s corrections (§7 numbering, §4.4/§7/
      UC-010 WiFi facts, §6/UC-004 mutation note, new §9 open question) are
      made and internally consistent with the rest of the document.

**Needs a physical board (record pass/fail/deferred explicitly, do not infer):**
- [ ] A board flashed with relay firmware over SWD reboots and re-announces
      with a `RADIORELAY` or `RADIOBRIDGE` role in the Devices tab.
- [ ] Real progress-event timing observed during an actual flash (erasing/
      writing/resetting) is sane, not just internally consistent with the
      fake DAPjs timeline used in sprint 2's tests.
- [ ] With two boards attached, a forced SWD failure on one falls back to MSD
      and flashes the correct board via the real `defaultResolveVolumePath`,
      leaving the other board untouched. **If only one board is available,
      this criterion is explicitly deferred, not marked done.**
- [ ] The Devices tab shows `/dev/cu.*` (not `/dev/tty.*`) for an attached
      board, confirmed against a real port path.
- [ ] (Stretch, if a robot board is present) `FUNCS` run against it returns a
      sane program list.

**Explicit finding, not a failure, if reached:** SWD flashing could not be
made to work on this platform within the time-box. Record what was tried
(DAPjs version, `node-hid` behavior, macOS HID permission state) and that MSD
is provisionally the primary flash path pending further investigation.

## Scope

### In Scope

- Real-hardware verification and bugfixing of the sprint-2 SWD flash path.
- Real implementation of `defaultResolveVolumePath` (MSD fallback volume
  matching), joining `DETAILS.TXT`'s unique id against device serial —
  contingent on two boards being available; otherwise explicitly deferred.
- Fixing the tty/cu display path so the UI shows the path it actually opens.
- Bumping the `vendor/pxt-nezha-diffdrive` submodule pin past `d4d8e4e` and
  updating any fixtures/tests that depended on the stale `RUN:` carve-out.
- Corrections to `docs/design/specification.md` (§7, §4.4/§7/UC-010, §6/UC-004,
  new §9 open question) per the roadmap issue's "Spec corrections" section.
- Time-boxed hardware bring-up session; recording a time-box finding if SWD
  cannot be made to work.
- Running `FUNCS` against a robot board if one is present (stretch, not a
  blocking criterion).

### Out of Scope

- Any new architecture, device-model changes, or navigation restructuring —
  that is arc position 4 (Device model, device types, two-level navigation),
  the keystone sprint that follows this one. Nothing produced here should be
  thrown away by that sprint.
- Persistence / the remembered-robot roster (arc position 5).
- Drive/remote control, telemetry, or trace UI (arc positions 6 and 8).
- Any new transport (radio relay client, mbrelay/mbserial, WiFi) — those
  belong to arc positions 7 and 9.
- Calibration wizards (arc position 10).
- Fixing `port-lock-contention-between-identify-and-user-open.md` and
  `no-build-pipeline-tsx-is-a-runtime-dependency.md` — both are explicitly
  folded into arc position 4 per the roadmap issue, not this sprint.
- Resolving §9 Q1-Q4 of the specification (calibration firmware existence,
  radio-enabled robot hex sourcing, router choice, roster scope) — this
  sprint only records the new open question about the missing radio-enabled
  hex; it does not answer it.

## Test Strategy

Every unit-testable piece (MSD join logic, tty→cu translation, submodule-
fixture regression) gets a vitest suite with no hardware in the loop.
Hardware-dependent behavior (SWD flash, real progress timing, MSD failover
with two boards, cu-path confirmation, stretch `FUNCS` run) is exercised
manually on the bench and recorded pass/fail/deferred in the relevant
ticket — never inferred from the unit tests that cover the surrounding
logic. `npm test` (vitest, root) and `npm run build` (tsc --noEmit, three
workspaces) both run after every desk ticket; the bench ticket re-runs
`npm test` only if it touches `swdName.ts`/`flash.ts` source, not as a
hardware check.

## Architecture

**Sizing: Substantial** — this sprint touches 3+ existing modules
(`flash.ts`, `devices.ts`, `link/UsbSerialLink.ts`, plus every test file
that reads a `vendor/pxt-nezha-diffdrive`-sourced fixture) and introduces
one small, non-cyclic import edge while consolidating duplicated logic
(see Design Rationale). Per the sprint-020 precedent, the diagram is
**omitted**: nothing new is being composed here. Every module already
exists; this sprint completes and repairs wiring between them (a
placeholder made real, a translation moved to where it belongs, a stale
pin advanced, a doc corrected) rather than adding a subsystem. Per the
sprint's own hard constraint, none of this is new architecture — arc
position 4's device-model restructure is untouched and unblocked by
anything here.

### What Changed

1. **`packages/host/src/flash.ts`** — `defaultResolveVolumePath` replaces
   its "first `MICROBIT*` volume, ignore which device was asked for"
   placeholder with a real join: read each mounted `/Volumes/MICROBIT*`
   volume's `DETAILS.TXT`, extract its unique id, and match it against
   the `DaplinkDevice.serialNumber` already resolved by `devices.ts`
   (`radio_relay/scripts/flash-local.js` is the named template, per
   `specification.md` §4.5). No match still returns `undefined` (no
   fallback attempted), unchanged from today's contract in `flash()`.
2. **`packages/host/src/devices.ts`** gains the canonical `toCalloutPath`
   translation (moved from `link/UsbSerialLink.ts`), applied when
   `joinDaplinkDevices` builds each `SerialPortInfo.path` — every
   downstream consumer (the Devices tab, `linkError` text) now sees the
   `/dev/cu.*` path unconditionally, at the source, rather than only at
   the one call site that happens to open the port.
3. **`packages/host/src/link/UsbSerialLink.ts`** drops its private copy
   of `toCalloutPath` and imports the one now living in `devices.ts` —
   see Design Rationale for why this is the one new dependency edge this
   sprint introduces, and why it's safe.
4. **`vendor/pxt-nezha-diffdrive`** submodule pin bumped past upstream
   `d4d8e4e`/`0056a64`. `packages/protocol/src/radioAddress.test.ts`'s
   fixture (`vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json`)
   and any other content that changed under the `RUN`/`FUNCS` rework are
   updated to match; a fixture that fails for a reason other than stale
   content is a real regression to fix, not to paper over.
5. **`docs/design/specification.md`** and **`docs/design/usecases.md`**
   corrected in the four places listed in the sprint's Solution section
   (documentation, not a code module — no architectural weight, listed
   here only for completeness).
6. **Real-hardware bring-up** against `flashOverSwd`/`swdName.ts`: any bug
   the actual DAPjs/`node-hid` attach → erase → write → reset sequence
   exposes against a physical board is fixed in place. Scope is bounded
   by the sprint's time-box, not predicted here — see Open Questions.

### Why

Each item closes exactly one of the sprint's five linked issues (see
sprint.md's Problem section); item 6 additionally closes the role- and
console-reply-verification half of
`sprint-001-hardware-criteria-unverified-no-announcing-board.md` in the
same bench session, since a successfully flashed relay is the announcing
board that issue has been waiting for.

### Impact on Existing Components

- **`deviceRegistry.ts`** — no logic change. It already reads
  `state.device.serialPort?.path` (item 2 corrects the value at the
  source) and already calls `flash()`'s resolver indirectly through
  `FlashOptions` defaults (item 1 corrects the default in place); neither
  caller needs to change unless the bench session (item 6) surfaces a bug
  in the staleness/mutex handling around a real flash, which is flagged
  as an open question below, not assumed.
- **UI (`DevicesTab.tsx`)** — no code change; it renders whatever `port`
  string the server sends, which item 2 corrects upstream.
- **`packages/protocol`** — untouched. The v6 codec already models a
  sequenced `RUN` with `#<seq>` framing (`codec.test.ts`'s "RUN: invocation
  by name" vectors), so item 4's firmware-side change brings the real
  robot's behavior in line with what the protocol layer already expects;
  it does not require a protocol change.
- No data-model change. No new external integration.

### Migration Concerns

None. No persisted state exists yet (persistence is arc position 5), no
wire-contract change, no schema change. The submodule bump is a
fast-forward within an already-vendored dependency; if vectored fixture
content changed, it is corrected in the same ticket that bumps the pin,
not migrated separately.

### Design Rationale

**Decision: consolidate `toCalloutPath` into `devices.ts` rather than
duplicating the platform-path logic.**
- *Context*: the tty/cu bug (`device-list-shows-tty-path-not-cu-path.md`)
  exists precisely because the translation lived only in the one consumer
  that opens the port (`link/UsbSerialLink.ts`), never in the module that
  reports the path for display (`devices.ts`).
- *Alternatives considered*: (a) duplicate the ~10-line pure function in
  `devices.ts` and leave `UsbSerialLink.ts`'s copy untouched — rejected,
  this reintroduces the exact two-copies-can-drift shape the issue exists
  to close; (b) introduce a new shared module (e.g. `platformPaths.ts`)
  just for this one function — rejected as unwarranted ceremony for a
  10-line, one-direction-of-reuse helper.
- *Why this choice*: `devices.ts` already owns `SerialPortInfo.path` and
  has zero outward host-module dependencies of its own (only external
  libs), so it is a safe, non-cyclic home for the canonical version;
  `link/UsbSerialLink.ts` importing it back is defense-in-depth (correct
  even if a caller ever constructs a link directly from a raw path) on
  top of, not instead of, the single source of truth.
- *Consequences*: one new intra-package import edge,
  `link/UsbSerialLink.ts → devices.ts`. Non-cyclic (`devices.ts` does not
  import `link/`). Both test files' imports of `toCalloutPath` move to
  `devices.ts`.

**Decision: the MSD resolver joins on `DETAILS.TXT`'s unique id against
`device.serialNumber`, not a bare volume-name match.**
- *Context*: `microbit-radio-relay`'s `flash-local.js` is the named
  template (`specification.md` §4.5); several mounted `MICROBIT*` volumes
  are indistinguishable by name alone.
- *Alternatives considered*: matching on volume label suffix — rejected,
  DAPLink volume labels don't embed the device's USB serial.
- *Why this choice*: `DETAILS.TXT`'s unique id is the only value DAPLink
  exposes on the mounted volume that ties it back to a specific board.
- *Consequences*: the matching logic itself is fully unit-testable against
  fixture `DETAILS.TXT` content (unique match, no match, multiple
  candidates); proving it picks the *right* volume among several real
  mounted ones needs two physical boards and is explicitly gated (see the
  MSD ticket's acceptance criteria).

### Open Questions

- Whether SWD flashing works at all on this platform (DAPjs over
  `node-hid`, macOS HID entitlement/permission behavior) is genuinely
  unknown until the bench session runs. The time-box and the
  MSD-becomes-primary finding are this sprint's answer to "what happens
  if it doesn't," not a prediction that it will or won't.
- Whether the submodule bump surfaces fixture drift beyond
  `radio-address-vectors.json` (anything else keyed to the retired `RUN:`
  cleartext carve-out) is unknown until the pin is actually bumped and
  the suite is run.
- §9 Q3(a)/(d) (whether `d4d8e4e` closes those sub-questions) is
  explicitly **not** decided by this sprint — the spec-corrections ticket
  records them as candidates pending stakeholder confirmation, per the
  roadmap issue's own instruction not to close them unilaterally.

## Use Cases

Sprint-level use cases sized to a verification/bugfix sprint: no new
domain use case is introduced (UC-001/UC-002 already describe the target
behavior); each SUC below either closes a verification gap in an
existing UC or fixes a defect in its execution.

### SUC-001: Verify firmware install and role/console reply against real hardware
Parent: UC-002 (also closes the role/console-reply half of UC-001's
unverified behavior)

- **Actor**: Sprint planner / bench operator (not an in-app student flow —
  a manual verification session)
- **Preconditions**: At least one micro:bit is attached and shows
  `linkError`/no role in the Devices tab (the "silent board" state sprint
  001 and 002 both hit).
- **Main Flow**:
  1. Click "Flash relay firmware" on the unidentified board, following
     UC-002's existing flow unchanged.
  2. Observe progress phases (`erasing`/`writing`/`resetting`) against
     real DAPjs/`node-hid` behavior; fix any attach/erase/write/reset bug
     the real sequence exposes that fixtures couldn't (this is the one
     part of the sprint whose code scope isn't fully known in advance).
  3. Confirm the board reboots and re-announces with a `RADIORELAY` or
     `RADIOBRIDGE` role.
  4. In the Console tab, send `HELLO`, `?`, and `STATUS` and confirm each
     returns a sane, readable reply (closing sprint 001's console-reply
     gap in the same session).
- **Postconditions**: A board that previously showed `linkError` and no
  role now shows its five-letter name, correct role, and answers all
  three console commands — or, if the time-box is hit first, a recorded
  finding (see Acceptance Criteria).
- **Acceptance Criteria**:
  - [ ] needs-a-board: flashed board reboots and re-announces with a
        relay role — record pass/fail/deferred, do not infer.
  - [ ] needs-a-board: real progress-event timing observed is sane, not
        merely internally consistent with sprint 2's fake DAPjs timeline
        — record pass/fail/deferred.
  - [ ] needs-a-board: `HELLO`, `?`, `STATUS` each return a readable reply
        — record pass/fail/deferred per command.
  - [ ] Explicit time-box observed: if attach/erase/write cannot be made
        to succeed against at least one real board after reasonable
        troubleshooting within the bench session, stop iterating, and
        record the finding (what was tried: DAPjs version, `node-hid`
        behavior, macOS HID permission state) that MSD is provisionally
        the primary flash path — this is a **finding**, not a failed
        acceptance criterion.

### SUC-002: Resolve the correct MSD volume for a given device
Parent: UC-002 (the MSD fallback path within firmware install)

- **Actor**: Host (`flash.ts`), on SWD failure
- **Preconditions (hardware criterion only)**: Two micro:bits attached
  simultaneously, both mounted as MSD volumes.
- **Main Flow**:
  1. `flash()`'s SWD attempt fails (forced, for this verification).
  2. `defaultResolveVolumePath` reads each mounted `/Volumes/MICROBIT*`
     volume's `DETAILS.TXT`, extracts its unique id, and matches it
     against the target device's `serialNumber`.
  3. The matched volume (not just "the first one found") receives the
     hex write.
- **Postconditions**: The correct board is flashed via MSD; the other
  attached board is untouched.
- **Acceptance Criteria**:
  - [ ] provable-without-hardware: the `DETAILS.TXT`-to-serial join logic
        is unit-tested against fixture content covering unique match, no
        match, and multiple candidate volumes — unconditional, passes
        regardless of what hardware is on the bench.
  - [ ] needs-a-board, **gated on two boards being attached
        simultaneously**: a forced SWD failure on one board falls back to
        MSD and flashes the correct board, leaving the other untouched —
        record pass/fail/deferred. **If only one board is available, this
        criterion is explicitly deferred, not marked done or faked.**

### SUC-003: Show the path that will actually open, not the one that will hang
Parent: UC-001 (device list display)

- **Actor**: Student
- **Preconditions**: A micro:bit is attached on macOS.
- **Main Flow**:
  1. `devices.ts` joins the device's serial-port and HID personas as
     today, but now applies the tty→cu translation when building
     `SerialPortInfo.path`.
  2. The Devices tab and any `linkError` text display that already-
     translated path.
- **Postconditions**: The path shown is the path `UsbSerialLink` actually
  opens; a student who copies it into a terminal does not hang.
- **Acceptance Criteria**:
  - [ ] provable-without-hardware: the tty→cu translation is unit-tested
        against synthetic path fixtures (darwin tty→cu, darwin cu
        unchanged, darwin non-DAPLink path unchanged, non-darwin
        unchanged) independent of a real serial port.
  - [ ] needs-a-board: the Devices tab shows `/dev/cu.*` for an attached
        board, confirmed against a real port path — record pass/fail.

### SUC-004: Keep fixture-sourced tests honest against current upstream firmware
Parent: N/A — infrastructure/process use case, not a student-facing flow.
Supports UC-002's firmware-install correctness and is a stated
prerequisite for arc position 10's calibration wizards.

- **Actor**: Sprint planner / programmer (submodule maintenance)
- **Preconditions**: `vendor/pxt-nezha-diffdrive` is pinned at `ce3445d`,
  predating upstream `d4d8e4e`/`0056a64`.
- **Main Flow**:
  1. Bump the pin past `d4d8e4e`/`0056a64`.
  2. Re-run every test that reads a fixture sourced from that submodule
     (at minimum `radioAddress.test.ts`'s
     `docs/radio-address-vectors.json`).
  3. Update any fixture content that changed under the `RUN`/`FUNCS`
     rework; investigate (don't paper over) any failure not explained by
     that rework.
- **Postconditions**: The full suite passes against the bumped pin with
  no stale-fixture assumptions left in place.
- **Acceptance Criteria**:
  - [ ] provable-without-hardware: every test reading a
        `vendor/pxt-nezha-diffdrive`-sourced fixture passes against the
        bumped pin, with content changes reconciled, not skipped.

### SUC-005: Correct specification.md so it stops misleading planning
Parent: N/A — documentation correction. Affects the facts underlying
UC-004 (registry mutation) and UC-010 (WiFi service names).

- **Actor**: Sprint planner (this ticket is documentation-only, no runtime
  behavior)
- **Preconditions**: `specification.md` and `usecases.md` carry stale
  sprint numbering, wrong WiFi mDNS facts, and an undocumented registry
  mutation.
- **Main Flow**: Apply the four corrections listed in the sprint's
  Solution section (§7 renumbering; §4.4/§7/UC-010 WiFi facts; §6/UC-004
  mutation note; new §9 open question), leaving §9 Q3(a)/(d) explicitly
  open pending stakeholder confirmation of `d4d8e4e`.
- **Postconditions**: The documents are internally consistent and no
  longer contradict verified upstream facts.
- **Acceptance Criteria**:
  - [ ] provable-without-hardware: all four corrections are made and the
        documents are internally consistent (cross-references, section
        numbers, and UC text agree with each other).
  - [ ] §9 Q3(a)/(d) are recorded as open candidates, not closed.

### SUC-006 (stretch, opportunistic): Run `FUNCS` against a robot board
Parent: UC-006 / UC-007 (calibration wizards, arc position 10) — de-risks
their largest open unknown at near-zero cost.

- **Actor**: Bench operator
- **Preconditions**: A robot board (not just a relay) happens to be
  present on the bench during the session. Not required — skip entirely
  if none is available.
- **Main Flow**:
  1. Send `FUNCS` to the robot over the Console tab.
  2. Record whether it returns a sane program list.
- **Postconditions**: A recorded observation (not a code change) of
  whether the shipping robot build's run registry is calibration-suitable
  — informs arc position 10's detail planning.
- **Acceptance Criteria**:
  - [ ] needs-a-board, stretch/non-blocking: `FUNCS` run against a present
        robot board returns a sane program list — record the result if
        attempted; its absence does not affect this sprint's completion.

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

| # | Title | Kind | Depends On |
|---|-------|------|------------|
| 001 | Show the callout (/dev/cu.*) path, not the tty path, everywhere it's displayed | Desk | — |
| 002 | Implement the MSD volume resolver: join DETAILS.TXT against device serial | Desk | — |
| 003 | Bump vendor/pxt-nezha-diffdrive past d4d8e4e and reconcile fixtures | Desk | — |
| 004 | Correct specification.md and usecases.md (numbering, WiFi facts, registry mutation, open question) | Desk | — |
| 005 | Bench: flash a relay over SWD and verify role + console replies against real hardware | Bench, time-boxed | — |
| 006 | Bench: verify MSD fallback with two boards, and stretch FUNCS run if a robot is present | Bench, gated on two boards | 002 |

Tickets execute serially in the order listed. Desk work (001-004) is
sequenced before bench work (005-006) deliberately, per the sprint's
"bench session, not a build" framing: everything test-provable should be
merged before spending bench time, so the bench session is spent entirely
on what only a board can answer. Ticket 006 additionally has a real
code dependency on ticket 002 (it verifies ticket 002's implementation
against real hardware).
