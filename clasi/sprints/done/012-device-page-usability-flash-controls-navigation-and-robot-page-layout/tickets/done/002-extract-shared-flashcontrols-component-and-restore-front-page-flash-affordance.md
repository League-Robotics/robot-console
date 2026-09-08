---
id: '002'
title: Extract shared FlashControls component and restore front-page flash affordance
status: done
use-cases:
- SUC-002
depends-on:
- '001'
github-issue: ''
issue: flash-controls-unreachable-for-silent-boards-and-missing-from-every-device-page.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Extract shared FlashControls component and restore front-page flash affordance

## Description

Two remaining defects from the flash-controls issue: flash controls
need to render on the front-page card again (a sprint-004 regression —
`FrontPage.tsx`'s own doc comment records the deliberate removal), and
this sprint's later app-header Flash entry (ticket 004) needs the same
flash logic without duplicating it a third time.

Extract `UnknownDevicePage.tsx:136-328`'s body — the release-firmware
buttons, the local-hex upload handshake, progress rendering, and the
`onFlashResult`/`onFlashLocalReady` subscriptions — into a new,
standalone `packages/ui/src/components/FlashControls.tsx`, taking an
`endpoint: EndpointListEntry` prop and owning all of its own
flash/progress/upload state internally (move, don't duplicate:
`UnknownDevicePage` becomes a thin wrapper composing `FlashControls` +
`DeviceConsole`).

Then use `FlashControls` to restore the front-page card's flash
affordance: in `FrontPage.tsx`'s `EndpointCard`, render `FlashControls`
for a `canBeFlashed(device)` device (ticket 001's predicate) as a
sibling of the card's `Link`, not nested inside it — the entire card is
currently one `<Link>`, and a `<button>`/`<input>` nested inside an
`<a>` is invalid HTML that will fight the router's click handling.
Restructure the card markup so the `Link` wraps only the informational
region (name/role/port/etc.) and an action row sits beside it inside
the `<li>`.

This ticket also stabilizes the known intermittent flake in
`UnknownDevicePage.test.tsx` under full-suite parallelism as part of
migrating its assertions into the new `FlashControls.test.tsx` — do not
just relocate the flake into a renamed file. Investigate first (most
likely candidate: `crypto.subtle.digest`'s async local-hex hashing or a
`setTimeout`-based cooldown interacting with Vitest's per-file worker
isolation racing a `waitFor`/assertion that doesn't actually await the
async chain) and either fix the root cause or add the missing
await/isolation. Confirm stability by running the migrated suite
repeatedly (e.g. `npm test -- FlashControls --reporter=verbose` in a
loop, or vitest's repeat/retry flag set to 1) before considering this
criterion met — a single green run does not prove a flake is fixed.

## Acceptance Criteria

- [x] New `packages/ui/src/components/FlashControls.tsx` (+ `.css`)
      owns the release-flash buttons, local-hex handshake, progress
      rendering, and `onFlashResult`/`onFlashLocalReady` subscriptions,
      parameterized on an `endpoint` prop — moved from
      `UnknownDevicePage.tsx`, not duplicated.
- [x] `UnknownDevicePage.tsx` is reduced to a thin wrapper: header +
      `FlashControls` (gated on `canBeFlashed`) + `DeviceConsole`, with
      no independent flash logic of its own.
- [x] `FrontPage.tsx`'s `EndpointCard` renders `FlashControls` for a
      `canBeFlashed` device, as a sibling of the card's `<Link>` — not
      nested inside it.
- [x] A DOM-structure assertion (not just visual placement) confirms
      the card's `<a>` contains no `<button>`/`<input>` descendant.
- [x] The card's navigation (click on the informational region,
      middle-click, keyboard activation) still reaches `/d/:endpointId`
      with the restructured markup.
- [x] A `canBeFlashed` device's front-page card shows flash controls; a
      device that is not `canBeFlashed` shows none (no visual regression
      for the common "already identified" card).
- [x] `UnknownDevicePage.test.tsx`'s release/local-hex/progress/
      post-flash-navigation assertions are migrated to
      `FlashControls.test.tsx`, exercised against the standalone
      component.
- [x] The known intermittent flake is root-caused and fixed (or the
      missing await/isolation is added); the migrated suite is run
      repeatedly to confirm stability, not just once.

## Testing

- **Existing tests to run**: `npm test -- UnknownDevicePage FrontPage`
  (packages/ui), before and after the extraction, to confirm no
  behavior regression during the move.
- **New tests to write**: `FlashControls.test.tsx` (migrated +
  component-level tests against the standalone component);
  `FrontPage.test.tsx` additions for the restored card affordance and
  the DOM-nesting assertion.
- **Verification command**: `npm test` (repeated for the migrated
  suite specifically, per the flake-stabilization criterion above),
  `npm run build`.

## Implementation Plan

### Approach

Move first, verify no regression, then wire the new call site
(`FrontPage.tsx`). Keep `FlashControls`'s public contract to exactly one
prop (`endpoint`) so it has no knowledge of which page/card/panel hosts
it — this is what lets ticket 004's app-header Flash panel reuse it
without a third bespoke implementation.

### Files to create/modify

- `packages/ui/src/components/FlashControls.tsx`, `.css`,
  `.test.tsx` — new (bulk of the move from `UnknownDevicePage.tsx`).
- `packages/ui/src/pages/UnknownDevicePage.tsx`, `.css` — trimmed to a
  thin wrapper; `.test.tsx` trimmed to whatever remains page-specific
  (header rendering, `DeviceConsole` presence) after the migration.
- `packages/ui/src/pages/FrontPage.tsx`, `.css`, `.test.tsx` — card
  restructuring, `FlashControls` mount, new tests.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

`FlashControls.tsx`'s new module doc comment should state its "one
endpoint in, no knowledge of caller" contract explicitly, since three
different call sites (this ticket's `FrontPage`, the existing
`UnknownDevicePage`, and ticket 004's `AppHeader`) depend on that
contract holding.
