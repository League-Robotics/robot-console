---
status: pending
---

# UI renders the host snapshot; remove every client-side connection decision; keep every screen feature

## Description

The UI is already about 90% a passive renderer (`04-ui.md` headline).
`WsProvider.tsx` is a store with `useSyncExternalStore` selectors, a
log ring and a telemetry ring, and infers nothing about connectivity.
What has to change is small and specific (`04-ui.md` §3):

1. `DevicePage.tsx:95-108` auto-sends `session-open` for `wifi` endpoints
   on mount and on every open→closed flip — connect policy in a route
   component, transport-branched.
2. Radio address overrides live in browser `localStorage` and are sent as
   `radio: {}` on every connect, bypassing the host's resolution
   (`RelayPage.tsx:129-170, 286-298`, `FrontPage.tsx:183-185`,
   `RadioAddressDialog.tsx`, `ConfigurationPage.tsx:99-122`) — moved
   host-side by rearch-08.
3. Switching robots on a relay is a client-sequenced `session-close` then
   `session-open`, with the UI scanning `endpoints` for the child to
   close (`RelayPage.tsx:287-289`, `FrontPage.tsx:175-178`).
4. `FrontPage.tsx:258-314` groups endpoints by name and scores links,
   duplicating host auto-switch preference.
5. Four components each send `STATUS`/`GET`/`FUNCS` on closed→open
   (`StatusPanel:164`, `CommandStrip:112`, both wizards), although the
   host probes on identify and polls `STATUS`.
6. `discoveredServices.robots` is only used for the relay dropdown; a
   discovered robot the host has not made an endpoint is invisible
   (pinned by `FrontPage.test.tsx:566`). Under the new contract the
   host's `owned` gate decides this, and the UI simply renders
   `devices[]`.

Stakeholder requirement: every feature on the relay page, robot page,
device pages, and dialogs is preserved. The checklist is
`docs/reviews/2026-09-11/04-ui.md` §1.

Related open issue: `no-disconnected-from-host-banner-in-the-ui.md`
(UC-020) is best done here, since the banner and the disable-on-disconnect
rule depend on the new `seq`/snapshot semantics.

## Proposed resolution

- `WsProvider.tsx`: one `snapshot` slice replaces `endpointsById`,
  `firmwareStatus`, `rememberedRobots`, `discoveredServices`,
  `wifiCredentials`, `wifiProvisionResultByEndpoint`, and
  `flashProgressByEndpoint` (flash progress now rides on `links[].flash`).
  Keep the store pattern, selectors, log ring (keyed by `linkId`),
  telemetry ring. Split the 137-line socket effect into `connect()` and
  `dispatch(message)`. Track `seq`; on reconnect, mark the held snapshot
  stale until a fresh one arrives.
- Selectors: `useDevices()`, `useDevice(id)`, `useLink(linkId)`,
  `useRelays()`, `useFirmware()`, `useWifiSetting()`, `useTasks()`.
- `FrontPage.tsx`: one card per `devices[]` row (host order), link rows
  from `links[]` with `state`/`reason`/`lastSeen`/`nextRetryAt` rendered
  as "Linked / Connecting / Unreachable: … / Retrying in N s / Not seen
  since …"; `unassigned` boards as their own cards; remembered section
  becomes "not seen recently" devices from the same list. Delete
  `groupEndpointsByRobot`/`linkScore`/`bestClassified`. Relay card uses
  the shared `RelayConnectControls` (rearch-16 may extract; do it here if
  convenient) sending `session-open {relayLinkId, name}` only.
- `DevicePage.tsx`: route on `linkId`; delete the WiFi auto-open effect.
- `RelayPage.tsx`: read `relays[].bridging`/`lease` and the child link
  from the snapshot; Connect sends one message; show "idle · sweeping"
  when the lease is `sweep`.
- `RobotPage.tsx` and panels: unchanged except removing the on-open
  probes in `StatusPanel`, `CommandStrip`, `DistanceCalibrationWizard`,
  `RotationCalibrationWizard`, and reading `session.functions`/
  `session.robotStatus` from the link. `RobotPage.transportBlind.test.ts`
  stays.
- `AppHeader`/`App`: render the disconnected banner from
  `useConnectionStatus()`; disable every send-capable control while the
  socket is not open; `send()` reports a host-style console line instead
  of dropping silently.
- Regenerate FakeSocket fixtures to the new `snapshot` shape; delete the
  tests that pin removed client policy (`DevicePage.test.tsx:264-330`,
  `RelayPage.test.tsx:351`, the "sends X on open" cases) and the
  contract-drift tests in `WsProvider.test.tsx:434-483`.

## Acceptance

- Every row of `04-ui.md` §1 (feature inventory) has a passing test or is
  visibly present in a manual pass on real hardware; the PR lists any
  row it dropped and why.
- `grep -rn "localStorage" packages/ui/src` shows only calibration
  state, function args, and the console's own preferences — no radio
  addresses, no connection state.
- `grep -rn "session-open" packages/ui/src` shows sends only from
  explicit user actions (Connect/Switch/open-link buttons, console
  "open a link").
- FakeSocket close → banner shown, controls disabled, a send produces
  the console line; open + snapshot → banner gone.
- A snapshot with an un-owned WiFi device absent and an unassigned USB
  board present renders the unassigned board's card.

## Depends on

rearch-06 (contract). rearch-08 (radio overrides) can land before or
after; if after, leave the Radio panel reading the derived default.

## References

- `docs/design/architecture.md` §9, §10
- `docs/reviews/2026-09-11/04-ui.md` §1, §2, §3, §5, §6, §7
- `docs/design/usecases.md` UC-018, UC-020
- `clasi/issues/no-disconnected-from-host-banner-in-the-ui.md`
