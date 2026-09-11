# robot-console — build health and error history triage

Date: 2026-09-11. Repo: /home/user/robot-console @ HEAD (93 commits). Node v22.22.2, npm 10.9.7, TypeScript 7.0.x, vitest 5.x.
Read-only review; no tracked file modified. Untracked side effects: `node_modules/`, `packages/{protocol,host}/dist/` (both gitignored), and `vendor/*` submodules checked out.
Process note: the CLASI MCP server failed to connect (`clasi` executable not in PATH) and `clasi oop status` could not run; no CLASI process operations were attempted.

Logs in this directory: `npm-install.log`, `tsc-protocol.log`, `tsc-host.log`, `tsc-ui.log`, `vitest.log` (pre-submodule), `vitest-2.log` (post-submodule), `submodule.log`, `git-log-oneline.txt`, `git-log-name-only.txt`, `fix-reliability-commits.txt`, `find-catches.mjs`.

## 1. Build and test health

| Step | Result |
|---|---|
| `npm install` | OK, 224 packages, 5 s, no build scripts failed. `node-hid` and `@serialport/bindings-cpp` load fine (prebuilt binaries; nothing compiled). No proxy/TLS issue. |
| `npx tsc -p packages/protocol --noEmit` | 0 errors |
| `npx tsc -p packages/host --noEmit` | 0 errors (requires `packages/protocol/dist` first: workspace `types` point at `dist/index.d.ts`, so a clean checkout must run `npm run build -w @robot-console/protocol` before host/ui type-check) |
| `npx tsc -p packages/ui --noEmit` | 0 errors (requires protocol + host dist for the same reason) |
| `npx vitest run` (clean checkout) | 58 files: 5 failed / 53 passed. 1073 tests: 2 failed, 1070 passed, 1 skipped. 16 s. |
| `git submodule update --init` then `npx vitest run` | 58 files: 2 failed / 56 passed. 1317 tests: 2 failed, 1314 passed, 1 skipped. |

Distinct failures:

| # | Where | Cause | Class |
|---|---|---|---|
| 1 | `packages/protocol/src/radioAddress.test.ts` (whole file) | `vendor/pxt-nezha-diffdrive/docs/radio-address-vectors.json` missing — submodule not initialized | environment; goes away after `git submodule update --init` |
| 2 | `packages/protocol/src/v6/codec.test.ts`, `v6/session.test.ts` (whole files) | `vendor/radio-robot-lib/tests/protocol/golden_vectors.txt` missing — same | environment; same fix. Adds ~244 tests when present |
| 3 | `packages/host/src/link/UsbSerialLink.test.ts:136` "translates the tty. path to cu. on darwin when connecting" | Expected `/dev/cu.usbmodem…`, got `/dev/tty.usbmodem…`. Production `toCalloutPath(path, platform = process.platform)` (`packages/host/src/devices.ts:173`) is only a no-op off darwin; the test hardcodes the darwin expectation while `UsbSerialLink.connect()` (`UsbSerialLink.ts:258`) calls it with the real platform. | test bug: passes only on macOS |
| 4 | `packages/host/src/link/RelayRadioLink.test.ts` same test name | identical pattern (`RelayRadioLink.ts:261`) | test bug: passes only on macOS |

Skipped: 1 — `packages/host/src/store/knownRobots.test.ts:373` `it.skipIf(isRoot)` (read-only-dir permission test; container runs as root).

Net: type-clean across all three packages; the suite is green on macOS with submodules, red on Linux/CI by exactly 2 platform-coupled tests. No `.skip`/`.todo` markers exist besides the one `skipIf`.

## 2. Test suite shape

| Package | Test files | `it(` cases | Test lines | Src files (non-test) | Src lines | Test:src line ratio |
|---|---|---|---|---|---|---|
| protocol | 8 | 157 | 2,061 | 9 | 2,071 | 1.0 |
| host | 23 | 507 | 12,707 | 26 | 12,703 | 1.0 |
| ui | 27 | 416 | 9,880 | 32 | 8,912 | 1.1 |
| total | 58 | 1,080 | 24,648 | 67 | 23,686 | 1.04 |

