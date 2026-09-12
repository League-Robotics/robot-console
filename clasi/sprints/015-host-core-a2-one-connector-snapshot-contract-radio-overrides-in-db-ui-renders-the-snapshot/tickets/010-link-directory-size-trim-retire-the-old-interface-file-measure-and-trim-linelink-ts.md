---
id: '010'
title: "link/ directory size trim: retire the old interface file, measure and trim LineLink.ts"
status: open
use-cases: []
depends-on:
- '003'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# link/ directory size trim: retire the old interface file, measure and trim LineLink.ts

## Description

Carried forward from sprint 014 ticket 006: once the four old link
classes are deleted (ticket 003), measure `packages/host/src/link/`
(including tests) against rearch-04's ~900-line target and trim
`LineLink.ts` (591 lines vs. a ~250-line estimate) if it still doesn't
fit.

Also confirmed during this sprint's planning: `link/Link.ts` (the old
`Link`/`LinkSpec`/`LinkFactory` interface) has no importers left once
`deviceRegistry.ts` and the four old link classes are gone (ticket 003)
except `usbWatcher.test.ts`'s stubbed-connector fake, which ticket 003
already updates to use the real connector/reconciler seam. Delete
`link/Link.ts` as part of this ticket, after confirming with a grep that
nothing new (connector, reconciler, harvester, watchers) references it.

Measure what remains: `LineLink.ts` (591), `LineRouter.ts` (110),
`lineStream.ts` (90), `pacing.ts` (70), `adapters/serialStream.ts` (185),
`adapters/tcpStream.ts` (181), `RelayCommandPlane.ts` (443, retained —
the connector's preamble builder), plus their tests. If the total still
exceeds the ~900-line non-test target, trim `LineLink.ts` first (the
single largest gap between actual and estimate) rather than spreading
cuts across every file.

## Acceptance Criteria

- [ ] `link/Link.ts` deleted; `grep -rn "link/Link['\"]\|LinkSpec\|LinkFactory" packages/host/src` returns nothing.
- [ ] A line count of `packages/host/src/link/` (source only, excluding
      tests) is recorded in the ticket's implementation notes at both
      "before this ticket" and "after this ticket."
- [ ] If the post-deletion total still exceeds ~900 lines, `LineLink.ts`
      is measurably reduced (target: closer to the original ~250-line
      estimate) with no loss of behavior — all existing `LineLink.test.ts`
      cases still pass.
- [ ] If the total already fits within ~900 lines after deleting
      `Link.ts` alone, no further trimming is required — record that
      finding rather than trimming for its own sake.
- [ ] `npx vitest run packages/host/src/link` is green after any trim.

## Implementation Plan

**Approach**: Measure first, decide, then act — this ticket may turn out
to be "delete `Link.ts`, record that the target is already met," which
is a legitimate outcome, not a shortfall. Only trim `LineLink.ts` if the
measurement says to.

**Files to delete**: `packages/host/src/link/Link.ts`.

**Files to potentially modify**: `packages/host/src/link/LineLink.ts`
(only if the post-deletion measurement requires it — likely candidates
for extraction are the pacer and reassembler logic into
`lineStream.ts`/`pacing.ts` if they are currently duplicated rather than
reused).

**Testing plan**:
- Run `npx vitest run packages/host/src/link` before and after to
  confirm no regression.
- Record line counts (`wc -l`) before/after in the ticket's completion
  notes.

**Documentation updates**: none.
