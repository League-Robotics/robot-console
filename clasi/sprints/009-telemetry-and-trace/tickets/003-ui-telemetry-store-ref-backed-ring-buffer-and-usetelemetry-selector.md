---
id: "003"
title: "UI telemetry store: ref-backed ring buffer and useTelemetry selector"
status: open
use-cases: [SUC-001, SUC-002, SUC-003]
depends-on: ["002"]
github-issue: ""
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI telemetry store: ref-backed ring buffer and useTelemetry selector

## Description

Extend `packages/ui/src/ws/WsProvider.tsx`'s ref-backed store (the
`useSyncExternalStore` design already established for
`robotStatus`/log lines) with a telemetry slice per endpoint, and a
`useTelemetry(endpointId)` selector hook so only components that
actually read telemetry re-render on each incoming frame — the same
reasoning already applied to the existing per-endpoint selectors.

Per-endpoint telemetry state:
- Current header (column names), or none — drives "waiting for
  header" rendering.
- A bounded ring buffer of recent decoded frames, with its own cap
  **independent of `MAX_LINES_PER_DEVICE`** (that constant bounds the
  console log; telemetry is a different kind of data at a different
  rate — do not reuse or resize that constant). Pick a cap sized for a
  reasonable chart window (e.g. a few seconds at 20 Hz); document the
  choice in the module's own comment the way `MAX_LINES_PER_DEVICE`'s
  choice is documented.
- Handle the socket message added in ticket 002: a header update
  replaces the current header (and, per SUC-003, should be treated as
  "header recovered" — clear any "waiting" flag); a frame update
  appends to the ring buffer, evicting the oldest entry once the cap is
  reached.

`useTelemetry(endpointId)` should return something like `{ header,
frames, hasHeader }` and use `useSyncExternalStore` so it re-renders
only the subscribing component, not every `WsProvider` consumer — this
is the load-bearing reason sprint 4 did the ref-backed refactor in the
first place (a naive context value would re-render every consumer of
`WsProvider` at 20 Hz).

This ticket does not render anything — it is the store/hook layer
tickets 004 and 005 both consume.

## Acceptance Criteria

- [ ] A telemetry slice exists per endpoint in the ref-backed store,
      independent of the existing log-line slice.
- [ ] The ring buffer has its own explicit, documented cap, distinct
      from `MAX_LINES_PER_DEVICE`, and evicts oldest-first once full.
- [ ] `useTelemetry(endpointId)` is implemented via
      `useSyncExternalStore` and only notifies subscribers of that
      endpoint's telemetry slice — a component subscribed to a
      *different* endpoint's telemetry (or to no telemetry at all) does
      not re-render when a frame arrives for this endpoint (a test
      using a render-count spy proves this).
- [ ] A header-update message clears any "waiting for header" state for
      that endpoint.
- [ ] A frame-update message with no header held yet is handled
      gracefully (buffered, ignored, or flagged — whichever the store
      design chooses, it must not throw).

## Testing

- **Existing tests to run**: `npx vitest run packages/ui/src/ws` —
  confirm `WsProvider.test.tsx`'s existing cases (log buffer capping,
  snapshot application, existing selectors) are unaffected.
- **New tests to write**: ring-buffer cap/eviction behavior; the
  no-extra-re-render property of `useTelemetry` under a fake-socket
  burst of frames (reuse the shared `packages/ui/src/testing/`
  `FakeSocket` harness sprint 4 extracted); header-then-frame ordering;
  a frame arriving before any header.
- **Verification command**: `npx vitest run packages/ui`