(`it(` static count is 1,080; vitest reports 1,317 because the protocol golden-vector files generate cases via `it.each`.)

10 largest test files:

| Lines | Cases | File |
|---|---|---|
| 4,906 | 120 | packages/host/src/deviceRegistry.test.ts |
| 1,246 | 25 | packages/host/src/server.test.ts |
| 1,065 | 44 | packages/ui/src/pages/FrontPage.test.tsx |
| 1,048 | 29 | packages/ui/src/ws/WsProvider.test.tsx |
| 753 | 48 | packages/host/src/flash.test.ts |
| 648 | 26 | packages/ui/src/components/RotationCalibrationWizard.test.tsx |
| 644 | 39 | packages/protocol/src/v6/session.test.ts |
| 608 | 29 | packages/host/src/releases.test.ts |
| 592 | 31 | packages/ui/src/pages/RelayPage.test.tsx |
| 571 | 48 | packages/protocol/src/v6/codec.test.ts |

For scale: `deviceRegistry.ts` is 3,873 lines (66 methods, 23 `catch` sites) and its test is 4,906 lines — 20% of all test code in the repo is pinned to one class.

Time/timer coupling:

| File | `vi.useFakeTimers`/`advanceTimers*`/`setSystemTime` hits |
|---|---|
| ui/components/DriveTab.test.tsx | 12 |
| host/discovery/mdnsDiscovery.test.ts | 9 |
| ui/components/DriveControls.test.tsx | 6 |
| ui/ws/WsProvider.test.tsx | 2 |
| ui/components/DeviceConsole.test.tsx | 2 |
| host/releases.test.ts | 2 |

Injected fake `Scheduler`/clock (a design-level seam, survives a rewrite only if the seam does): RelayConnectionCoordinator, RelayCommandPlane, MbrelayLink, MbserialLink, UsbSerialLink, RelayRadioLink, pacing, deviceRegistry, mbrelayRegistry tests (host); CalibrationPage, FlashControls, RotationCalibrationWizard tests (ui).

Private-internals / shape-faking in tests (rewrite casualties):

| File | Hits | What |
|---|---|---|
| host/deviceRegistry.test.ts | 17 | `vi.mock("./discovery/mdnsDiscovery.js")` (the only module mock in the repo) + `as unknown as MdnsDiscovery & { setSnapshot }` (l.89, 3391, 3420); reads private `(registry as unknown as { states: Map }).states` (l.3088, 3120); asserts private `link.host`/`link.port` (l.4357-4358); 6× hand-rolled `as unknown as KnownRobotsStore` fakes |
| host/discovery/mdnsDiscovery.test.ts | 12 | injected fake bonjour backend + fake timers; asserts exact service-type strings |
| host/server.test.ts | 4 | `as unknown as KnownRobotsStore` / `as unknown as MdnsDiscovery` fixtures |
| ui/components/DriveTab.test.tsx, host/flash.test.ts | 2 each | `as any`/`as unknown as` |
| 7 more files | 1 each | RelayPage, DevicePage, DriveControls, CommandStrip tests (ui); protocol/relay/commands, host/link/LineRouter |

Test-only production surface: `KnownRobotsStore.flush()` and its `now` option exist "purely for test determinism" (`store/knownRobots.ts:60,90`); `WifiCredentialsDialog.tsx:26` exports a validator "for tests"; `FlashDialog.tsx:77` has a test-only `showModal` fallback.

Likely casualties of a device/connection rewrite: `deviceRegistry.test.ts` (entire), `server.test.ts` fixtures, `mdnsDiscovery.test.ts`, all six `link/*.test.ts` that share the `FakeSerialPort`/`Scheduler` harness, `RelayConnectionCoordinator.test.ts`, `mbrelayRegistry.test.ts`, `ui/ws/WsProvider.test.tsx`, `ui/pages/RobotPage.transportBlind.test.ts`. Roughly 9,000 of the 12,700 host test lines.

