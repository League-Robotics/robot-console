---
id: '004'
title: 'Flash/SWD: platform-aware MSD fallback with settle/poll timing'
status: done
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

- [x] `listVolumeNames(platform)`: darwin enumerates `/Volumes`; linux
      enumerates `/media/<user>`, `/run/media/<user>`, `/mnt`; win32
      enumerates drive letters. All match on `DETAILS.TXT` as today.
- [x] Enumeration failures are logged, not swallowed.
- [x] The MSD path waits 500 ms before starting the copy.
- [x] After `writeFile` completes, the host polls for the volume to
      disappear/reappear (DAPLink remounting) for up to 10 s before
      reporting `resetting` → done; it does not report success
      immediately on `writeFile` returning.
- [x] `listVolumeNames` has unit tests per platform against a fake
      `fs`.
- [x] A completed MSD copy is not reported done until the settle/poll
      sequence finishes (test with a fake `fs` that simulates the
      volume disappearing and reappearing on a delay).
- [x] Existing `flash.test.ts` MSD-path cases still pass.

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

## Implementation notes

- **`flash.ts`**: added `listVolumeNames(platform: NodeJS.Platform,
  deps?: ListVolumeNamesDeps)`, replacing the old darwin-only
  `readdir("/Volumes")` call with a platform branch: darwin lists
  `/Volumes` (unchanged); linux lists `/media/<user>`,
  `/run/media/<user>`, and `/mnt` (`<user>` from `os.userInfo().username`
  unless `deps.username` overrides it), merging `MICROBIT*`-prefixed
  entries from all three, one directory's listing failure not blocking
  the others; win32 probes drive letters `A:` through `Z:` via
  `deps.readdir` (a successful `readdir` on `"<letter>:/"` means the
  drive is present — no name filter, since a drive letter carries no
  name to check, unlike darwin/linux). Every path this function builds
  uses forward slashes (`"D:/"`, not `"D:\\"`) so behavior is
  deterministic under test on any host OS — Node's `fs` accepts `/` as a
  separator on Windows too, so this is not a compromise at real runtime.
  Darwin/linux directory-listing failures are logged via `console.warn`
  and the directory skipped (not fatal to the others); an absent win32
  drive letter is deliberately *not* logged (most of the 26 letters are
  unassigned on any real machine — logging each would be noise, not
  signal, unlike a genuinely missing `/Volumes` or `/media/<user>`).
  `defaultResolveVolumePath` now delegates to
  `listVolumeNames(os.platform())` by default instead of hard-coding
  `/Volumes`; its own `MICROBIT*` name filter moved into
  `listVolumeNames` itself, so `defaultResolveVolumePath` now just reads
  `DETAILS.TXT` for whatever full paths it's handed (the injectable
  `listVolumeNames` option's contract changed from "bare names under an
  implicit `/Volumes`" to "full candidate paths" accordingly — the
  existing `flash.test.ts` `defaultResolveVolumePath` cases were updated
  to pass full paths rather than bare names; their assertions/outcomes
  are otherwise unchanged).
- **`flash.ts`**: the MSD path in `flash()` now (a) awaits a
  `DEFAULT_MSD_SETTLE_MS` (500 ms) delay before `flashViaMsd`'s write
  starts; (b) reports `"resetting"` once the write returns, then calls a
  new internal `waitForVolumeRemount` that polls (bounded by
  `DEFAULT_MSD_REMOUNT_TIMEOUT_MS`, 10 s, at
  `DEFAULT_MSD_REMOUNT_POLL_MS`, 200 ms intervals) for the volume to be
  observed absent and then present again — DAPLink's own remount cycle —
  before `flash()` resolves `{status: "ok", method: "msd"}`. The poll is
  best-effort: never observing the disappear/reappear cycle (or running
  out the 10 s budget) still resolves success rather than failing the
  flash, since the write itself already succeeded and a remount this
  function fails to *observe* is a lost confirmation, not evidence the
  flash failed. All of `msdSettleMs`/`msdRemountTimeoutMs`/
  `msdRemountPollMs`/`delay`/`now`/`volumeExists` are new `FlashOptions`
  fields, overridable per call (defaults apply for every real caller —
  `connect/flasher.ts` and `server.ts` pass no `FlashOptions` overrides
  for these, so production flashes get the real 500 ms settle / 10 s
  poll budget).
- **`connect/flasher.ts`** / **`server.ts`**: unchanged. Both already
  forward `FlashOptions` and the `onProgress` phase callback through
  opaquely; the phase *sequence* itself is unchanged (`"writing"` then
  `"resetting"` then the outcome, same two phases as before this
  ticket) — only the timing around when `"resetting"`/the outcome are
  reported changed, entirely inside `flash()`. `flasher.test.ts` and
  `server.test.ts` were run and pass unmodified (both mock the `flash`
  function entirely at their own boundary, so they never exercise the
  real MSD timing).
- **`flash.test.ts`**: added a `listVolumeNames` describe block covering
  darwin (name-filtered enumeration, logged listing failure), linux
  (merging three directories, `<user>` substitution via the injectable
  override, one directory's failure logged while the others still
  resolve), and win32 (drive-letter probing, and confirming an absent
  drive is *not* logged). Added MSD settle/poll cases to the `flash`
  describe block: settle delay ordering (delay happens before `"writing"`
  before the write itself), success withheld until a fake volume is
  observed to disappear then reappear, `"resetting"` reported before the
  poll resolves and only then the outcome, and a best-effort case where
  the volume is never observed absent yet the flash still reports
  success. All pre-existing MSD-path `flash()`/`defaultResolveVolumePath`
  cases still pass (the latter updated to the full-path
  `listVolumeNames` contract described above); every MSD test that
  doesn't specifically exercise the new timing injects a fast, manually-
  advanced fake clock (`fakeClock()`) so the suite stays fast despite
  the new 500 ms/10 s real-world defaults.
- **Bench verification**: per `sprint.md`'s Open Question 1, this
  ticket's linux and win32 code paths are unit-tested against a fake
  `fs` only — no Linux or Windows bench hardware was available this
  sprint to exercise `listVolumeNames("linux" | "win32", ...)` or the
  settle/poll timing against a real DAPLink remount. macOS (`darwin`)
  behavior is unchanged from before this ticket and was already the one
  platform with real-hardware coverage; a real Linux (and, time
  permitting, Windows) bench run against this code is ticket 010's
  scope, not this one's.
