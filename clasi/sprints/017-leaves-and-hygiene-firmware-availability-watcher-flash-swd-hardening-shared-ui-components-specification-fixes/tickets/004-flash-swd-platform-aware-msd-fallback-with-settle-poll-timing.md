---
id: '004'
title: 'Flash/SWD: platform-aware MSD fallback with settle/poll timing'
status: in-progress
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: rearch-14-flash-swd-timeouts-platform-msd-fallback.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Flash/SWD: platform-aware MSD fallback with settle/poll timing

## Description

MSD fallback (used when an SWD flash fails) only works on macOS today:
`readdir("/Volumes")` is hard-coded, so Linux (`/media/$USER`,
`/run/media/$USER`) and Windows (drive letters) never find a volume
and the SWD error becomes final. Separately, the MSD write starts with
no settle delay after a failed attempt, and success is reported as
soon as `writeFile` returns while DAPLink is still programming. This
ticket makes volume listing platform-aware and adds the settle/poll
timing DAPLink's remount behavior needs. Depends on ticket 003 (same
files, timeout infrastructure lands first).

## Acceptance Criteria

- [ ] `listVolumeNames(platform)`: darwin enumerates `/Volumes`; linux
      enumerates `/media/<user>`, `/run/media/<user>`, `/mnt`; win32
      enumerates drive letters. All match on `DETAILS.TXT` as today.
- [ ] Enumeration failures are logged, not swallowed.
- [ ] The MSD path waits 500 ms before starting the copy.
- [ ] After `writeFile` completes, the host polls for the volume to
      disappear/reappear (DAPLink remounting) for up to 10 s before
      reporting `resetting` → done; it does not report success
      immediately on `writeFile` returning.
- [ ] `listVolumeNames` has unit tests per platform against a fake
      `fs`.
- [ ] A completed MSD copy is not reported done until the settle/poll
      sequence finishes (test with a fake `fs` that simulates the
      volume disappearing and reappearing on a delay).
- [ ] Existing `flash.test.ts` MSD-path cases still pass.

## Implementation Plan

**Approach**: Replace the single `readdir("/Volumes")` call with a
`listVolumeNames(platform: NodeJS.Platform)` function branching on
`os.platform()`, using plain `fs`/`readdir` per candidate directory
(no external process, per the sprint's Design Rationale). Add the
settle delay and remount poll around the existing MSD write path.

**Files to modify**:
- `packages/host/src/flash.ts` — `listVolumeNames`, settle/poll timing
  around the MSD write.
- `packages/host/src/flash.test.ts` — per-platform `listVolumeNames`
  tests, settle/poll timing test.

**Testing plan** (scoped vitest run: `flash.test.ts`):
- `listVolumeNames('darwin')` with a fake `fs` → `/Volumes/MICROBIT*`
  found.
- `listVolumeNames('linux')` with a fake `fs` → `/media/<user>/
  MICROBIT*` and `/run/media/<user>/MICROBIT*` found.
- `listVolumeNames('win32')` with a fake `fs` → drive-letter volumes
  found.
- Enumeration failure (fake `fs` throws) → logged, function returns
  empty rather than throwing.
- MSD write completes → done is not reported until the fake volume's
  disappear/reappear sequence resolves.

**Documentation updates**: None; this is an internal fallback-path
hardening with no wire-contract or architecture-level change. Note in
the ticket's own notes (on completion) whether Linux was verified on
bench hardware per sprint.md's Open Question 1 (Windows has no bench
hardware and is unit-tested only).
