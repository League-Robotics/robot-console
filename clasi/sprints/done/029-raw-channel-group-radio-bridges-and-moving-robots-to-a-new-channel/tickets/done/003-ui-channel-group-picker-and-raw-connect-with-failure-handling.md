---
id: '003'
title: UI Channel/group picker and raw connect with failure handling
status: done
use-cases:
- SUC-001
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: connect-a-radio-bridge-to-a-raw-channel-and-group.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI Channel/group picker and raw connect with failure handling

## Description

Add the "Channel/group" option to the robot picker on a radio bridge's page and wire Connect. Because a failed raw bridge has no `deviceId` and is therefore absent from the snapshot, the UI must track its own attempt (pattern of `FrontPage.tsx`'s `RadioChip`): success when the synthetic link is usable, failure on a `linkNotices` entry for that id, else give up after `RADIO_CONNECT_GIVE_UP_MS`. Move that constant out of `FrontPage.tsx` into a shared UI module.

## Acceptance Criteria

- [x] `RobotSelect` lists "Channel/group" first (after the placeholder), using a sentinel value that cannot equal a robot name; choosing it shows a channel input/selector (0-83) and group input/selector (0-255) with validation.
- [x] Connect with Channel/group selected sends `{type:"session-open", relayLinkId, channel, group}`; Connect with a name still sends the named form unchanged. `RelayConnectControls.onConnect` is a union and `RelayPage` handles both.
- [x] The UI computes the tracked link id with the protocol `rawRadioChildLinkId`.
- [x] While pending the page shows connecting status; on success shows connected; on a notice or after `RADIO_CONNECT_GIVE_UP_MS` shows the same failed-style alert as a named bridge ("Couldn't connect: no answer through the radio bridge" or the notice text) and returns to idle.
- [x] `RADIO_CONNECT_GIVE_UP_MS` is defined once and imported by `FrontPage.tsx` and the new code.
- [x] Connect is disabled until channel and group are valid.

## Testing

- **Existing tests to run**: `packages/ui/src/components/RobotSelect.test.tsx`, `RelayConnectControls.test.tsx`, `packages/ui/src/pages/RelayPage.test.tsx`, `FrontPage.test.tsx`
- **New tests to write**: `RobotSelect.test.tsx` (first option, reveal, validation); `RelayConnectControls.test.tsx` (union onConnect); `RelayPage.test.tsx` (sends raw `session-open`, success, notice failure, give-up with fake timers).
- **Verification command**: `npm test` and `npm run typecheck`
