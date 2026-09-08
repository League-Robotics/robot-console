---
id: '006'
title: Command strip Get/Set field auto-discovery
status: done
use-cases:
- SUC-007
depends-on:
- '005'
github-issue: ''
issue: robot-page-two-column-layout-with-unified-console-command-strip.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Command strip Get/Set field auto-discovery

## Description

`GetSetPanel.tsx`'s own doc comment records why this codebase has no
enumerable list of legal GET/SET field names to build a dropdown from:
per protocol.md, "no config field table lives in this library." The
linked issue works out the one mechanism already available: a bare
`GET` (no name) returns one `get <name> <value>` line per known field,
so the field picker can be populated by firing a bare `GET` when the
page mounts and harvesting names from the replies — discovered from the
live device, never a hardcoded vocabulary.

Layer this onto ticket 005's `CommandStrip`: on mount (or first open,
implementer's choice, document which), send a bare `GET` via
`sendCommand(endpointId, "GET")`. Watch the endpoint's log
(`useEndpointLog`) for `get <name> ...` reply lines and harvest the
`<name>` token from each into a set of discovered names. Render the
GET/SET name field as an editable combo box (`<input list="...">` with
a `<datalist>`, or equivalent) populated with the discovered names —
**never a closed `<select>`** — so a name the device didn't report (or
hasn't reported yet) can still be typed and sent.

This ticket depends on 005 because it modifies `CommandStrip` directly
and needs the base strip's GET/SET free-text fields already in place.

## Acceptance Criteria

- [x] `CommandStrip` fires a bare `GET` (`sendCommand(endpointId,
      "GET")`, no fields) when the page/session becomes ready — document
      exactly when (mount vs. first open) in the component's own doc
      comment.
- [x] `get <name> <value>` reply lines (matching the existing
      `err`/`nack`/`ack` classification conventions used elsewhere, e.g.
      `GetSetPanel`'s old `ERROR_REPLY_PATTERN`/`DeviceConsole`'s
      `classifyLine`) are parsed for `<name>` and added to a discovered-
      names set.
- [x] The GET/SET name field is an editable combo box populated with
      discovered names.
- [x] A name not among the discovered options can still be typed into
      the field and sent via GET or SET — the field is never a closed
      `<select>`.
- [x] Discovery re-fires appropriately if the session reopens (a
      reconnected session's discovered-names set should not silently go
      stale forever — document the chosen refresh trigger, e.g. on
      `sessionOpen` transitioning false→true again).
- [x] `RobotPage.transportBlind.test.ts` still passes against
      `CommandStrip.tsx` with this addition (no transport-specific
      reference introduced by the discovery logic).

## Testing

- **Existing tests to run**: `npm test -- CommandStrip RobotPage`
  (packages/ui).
- **New tests to write**: a fake-link test asserting a bare `GET` fires
  on mount, `get ...` reply lines populate the combo box's options, and
  an untyped/undiscovered name is still sendable.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Additive change to `CommandStrip.tsx` only — no new module. Parsing
`get <name> <value>` lines reuses the same "loose prefix match, no
invented grammar" discipline `StatusPanel`/`GetSetPanel` already used
(`/^get\b/i` or similar), consistent with `v6/codec.ts`'s "no verb
table" rule: this ticket must not introduce a stricter parsed reply
shape than the firmware actually promises.

### Files to create/modify

- `packages/ui/src/components/CommandStrip.tsx`, `.css` — discovery
  state, combo box.
- `packages/ui/src/components/CommandStrip.test.tsx` — new discovery
  tests.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`CommandStrip.tsx`'s doc comment should explain the discovery mechanism
and explicitly state the "never a closed select, no invented
vocabulary" contract, mirroring `GetSetPanel.tsx`'s original doc comment
so the next reader understands why this isn't a hardcoded field list.
