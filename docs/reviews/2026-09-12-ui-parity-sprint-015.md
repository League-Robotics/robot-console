# UI parity report — sprint 015 (rearch-07)

Closes out `docs/reviews/2026-09-11/04-ui.md` §1's feature-inventory
checklist against the sprint 015 `Snapshot` rewrite (tickets 007, 008,
009). Written at the end of ticket 009, the sprint's last UI ticket;
rows for §1.1-§1.4 restate tickets 007/008's own dispositions (already
landed and tested) so this one file is the single place to check the
whole checklist against, per this ticket's own Description. §1.5
onward — the Robot page, its tabs, and its panels — is this ticket's
own scope; every row there was touched by this ticket directly.

Legend: **confirmed** = a passing test cites the exact behavior;
**confirmed (bench)** = proven working in ticket 011's hands-on bench
pass, not by an automated test; **dropped** = intentionally not carried
forward, with the reason.

## §1.1 App shell / header

| Feature | Status |
|---|---|
| Single WS connection, auto-reconnect 1.5s, keep last snapshot while reconnecting | confirmed — `ws/WsProvider.test.tsx` ("hasSnapshot / useHostConnection staleness"); ticket 007 |
| Header title + back-to-devices arrow on every non-`/` route | confirmed — `components/AppHeader.test.tsx` ("AppHeader back-to-devices link"); ticket 007 |
| Header actions: Set Radio (robot, named only), Set Wi-Fi (non-relay), Flash (any resolvable link, `forceShow`) | confirmed — `components/AppHeader.test.tsx` ("AppHeader Set Radio", "AppHeader Flash", "AppHeader Set Wi-Fi"); tickets 007/008 |
| **New this ticket**: disconnected-from-host banner (UC-020, `no-disconnected-from-host-banner-in-the-ui.md`) | confirmed — `App.test.tsx` ("App shell: disconnected-from-host banner reaches a mounted RobotPage route"), `components/AppHeader.test.tsx`'s own `disconnectedBannerText` is exercised transitively via the same banner text |
| **New this ticket**: every send-capable control in `RobotPage`'s own subtree (and `DeviceConsole`, shared by every per-device page) disables while the socket is not open or the snapshot is stale | confirmed — `App.test.tsx` ("re-shows the banner and disables RobotPage's send-capable controls when the socket closes", "re-enables controls only once...") |
| **New this ticket**: a send attempted while disconnected reports a host-style console line instead of dropping silently | confirmed — `App.test.tsx` ("a send attempted while disconnected reports a host-style console line instead of dropping silently") |

## §1.2 Front page

Ticket 007's own scope; restated here for one complete checklist.

| Feature | Status |
|---|---|
| Connection banner, empty state, one card per device (host order), unassigned boards as their own cards, "not seen recently" section | confirmed — `pages/FrontPage.test.tsx`; ticket 007 |
| Relay quick-connect (Connect/Switch/Disconnect, name picker) | confirmed — `pages/FrontPage.test.tsx`; ticket 007 |
| Flash trigger on an unassigned board's card | confirmed — restored on `UnassignedCard`; ticket 008 |
| Radio-migration nicety (leftover `localStorage` override offered once) | confirmed — `pages/FrontPage.test.tsx` ("RadioMigrationOffers"); ticket 007 |
| **dropped**: the relay picker's roster/discovered split ("(on the network)" annotation) | ticket 007's own report: retired along with `EndpointsMessage`'s `discoveredServices` list — the new wire contract has no separate discovered-robots side list, `relays[]`/`devices[]` already fold in everything the old split tried to distinguish |
| **dropped**: the no-pick `autoRobot: true` default-failover connect request | ticket 007's own report and `wsMessages.ts`'s own `SessionOpenMessage` doc comment: no replacement in the new wire contract; a name must be picked before Connect enables |
| **dropped**: per-connect channel/group override inputs on the connect bar | ticket 008's own report: retired along with the client-side radio override model (ticket 006's `set-radio-override` replaces it) |

## §1.3 Device page shell

Ticket 008's own scope; restated here.

| Feature | Status |
|---|---|
| Routes on `linkId`; "Looking for this device…" vs "This device isn't connected." vs dispatch; never auto-redirects | confirmed — `pages/DevicePage.test.tsx`; ticket 008 |
| Per-`device.kind` dispatch (no device → Unknown; relay → RelayPage; robot → RobotPage) | confirmed — `pages/DevicePage.test.tsx` ("DevicePage per-type dispatch"); ticket 008 |
| **dropped**: the WiFi auto-`session-open` effect on mount/open→closed | ticket 008's own report: deleted outright, not adapted — the reconciler's `planUserOpen` (ticket 002) owns that decision entirely now; confirmed by `pages/DevicePage.test.tsx` ("DevicePage never sends session-open on its own") |

