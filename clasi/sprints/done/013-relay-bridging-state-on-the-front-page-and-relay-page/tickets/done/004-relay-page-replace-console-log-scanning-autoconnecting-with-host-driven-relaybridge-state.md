---
id: '004'
title: 'Relay page: replace console-log-scanning autoConnecting with host-driven relayBridge
  state'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: relay-card-must-show-radio-connection-state-not-just-linked.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay page: replace console-log-scanning autoConnecting with host-driven relayBridge state

## Description

Replace `packages/ui/src/pages/RelayPage.tsx`'s `autoConnecting`/
`autoConnectLogBaseline` mechanism (lines ~204-246 per the current file:
`useState<boolean>`, a `useRef` log baseline, and a `useEffect` that
infers failure from a host-origin log line landing) with rendering
driven directly by `endpoint.relayBridge` (shipped by tickets 001/002),
per sprint.md's Design Rationale ("RelayPage.tsx drops
autoConnecting/autoConnectLogBaseline entirely").

**Remove**:
- The `autoConnecting` state, `autoConnectLogBaseline` ref, and the
  `useEffect` that clears it via log-diffing (lines ~204-246).
- The `setAutoConnecting`/`autoConnectLogBaseline.current` writes inside
  `handleConnect` (lines ~281, ~293-294).
- The `{autoConnecting && (...)}` rendering block (around line 370-374).

**Add**: render `endpoint.relayBridge`'s three states directly, in both
branches of the existing `{child ? (...) : (...)}` structure (lines
~313-378) -- though in practice `relayBridge` and `child` should be
mutually exclusive per ticket 002's contract (connecting/failed only
occur while no child exists; the moment the child exists, `relayBridge`
is cleared), so this mainly means adding the connecting/failed rendering
to the *not-connected* branch (currently lines ~357-378), replacing the
old `autoConnecting`-driven status line:
- `endpoint.relayBridge?.state === "connecting"`: render "Connecting to
  `<name>`…" (named pick) or the existing "Trying remembered robots…"
  copy (no-pick case, `role="status"`, `data-testid="relay-autoconnecting"`
  -- keep the same test id if reasonable so downstream consumers of that
  id, if any exist outside this test file, don't break; confirm no such
  external consumer exists before assuming this is safe to keep or
  rename).
- `endpoint.relayBridge?.state === "failed"`: render the failure reason
  (`endpoint.relayBridge.error`) visibly, replacing today's silent
  reversion to a bare connect bar with nothing said about the failure.

Also update this file's own module doc comment (lines 1-73): the
"Sprint 8 ticket 005 additions" section's "In-flight failover
visibility" paragraph (lines ~47-58) currently documents the log-
scanning approach as current, correct behavior ("this page reads
`useEndpointLog(endpoint.endpointId)` rather than `endpoint.sessionError`
to detect that outcome"). Rewrite it to describe the `relayBridge`-based
approach instead -- this is exactly the "stale UI copy/doc comments
describing the log-scanning workaround" the issue asks to be updated.
Leave `useEndpointLog`/`relayLog` in place if the relay's own console
log rendering elsewhere on this page still needs it (check before
removing the import/hook entirely).

## Acceptance Criteria

- [x] `autoConnecting`/`autoConnectLogBaseline` and their `useEffect`
      are removed; no log-diffing mechanism remains for detecting
      bridging state.
- [x] Relay page shows "Connecting to `<name>`…" (or "Trying remembered
      robots…" for no-pick) as soon as `relayBridge.state ===
      "connecting"` appears, without waiting for a log line or the
      handshake to resolve.
- [x] Relay page shows the failure reason from `relayBridge.error` when
      `relayBridge.state === "failed"`, instead of silently reverting to
      a bare connect bar.
- [x] Connected-state rendering (the `child ? (...) : ...` true branch)
      is unchanged in behavior -- still driven by the child's existence,
      not by `relayBridge`.
- [x] The module doc comment's "In-flight failover visibility" section
      (and any other passage describing the log-scanning approach as
      current) is rewritten to describe the `relayBridge`-based
      approach; no doc comment anywhere in this file still claims the
      page reads `useEndpointLog` to detect bridging failure/success.
- [x] `RelayPage.test.tsx`'s tests built around `autoConnecting`/log
      baselines are rewritten against `relayBridge` fixtures instead of
      simulated log entries.
- [x] Sprint review follow-up: the connected branch's status line reads
      "Connected to `<name>` via `<relay>` on channel X, group Y" only
      when `child.sessionOpen === true` -- a child left listed with
      `sessionOpen: false` after `deviceRegistry.ts#handleLinkError`
      drops the radio link (not deleted, only Disconnect/`requestClose`/
      the WiFi auto-switch removes it) instead renders "Connection to
      `<name>` lost" (plus `child.sessionError` when present) as a
      `.relay-page-alert` line, `data-testid="relay-lost"`, with the
      connect bar and Disconnect still available.

## Completion Notes

Sprint review found one gap after this ticket first shipped: the
connected branch rendered "Connected to `<name>` via `<relay>` …"
whenever the synthesized child endpoint existed at all, regardless of
whether its session was actually open. `deviceRegistry.ts#handleLinkError`
leaves a dropped child listed with `sessionOpen: false` and
`sessionError` set rather than deleting it, so after a radio link died
this page kept saying "Connected" while the robot's own card said
"Unreachable: …". Fixed by branching the status line in `RelayPage.tsx`
on `child.sessionOpen`: `true` keeps the existing "Connected to" text,
`false` renders a new `.relay-page-alert` "Connection to `<name>` lost"
paragraph (`data-testid="relay-lost"`) folding in `child.sessionError`
when present. The pre-existing `child.sessionError` alert block (for a
transient error while still connected) is now gated on
`child.sessionOpen` too, so it no longer double-renders alongside the
new lost line. The connect bar, Disconnect, and `RobotPage` for the
child all stay mounted in that state (unchanged, still driven by the
child's existence). Fixed together with ticket 003 (same gap, same
commit) since both surfaces share the wording. Regression test added in
`RelayPage.test.tsx`; module doc comment's "Connected" section and
"In-flight failover visibility" section updated.

## Implementation Plan

**Approach**: Delete the `autoConnecting` mechanism; read
`endpoint.relayBridge` directly in the render body (no new local state
needed -- it's already reactive via `useEndpoints()`/props, exactly like
`child` already is). Match wording with ticket 003's front-page
rendering where both show the same state (see ticket 003's note on
reconciling wording; whichever ticket lands second should check the
other's copy and align).

**Files to modify**:
- `packages/ui/src/pages/RelayPage.tsx` -- remove `autoConnecting`
  mechanism, add `relayBridge`-driven rendering, rewrite the module doc
  comment's stale section.

**Testing plan**:
- Rewrite the `autoConnecting`/log-based tests in
  `packages/ui/src/pages/RelayPage.test.tsx` to instead pass a fixture
  `endpoint` with `relayBridge: { state: "connecting", ... }` /
  `{ state: "failed", error: "..." }` and assert the corresponding text
  renders, with no dependency on simulated log entries.
- Confirm the connected-branch tests (child present) are unaffected.

**Documentation updates**:
- The module doc comment rewrite described above, in the file itself
  (no separate doc file).

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/pages/RelayPage.test.tsx`
- **New tests to write**: see Implementation Plan's Testing plan above.
- **Verification command**: `npx vitest run packages/ui/src/pages/RelayPage.test.tsx`
