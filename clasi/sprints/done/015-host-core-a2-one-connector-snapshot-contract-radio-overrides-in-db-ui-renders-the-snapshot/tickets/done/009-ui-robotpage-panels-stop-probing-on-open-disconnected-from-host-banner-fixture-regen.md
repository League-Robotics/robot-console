---
id: 009
title: 'UI: RobotPage panels stop probing on open, disconnected-from-host banner,
  fixture regen'
status: done
use-cases:
- SUC-004
- SUC-008
- SUC-010
depends-on:
- 008
github-issue: ''
issue: rearch-07-ui-renders-snapshot-drops-client-policy.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: RobotPage panels stop probing on open, disconnected-from-host banner, fixture regen

## Description

Third and final UI ticket; completes rearch-07 and, with it, this
sprint's parity gate.

- `StatusPanel`, `CommandStrip`, `DistanceCalibrationWizard`,
  `RotationCalibrationWizard`: remove the on-open
  `STATUS`/`GET`/`FUNCS` probe each currently sends on closed→open,
  since the harvester (ticket 003) now probes on identify and polls
  `STATUS`. Read `session.functions`/`session.robotStatus` from the
  link in the snapshot rather than deriving them from local state built
  up by these probes. `RobotPage.tsx` and its other tabs (Drive,
  Calibration code/table, Functions & charts, Configuration minus the
  Radio panel already done in ticket 006) are otherwise unchanged —
  `RobotPage.transportBlind.test.ts` stays as-is.
- `AppHeader`/`App.tsx`: render the disconnected-from-host banner from
  `useConnectionStatus()` (ticket 007's `WsProvider` seq/staleness
  tracking); disable every send-capable control while the socket is not
  open or the held snapshot is stale; `send()` reports a host-style
  console line instead of dropping silently. This resolves
  `no-disconnected-from-host-banner-in-the-ui.md` (UC-020) as part of
  this ticket.
- Regenerate any remaining `FakeSocket` fixtures not already covered by
  ticket 007; delete the last of the pinned "sends X on closed→open"
  test cases (`StatusPanel`, `CommandStrip`, both wizards).
- Produce the `04-ui.md` §1 parity report: every row either has a
  passing test (cite it) or was confirmed present in the sprint 011
  bench pass — call out explicitly, in the PR description, any row this
  sprint could not preserve and why.

## Acceptance Criteria

- [x] `StatusPanel`, `CommandStrip`, `DistanceCalibrationWizard`,
      `RotationCalibrationWizard` no longer send `STATUS`/`GET`/`FUNCS`
      on closed→open; the pinned tests for that behavior are deleted,
      not adapted. (`grep -rn "wasOpenRef" packages/ui/src` returns
      nothing; each component's own test file no longer carries a
      "fires on mount/reopen" case.)