## §1.4 Relay page

Ticket 008's own scope; restated here.

| Feature | Status |
|---|---|
| Heading, connected/lost/idle/sweeping/bridging states, Connect/Switch/Disconnect | confirmed — `pages/RelayPage.test.tsx`; ticket 008 |
| Connect/Switch sends exactly one `session-open{relayLinkId,name}`, never a client-sequenced close-then-open | confirmed — `pages/RelayPage.test.tsx` ("Connect sends exactly one...", "Switch...sends exactly one session-open, never a session-close first"); ticket 008 |
| `AddressSourceChip` from the connected child's own resolved `radio` field | confirmed — `pages/RelayPage.test.tsx` ("mounts the child's AddressSourceChip..."); ticket 008 |
| RobotPage mounted for the child, unmodified prop contract from RelayPage's own perspective | confirmed — `pages/RelayPage.test.tsx` ("mounts RobotPage for the connected child device"); this ticket updates the mocked stub's prop name (`endpoint` → `device`) to match ticket 009's own `RobotPage` rename, no behavior change |
| **dropped**: `AddressSourceChip`'s failover-trail/registry-considered nuance (`registryWasConsidered`, `failoverTrail`) | ticket 008's own report: the new `RadioSourceWire` (`"override"\|"registry"\|"derived"`) is always already resolved server-side; there is no host-reported equivalent of the old five-outcome model to preserve |

## §1.5 Robot page and its tabs (this ticket's own scope)

