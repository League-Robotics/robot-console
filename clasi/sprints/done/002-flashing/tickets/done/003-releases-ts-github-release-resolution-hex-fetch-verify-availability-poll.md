---
id: '003'
title: 'releases.ts: GitHub release resolution, hex fetch/verify, availability poll'
status: done
use-cases: []
depends-on:
- '001'
- '002'
github-issue: ''
issue: flash-firmware-buttons-for-unresponsive-boards.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# releases.ts: GitHub release resolution, hex fetch/verify, availability poll

## Description

Implement `packages/host/src/releases.ts` (`specification.md` §4.6):
resolve a `FirmwareSource` (from ticket 002's `config.ts`) to a
GitHub release, fetch and sha256-verify its `MICROBIT.hex` +
`MICROBIT.hex.txt` manifest, and expose a boolean availability check
plus a small periodic poller the robot-firmware button's disabled
state depends on. All GitHub HTTP calls live in this module and this
module alone — per `specification.md` §2.1, the browser cannot reach
GitHub release assets (no CORS), so this is a hard boundary, not a
convenience. See `sprint.md`'s Architecture, Step 5, "`releases.ts`"
bullet for the exact function shapes.

This ticket does not touch `flash.ts`, `deviceRegistry.ts`, or the UI —
it produces a verified hex `Buffer` and an availability signal that
ticket 005 later wires in.

## Acceptance Criteria

- [x] `resolveRelease(source, options?): Promise<ResolvedRelease |
      ReleaseError>` uses `GET /repos/{owner}/{repo}/releases/latest`
      when `tag === "latest"` and `GET /repos/{owner}/{repo}/releases/
      tags/{tag}` otherwise; a 404 from either yields
      `{ reason: "no-releases" }` or `{ reason: "tag-not-found" }`
      respectively (distinguish the two cases in the returned reason).
- [x] Against a mocked fetch fixture shaped like the real
      `microbit-radio-relay` release (`v0.20260831.1`,
      `MICROBIT.hex` 717576 bytes + `MICROBIT.hex.txt`),
      `resolveRelease` succeeds and identifies both asset download URLs.
- [x] Against a mocked fetch fixture shaped like the real, verified
      zero-release `pxt-nezha-diffdrive` state, `resolveRelease` (and
      therefore `checkAvailability`) reports unavailable, using this as
      the test fixture per the sprint's Success Criteria.
- [x] `fetchAndVerifyHex(resolved, options?): Promise<{ hex: Buffer } |
      { error: string }>` downloads both assets and computes sha256 of
      the hex bytes; a manifest whose sha256 does not match the
      downloaded bytes yields an `{ error }` result, and the hex is
      never returned as if it were valid.
- [x] The manifest's sha256 line is matched leniently (case-insensitive
      `sha256` key, regex-extracted 64-hex-char value) rather than
      hardcoded to one exact key string/casing — see `sprint.md`'s Step
      7 open question on manifest format.
- [x] `checkAvailability(source, options?): Promise<boolean>` is
      `resolveRelease` narrowed to a boolean.
- [x] `FirmwareAvailabilityCache` (constructor takes the configured
      `FirmwareConfigMap`, an injectable interval, and an injectable
      `checkAvailability`): exposes `current(): Record<FirmwareKind,
      FirmwareAvailability>`, `onChange(listener)`, `start()`/`stop()`,
      and a directly-callable `pollOnce()` for deterministic tests
      (mirrors `devices.ts`'s `DeviceWatcher` shape exactly, including
      not letting its timer keep the process alive).
- [x] All fetch calls go through an injectable `fetch` function
      (default: global `fetch`); no test in this ticket makes a real
      network call.
- [x] Every exported async function resolves rather than throws for
      every network/parse failure mode it defines (matches this
      codebase's existing "failure is a value" convention from
      `swdName.ts`).

## Implementation Plan

**Approach**: Three layers in one file: (1) pure/thin GitHub API
wrappers (`resolveRelease`), (2) fetch+verify (`fetchAndVerifyHex`,
`checkAvailability`), (3) the `FirmwareAvailabilityCache` poller class,
built the same way `devices.ts` layers pure functions under a
`DeviceWatcher`-shaped live class.

**Files to create**:
- `packages/host/src/releases.ts`
- `packages/host/src/releases.test.ts`

**Testing plan**: Mock `fetch` with fixtures for: a real-shaped
successful relay release; the real zero-release robot-firmware repo
response; a tag-not-found (non-latest tag, repo has other releases); a
sha256 mismatch; a network-error/rejected fetch. Drive
`FirmwareAvailabilityCache.pollOnce()` directly in tests rather than
relying on real timers, per the existing `DeviceWatcher.pollOnce()`
testing pattern in `devices.test.ts`.

**Documentation updates**: Module doc comment covering the
server-side-only fetch boundary (cite `specification.md` §2.1 the way
`swdName.ts` cites §2.2), and why availability is polled rather than
checked only on click (cite `sprint.md`'s Design Rationale).
