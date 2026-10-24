---
id: '002'
title: MCP open_session channel and group
status: open
use-cases: [SUC-003]
depends-on: ["001"]
github-issue: ''
issue: connect-a-radio-bridge-to-a-raw-channel-and-group.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# MCP open_session channel and group

## Description

MCP parity: `open_session` accepts `relayLinkId` + `channel` + `group` as an alternative to `relayLinkId` + `name`.

## Acceptance Criteria

- [ ] `open_session` input schema adds optional `channel` (0-83) and `group` (0-255); description documents the third shape.
- [ ] `parseOpenSessionParams` accepts exactly `{linkId}` | `{relayLinkId,name}` | `{relayLinkId,channel,group}`; other mixes return the existing plain error (updated to name all three shapes, keeping the empty-argument harness note).
- [ ] A successful raw open returns `{ok:true, linkId:"radio-ch<c>-g<g>-via-<relay>", caller}`.
- [ ] A no-answer/failed raw open returns the same plain error shape as a named failure (`could not open a session on "<id>": <reason>`).

## Testing

- **Existing tests to run**: `packages/host/src/mcp/tools/connect.test.ts`
- **New tests to write**: in `connect.test.ts`: raw happy path, raw failure, channel/group out of range, `name` mixed with `channel`, `channel` without `group`.
- **Verification command**: `npm test` and `npm run typecheck`
