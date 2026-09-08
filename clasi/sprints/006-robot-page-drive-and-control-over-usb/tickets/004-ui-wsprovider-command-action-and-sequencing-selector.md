---
id: '004'
title: 'UI: WsProvider command action and sequencing selector'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
depends-on:
- '002'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: WsProvider command action and sequencing selector

## Description

`WsProvider.tsx` already exposes granular, ref-backed selectors
(`useEndpoint`, `useFlashProgress`, ...) and an imperative `WsActions`
surface (`send`, `sendBinary`, ...). This ticket adds the one new
action `RobotPage` (ticket 005/006) needs — `sendCommand` — and a
selector for the `sequencing` field ticket 002 added to
`EndpointListEntry`.

This ticket depends only on ticket 002 (the frozen wire contract
types), not ticket 003 (the host's runtime implementation) — it can be
built and fully tested against a fake `WebSocketLike` exactly like
every other action/selector in this file already is, with no
dependency on a running host.

**`sendCommand` action.** `sendCommand(endpointId: string, verb:
string, fields?: WireField[])` sends `{ type: "send-command",
endpointId, verb, fields }` through the existing `send` guard
(silently dropped if the socket isn't open — same as every other
action here, no queuing).

**`useSequencing` selector.** `useSequencing(endpointId): EndpointListEntry["sequencing"]`
mirrors `useFlashProgress`'s exact shape: a narrow
`useSyncExternalStore` subscription that only re-renders when *this*
endpoint's `sequencing` slice changes. No new store-mutation logic is
needed — `sequencing` travels inside the existing `endpoints` snapshot,
already handled end-to-end by `applySnapshot`'s per-entry `deepEqual`/
structural-sharing logic (a new field on `EndpointListEntry` is exactly
the case that logic already generalizes over). This ticket is almost
entirely additive plumbing, not new state-management design.

## Acceptance Criteria

- [x] `WsActions.sendCommand(endpointId, verb, fields?)` added, sending
      the correct `SendCommandMessage` shape via the existing `send`
      guard.
- [x] `useSequencing(endpointId)` added, returning `EndpointListEntry.sequencing`
      for that endpoint, subscribed narrowly (a component reading
      `useSequencing("A")` does not re-render when endpoint B's
      `sequencing` changes, or when an unrelated `line`/`flash-progress`
      message arrives).
- [x] `WsProvider.test.tsx` covers: `sendCommand` produces the correct
      wire message (including the no-fields/omitted-fields case);
      `useSequencing` reflects an `endpoints` snapshot's `sequencing`
      field; a snapshot update that leaves one endpoint's `sequencing`
      unchanged does not trigger a re-render for that endpoint's
      consumer (reuse this file's existing referential-stability test
      pattern, e.g. from `useEndpoint`'s own tests).
- [x] No behavior change to any existing action/selector in this file.

## Testing

- **Existing tests to run**: `npm test -- WsProvider` (packages/ui).
- **New tests to write**: see Acceptance Criteria.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Follow `useFlashProgress`'s existing pattern exactly (same file,
same `useSyncExternalStore` + `useCallback` shape) rather than
introducing a new selector idiom.

### Files to create/modify

- `packages/ui/src/ws/WsProvider.tsx` — add `sendCommand` to
  `WsActions`, add `useSequencing`.
- `packages/ui/src/ws/WsProvider.test.tsx` — new test cases.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Add a short doc comment on `useSequencing` matching this file's
existing per-hook documentation style (see `useFlashProgress`'s own
comment for the level of detail expected).
