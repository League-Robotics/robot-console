---
id: '005'
title: 'UI: remembered-robot roster and forget affordance on the front page'
status: done
use-cases:
- SUC-002
- SUC-003
depends-on:
- '004'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# UI: remembered-robot roster and forget affordance on the front page

## Description

Surface the roster to the student, per `sprint.md`'s Architecture (Step 3,
"WsProvider.tsx additions" and "FrontPage.tsx additions") and SUC-002/
SUC-003. This is the last ticket in the sprint — it only consumes what
tickets 002-004 already put on the wire.

**`WsProvider.tsx`**: add a `rememberedRobots: RememberedRobotEntry[]`
field to the `Store` interface, initialized to `[]`. In `applySnapshot`,
set it from the incoming message the same way `firmwareStatus` is
handled — guard against `undefined` (an old-shaped message, or a test
fixture that omits the field) by keeping the previous value rather than
clobbering it with `undefined`:
```ts
if (rememberedRobots !== undefined) {
  store.rememberedRobots = rememberedRobots;
}
```
(`applySnapshot`'s signature gains a third parameter,
`rememberedRobots: RememberedRobotEntry[] | undefined`, threaded from the
`"endpoints"` case in the socket message handler exactly like
`firmwareStatus` already is.) Add a selector:
```ts
export function useRememberedRobots(): RememberedRobotEntry[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => store.rememberedRobots);
}
```
No new action is needed on `WsActions` — "forget" is sent via the
existing generic `send()`:
`useWsActions().send({ type: "forget-known-robot", name })`.

**`FrontPage.tsx`**: render a second section below (or above — a
stakeholder call, noted as an open question in `sprint.md`) the existing
attached-endpoint list, one card per `RememberedRobotEntry`:
- Robot's `name`.
- A human-readable relative or absolute rendering of `lastSeenAt` (e.g.
  `new Date(lastSeenAt).toLocaleString()` is sufficient this sprint — no
  new date-formatting dependency).
- A "Forget" button calling
  `send({ type: "forget-known-robot", name: entry.name })` on click.
- Visually greyed/muted (a CSS class distinct from `.device-card`, e.g.
  `.remembered-robot-card`) to distinguish it from an attached device.
- **Not** a `react-router` `Link` and not wrapped in one — per
  `sprint.md`'s Design Rationale, there is nowhere to navigate to this
  sprint.
- Only rendered when `rememberedRobots.length > 0` — no empty-state
  copy is needed for this section (the existing "No devices detected
  yet" empty state already covers the whole-page-empty case).

## Acceptance Criteria

All of the following are provable without hardware — pure component/
store-logic tests against fixture `EndpointsMessage`/`RememberedRobotEntry`
values, following `FrontPage.test.tsx`'s and `WsProvider.test.tsx`'s
existing patterns.

- [x] `useRememberedRobots()` returns `[]` before any `endpoints` message
      arrives, and the parsed `rememberedRobots` array after one does.
- [x] An `endpoints` message with no `rememberedRobots` field at all
      (simulating an old host) leaves the store's `rememberedRobots` at
      its previous value (starting at `[]`) rather than throwing or
      setting `undefined`.
- [x] `FrontPage`, given a fixture with one remembered robot and zero
      attached endpoints, renders that robot's name and a rendering of
      `lastSeenAt`, and renders **no** `<a>`/router `Link` for that card.
- [x] `FrontPage`, given a fixture with both an attached endpoint and a
      remembered robot with a different name, renders exactly one card
      for each — no accidental duplication or cross-rendering.
- [x] Clicking the "Forget" button calls the injected `send` action (via
      a mocked `useWsActions`) with exactly
      `{ type: "forget-known-robot", name: "<that robot's name>" }`.
- [x] With `rememberedRobots: []`, no remembered-robot section (and no
      empty-state copy for it) is rendered.

## Testing

- **Existing tests to run**: `npm test -w @robot-console/ui`, in
  particular `WsProvider.test.tsx` and any `FrontPage` test file — the
  `EndpointsMessage` fixtures they construct need a `rememberedRobots`
  field added (mirroring ticket 002's/004's fixture-update note on the
  host side).
- **New tests to write**: extend `WsProvider.test.tsx` with the selector/
  guard cases above; extend or create a `FrontPage.test.tsx` covering the
  rendering and forget-click cases, following `EndpointsList`/
  `EndpointCard`'s existing presentational-component test pattern
  (fixture `EndpointListEntry`/`RememberedRobotEntry` values in, no real
  WebSocket).
- **Verification command**: `npm test -w @robot-console/ui` and
  `npm run build`.