## 3. Git history

Caveat first: the DAG has **5 root commits** (`d6e2c1b` 09-08, `13e89b2` 09-09, `af4b0f0` 09-10, `4e905f4` 09-10, `62e2516` 09-10), each a 300–350 file snapshot merged in later. Everything built in sprints 001–007 has no per-commit history; sprints 008/009/010/011 each arrive as one snapshot. Attributable history = 83 non-root, non-merge commits over 4 days (2026-09-08..11), single author. Every count below excludes the 5 roots and 5 merges unless stated.

Prefix classification (83 commits): chore 38 (of which 15 are `chore: bump version`, 4 `chore: update .clasi.db`), feat 23, fix 16, docs 5, other 1 ("Add FunctionsPanel and StatusPanel…").
Scope tags: `ui` 16, `host` 6, `<sprint>-<ticket>` 26, `config` 2, `issues` 3, `firmware` 1, none 5.

Area churn (file-touches, `packages/` only): ui/components 99, ui/pages 65, host/src root 40 (deviceRegistry, wsMessages, server, flash…), host/link 15, protocol/v6 8, ui/ws 4, host/store 4, protocol root 2, host/discovery 2, host/relay 0, host/wifi 0 (relay/wifi/coordinator code exists only in the snapshots).

(a) Most-touched files (non-root commits):

| Commits | File |
|---|---|
| 12 | packages/ui/src/pages/RobotPage.tsx |
| 11 | packages/ui/src/pages/RobotPage.test.tsx |
| 11 | packages/host/src/deviceRegistry.ts |
| 11 | packages/host/src/deviceRegistry.test.ts |
| 7 | packages/ui/src/pages/RobotPage.transportBlind.test.ts |
| 7 | packages/ui/src/pages/FrontPage.tsx |
| 7 | packages/ui/src/pages/FrontPage.test.tsx |
| 6 | packages/host/src/wsMessages.ts |
| 5 | packages/ui/src/components/StatusPanel.tsx |
| 4 | packages/ui/src/pages/RobotPage.css |
| 4 | packages/ui/src/pages/RelayPage.tsx |
| 4 | packages/ui/src/pages/FrontPage.css |
| 4 | packages/ui/src/components/StatusPanel.test.tsx |
| 4 | packages/ui/src/components/RotationCalibrationWizard.tsx |
| 4 | packages/ui/src/components/RotationCalibrationWizard.test.tsx |

(Outside packages: `package.json` 22, `config/dotconfig.yaml` 17, `.clasi/.clasi.db` 19 — version bumps and process db.)

(b) Files with most `fix(` commits (16 fix commits total):

| Fix commits | File |
|---|---|
| 7 | packages/host/src/deviceRegistry.ts |
| 7 | packages/host/src/deviceRegistry.test.ts |
| 2 | packages/ui/src/pages/FrontPage.tsx |
| 2 | packages/ui/src/pages/FrontPage.test.tsx |
| 2 | packages/ui/src/components/StatusPanel.tsx |
| 2 | packages/ui/src/components/RotationCalibrationWizard.tsx |
| 2 | packages/ui/src/components/RotationCalibrationWizard.test.tsx |
| 1 | packages/ui/src/pages/RelayPage.tsx |
| 1 | packages/ui/src/pages/RelayPage.test.tsx |
| 1 | packages/ui/src/pages/FrontPage.css |
| 1 | packages/ui/src/pages/DevicePage.tsx |
| 1 | packages/ui/src/pages/DevicePage.test.tsx |
| 1 | packages/ui/src/deviceDisplay.ts |
| 1 | packages/ui/src/deviceDisplay.test.ts |
| 1 | packages/ui/src/components/StatusPanel.test.tsx |

7 of 16 fixes land in `deviceRegistry.ts`; no other host file receives more than 1.

(c) `fix(` commits mentioning connect/link/relay/mdns/wifi/usb/discover/roster/endpoint/presence (chronological, oldest first):