| Feature | Status |
|---|---|
| Heading = `device.name`; tabs Main/Drive/Calibration (only `isCalibrationProgram(device.program)`)/Functions & charts/Configuration; falls back to Main if the calibration tab vanishes | confirmed — `pages/RobotPage.test.tsx` ("tabs sit beside the name...", "a calibration robot gets a Calibration tab...") |
| "Program: X · Version: Y" diagnostics when `device.program !== null` | confirmed — `pages/RobotPage.test.tsx` ("RobotPage program/version diagnostics") |
| Main tab: StatusPanel + DriveControls (left), DeviceConsole + CommandStrip (right); exactly one console region | confirmed — `pages/RobotPage.test.tsx` ("the Main tab shows status and drive...", "renders exactly one console and a command strip...") |
| STOP/E-STOP inside DriveControls' own pad, not a page-level sibling | confirmed — `pages/RobotPage.test.tsx` ("renders STOP/E-STOP inside DriveControls' pad...") |
| Drive tab: pad + keyboard (arrows/WASD, space/esc stop) + gamepad left stick, held-key/gamepad readouts | confirmed — `components/DriveTab.test.tsx` |
| Calibration tab: both wizards, code block + Copy, current-calibration table, Start over, DeviceConsole | confirmed — `components/CalibrationPage.test.tsx`, `pages/RobotPage.test.tsx` ("a calibration robot gets a Calibration tab...") |
| Functions & charts tab: FunctionsPanel + DriveControls (left), ChartsPanel + PathTracePanel (right) | confirmed — `pages/RobotPage.test.tsx` ("the Functions & charts tab shows functions and the drive pad...") |
| Configuration tab: calibration table, Wi-Fi, Radio, Save/Write, generated code | confirmed — `components/ConfigurationPage.test.tsx` (ticket 007's own migration, unchanged this ticket) |
| **StatusPanel**: E-STOPPED badge, waiting/no-link text, Clear E-STOP, labelled status table | confirmed — `components/StatusPanel.test.tsx` |
| **StatusPanel dropped**: the closed→open one-shot `STATUS` probe | this ticket's own Description: deleted outright — the harvester (ticket 003) already polls `STATUS` on its own once a session opens; `components/StatusPanel.test.tsx`'s former "asks for STATUS itself on mount..." pinned case is deleted, not adapted |
| **DriveControls**: 3x3 pad (held drive, fixed turns, STOP/E-STOP/Clear E-STOP), all disabled with no session or host connection | confirmed — `components/DriveControls.test.tsx` |
| **SequencingIndicator**: seq/pending/last-done/last-reason or "No session" | confirmed — `components/SequencingIndicator.test.tsx` (ticket 008's own migration, unchanged this ticket) |
| **DeviceConsole**: autoscroll, Clear log, show-polls toggle, host-notice styling, send box with cooldown | confirmed — `components/DeviceConsole.test.tsx` (ticket 008's own migration); this ticket's own addition (gating on `useSendable()` too) confirmed by `App.test.tsx` |
| **CommandStrip**: HELLO/ID/VER/STATUS/FUNCS, GET/SET with `<datalist>` harvested from the link's own log | confirmed — `components/CommandStrip.test.tsx` |
| **CommandStrip dropped**: the closed→open one-shot bare `GET` discovery probe | this ticket's own Description: deleted outright — the harvester never auto-sends `GET` either, so there is no snapshot-side name list to read; discovery now only ever comes from a manual GET/SET already in the log. `components/CommandStrip.test.tsx`'s former "fires a bare GET on mount/on reopen" pinned cases are deleted, not adapted |
| **FunctionsPanel**: Refresh, select + declaration labels, per-signature args, remembered-argument memory (in-memory + `localStorage`) | confirmed — `components/FunctionsPanel.test.tsx` |
| **ChartsPanel**: TLM mode buttons, wheel-speed bars, time-series chart | confirmed — `components/ChartsPanel.test.tsx` (prop renamed `endpointId` → `linkId`, no behavior change) |
| **PathTracePanel**: `ox`/`oy` trail, current pose, heading tick, auto viewBox, Clear | confirmed — `components/PathTracePanel.test.tsx` (prop renamed `endpointId` → `linkId`, no behavior change) |
| **DistanceCalibrationWizard**/**RotationCalibrationWizard**: `calx`/`cala` availability, setup checklist, Go/RUN, progress/stage rendering, apply/fail/run-error terminal states | confirmed — `components/DistanceCalibrationWizard.test.tsx`, `components/RotationCalibrationWizard.test.tsx` |
| **Both wizards dropped**: the closed→open one-shot `FUNCS` probe | this ticket's own Description: deleted outright — same reasoning as CommandStrip's dropped `GET` probe; `FUNCS` is not auto-sent by the harvester either, so availability now only reflects whatever `link.session.functions` the snapshot already reports (populated by a manual FUNCS press elsewhere, e.g. `CommandStrip` or `FunctionsPanel`'s own Refresh). Both wizards' former "fires a one-shot FUNCS probe on mount" pinned cases are deleted, not adapted |
| Transport-blindness (no `UsbSerialLink`/`"usb"` literal/`.transport` read anywhere under `RobotPage`) | confirmed — `pages/RobotPage.transportBlind.test.ts` (source scan over all 11 files, plus render-based relay-radio and wifi transport fixtures) |

## §1.6 Unknown page

| Feature | Status |
|---|---|
| Heading, link-attempt reason, FlashDialog, DeviceConsole | confirmed — `pages/UnknownDevicePage.test.tsx`; tickets 007/008, unchanged this ticket |

## §1.7 Dialogs

| Feature | Status |
|---|---|
| FlashDialog (trigger gating, `forceShow`, reflash warning, resets on link change) | confirmed — `components/FlashDialog.test.tsx`; ticket 008 |
| FlashControls (release/local-hex flash, progress, error, post-flash navigate) | confirmed — `components/FlashControls.test.tsx`; ticket 008 |
| WifiCredentialsDialog (validation, save+write, disabled without session) | confirmed — `components/WifiCredentialsDialog.test.tsx`; ticket 008 |
| RadioAddressDialog (channel/group validation, `set-radio-override` send) | confirmed — `components/RadioAddressDialog.test.tsx`; ticket 006/007 |
| AddressSourceChip (neutral "ch N / grp M" + source text) | confirmed — `components/AddressSourceChip.test.tsx`; ticket 008 |

## Finding #6 from `04-ui.md` §3, resolved by this ticket

> "Host-poll bootstrapping from the UI: `STATUS`, bare `GET`, `FUNCS` are
> each sent on every closed→open transition by four components
> independently... the UI probes are redundant."

All four call sites this finding named (`StatusPanel.tsx`, `CommandStrip.tsx`,
`DistanceCalibrationWizard.tsx`, `RotationCalibrationWizard.tsx`) have their
on-open probe deleted by this ticket, per its own Description and
Acceptance Criteria. Confirmed by `grep -rn "wasOpenRef" packages/ui/src`
returning nothing, and by each component's own test file no longer
carrying a "fires on mount/reopen" pinned case.

## Overall

Every §1 row is either confirmed by a passing test, confirmed by ticket
011's bench pass (none of this ticket's own rows needed that fallback —
all are test-covered), or explicitly recorded above as dropped with a
reason. `npx vitest run packages/ui` — 433/433 passing across 29 files.
`npx tsc --noEmit` — clean for `packages/ui`, `packages/host`, and the
repo-wide `npm run typecheck`.
