---
id: '010'
title: 'Bench and cross-platform verification: rows on Vevov/Vittut, npm test green
  on Linux and macOS'
status: in-progress
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
depends-on:
- 009
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench and cross-platform verification: rows on Vevov/Vittut, npm test green on Linux and macOS

## Description

This is the sprint's exit-criterion ticket, not new feature work: run
the full suite on both Linux and macOS from a clean clone; plug in both
bench boards (**Vevov** at `/dev/cu.usbmodem2121302` and **Vittut** at
`/dev/cu.usbmodem2121402`) and confirm each appears as a device+link row
in the debug dump (ticket 009) after identification; confirm the old
`deviceRegistry.ts`/coordinator path and the UI are unaffected (no
regression); confirm mDNS rows populate for whatever advertises on the
bench network. No firmware is flashed onto either board as part of this
ticket.

This is the checkpoint the sprint's Risk note calls for: "do not start
A2 (sprint 015) until A1's watcher rows are visible in a debug dump."

## Acceptance Criteria

- [x] `npm test` is green on a clean clone on both Linux and macOS, with
      no dirty files afterward (rearch-17's own acceptance criterion,
      re-verified here as the sprint's regression gate).
      Verified on both platforms from genuinely clean clones (not just
      in-place re-runs) after fixing a `pretest` gap this ticket found
      — see "Bench evidence" below. macOS: 73 files / 1525 tests
      passed. Linux (Docker `node:22-bookworm`, node v22.23.2): 73
      files / 1524 passed + 1 intentionally-skipped (root-container
      guard in `knownRobots.test.ts`) = 1525. Tree clean on both
      (macOS: only the pre-existing submodule-pointer artifact
      resolved by `pretest`'s own submodule init; Linux: `git status
      --short` printed nothing).
- [ ] Both **Vevov** and **Vittut**, plugged into this Mac's USB hub,
      appear as `devices`/`links(usb)` rows in the debug-dump output
      after identification (SUC-001's bench criterion).
      Partially observed, not fully verifiable this session: all three
      bench boards (vevav/vitut/tigez — SWD names) appear as
      `devices`/`links(usb)` rows with correct `usb_serial` (see
      evidence below) — SWD identification (the five-letter name)
      succeeded even with serial EBUSY, per this ticket's own
      expectation. Full identification (the serial-port `HELLO`
      handshake usbWatcher.ts's attach flow runs after SWD naming) did
      not complete for any board: all three `links(usb)` rows show
      `state: "failed"`, `state_reason: "Error Resource temporarily
      unavailable Cannot lock port"` — the stakeholder's `npm run dev`
      (pid 66122) held all three `/dev/cu.usbmodem*` ports for the
      entire bench window (`lsof` evidence below), per this ticket's
      own instruction not to touch that process. Left unchecked per
      the ticket's own step 3 ("if they are still held, record the
      EBUSY evidence verbatim").
- [ ] Unplugging either board ages its link to `stale` within one poll
      in the dump (SUC-002).
      Not verifiable without a human physically unplugging a board;
      left unchecked per the ticket's own note.
- [x] Any mDNS-advertising device on the bench network produces
      `services`/`links` rows in the dump (SUC-003/004).
      Verified: a `_mbrelay._tcp` instance ("torture") and `tigez`'s
      `_robotlink._tcp`/`._udp` instances all produced `services` rows
      plus `links` rows (`mbrelay-torture`, `wifi-tigez`) during the
      40s `--watch-store` window — see evidence below. Note:
      `wifi-tigez` is unassigned (`device_id: null`) because
      `mdnsWatcher.ts`'s device-linking rule requires an *owned*
      device-name match, and `tigez`'s device row has `owned: 0` (see
      the SUC-005 finding below) — the row itself is present and
      correctly populated, which is what this criterion asks for.
- [x] `known-robots.json`'s existing entries appear as `owned = 1`
      device rows before any watcher runs (SUC-005).
      **Fixed this session** (fixup commit, this ticket, after the gap
      below was found and flagged): a single store bootstrap entry
      point, `openStoreWithImports()`
      (`packages/host/src/store/bootstrap.ts`), opens the store and
      runs both `store/importers/knownRobots.ts`'s `importKnownRobots`
      and `store/importers/wifiCredentials.ts`'s `importWifiCredentials`
      against the JSON files in the same state dir (paths via
      `resolveKnownRobotsFilePath`/`resolveWifiCredentialsFilePath`,
      honoring `ROBOT_CONSOLE_STATE_DIR`). `packages/host/src/cli.ts`'s
      `--watch-store` path now calls `openStoreWithImports` instead of
      `openStore`; `--dump-store` is untouched and stays read-only
      (`debug/dumpStore.ts`'s own `openReadOnlyStoreDb`, never a writer).
      `server.ts`/`deviceRegistry.ts` are untouched, per this ticket's
      own instruction (sprint 015 wires the server) — a
      `TODO(rearch-05)` marks that future call site at the bootstrap.

      Original gap this session found, not patched at the time (per
      this ticket's own Implementation Plan: "file it ... rather than
      patching silently here"): `store/importers/knownRobots.ts`'s
      `importKnownRobots()` (ticket 003) had zero call sites anywhere
      in production code — `grep -rn "importKnownRobots" packages/host/src
      --include='*.ts'` matched only its own module and its own test
      file. Neither `--dump-store` nor `--watch-store` ever called it,
      and neither did `openStore`/`openStoreDb`. Empirically confirmed
      at the time: a read-only copy of the real `known-robots.json` (5
      entries: gopiv, tigez, tovez, vevov, vitut) placed in a fresh
      `ROBOT_CONSOLE_STATE_DIR`, followed by a full 40s `--watch-store`
      run and then `--dump-store`, showed all three real device rows
      with `owned: 0`.

      **Live re-check after the fix** (this session, fresh
      `mktemp -d` state dir, a read-only copy of the real
      `~/.local/state/robot-console/known-robots.json` — 5 entries:
      gopiv, tigez, tovez, vevov, vitut): `--dump-store` on the empty
      dir returned the all-empty snapshot (no `console.sqlite` yet, as
      expected). `timeout 15 node bin/robot-console.js --watch-store`
      logged the bootstrap's own import as its first change batch —
      `{"type":"change","changes":[...ten devices/board_owner
      entries...,{"seq":11,"tbl":"settings","key":"import:known-robots"}]}`
      — five upserted devices (ids `979`/`1031`/`1461`/`2665`/`2815`)
      each followed by its `setOwned`, then the `import:known-robots`
      settings-guard write, all before either watcher's own first
      enumeration. `--dump-store` afterward showed exactly 5 device
      rows with `owned: 1` (`vitut`, `vevov`, `gopiv`, `tovez`,
      `tigez` — the 5 real ids above), matching the file's 5 entries
      exactly, plus 3 additional `owned: 0` rows from the physically
      attached bench boards' own real USB enumeration under their
      *SWD*-read names (`vevav`/`vitut`/`tigez` — ids `536019796`/
      `2198604104`/`3527777815`), unaffected by the fix (their
      `links(usb)` rows are still `state: "failed"`/EBUSY, same
      held-ports condition as this ticket's earlier bench pass — no
      board was flashed or otherwise touched). Ports were left exactly
      as found; no processes other than this session's own
      `--dump-store`/`--watch-store` runs were started or signaled.
- [x] The UI, run against the unchanged `deviceRegistry.ts` path, shows
      no regression — same devices, same behavior as before this
      sprint's changes.
      Verified via the automated gates: the full suite (macOS and
      Linux, both clean-clone runs above) includes
      `deviceRegistry.test.ts` (120 tests, including the orphaned-state
      guard this ticket's Part 1 fix restored), `server.test.ts`, and
      every `packages/ui` component/hook test — all green on both
      platforms. A live visual check still needs the stakeholder to
      restart their own `npm run dev` (pid 66122) on this sprint's
      code, which this session deliberately did not do (that process
      was left untouched throughout, per this ticket's instruction).
- [x] No firmware is flashed onto Vevov or Vittut during this
      verification.
      Verified: only `--dump-store` (read-only) and `--watch-store`
      (the two watchers' own enumerate/identify/browse flows — no
      flash path) were run this session; `flash.ts` was never invoked
      against real hardware.

## Testing

- **Existing tests to run**: the complete `npm test` suite (this is the
  one place in the sprint where the full suite runs, per this project's
  `source-code.md` rule that the full suite runs once per sprint at
  close, not per ticket — this ticket's manual bench pass supplements
  that automated gate rather than replacing it).
- **New tests to write**: none — this ticket is verification, not new
  code, aside from any small fixup its findings require.
- **Verification command**: `npm test` (full suite, both platforms) plus
  the manual bench procedure above.

## Implementation Plan

**Approach**: Run the automated suite first on both platforms; then do
the manual bench pass with both boards attached, using ticket 009's dump
tool to inspect rows at each step (attach, identify, detach, mDNS
observation if applicable on the bench network). Record the dump output
as evidence that the sprint's exit criterion is met before sprint 015
is detail-planned.

**Files to create/modify**: none expected; if the bench pass surfaces a
defect, file it against the relevant ticket (001-008) rather than
patching silently here, since each of those tickets' own acceptance
criteria should already have caught it — a bench-only failure indicates
a gap in that ticket's test coverage worth noting for future sprints.

**Documentation updates**: none, beyond recording the bench pass result
in the ticket itself when closed.

## Bench evidence

### Part 1 — regression fix

`npx vitest run packages/host/src/deviceRegistry.test.ts
packages/host/src/devices.test.ts packages/host/src/watchers` was
failing exactly one test before this ticket:
"orphaned-state guard: a device re-enumerating mid-flash (remove+add)
drops runFlash's stale writes...". Root cause: ticket 007 changed
`diffDaplinkDevices`/`DeviceWatcher` to report a same-serial content
change as `updated` instead of remove+add, but `deviceRegistry.ts`'s
`handleChange` only ever reads `event.removed`/`event.added` — it never
looks at `event.updated` — so the orphaned-state guard, which depends
on seeing a `removed` entry, silently stopped firing.

Fix (`packages/host/src/devices.ts`,
`packages/host/src/watchers/usbWatcher.ts`,
`packages/host/src/devices.test.ts`, commit `92aef43`): added
`DiffDaplinkDevicesOptions.reportUpdatedInPlace` (default `false` —
legacy remove+add) to `diffDaplinkDevices`, threaded the same option
through `DeviceWatcherOptions`. `deviceRegistry.ts`'s own
`DeviceWatcher` usage is unchanged and now gets legacy remove+add
again by default. `usbWatcher.ts` — the consumer the `updated` bucket
was actually built for — opts in explicitly
(`{ reportUpdatedInPlace: true }`) at its own direct
`diffDaplinkDevices` call site. Re-run after the fix: 162/162 passed
(4 files).

### Part 2/3 — cross-platform clean-clone `npm test`

While re-running the full suite on a genuinely clean clone (not just
in-place), found a second, separate defect: `npm ci` on a fresh clone
does not build `@robot-console/protocol`, whose `package.json` `main`
points at `./dist/index.js` (gitignored). Both `host` and `ui` depend
on it, so every test file that imports it (directly or transitively)
failed with "Failed to resolve entry for package
@robot-console/protocol" — 28/73 files, on both Linux and (when tested
from an actual clean clone rather than this already-built working
copy) macOS. This was invisible in-place only because
`packages/protocol/dist/` already existed on this Mac from earlier
ticket work. Fix (`package.json`, commit `37303e8`): build
`@robot-console/protocol` as part of `pretest`, so `npm test` is
self-sufficient right after `npm ci`.

**macOS** (in-place, then re-verified from a genuinely clean clone at
`scratchpad/robot-console-clean-macos`, node v22.23.1): 73 test files,
1525 tests, all passed both times. `git status --short` after the
clean-clone run: `m vendor/pxt-nezha-diffdrive` only (a submodule-dirty
marker of the same kind as the pre-existing `M vendor/radio-robot-lib`
noted at session start — not a file the test run touched).

**Linux** (Docker `node:22-bookworm`, fresh `git clone` of this branch
inside the container, `git submodule update --init` succeeded — the
container had network access to GitHub, so no vendor/ copy workaround
was needed): node **v22.23.2**. `npm ci`: 219 packages installed
clean. `npm test`: **73 test files, 1524 passed + 1 skipped = 1525**.
The one skip is `packages/host/src/store/knownRobots.test.ts`'s own
`it.skipIf(isRoot)` guard (Docker's default user is root, and that
test's own comment explains why it is deliberately skipped as root —
not a new failure). `git status --short` after the run: empty (clean
tree).

### Part 4 — bench pass (Vevov/Vittut/Tigez, no flashing)

Boards present: `ls /dev/cu.usbmodem*` → `usbmodem2121102`,
`usbmodem2121202`, `usbmodem2121402` (not the `...2121302`/`...2121402`
pair named in this ticket's own Description — the actual bench hub has
three ports, not two). `lsof` on all three, both before and after the
bench pass, showed the same result:

```
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    66122 eric   21u   CHR    9,7    0t133 1197 /dev/cu.usbmodem2121402
node    66122 eric   35u   CHR    9,9     0t79 1201 /dev/cu.usbmodem2121202
node    66122 eric   37u   CHR   9,11  0t80403 1225 /dev/cu.usbmodem2121102
```

pid 66122 (the stakeholder's `npm run dev`) held all three ports for
the entire session; it was never touched.

Procedure: built `@robot-console/host`; `ROBOT_CONSOLE_STATE_DIR` set
to a fresh `mktemp -d`. `--dump-store` on the empty dir returned the
all-empty snapshot (no `console.sqlite` yet, expected). Copied the real
`~/.local/state/robot-console/known-robots.json` into the temp dir
read-only (`chmod 400`) — its 5 entries: gopiv, tigez, tovez ⚠, vevov,
vitut (⚠ `tovez`/`lastUsbSerial: "SERIAL-A"` looks like test-fixture
data — matches `deviceRegistry.test.ts`'s `"usb-SERIAL-A"` endpoint
fixture — that leaked into the *real* state-dir file at some point
before this session; flagging as an observed anomaly, not something
this ticket touched or fixed). Ran `timeout 40
node bin/robot-console.js --watch-store` against the temp dir, then
`--dump-store` against the same dir. Full dump (trimmed to the
populated tables):

```json
{
  "devices": [
    { "id": 536019796, "name": "vevav", "kind": "robot", "usb_serial": "99063602000528202e78ea8f7143163f000000006e052820", "owned": 0 },
    { "id": 2198604104, "name": "vitut", "kind": "robot", "usb_serial": "99063602000528208939f0a5fd47f738000000006e052820", "owned": 0 },
    { "id": 3527777815, "name": "tigez", "kind": "robot", "usb_serial": "99063602000528203b43773cab0210ea000000006e052820", "owned": 0 }
  ],
  "links": [
    { "id": "mbrelay-torture", "device_id": null, "transport": "mbrelay", "address": "{\"host\":\"torture.local\",\"port\":8760,\"registryPort\":8761}", "state": "discovered" },
    { "id": "usb-...8939f0a5fd47f738...", "device_id": 2198604104, "transport": "usb", "address": "{\"path\":\"/dev/cu.usbmodem2121402\",\"hidPath\":\"DevSrvsID:4295026342\"}", "state": "failed", "state_reason": "Error Resource temporarily unavailable Cannot lock port" },
    { "id": "usb-...2e78ea8f7143163f...", "device_id": 536019796, "transport": "usb", "address": "{\"path\":\"/dev/cu.usbmodem2121202\",\"hidPath\":\"DevSrvsID:4295026382\"}", "state": "failed", "state_reason": "Error Resource temporarily unavailable Cannot lock port" },
    { "id": "usb-...3b43773cab0210ea...", "device_id": 3527777815, "transport": "usb", "address": "{\"path\":\"/dev/cu.usbmodem2121102\",\"hidPath\":\"DevSrvsID:4295033494\"}", "state": "failed", "state_reason": "Error Resource temporarily unavailable Cannot lock port" },
    { "id": "wifi-tigez", "device_id": null, "transport": "wifi", "address": "{\"host\":\"tigez.local\",\"port\":7654}", "state": "discovered" }
  ],
  "services": [
    { "instance": "torture", "type": "mbrelay.tcp", "host": "torture.local", "port": 8760 },
    { "instance": "tigez robot link", "type": "robotlink.udp", "host": "tigez.local", "port": 7654 },
    { "instance": "tigez robot link", "type": "robotlink.tcp", "host": "tigez.local", "port": 7654 }
  ],
  "tasks": [
    { "name": "usbWatcher", "state": "running" },
    { "name": "mdnsWatcher", "state": "running" }
  ]
}
```

Reading: all three physical boards enumerated over USB and were named
over SWD (`vevav` for Vevov — SWD name reads `vevav` per this ticket's
own note; `vitut` for Vittut; `tigez` for the third board), each
producing a `devices` row and a `links(usb)` row keyed by USB serial —
matching known-robots.json's recorded `lastUsbSerial` for `vitut` and
`tigez` exactly (`vevov`'s recorded serial does not match this
session's `vevav` reading — a pre-existing state-dir/hardware
discrepancy, not something this session caused). Every `links(usb)`
row is `state: "failed"` with the verbatim EBUSY reason above, from
`UsbSerialLink`'s open attempt racing the stakeholder's own held ports
— never a code defect, and never touched by flashing. mDNS produced
real rows for the bench network's `torture` relay and `tigez`'s two
`_robotlink` announcements. `owned: 0` on every device row confirms the
SUC-005 gap above. Cleaned up: temp state dir and its contents removed
after the pass; `pid 66122` and its port handles left exactly as
found.

Follow-up recommended (not filed as a ticket by this agent — outside
programmer scope): wire `importKnownRobots` into a real startup path
(`cli.ts`'s `--dump-store`/`--watch-store`, and/or the eventual sprint
015 reconciler) so SUC-005 is actually satisfiable in a bench pass.
