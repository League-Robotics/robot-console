---
id: '017'
title: Flash modal and calibration flash show the release URL and version being flashed;
  card shows program version
status: done
use-cases: []
depends-on:
- '015'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Flash modal and calibration flash show the release URL and version being flashed; card shows program version

## Description

Stakeholder (2026-09-13, verbatim intent): "When you flash, the flash
pop-up should have extra information about what the URL is and what
the version you're flashing is."

The host resolves `firmware.robot.source` / `firmware.relay.source`
(from `.env` `ROBOT_CONSOLE_ROBOT_FIRMWARE=https://github.com/League-Robotics/nezha-robot-template:latest`,
`ROBOT_CONSOLE_RELAY_FIRMWARE=https://github.com/League-Robotics/microbit-radio-relay:latest`)
to a GitHub release and downloads its `MICROBIT.hex` (+
`MICROBIT.hex.txt` sha256 manifest). The resolved release is recorded
in the store's `firmware` table: `repo`, `tag` (e.g.
`v0.20260913.1`), `available`, `checked_at`. Today the modal
(`packages/ui/src/components/FlashDialog.tsx` / `FlashControls.tsx`)
and the Calibration tab's `CalibrationFirmwarePanel.tsx` show only
"Flash relay firmware" / "Flash robot firmware" — no source, no
version, no freshness.

Second, related defect found the same day: the robot card identity
line (`roleDisplay`, ticket 016) shows the ID reply's library
`version` (e.g. `1.20260912.8`, the pxt-nezha-diffdrive library
version) as "the version." The stakeholder expects the firmware
release version instead — `program` is `calibration-0.20260913.1`,
and the release version (`0.20260913.1`) is what should appear on the
card. The library version should move to a diagnostics fact instead of
being presented as "the" version.

## Acceptance Criteria

- [x] For each release source (robot, relay) in the flash modal and in
      the Calibration tab's flash panel: show the configured source
      URL (rendered as a link to the GitHub release page), the
      resolved release tag, and when it was last checked; if
      unavailable, show the plain reason instead. Data comes from the
      snapshot's firmware availability info — extend the wire type
      with `repo`/`tag`/`checkedAt` if not already present, projecting
      them from the store's `firmware` table.
- [x] Progress and result lines during a flash name what is being
      flashed, e.g. "Flashing nezha-robot-template v0.20260913.1:
      writing…", "Flashed nezha-robot-template v0.20260913.1" (relay
      flashes name `microbit-radio-relay` analogously).
- [x] The local `.hex` file option shows the chosen file name and size
      before flashing (no repo/tag/checked-at, since there is no
      release source for a local file).
- [x] Robot card identity line (`roleDisplay` in
      `packages/ui/src/deviceDisplay.ts`) uses the program's release
      version rather than the library version: for a calibration
      program (`calibration-0.20260913.1`) show `0.20260913.1`; for any
      other program string, show the program string itself unchanged
      (no parsing assumed). The library version (today's
      `device.version`) moves to the Diagnostics tab facts, labeled
      "Library version" — it is no longer shown on the front-page card.
- [x] Unit tests for each of the above (firmware source display in the
      modal and calibration panel for available/unavailable states,
      progress/result line naming, local-file name+size display,
      `roleDisplay`'s program-version parsing for calibration and
      non-calibration strings, Diagnostics tab "Library version" fact).
- [x] Evidence: `npx vitest run packages/ui packages/host`, `npm run
      typecheck`, `npm run build`, `npm run vite:build -w
      @robot-console/ui` green; DOM text of the open flash modal and
      Calibration firmware panel captured from a host running against
      a scratch copy of the state DB (never the stakeholder's live
      `console.sqlite`); nothing is actually flashed to a device during
      verification.
- [x] Reopened same day (team-lead live check, 2026-09-13): the
      Calibration tab's firmware panel itself still read "Calibration
      firmware 1.20260912.8 is running" -- `CalibrationFirmwarePanel.tsx`
      used `device.version` (the library version) for its own "is
      running"/"confirmed" text, the same defect this ticket already
      fixed in `roleDisplay`. The Calibration tab's firmware panel now
      shows the program's release version (via `programVersionText`),
      never the library version, for both the "is running" and
      "confirmed" lines; the confirmed line also names the flashed
      release's own repo+tag when known (e.g. "Calibration firmware
      0.20260914.2 confirmed (nezha-robot-template v0.20260914.2).").
      The front-page calibration badge (`FrontPage.tsx`) had the
      identical defect and is fixed the same way.

## Implementation Plan

**Approach**: extend the firmware wire/projection data first (source
URL, tag, checked-at already live in the store's `firmware` table —
confirm what's already projected onto `SnapshotDevice`/snapshot
firmware info before adding fields), then update the two display
surfaces (`FlashDialog.tsx`/`FlashControls.tsx` and
`CalibrationFirmwarePanel.tsx`) to render it, then update progress/
result copy to name the repo and tag, then fix `roleDisplay` to prefer
the program's release version over the library version and relocate
the library version into the Diagnostics tab.

**Files to modify**:
- `packages/host/src/wsMessages.ts` (or wherever firmware availability
  is typed for the snapshot) — add `repo`/`tag`/`checkedAt` if not
  already present
- `packages/host/src/projection.ts` (or the firmware projection path)
  — project the `firmware` table's `repo`/`tag`/`checked_at` onto the
  snapshot
- `packages/ui/src/components/FlashDialog.tsx` /
  `FlashControls.tsx` — show source URL (linked), tag, checked-at, or
  the unavailable reason; show chosen local-file name+size; name the
  repo/tag in progress and result copy
- `packages/ui/src/components/CalibrationFirmwarePanel.tsx` — same
  source/tag/checked-at display for the calibration flash path
- `packages/ui/src/deviceDisplay.ts` — `roleDisplay`, to derive the
  displayed version from `program` (strip a `calibration-` prefix to
  get the release version; otherwise show `program` as-is) instead of
  `device.version`
- the Diagnostics tab component (wherever device facts are listed) —
  add a "Library version" fact sourced from `device.version`

**Testing plan**: unit tests for the firmware wire/projection fields;
component/DOM tests for the flash modal and calibration panel showing
linked source, tag, checked-at, and the unavailable-reason fallback;
a test for local-file name+size display; tests for progress/result
copy naming repo+tag; `roleDisplay` tests for a calibration program
string, a non-calibration program string, and the existing
full/partial/empty cases from ticket 016 (no regression); a
Diagnostics tab test for the "Library version" fact. Scoped run:
`npx vitest run packages/ui packages/host`. Then `npm run typecheck`,
`npm run build`, `npm run vite:build -w @robot-console/ui`. Evidence:
start a host against a scratch copy of the state DB, open the flash
modal and the Calibration tab's firmware panel in headless Chrome, and
capture DOM text showing source/tag/checked-at; do not initiate an
actual flash to a device.

**Documentation updates**: none beyond this ticket's completion notes.
