---
id: '007'
title: Router and front page
status: done
use-cases:
- SUC-001
- SUC-006
depends-on:
- '006'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Router and front page

## Description

Add `react-router` to `packages/ui`, replace `App.tsx`'s tab-bar shell
with `BrowserRouter`/`Routes`, and build the front page. No server
change is needed — `server.ts` already does SPA fallback
(`app.get(/.*/, ...)` serves `index.html` for any path).

**Routes this ticket adds:**
- `/` → `FrontPage` — the endpoint list, replacing `DevicesTab`'s
  rendering (minus per-row Connect/Disconnect and flash controls,
  which move to the per-device page in ticket 008 — see `sprint.md`'s
  "click a device, get its page" framing). Each row links to
  `/d/:endpointId`. Shows the same naming/role/error states
  `DevicesTab`/`DeviceCard` render today (naming pending, unnamed/
  flagged, unresponsive, HID-only, no serial port) — this is a
  presentation move, not a redesign of what's shown.
- `/d/:endpointId` → a placeholder route this ticket wires up but does
  not fully build out — ticket 008 owns the actual per-type dispatch
  and page content. This ticket's job is only to prove the route
  exists and reads the right endpoint via `useEndpoint(endpointId)`
  (ticket 006), rendering e.g. a minimal "device found: <name>" stub
  gated on `hasSnapshot`. Coordinate with ticket 008 on the exact
  hand-off shape (a `DevicePage` component this ticket creates as a
  thin shell, which ticket 008 fills in) so the two tickets don't
  duplicate route-registration work.

**Deep-link / `hasSnapshot` handling (SUC-001's alternate flow):**
before the first `endpoints` snapshot arrives, `/d/:endpointId` must
render a "loading" state, not "no such device" — read `useHasSnapshot()`
(ticket 006) to distinguish the two.

## Acceptance Criteria

- [x] `react-router` is added to `packages/ui/package.json` as a
      dependency; `App.tsx` wraps its content in `BrowserRouter` and
      `Routes` with `/` and `/d/:endpointId` registered.
- [x] `FrontPage` renders the live endpoint list with the same
      states/wording `DevicesTab`/`DeviceCard` render today (naming
      pending, flagged/unnamed, unresponsive, HID-only, no serial
      port, "no devices detected yet"), each row a link to
      `/d/:endpointId`.
- [x] Clicking a device row navigates to `/d/:endpointId` (a router
      test asserts the URL changes and the target route renders).
- [x] Deep-linking directly to `/d/:endpointId` before any `endpoints`
      snapshot has arrived renders a distinct "loading" state; once
      the snapshot arrives, it renders either the matched endpoint or
      a "no such device" state — the two states are distinguishable in
      a test (not just visually).
- [x] `App.tsx`'s old tab-bar (`Devices`/`Console` buttons,
      `activeTab` state) is removed.
- [x] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/ui/src/components/DevicesTab.test.tsx`
  (rendering assertions migrate to `FrontPage.test.tsx` — see below;
  confirm nothing is silently dropped), full `npm test`.
- **New tests to write**: `FrontPage.test.tsx` (list rendering states,
  migrated from `DevicesTab.test.tsx`'s presentational assertions,
  using a router test wrapper — e.g. `MemoryRouter` — to assert
  navigation on click); a router-level test for the `hasSnapshot`
  loading-vs-not-found distinction on `/d/:endpointId`.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Build `FrontPage` as a presentational component first
(mirroring `DevicesTab`'s existing `DevicesList`/`DeviceCard` split —
reuse `DeviceCard`'s rendering logic directly where possible, adding
only the link-to-page behavior and dropping the inline
Connect/flash actions), verify it against fixture data before wiring
up routing, then add `BrowserRouter`/`Routes` in `App.tsx` last.

**Files to create:**
- `packages/ui/src/router.tsx` (or inline in `App.tsx` if the
  programmer judges that clearer for two routes — keep it easy for
  ticket 008 to extend with nested routes later)
- `packages/ui/src/pages/FrontPage.tsx`
- `packages/ui/src/pages/FrontPage.test.tsx`
- `packages/ui/src/pages/DevicePage.tsx` (thin shell — see Description)

**Files to modify:**
- `packages/ui/package.json` (add `react-router`)
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/DevicesTab.tsx` /
  `DevicesTab.test.tsx` (retire once `FrontPage` fully covers its
  rendering — confirm with ticket 008 before deleting, since the
  per-row flash controls it currently owns move there, not here)

**Documentation updates:** `App.tsx`'s module doc comment currently
describes the tab-bar shell added by tickets 010/011 (sprint 1) —
replace with a description of the router mount and link to
`sprint.md`'s Architecture for the full navigation design.