| Hash | Date | Subject |
|---|---|---|
| af4b0f0 | 09-10 | fix(010-004): try WiFi before closing the radio session (snapshot root) |
| 0e15438 | 09-10 | fix(010-005): open the link when a WiFi robot's page is opened |
| 8b5adf1 | 09-10 | fix(host): identify WiFi robots at discovery instead of on first click |
| 3ba2043 | 09-10 | fix(host): retry a dropped or failed WiFi link on a timer, not only on an mDNS change |
| 9250aa1 | 09-10 | fix: one front-page card per robot, and age out WiFi robots that stop announcing |
| 5c69848 | 09-10 | fix(ui): drop the Ready/Moving word from the Status heading; motor rows never claim 'not connected' |
| 680e3d3 | 09-10 | fix: declare a silent WiFi link dead after three unanswered polls; cap gamepad drive sends at the resend cadence |
| 68c8c71 | 09-10 | fix(host): confirm a WiFi credential write by reading the slot back; read WIFI_* from .env directly |
| 43d1bcb | 09-10 | fix(host): accept either wificred reply field order across extension builds |
| 5536aa1 | 09-11 | fix(ui): relay card must require an open child session before saying Connected |

10 of 16 fixes are in this bucket; 7 are WiFi-link lifecycle (when to open, when to declare dead, when to retry, when to age out, how to dedupe cards), all within one day of sprint 010 landing. Related non-fix evidence: sprint 013 exists solely to add `relayBridge` state because "Linked" was being read as "connected to robot" (`21a12b7`, `fa536e0`, `9938804`, `8090c45`), and open issues `wifi-drops-burst-lines-calibration-apply-lost.md`, `background-roster-sweep-over-radio-and-firmware-tcp-slots.md`, `no-disconnected-from-host-banner-in-the-ui.md` (docs commits `c719b09`, `0b8df84`, `871417e`, `4a40c5a`).

Remaining 6 fixes: calibration wizard log parsing (`7d0bd76`, `b9b36dd`), STATUS bit names (`e941dd4`), MOVE_X units (`857cced`), telemetry header recovery (`2df935f`), firmware release source/message (`6612bc9`, `b527df0`).

## 4. Sprint history (clasi/sprints/done, 13 sprints, 1 ticket dir each)

