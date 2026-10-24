---
id: '001'
title: Protocol helper and host raw channel/group session-open
status: in-progress
use-cases:
- SUC-001
- SUC-002
depends-on: []
github-issue: ''
issue: connect-a-radio-bridge-to-a-raw-channel-and-group.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Protocol helper and host raw channel/group session-open

## Description

Add the raw channel/group form of `session-open` on the host. A shared protocol helper mints the synthetic link id; `sessionOps.openSession` upserts a `links(radio)` row at the given address and opens it through the existing reconciler/relayBridger path. No `BridgeRequest` shape change is needed (a raw link row already feeds `toBridgeRequest` as a single candidate); update the stale doc comment in `relayBridger.ts`.

## Acceptance Criteria

- [ ] `packages/protocol` exports `rawRadioChildLinkId(relayLinkId, channel, group)` returning `radio-ch<channel>-g<group>-via-<relayLinkId>` (e.g. `radio-ch76-g30-via-guvov`), re-exported from `index.ts`.
- [ ] `SessionOpenMessage` has a third variant `{relayLinkId, channel, group}`; `parseClientMessage` accepts exactly one of the three shapes and rejects mixes, non-integers, channel outside 0-83, group outside 0-255, empty `relayLinkId`.
- [ ] `OpenSessionParams` has the same variant; `openSession` upserts the radio link with address `{relayLinkId, channel, group}` and no override/registry/derived lookup, calls `requestOpen` with the synthetic id, and returns it as `linkId`.
- [ ] `server.ts` `session-open` handler passes the third shape through; a refusal still produces the `connect refused:` notice.
- [ ] If the robot answers `ID`, the link attaches to the robot's device (existing behaviour); the link id is not re-keyed.
- [ ] If nothing answers, the link ends `failed` via the existing `recordFailure` path, same as a named bridge.
- [ ] `relayBridger.ts` doc comment no longer says the shape is missing.

## Testing

- **Existing tests to run**: `packages/host/src/wsMessages.test.ts`, `packages/host/src/connect/sessionOps.test.ts`, `packages/host/src/connect/relayBridger.test.ts`, `packages/host/src/server.test.ts`
- **New tests to write**: protocol `rawRadioChildLinkId` unit test; parser cases in `wsMessages.test.ts`; `sessionOps.test.ts` raw open (row address, returned id, no resolver calls, refusal); `relayBridger.test.ts` single-candidate bridge from a raw link row including no-answer failure.
- **Verification command**: `npm test` (workspace root) and `npm run typecheck`
