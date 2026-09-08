---
id: '003'
title: Route host error messages into the per-endpoint console log
status: open
use-cases:
- SUC-005
depends-on: []
github-issue: ''
issue: robot-page-two-column-layout-with-unified-console-command-strip.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Route host error messages into the per-endpoint console log

## Description

Discovered while verifying this sprint's premises against actual
source, not stated in the linked issue: the robot page's planned
command strip (ticket 005) wants a Hello button that sends
`sendCommand(endpointId, "HELLO")`. But `deviceRegistry.ts:945-951`
deliberately rejects `"HELLO"` sent as a live command *before* it ever
reaches `Session` — a sprint 006 safety decision (protocol.md §8.3:
`HELLO` resets the robot's sequence state and must never be issued
mid-session) that this sprint does not change. That rejection is
reported via `DeviceRegistry.onError` → a `type: "error"` wire message.

`WsProvider.tsx:598-606` currently drops every `type: "error"` message
as an explicit no-op — its own comment says "no component ever
subscribed ... a future ticket adding error handling has an obvious
place to put it." Left as-is, pressing the command strip's Hello button
on an already-open session would appear to do nothing, which is worse
than the layout bug this sprint is fixing.

Fix: when a `type: "error"` message carries an `endpointId`, append it
to that endpoint's log in the same store `DeviceConsole`/`useEndpointLog`
already read (`appendLine`'s existing per-endpoint log mechanism, or
directly alongside it) — matching this sprint's own stated goal for the
robot page: "no separate response areas, all replies land in the one
console log." Both current `emitError` call sites in `deviceRegistry.ts`
(`sendLine`'s "no open link" case, `sendCommand`'s "no open link" and
`"HELLO"` cases) already carry an `endpointId`, so this is the path that
matters in practice. Decide and document what happens for a
hypothetical `error` message with no `endpointId` (no current caller
produces one) — a global banner, or dropped — rather than leaving it
unspecified.

This ticket is UI-only (`WsProvider.tsx`); no host-side change (the
host already emits `type: "error"` correctly — this only starts
consuming it).

## Acceptance Criteria

- [ ] `WsProvider.tsx`'s `case "error":` branch appends the message text
      to the firing endpoint's per-endpoint log when `endpointId` is
      present, visible via `useEndpointLog(endpointId)` exactly like an
      ordinary `line` entry.
- [ ] The appended entry is visually distinguishable in `DeviceConsole`
      as a host-side note, not mistaken for a line the device itself
      sent (e.g. reuse or extend `classifyLine`'s existing "error"
      styling — do not invent a fourth `direction` value if `rx`/`tx`
      is not a good fit; document whichever representation is chosen).
- [ ] The no-`endpointId` case is given one deliberate, tested behavior
      (global banner or drop) rather than left as an implicit fallback.
- [ ] A test proves: sending `sendCommand(endpointId, "HELLO")` against
      a fake link with an open session results in the host's refusal
      text appearing in that endpoint's log (this is the concrete
      scenario ticket 005's Hello button depends on).
- [ ] `WsProvider.tsx`'s doc comment noting the drop as a documented gap
      ("a future ticket adding error handling has an obvious place to
      put it") is updated to reflect that this is now handled, not left
      stale.

## Testing

- **Existing tests to run**: `npm test -- WsProvider DeviceConsole`
  (packages/ui).
- **New tests to write**: `WsProvider.test.tsx` — `type: "error"` with
  and without `endpointId`; the `HELLO`-rejection-surfaces-in-log
  scenario end-to-end against a fake socket.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Minimal, single-file-focused change: extend `WsProvider.tsx`'s message
switch. No new module needed — this reuses the existing per-endpoint
log store and `DeviceConsole`'s existing rendering, per the sprint's
Design Rationale ("matches this sprint's own stated goal ... at zero
new UI surface").

### Files to create/modify

- `packages/ui/src/ws/WsProvider.tsx` — `case "error":` branch;
  possibly a small addition to `DeviceConsole.tsx`'s `classifyLine` (or
  equivalent) if a new visual treatment is needed to distinguish a
  host-side note from a device line.
- `packages/ui/src/ws/WsProvider.test.tsx` — new test cases.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`WsProvider.tsx`'s existing doc comment at the `"error"` case (the
"dropped here rather than carried forward unused" note) must be rewritten
to describe the new behavior, not left as a stale pointer to a "future
ticket" that has now landed.
