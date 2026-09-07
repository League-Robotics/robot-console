---
id: '006'
title: WsProvider ref-backed store, selectors, and hoisted log buffer
status: open
use-cases: ["SUC-001", "SUC-006", "SUC-007"]
depends-on: ["001"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# WsProvider ref-backed store, selectors, and hoisted log buffer

## Description

Rewrite `WsProvider.tsx`'s internals from React `useState` (which
recreates the context value on every message) to a ref-backed store
with an explicit subscribe API via `useSyncExternalStore`, so a
consumer only re-renders when the slice of state it actually reads
changes. This is a prerequisite for sprint 8's 20Hz telemetry, not a
cleanup for its own sake — todays's whole-context-value approach would
re-render every consumer on every telemetry frame.

**Store shape (internal, ref-backed):**
- `endpoints: Map<string, EndpointListEntry>` (or array — programmer's
  choice, but lookups by `endpointId` must be O(1) for the selector
  hooks below).
- `hasSnapshot: boolean` — `false` until the first `type: "endpoints"`
  message is processed, `true` forever after (survives reconnects —
  do not reset to `false` on a `close`/reconnect cycle, since the last
  known snapshot is still meaningful per `WsProvider`'s existing "never
  destabilize the list" precedent for the whole-list case).
- `firmwareStatus` (unchanged shape from ticket 001).
- `logsByEndpoint: Record<string, LogEntry[]>` — the hoisted buffer,
  moved here from `ConsoleTab.tsx`'s local state verbatim in behavior
  (same `MAX_LINES_PER_DEVICE` cap, same append-and-trim logic),
  keyed by `endpointId`.
- `status: ConnectionStatus` (unchanged).

**Public API (replaces the current `useWs()` whole-context hook):**
- `useConnectionStatus(): ConnectionStatus`
- `useHasSnapshot(): boolean`
- `useEndpoints(): EndpointListEntry[]` (for the front page's list —
  still one subscription, since the front page legitimately needs the
  whole list; this is not the render-storm case telemetry will be)
- `useEndpoint(endpointId: string): EndpointListEntry | undefined`
  (subscribes only to that one endpoint's slice)
- `useEndpointLog(endpointId: string): LogEntry[]` (subscribes only to
  that one endpoint's log)
- `useFirmwareStatus(): Record<FirmwareKind, FirmwareAvailability>`
- `useWsActions(): { send, onFlashResult }` (or similar — the
  imperative surface existing components already use, largely
  unchanged; `onLine`/`onError` may no longer need to be exposed
  publicly if their only consumer becomes internal store-population
  logic — programmer's judgment, but do not remove capability existing
  code depends on without checking every call site first)

Keep the existing socket lifecycle (connect, reconnect on close,
teardown on unmount, injectable `socketFactory`/`url` for tests)
**unchanged** — this ticket changes how state is exposed to consumers,
not how the socket itself behaves.

**Extract the shared test harness:** `FakeSocket` is duplicated
verbatim in `DevicesTab.test.tsx` and `ConsoleTab.test.tsx` today.
Move it to `packages/ui/src/testing/FakeSocket.ts` (or
`testing/index.ts`), and update both test files (plus whatever new
test file exercises the store directly) to import it from there.

## Acceptance Criteria

- [ ] A component subscribed only to `useEndpoint("A")` does **not**
      re-render when a `type: "line"` message arrives for a different
      endpoint, or when `endpoint B`'s state changes — verified by an
      explicit render-count assertion in a test (per `sprint.md`'s
      Success Criteria: "verified via render counts in a test, not by
      inspection").
- [ ] A component subscribed only to `useEndpointLog("A")` does not
      re-render on an `endpoints` snapshot update that leaves A's log
      untouched.
- [ ] `hasSnapshot` is `false` before the first `endpoints` message,
      `true` after, and stays `true` across a reconnect (simulate
      close → reconnect in a test).
- [ ] The hoisted log buffer preserves `ConsoleTab`'s existing
      behavior exactly: append order, `MAX_LINES_PER_DEVICE` trimming
      from the front, independent per-endpoint buffers.
- [ ] `FakeSocket` exists in exactly one place
      (`packages/ui/src/testing/`) and both `DevicesTab.test.tsx` and
      `ConsoleTab.test.tsx` import it from there with no behavior
      change to either test file's assertions.
- [ ] Every existing `WsProvider`-dependent test (`DevicesTab.test.tsx`,
      `ConsoleTab.test.tsx`) passes against the new hook surface —
      update call sites (`useWs()` → the new selector hooks) without
      changing what each test asserts.
- [ ] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/ui/src/components/DevicesTab.test.tsx`,
  `packages/ui/src/components/ConsoleTab.test.tsx`, full `npm test`.
- **New tests to write**: a new `WsProvider.test.tsx` (or similar)
  covering the render-count-isolation assertions above, the
  `hasSnapshot` transition, and the hoisted log buffer's cap/order
  behavior directly against the store, independent of any consuming
  component.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Build the ref-backed store and its selector hooks first,
with a throwaway/minimal consumer to prove render isolation, before
touching `DevicesTab.tsx`/`ConsoleTab.tsx`'s call sites — this lets the
store's correctness be established independent of the two existing
components' own logic. Extract `FakeSocket` as an early, separate step
since it's needed by the new `WsProvider.test.tsx` anyway.

**Files to create:**
- `packages/ui/src/testing/FakeSocket.ts`
- `packages/ui/src/ws/WsProvider.test.tsx`

**Files to modify:**
- `packages/ui/src/ws/WsProvider.tsx`
- `packages/ui/src/components/DevicesTab.tsx` (hook call sites only —
  `useWs()` → new selectors; full front-page extraction is ticket 007)
- `packages/ui/src/components/DevicesTab.test.tsx` (import `FakeSocket`
  from `testing/`)
- `packages/ui/src/components/ConsoleTab.tsx` (hook call sites; log
  state moves out of local `useState` into `useEndpointLog`)
- `packages/ui/src/components/ConsoleTab.test.tsx` (import `FakeSocket`
  from `testing/`)

**Documentation updates:** Rewrite `WsProvider.tsx`'s module doc
comment — it currently documents a `useState`-based single context
value; replace with the ref-backed store's rationale (cite the
render-storm-at-20Hz reason directly, matching `sprint.md`'s Design
Rationale) and document each exported selector hook's subscription
granularity.
