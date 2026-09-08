---
id: '004'
title: 'App header: route-aware back-to-devices link and Flash menu'
status: open
use-cases:
- SUC-003
- SUC-004
depends-on:
- '002'
github-issue: ''
issue:
- flash-controls-unreachable-for-silent-boards-and-missing-from-every-device-page.md
- device-page-needs-a-back-button-to-the-device-list.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# App header: route-aware back-to-devices link and Flash menu

## Description

This ticket finishes both remaining device-page-usability issues:

**Back button.** `DevicePage.tsx:57-68` renders "Back to devices" only
in the not-connected branch; the loading (`!hasSnapshot`) branch and all
three successful per-type pages (`RelayPage`, `RobotPage`,
`UnknownDevicePage`) have no way back. Fix with a route-aware
`AppHeader` component (per the linked issue's own recommended option),
mounted in `App.tsx` in place of the current static `<h1>`-only header,
shown above `<AppRoutes />` for every route. It renders a back-to-`/`
link whenever the current route is not `/`. This covers all five
device-page states in one place — including the loading state, which
`DevicePage.tsx` never needs to special-case for this — and keeps the
control in one stable screen position as the student moves between
device types. Remove `DevicePage.tsx`'s existing not-connected-branch
`<Link>`; `AppHeader` is now the single source of the back control (no
state should render two).

**Flash top-menu entry.** No page currently offers a way to reflash an
already-identified device (`grep` for `flash` in `RelayPage.tsx`/
`RobotPage.tsx` returns nothing). Add a Flash entry to `AppHeader`,
enabled whenever the current route resolves to a real endpoint (any of
`relay`/`robot`/`unknown`), opening ticket 002's shared `FlashControls`
for that endpoint. Reflashing an **identified** device (`relay`/`robot`)
requires an explicit confirmation step first — a reflash of a working
device is more destructive than recovering a dead one (per the linked
issue's own flag; this sprint decides to require confirmation as the
safer default — see `sprint.md`'s Design Rationale). An `unknown`
device's Flash entry opens `FlashControls` directly, matching the
existing per-page flow.

**Route matching.** `AppHeader` sits outside `DevicePage`'s route tree
(a sibling of `<AppRoutes />`, not a descendant), so it cannot use
`useParams`. Use `react-router`'s `useMatch("/d/:endpointId")`
(`react-router@8.3.1` is already installed) to detect a device-page
route and extract `endpointId`, rather than hand-rolling a regex against
`location.pathname` — this reuses the same path-matching engine
`router.tsx`'s route table is built on. Resolve the endpoint itself via
`useEndpoint(endpointId)` (already exported by `WsProvider`), same as
`DevicePage.tsx` does.

## Acceptance Criteria

- [ ] New `packages/ui/src/components/AppHeader.tsx` (+ `.css`), mounted
      in `App.tsx` inside `<BrowserRouter>` above `<AppRoutes />`.
- [ ] A back-to-`/` link renders on every route other than `/`,
      including: the loading (`!hasSnapshot`) state, the not-connected
      state, and all three successful per-type pages.
- [ ] The link has an accessible name (not icon-only) and is reachable
      by keyboard.
- [ ] `DevicePage.tsx`'s existing not-connected-branch `<Link>` is
      removed; no device-page state renders two back controls.
- [ ] A Flash menu entry is present and enabled whenever `useMatch`
      resolves a `/d/:endpointId` route with a matching endpoint in the
      current snapshot.
- [ ] Selecting Flash for `unknown` opens `FlashControls` for that
      endpoint directly.
- [ ] Selecting Flash for `relay`/`robot` requires an explicit
      confirmation step before `FlashControls` opens; declining the
      confirmation leaves `FlashControls` unopened.
- [ ] `AppHeader` uses `useMatch`/`useLocation`, not a hand-rolled
      `location.pathname` regex.
- [ ] `use-cases`/tests updated across `DevicePage.test.tsx`,
      `RelayPage.test.tsx`, `RobotPage.test.tsx`,
      `UnknownDevicePage.test.tsx`/`FlashControls.test.tsx` to assert
      the back link and Flash entry per state, per the linked issue's
      own note that these files already render through
      `renderWithRouter`/`withRouter` so this is cheap.

## Testing

- **Existing tests to run**: `npm test -- DevicePage RelayPage
  RobotPage UnknownDevicePage FlashControls App` (packages/ui).
- **New tests to write**: `AppHeader.test.tsx` (new) covering all five
  device-page states plus `/`; confirmation-required-for-identified-
  device behavior; page-test additions listed above.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

`AppHeader` reads route state via `useLocation`/`useMatch` and endpoint
state via `useEndpoint`, exactly mirroring how `DevicePage.tsx` already
reads the same data — no new data-fetching pattern introduced. The
confirmation step can be a native `confirm()` call or a small in-page
dialog; either satisfies the acceptance criteria, implementer's choice,
documented in the component's own doc comment (flagged in `sprint.md`'s
Open Questions as worth stakeholder review once built).

### Files to create/modify

- `packages/ui/src/components/AppHeader.tsx`, `.css`, `.test.tsx` — new.
- `packages/ui/src/App.tsx` — mount `AppHeader`, remove the static
  `<h1>`-only header.
- `packages/ui/src/pages/DevicePage.tsx`, `.css` — remove the
  not-connected-branch back link; `.test.tsx` — remove the assertion
  that was pinned to it (superseded by `AppHeader.test.tsx`'s coverage).
- `packages/ui/src/pages/RelayPage.test.tsx`,
  `packages/ui/src/pages/RobotPage.test.tsx`,
  `packages/ui/src/pages/UnknownDevicePage.test.tsx`/
  `FlashControls.test.tsx` — back-link and Flash-entry assertions.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`AppHeader.tsx`'s module doc comment should record why it lives outside
the route tree and parses route state via `useMatch` rather than
`useParams` (see `sprint.md`'s Design Rationale), and should state the
confirmation-step decision (native `confirm()` vs. in-page dialog) and
that its exact UX is flagged for stakeholder review.
