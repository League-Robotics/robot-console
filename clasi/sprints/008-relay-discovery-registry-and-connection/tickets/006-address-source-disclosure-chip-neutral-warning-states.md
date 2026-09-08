---
id: '006'
title: Address-source disclosure chip (neutral/warning states)
status: open
use-cases:
- SUC-006
depends-on:
- '004'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Address-source disclosure chip (neutral/warning states)

## Description

Create `packages/ui/src/components/AddressSourceChip.tsx`: a small,
persistent inline chip rendering an endpoint's `addressSource`
(ticket 004's `EndpointListEntry.addressSource`/`failoverTrail`
fields), styled per `sprint.md`'s Solution:

- **Neutral** when no registry was ever configured/discovered for this
  relay (the `local-derived` outcome with no registry attempt at all —
  the *normal* local-USB-relay classroom path, not an exceptional one,
  per the roadmap plan's finding).
- **Warning** when a registry *was* discovered and either failed to
  respond or answered `derived` (the registry only echoed its own
  just-made guess) — surfaced as prominently as a fallback, because
  that failure mode is identical to the registry simply not knowing.
- **Neutral**, stating the registry as the source, when the outcome is
  `"config"`/`"registry"` (the registry actually knew).

Text example from `sprint.md`: `Address: ch 37 / grp 3 · derived (no
registry)`. The chip is **never absent** when a relay-mediated,
non-`mbserial` session is open — this is the property SUC-006's
acceptance criteria check directly, not just the text content. No chip
renders for an `mbserial`-transport endpoint (nothing to disclose —
that transport has no address-source concept at all, per sprint 007's
Design Rationale).

This ticket builds the component standalone against fixture
`addressSource` data — it does not itself wire `RelayPage` to mount it
(ticket 005's job) — so it is fully testable and stylable in isolation
first.

## Acceptance Criteria

- [ ] All three resolution outcomes (`config`/`registry`, `derived`,
      `local-derived`) render with correct text and the correct
      neutral/warning styling, driven entirely by fixture props (no
      live registry, no `WsProvider` dependency in this component's own
      tests).
- [ ] `local-derived` with no registry ever discovered renders neutral;
      `local-derived`/`derived` with a registry that was discovered but
      not authoritative renders warning — these are two different input
      shapes to the same `"local-derived"`-adjacent styling decision;
      the component's prop shape must let a caller distinguish them
      (e.g. a `registryWasConsidered: boolean` alongside the outcome
      tag, or equivalent — pick a concrete shape and document it).
- [ ] The chip renders the current `(channel, group)` alongside the
      source text, per the example format in `sprint.md`.
- [ ] Passing `undefined`/no `addressSource` prop renders nothing (the
      chip's own not-applicable case) — callers (ticket 005) are
      responsible for not mounting it for an `mbserial` endpoint, but
      the component itself degrades safely if it ever is.
- [ ] `npm test` and `npm run build` pass.

## Testing

- **Existing tests to run**: `npm test -- ui` (packages/ui), to confirm
  no regression in existing component tests.
- **New tests to write**: `AddressSourceChip.test.tsx` covering every
  acceptance criterion above via React Testing Library, fixture props
  only.
- **Verification command**: `npm test`, `npm run build`.

## Implementation Plan

### Approach

Depends on ticket 004 for `EndpointListEntry.addressSource`'s exact
shape. Build as a small, prop-driven, stateless component — no
`WsProvider` selector reads inside this component itself, so it stays
trivially testable and reusable if a future sprint wants the same chip
elsewhere.

### Files to create/modify

- `packages/ui/src/components/AddressSourceChip.tsx` — new.
- `packages/ui/src/components/AddressSourceChip.css` — new (or
  co-located styles, matching this package's existing per-component CSS
  convention, e.g. `RelayPage.css`).
- `packages/ui/src/components/AddressSourceChip.test.tsx` — new.

### Testing plan

See Acceptance Criteria / Testing above.

### Documentation updates

Component doc comment stating the neutral/warning decision rule
plainly (quoting or closely paraphrasing `sprint.md`'s Solution
section), since getting this rule backwards (warning when it should be
neutral, or vice versa) is exactly the alarm-fatigue-vs-silence failure
mode this sprint's design exists to avoid.