- [x] FakeSocket close → banner shown, every send-capable control
      disabled, a send attempt produces a console line (not a silent
      drop). (`App.test.tsx`; `AppHeader.tsx`'s `disconnectedBannerText`;
      `WsProvider.tsx`'s `send()` no-silent-drop change.)
- [x] FakeSocket open + fresh snapshot (higher `seq`) → banner gone,
      controls re-enable only for links the snapshot says are
      `connected`. (`App.test.tsx`'s "re-enables controls only once the
      socket has actually reconnected and a fresh snapshot confirms the
      link is still connected" — gated on `link.session !== undefined`,
      the same "is this link open" signal tickets 007/008 already
      established for `ConfigurationPage`/`DeviceConsole`, multiplied by
      the new `useSendable()` host-connection gate.)
- [x] `grep -rn "localStorage" packages/ui/src` shows only calibration
      state, function args, and console preferences — no radio
      addresses, no connection state (radio addresses already cleared by
      ticket 006; this ticket's grep confirms no new violations were
      introduced). (Verified — see the Parity report's "Overall"
      section.)
- [x] The PR description includes the `04-ui.md` §1 parity report
      (row → test or "confirmed in bench pass ticket 011" or "dropped:
      <reason>"). (No PR in this workflow — satisfied instead by the
      `## Parity report` section below and the standalone
      `docs/reviews/2026-09-12-ui-parity-sprint-015.md`, per this
      ticket's own dispatch instructions.)

## Implementation Plan

**Approach**: Panels first (mechanical deletions + read-from-snapshot),
then the app-shell banner (new logic), then the parity report as a
final pass across all three UI tickets' test coverage.

**Files to modify**:
- `packages/ui/src/components/StatusPanel.tsx`
- `packages/ui/src/components/CommandStrip.tsx`
- `packages/ui/src/components/DistanceCalibrationWizard.tsx`
- `packages/ui/src/components/RotationCalibrationWizard.tsx`
- `packages/ui/src/components/AppHeader.tsx`
- `packages/ui/src/App.tsx`

**Files to delete/trim**: the four panels' "sends X on closed→open"
pinned test cases.

**Testing plan**:
- FakeSocket: banner/disable/send-line behavior in `App.test.tsx`;
  panel tests asserting no probe send on open.
- Run: `npx vitest run packages/ui/src/components/StatusPanel.test.tsx packages/ui/src/components/CommandStrip.test.tsx packages/ui/src/components/DistanceCalibrationWizard.test.tsx packages/ui/src/components/RotationCalibrationWizard.test.tsx packages/ui/src/App.test.tsx`.

**Documentation updates**: none.
`no-disconnected-from-host-banner-in-the-ui.md` already lives at
`clasi/issues/done/` (verified during sprint planning) — its content is
folded into this ticket's scope per `rearchitecture-plan.md`'s
disposition table, and no separate `move_issue_to_done` call is needed;
it is not one of this sprint's four linked issues.

## Implementation notes

**Deviation from this ticket's own Description**: "`RobotPage.transportBlind.test.ts`
stays as-is" turned out not to be literally possible — `RobotPage.tsx`'s
own prop shape has to change (`{ endpoint: EndpointListEntry }` →
`{ device, link }`) for the file to compile at all against the retired
type, and this test file both source-scans `RobotPage.tsx` (unaffected)
and directly mounts `<RobotPage endpoint={...} />` with hand-built
`EndpointListEntry` fixtures in its own two render-based describe
blocks (affected). Kept the file's structure, intent, and every
assertion byte-for-byte; only the fixtures (`SnapshotDevice`/
`SnapshotLink` instead of `EndpointListEntry`) and the render call
(`{device, link}` instead of `{endpoint}`) changed — the same treatment
`DevicePage.test.tsx`/`RelayPage.test.tsx` already got from tickets
007/008 for the identical reason.

Delivered in three commits (panels, banner/send-guard, parity report):

- **Panels migrated off `EndpointListEntry` onto `{link, name}` or
  `{link}`**: `StatusPanel`, `CommandStrip`, `DriveControls`, `DriveTab`,
  `FunctionsPanel` (`{link, name}`), `DistanceCalibrationWizard`,
  `RotationCalibrationWizard`, `CalibrationPage` (`{link, name}`),
  `ChartsPanel`/`PathTracePanel` (prop renamed `endpointId` → `linkId`,
  no behavior change). `RobotPage` itself takes `{device, link}` — the
  caller (`DevicePage.tsx`'s `"robot"` dispatch arm, which already holds
  both `useLink`/`useDeviceForLink` results; `RelayPage.tsx`'s
  `findRelayChild`, which already returns both) resolves which specific
  link this page is showing a session for, rather than `RobotPage`
  guessing `device.links[0]` itself — a device can in principle own more
  than one link. `DeviceConsole.tsx` (ticket 008's own migration, not in
  this ticket's original file list) also picked up `useSendable()`
  gating, since its send box is the single most representative
  "send-capable control" the disconnected-banner acceptance criterion
  describes, and it is shared by every per-device page.
- **On-open probes deleted, not adapted**: `StatusPanel`'s `STATUS`,
  `CommandStrip`'s bare `GET`, and both wizards' `FUNCS` — all four
  `wasOpenRef` effects are gone (`grep -rn "wasOpenRef" packages/ui/src`
  returns nothing). `session.functions`/`session.robotStatus` now come
  straight from the snapshot's own `SnapshotLink.session`. One
  consequence worth flagging explicitly: the harvester (ticket 003)
  auto-sends `ID` once per identify and polls `STATUS` on its own, but
  it does **not** auto-send `FUNCS` or `GET` — so `CommandStrip`'s
  discovered-name `<datalist>` and the wizards' `calx`/`cala`
  availability now only ever populate after an explicit `FUNCS`/`GET`
  press somewhere (`CommandStrip`'s own buttons, `FunctionsPanel`'s
  Refresh), not automatically on page open. This is the ticket's own
  intended trade — accepted, not an oversight — see the parity report's
  "Finding #6, resolved" section below.
- **Disconnected-from-host banner (UC-020)**: `AppHeader.tsx` renders one
  banner from `useHostConnection()` (`disconnectedBannerText`, exported
  for its own test), worded per state — `"Connecting to the host…"`
  before any first connect, `"Disconnected from the host —
  reconnecting…"` while closed, `"Reconnected — waiting for the latest
  state…"` once the socket reopens but before a fresh snapshot confirms
  it. `App.tsx` itself needed no change (it only ever mounted
  `AppHeader` as a sibling of the route tree; that's still the single
  render path).
- **Every migrated component's `linkOpen` gate multiplies by a new
  `useSendable()` hook** (`WsProvider.tsx`: `status === "open" &&
  !stale`), not just `link.session !== undefined` — a link's own
  `session` field survives a reconnect in the last-known snapshot
  (`WsProvider`'s own doc comment), so it alone cannot tell "still
  connected" from "what we had before we lost the host". This was
  applied to every panel this ticket touches plus `DeviceConsole`; it
  was **not** applied to `RelayPage`/`ConfigurationPage`/`FrontPage`/the
  header's own dialog triggers, which stay out of this ticket's file
  scope (tickets 007/008 own those pages) — flagged explicitly here
  rather than silently narrowing the acceptance criterion's "every
  send-capable control" to only what this ticket actually touches.
- **`send()` no longer drops silently**: `WsProvider.tsx`'s `actions.send`
  now pushes a synthesized `{direction: "tx", origin: "host", line: "Not
  sent -- no connection to the host."}` entry into the message's own
  scoped link log (via its `linkId`, or a `SessionOpenMessage`'s
  `relayLinkId` when that's the only id present) when the socket isn't
  open, instead of doing nothing. A message with neither field
  (`set-radio-override`, `forget-device`, the two Wi-Fi credential
  messages) still drops silently — there is no link-scoped console to
  write a notice into for those, and none of them are reachable from a
  disabled control this ticket introduces.
- **A genuine bug found and fixed along the way**: `DriveTab.tsx`'s
  keyboard/gamepad effects mount once (`useEffect(..., [linkId])`) and
  keep calling the exact `engine.setSource` closure from that first
  render forever; `useDriveEngine`'s own `apply()` used to read its
  `linkOpen` parameter by value, frozen at whatever it was when that
  first closure was created. Under the old model `sessionOpen` was
  already `true` on a device fixture's very first render, so this never
  surfaced; under the new model `useSendable()` starts `false` (before
  the socket reports "open"), so the frozen closure's stale `false`
  permanently blocked every key/gamepad press once flipped in a real
  render. Fixed with a `linkOpenRef` ref (stable identity, updated every
  render) that `apply()` reads instead — caught by `DriveTab.test.tsx`'s
  own existing assertions failing after the migration, not a new test.
- **UI tsc**: 34 → 0 errors. `npx tsc --noEmit -p packages/ui/tsconfig.json`,
  `-p packages/host/tsconfig.json`, and the repo-wide `npm run typecheck`
  are all clean.
- **Not carried forward this ticket, confirmed pre-existing/out of
  scope**: `ChartsPanel.tsx`/`PathTracePanel.tsx`'s own prop rename is
  cosmetic only (no behavior change); `RelayPage.tsx`'s
  `<RobotPage endpoint={...}/>` call site and `DevicePage.tsx`'s
  matching one both updated to `<RobotPage device={...} link={...}/>`
  for the new prop shape.

## Parity report

See `docs/reviews/2026-09-12-ui-parity-sprint-015.md` for the full,
identical copy of this report (required to live in both places per this
ticket's own dispatch instructions, since this sprint has no PR to carry
it).

### §1.1 App shell / header

| Feature | Status |
|---|---|
| Single WS connection, auto-reconnect 1.5s, keep last snapshot while reconnecting | confirmed — `ws/WsProvider.test.tsx` ("hasSnapshot / useHostConnection staleness"); ticket 007 |
| Header title + back-to-devices arrow on every non-`/` route | confirmed — `components/AppHeader.test.tsx` ("AppHeader back-to-devices link"); ticket 007 |
| Header actions: Set Radio (robot, named only), Set Wi-Fi (non-relay), Flash (any resolvable link, `forceShow`) | confirmed — `components/AppHeader.test.tsx` ("AppHeader Set Radio", "AppHeader Flash", "AppHeader Set Wi-Fi"); tickets 007/008 |
| **New this ticket**: disconnected-from-host banner (UC-020, `no-disconnected-from-host-banner-in-the-ui.md`) | confirmed — `App.test.tsx` ("App shell: disconnected-from-host banner reaches a mounted RobotPage route") |
| **New this ticket**: every send-capable control in `RobotPage`'s own subtree (and `DeviceConsole`, shared by every per-device page) disables while the socket is not open or the snapshot is stale | confirmed — `App.test.tsx` ("re-shows the banner and disables RobotPage's send-capable controls when the socket closes", "re-enables controls only once...") |
| **New this ticket**: a send attempted while disconnected reports a host-style console line instead of dropping silently | confirmed — `App.test.tsx` ("a send attempted while disconnected reports a host-style console line instead of dropping silently") |

### §1.2 Front page (ticket 007's own scope, restated)

| Feature | Status |
|---|---|
| Connection banner, empty state, one card per device, unassigned boards as own cards, "not seen recently" section | confirmed — `pages/FrontPage.test.tsx`; ticket 007 |
| Relay quick-connect (Connect/Switch/Disconnect, name picker) | confirmed — `pages/FrontPage.test.tsx`; ticket 007 |
| Flash trigger on an unassigned board's card | confirmed — restored on `UnassignedCard`; ticket 008 |
| Radio-migration nicety (leftover `localStorage` override offered once) | confirmed — `pages/FrontPage.test.tsx` ("RadioMigrationOffers"); ticket 007 |
| **dropped**: the relay picker's roster/discovered split ("(on the network)" annotation) | ticket 007's own report: retired along with `EndpointsMessage`'s `discoveredServices` list — the new wire contract has no separate discovered-robots side list |
| **dropped**: the no-pick `autoRobot: true` default-failover connect request | ticket 007's own report and `wsMessages.ts`'s own `SessionOpenMessage` doc comment: no replacement in the new wire contract |
| **dropped**: per-connect channel/group override inputs on the connect bar | ticket 008's own report: retired along with the client-side radio override model |

### §1.3 Device page shell (ticket 008's own scope, restated)

| Feature | Status |
|---|---|
| Routes on `linkId`; loading/not-connected/dispatch states; never auto-redirects | confirmed — `pages/DevicePage.test.tsx`; ticket 008 |
| Per-`device.kind` dispatch | confirmed — `pages/DevicePage.test.tsx` ("DevicePage per-type dispatch"); ticket 008 |
| **dropped**: the WiFi auto-`session-open` effect on mount/open→closed | ticket 008's own report: deleted outright — the reconciler's `planUserOpen` owns that decision now; confirmed by `pages/DevicePage.test.tsx` ("DevicePage never sends session-open on its own") |

### §1.4 Relay page (ticket 008's own scope, restated)

| Feature | Status |
|---|---|
| Heading, connected/lost/idle/sweeping/bridging states, Connect/Switch/Disconnect | confirmed — `pages/RelayPage.test.tsx`; ticket 008 |
| Connect/Switch sends exactly one `session-open{relayLinkId,name}`, never a client-sequenced close-then-open | confirmed — `pages/RelayPage.test.tsx`; ticket 008 |
| `AddressSourceChip` from the connected child's own resolved `radio` field | confirmed — `pages/RelayPage.test.tsx`; ticket 008 |
| RobotPage mounted for the child | confirmed — `pages/RelayPage.test.tsx` ("mounts RobotPage for the connected child device"); this ticket updates the mocked stub's prop name (`endpoint` → `device`) only |
| **dropped**: `AddressSourceChip`'s failover-trail/registry-considered nuance | ticket 008's own report: no host-reported equivalent of the old five-outcome model |

### §1.5 Robot page and its tabs (this ticket's own scope)

| Feature | Status |
|---|---|
| Heading = `device.name`; tabs Main/Drive/Calibration (`isCalibrationProgram`)/Functions & charts/Configuration; falls back to Main | confirmed — `pages/RobotPage.test.tsx` |
| "Program: X · Version: Y" diagnostics when `device.program !== null` | confirmed — `pages/RobotPage.test.tsx` ("RobotPage program/version diagnostics") |
| Main tab: StatusPanel + DriveControls (left), DeviceConsole + CommandStrip (right); exactly one console region | confirmed — `pages/RobotPage.test.tsx` |
| STOP/E-STOP inside DriveControls' own pad | confirmed — `pages/RobotPage.test.tsx` |
| Drive tab: pad + keyboard + gamepad | confirmed — `components/DriveTab.test.tsx` |
| Calibration tab: both wizards, code block, current-calibration table, Start over, DeviceConsole | confirmed — `components/CalibrationPage.test.tsx`, `pages/RobotPage.test.tsx` |
| Functions & charts tab | confirmed — `pages/RobotPage.test.tsx` |
| Configuration tab | confirmed — `components/ConfigurationPage.test.tsx` (ticket 007, unchanged this ticket) |
| StatusPanel: badge, waiting/no-link text, Clear E-STOP, table | confirmed — `components/StatusPanel.test.tsx` |
| **StatusPanel dropped**: closed→open one-shot `STATUS` probe | deleted outright — harvester already polls `STATUS`; former pinned mount/reopen case deleted |
| DriveControls: pad, turns, STOP/E-STOP/Clear E-STOP, all disabled with no session/connection | confirmed — `components/DriveControls.test.tsx` |
| SequencingIndicator | confirmed — `components/SequencingIndicator.test.tsx` (ticket 008, unchanged) |
| DeviceConsole | confirmed — `components/DeviceConsole.test.tsx` (ticket 008); this ticket's `useSendable()` addition confirmed by `App.test.tsx` |
| CommandStrip: verb buttons, GET/SET, `<datalist>` harvest | confirmed — `components/CommandStrip.test.tsx` |
| **CommandStrip dropped**: closed→open one-shot bare `GET` | deleted outright — harvester never auto-sends `GET` either; former pinned mount/reopen cases deleted |
| FunctionsPanel | confirmed — `components/FunctionsPanel.test.tsx` |
| ChartsPanel | confirmed — `components/ChartsPanel.test.tsx` (prop rename only) |
| PathTracePanel | confirmed — `components/PathTracePanel.test.tsx` (prop rename only) |
| DistanceCalibrationWizard / RotationCalibrationWizard | confirmed — their own test files |
| **Both wizards dropped**: closed→open one-shot `FUNCS` | deleted outright — harvester never auto-sends `FUNCS` either; former pinned mount cases deleted |
| Transport-blindness | confirmed — `pages/RobotPage.transportBlind.test.ts` |

### §1.6 Unknown page

| Feature | Status |
|---|---|
| Heading, link-attempt reason, FlashDialog, DeviceConsole | confirmed — `pages/UnknownDevicePage.test.tsx`; tickets 007/008, unchanged |

### §1.7 Dialogs

| Feature | Status |
|---|---|
| FlashDialog | confirmed — `components/FlashDialog.test.tsx`; ticket 008 |
| FlashControls | confirmed — `components/FlashControls.test.tsx`; ticket 008 |
| WifiCredentialsDialog | confirmed — `components/WifiCredentialsDialog.test.tsx`; ticket 008 |
| RadioAddressDialog | confirmed — `components/RadioAddressDialog.test.tsx`; ticket 006/007 |
| AddressSourceChip | confirmed — `components/AddressSourceChip.test.tsx`; ticket 008 |

### Finding #6 from `04-ui.md` §3, resolved by this ticket

All four call sites the finding named (`StatusPanel.tsx`,
`CommandStrip.tsx`, `DistanceCalibrationWizard.tsx`,
`RotationCalibrationWizard.tsx`) have their on-open probe deleted.
`grep -rn "wasOpenRef" packages/ui/src` returns nothing.

### Overall

Every §1 row is confirmed by a passing test or explicitly recorded as
dropped with a reason; none of this ticket's own rows needed the
bench-pass fallback. `npx vitest run packages/ui` — 433/433 passing
across 29 files. `npx tsc --noEmit` clean for `packages/ui`,
`packages/host`, and the repo-wide `npm run typecheck`.
