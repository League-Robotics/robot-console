---
id: '010'
title: 'Bench fixes: skip gone boards, spawn socket-path robustness'
status: in-progress
use-cases:
- SUC-002
- SUC-004
depends-on:
- '001'
- '002'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench fixes: skip gone boards, spawn socket-path robustness

## Description

Two fixes found while running ticket 009's bench pass against a real
mbregistry v0.20260924.7, both blocking that pass from being re-run
cleanly. Ticket 009 now depends on this ticket so the bench runs on the
fixed build.

**1. `mbregistryWatcher` treats a `disconnected` ("gone") device as
connectable.** mbtools' device `state` field is `attached_unprobed|
connected|attached_no_announce|connected_no_firmware|disconnected` —
`disconnected` is what mbregistry's own CLI renders as `gone`
(`mbtools/src/mbtools/registry/render.py`; UC-002 in mbtools'
`docs/design/usecases.md`: "Listings show the device as gone, not
silently drop it"). `mbregistryWatcher.ts`'s `upsertFromListEntry`
doesn't look at `device.state` at all — a `list` entry with
`state: "disconnected"` and `host: null` (a locally-known but unplugged
device, e.g. the joystick observed on the bench) is treated as `owned`
and identified exactly like a present device, so `identify()` promotes
its link straight to `connectable`. The reconciler then repeatedly
auto-connects it: `link_state "failed"`, `fail_count` climbing past 5,
`state_reason "produced no banner within the identify budget"`, retried
forever. Expected: a `disconnected`/`gone` device's link is left/set
`stale` (not connectable, no auto-connect attempt), exactly like
`handleDetach` already does for a live `detach` event — and it becomes
connectable again the normal way, via a later `attach`/`identity`
event, when replugged. Fix in `upsertFromListEntry` (and/or
`identify`): skip promotion to `connectable` (and skip calling
`store.setOwned`) for any `list` entry whose `state` is `disconnected`;
mark/leave its link `stale` instead, the same call `handleDetach` uses.

Also on the bench: that same JOYSTICK-firmware device was stored with
`devices.kind = "robot"`. `classifyDeviceKind` in `mbregistryWatcher.ts`
collapses `classifyBanner`'s result with `classification.type ===
"relay" ? "relay" : "robot"` — so an `"unknown"` classification (no
`commonName`/`role` match, which is what a joystick's firmware banner
produces) silently becomes `"robot"`. This is the same collapsing
pattern `connector.ts`'s own banner-identify path already uses
(`packages/host/src/connect/connector.ts` around line 944), and
`DeviceKind` (`packages/host/src/store/index.ts`) currently only has
`"robot" | "relay"` — there is no third value to map an unrecognized
device to today. Given that, prefer the narrower fix that doesn't touch
the shared `DeviceKind` type or UI dispatch: when `classifyBanner`
returns `evidence: "unrecognized"` (`type: "unknown"`), treat it the
same way `identify()` already treats an incomplete identification
(missing chip id / device name) — don't upsert a `devices` row or
promote the link at all, leaving it `discovered`/`stale` instead of
mislabeling it `"robot"`. If that turns out to be insufficient (e.g. a
later ticket needs to actually display "unknown device" in the UI for
this transport), adding a real `"unknown"`/`"other"` `DeviceKind` value
is the fallback — flag that as an open question in the PR rather than
doing it here, since it would touch UI dispatch outside this ticket's
scope.

**2. `spawnMbregistry` can silently fail on a too-long socket path.**
`packages/host/src/mbregistry/client.ts`'s `spawnMbregistry` derives the
console-owned socket path from the state dir. When that derived path
exceeds the AF_UNIX limit (104 bytes on macOS, 108 on Linux), the
spawned mbregistry process dies immediately with `OSError: AF_UNIX path
too long`, and the console currently reports only "mbregistry exited
before reporting ready (code 1)" — the child's stderr is read but
discarded, so there's no way to tell what actually happened without
re-running the spawn by hand outside the console. Expected fixes:
- (a) If the derived socket path would be too long, fall back to a
  short, deterministic path under `os.tmpdir()`/`/tmp` keyed by a short
  hash of the state dir (mode `0700` on the containing directory), so
  the same console instance always derives the same fallback path.
  Client resolution step 3 ("previously spawned console-owned socket")
  must also check this fallback location, or a second launch against
  the same state dir won't find the first launch's spawned instance.
- (b) Whenever a spawned mbregistry process exits before reporting
  ready, include the tail of its captured stderr in the thrown/reported
  error, regardless of exit reason — not just for the too-long-path
  case.

## Acceptance Criteria

- [ ] A `list` entry (or a device already known from a prior `list`)
      with `state: "disconnected"` is never promoted to a `connectable`
      link and never triggers `store.setOwned` — its link is `stale`.
- [ ] A device replugged after being `disconnected` still becomes
      `connectable` again normally, via `attach`/`identity`, matching
      existing detach/reattach behavior.
- [ ] A device whose banner classifies as `"unknown"`
      (`evidence: "unrecognized"`) is not stored with `devices.kind =
      "robot"` — either no `devices` row is upserted for it, or (if a
      broader fix is chosen) it is stored with a kind other than
      `"robot"`/`"relay"`.
- [ ] `spawnMbregistry` falls back to a short, deterministic socket path
      under the system temp dir when the state-dir-derived path would
      exceed the AF_UNIX length limit, and that fallback location is
      also checked when resolving a previously-spawned console-owned
      socket.
- [ ] When a spawned mbregistry process exits before reporting ready,
      the error/log includes the tail of its stderr output.
- [ ] No regression in existing `mbregistryWatcher`/`mbregistry/client`
      tests.

## Implementation Plan

- **Approach**: fix both issues in place with unit tests against fakes
  — no real mbregistry process or real AF_UNIX socket needed for either
  fix; ticket 009's bench pass is what confirms the fix on real
  hardware/binary afterward.
- **Files to modify**:
  - `packages/host/src/watchers/mbregistryWatcher.ts` (`upsertFromListEntry`,
    `identify`, `classifyDeviceKind`)
  - `packages/host/src/mbregistry/client.ts` (`spawnMbregistry` and its
    socket-path resolution step)
  - Corresponding test files for both modules.
- **Testing plan**:
  - New watcher test: a `list` entry with `state: "disconnected"` and
    `host: null` does not promote its link to `connectable` and does not
    call `setOwned`; a subsequent `attach`/`identity` for the same `uid`
    does promote it normally.
  - New watcher test: an identity whose fields classify as `"unknown"`
    does not result in `devices.kind === "robot"`.
  - New client test: a fake state dir path long enough to exceed the
    AF_UNIX limit causes `spawnMbregistry` to use the short fallback
    path instead, and a second resolution call against the same state
    dir finds it there.
  - New client test: a fake spawned process that exits before reporting
    ready surfaces its stderr tail in the resulting error.
  - Run the existing `mbregistryWatcher` and `mbregistry/client` test
    files in full to confirm no regression.
- **Documentation updates**: none required beyond this ticket and the
  bench report ticket 009 produces.