1. **001** Connect/identify/console: monorepo skeleton; `protocol` (naming, radio address, banner, v6 codec/session), `host` USB enumerate + SWD name + `UsbSerialLink` + Express/ws, flat two-tab UI.
2. **002** Flashing: `flash.ts`/`releases.ts`, `KeyedMutex` per-device serialization in `deviceRegistry.ts`; fan-out of deviceRegistry already flagged and accepted.
3. **003** Hardware bring-up: first bench verification; `toCalloutPath` tty→cu moved into `devices.ts`.
4. **004** Device model (**rework #1**): replaces flat device list with endpoint/session/resource-key model in `deviceRegistry.ts`; `Link` split into `connect()`/`identify()`; `DeviceListEntry`→`EndpointListEntry`; react-router two-level UI.
5. **005** Persistence: `store/knownRobots.ts` roster, first on-disk state, feeds later relay dropdown/mDNS gating.
6. **006** Robot page drive/control over USB only, deliberately transport-blind.
7. **007** Relay transports (**rework #2, split at planning**): `RelayCommandPlane`, `RelayRadioLink`, `MbrelayLink`, `MbserialLink`, `LinkSpec` variants, `EndpointTransport` widened — built against fakes, no consumer.
8. **008** Relay discovery/registry/connection (**rework #2b**): `discovery/mdnsDiscovery.ts`, `mbrelayRegistry.ts`, `relay/RelayConnectionCoordinator.ts` (candidate failover), `-via-<relay>` child endpoints synthesized inside deviceRegistry.
9. **009** Telemetry: `v6/telemetry.ts`, per-endpoint ring buffers, charts/trace (USB-only dependency).
10. **010** WiFi robots (**rework #3**): mDNS `_robotlink._tcp/_udp`, `wifi/wifiRobotGate.ts`, `wifi-<name>` endpoint synthesis + radio→WiFi auto-switch inside deviceRegistry; followed by the 7-fix WiFi lifecycle burst in §3(c).
11. **011** Calibration wizards; **012** (executed after 007) device-page usability/flash controls/navigation.
12. **013** Relay bridging state (**rework #4, presentation**): `relayBridge` field on `EndpointListEntry`, set/cleared across `openRobotViaRelay` reset/boot/handshake; retires RelayPage console-log-scanning `autoConnecting`.
13. Pattern: every transport (USB→relay→mbrelay/mbserial→WiFi→relay-bridge state) was absorbed into `deviceRegistry.ts` rather than a new layer; it grew to 3,873 lines / 66 methods and owns endpoint synthesis, session lifecycle, failover, WiFi retry/poll timers, flash, wificred, and status polling.
14. Post-arc work (09-10..11) is out-of-process UI feature commits (tabs, Drive tab, Configuration tab, Set Wi-Fi/Radio) plus the fix burst; the roadmap issue was closed at `e483d0b`.

## 5. Markers and swallowed errors (packages/*/src, non-test)

`TODO`/`FIXME`/`HACK`/`XXX`: **none** in source.
Literal `catch {}` / `catch (e) {}` on one line: **none**. Multi-line catches whose body is empty, comment-only, or a bare `return`/`continue` (scanned by `find-catches.mjs`, brace-matched):

| Location | Body | Note |
|---|---|---|
| packages/host/src/flash.ts:399 | comment only | best-effort `removeListener` cleanup |
| packages/host/src/flash.ts:404 | comment only | best-effort `daplink.disconnect()` |
| packages/host/src/flash.ts:476 | comment only ("Swallowed intentionally") | `daplink.disconnect()` |
| packages/host/src/flash.ts:631 | `return undefined` | `listVolumeNames()` failure → no MSD fallback, no log |
| packages/host/src/flash.ts:641 | `continue` | unreadable DETAILS.TXT skipped silently |
| packages/host/src/mbrelayRegistry.ts:250 | `return undefined` | fetch/timeout failure collapsed to "unknown" outcome |
| packages/host/src/mbrelayRegistry.ts:261 | `return undefined` | JSON parse failure collapsed identically |
| packages/host/src/deviceRegistry.ts:594 | `return undefined` | `nameToRadioAddress` throw → no radio address |
| packages/host/src/releases.ts:164 | `return undefined` | bad repo URL |
| packages/host/src/store/wifiCredentials.ts:123 | comment only | unreadable/malformed store treated as absent |
| packages/host/src/swdName.ts:166 | comment only | best-effort `processor.disconnect()` |
| packages/ui/src/ws/WsProvider.tsx:943 | `return` | unparseable WS frame dropped silently |
| packages/ui/src/pages/RelayPage.tsx:156 | `return null` | localStorage read |
| packages/ui/src/pages/RelayPage.tsx:167 | comment only | localStorage write |
| packages/ui/src/components/CalibrationPage.tsx:137 | `return {}` | localStorage read |
| packages/ui/src/components/CalibrationPage.tsx:145 | comment only | localStorage write |
| packages/ui/src/components/CalibrationPage.tsx:221 | comment only | clipboard |
| packages/ui/src/components/FunctionsPanel.tsx:172 | comment only | localStorage write |
| packages/ui/src/components/ConfigurationPage.tsx:185 | comment only | clipboard |

Catches that convert to a result value without logging (not swallowed, listed for completeness): flash.ts:455/461/468 (`{ok:false,error}`), config.ts:139, deviceRegistry.ts:2564 (wificred wait → `{ok:false,message}`), deviceRegistry.ts:2827 (`failFlash`), releases.ts:256/272/329/339/349/356, ui FunctionsPanel.tsx:162, ui DriveTab.tsx:237 (`pad = null`).

Catch-site density: deviceRegistry.ts 23, flash.ts 14, releases.ts 7, server.ts 4; all other files ≤3.
