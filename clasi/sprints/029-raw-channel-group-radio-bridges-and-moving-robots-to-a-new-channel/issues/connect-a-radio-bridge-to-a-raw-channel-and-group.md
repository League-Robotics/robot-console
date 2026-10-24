---
status: in-progress
sprint: 029
tickets:
- 029-001
- 029-002
- 029-003
- 029-005
---

# Connect a radio bridge to a raw channel and group, not only a named robot

## Stakeholder request (2026-10-23)

"When you go in from the main page, you go into the radio bridges
section and select a specific radio bridge. You need to allow
connecting to a channel and group rather than just robot names. ...
When you click on 'Choose Robot' and list all the robots, the first one
should be channel/group. That should open up a channel and group
selector, and then when you click 'Connect,' it's going to that channel
and group."

## Why

Diagnosing gopiv via guvov on ferranti (2026-10-23): the radio link lost
~24% of STATUS replies even at idle. gopiv's name-derived channel 12 is
2412 MHz, the centre of Wi-Fi channel 1. The next step is moving robots
to a Wi-Fi-free channel (e.g. 76, 2476 MHz) to test that, and today
the console can only bridge to a robot whose name it knows, at the
address derived from that name or set by its Set Radio override. There
is no way to point a bridge at an arbitrary channel/group and see what
answers.

## What to build

- **UI** — Front page → Radio bridges → a bridge's page (`RelayPage.tsx`).
  In the robot picker (`components/RobotSelect.tsx`, used by
  `RelayConnectControls`), the **first** option is "Channel/group".
  Choosing it reveals a channel selector (0–83) and a group selector
  (0–255). Connect then bridges to that channel/group.
- **Host** — `session-open` currently takes `{relayLinkId, name}` (or
  `{linkId}`); `SessionOpenMessage` in `packages/host/src/wsMessages.ts`
  and its parser need a `{relayLinkId, channel, group}` form, carried
  through `server.ts` → reconciler/connector → `connect/relayBridger.ts`
  (its `BridgeRequest` doc already notes there is no
  "relayLinkId with no name" shape yet).

## Decisions (stakeholder, 2026-10-23)

- **Link identity:** use a synthetic name built from the address. The
  bridge's link id is `radio-ch<channel>-g<group>-via-<relayLinkId>`
  (e.g. `radio-ch76-g30-via-guvov`), and that is the session's device
  name. No re-keying or merging once `ID` answers; the robot's real name
  can be shown from `ID` if it comes back, but identity stays the
  address.
- **Nothing answers:** fail exactly as a named bridge does, after
  `RADIO_CONNECT_GIVE_UP_MS`. No anonymous "listen to the air" session.
- **MCP parity:** yes. `open_session` accepts `relayLinkId` +
  `channel` + `group` as an alternative to `relayLinkId` + `name`.
- **Moving a robot to a new channel** is out of scope here; tracked in
  `verify-moving-a-robot-to-a-new-radio-channel.md`.
