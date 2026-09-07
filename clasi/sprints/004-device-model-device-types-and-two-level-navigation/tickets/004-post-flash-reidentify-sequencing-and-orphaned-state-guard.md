---
id: '004'
title: Post-flash reidentify sequencing and orphaned-state guard
status: open
use-cases: ["SUC-004", "SUC-005"]
depends-on: ["003"]
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Post-flash reidentify sequencing and orphaned-state guard

## Description

Fix the two concrete bugs the roadmap issue's "finding 5" documents in
`runFlash`, both real defects in shipped code, independent of the
type-union/navigation work but naturally part of this same
connection-model sprint:

1. **Post-flash type flicker.** Today, `runFlash` clears `flashStatus`
   and emits `flash-result ok` **before** calling `openLink`
   (`this.openLink(state)` runs after `emitFlashResult`). A client
   navigating on `ok` sees the pre-flash type for up to the open
   timeout, then it changes underneath it. Fix: add
   `"reidentifying"` to `FlashPhase` (already typed in ticket 001)
   between `"resetting"` and the terminal result; after a successful
   write, set phase to `"reidentifying"`, call `connect()`+`identify()`
   (ticket 002's split) with a **distinct** `reidentifyTimeoutMs`
   (~8s, vs. the 3s open timeout) and **one retry** on a `null`
   identify; only then emit `flash-result`, carrying
   `classification`/`name` from whatever `identify()` returned (real
   banner, or `unknown` if it never came back), plus
   `reidentify: "timeout"` in the latter case. `flashStatus` is
   cleared only at this final emission, not before.
2. **Orphaned-state guard.** `runFlash` lacks the
   `this.states.get(id) !== state` staleness check that
   `resolveNameAndOpen`/`openLink` already have (ticket 002/003's
   reshaped registry — check under whatever name the state map/object
   ended up with after ticket 003). A board that re-enumerates
   mid-flash (the watcher reports remove+add for a "modified" device)
   orphans the in-flight `runFlash`'s state object; every write in
   `runFlash` (`setFlashPhase`, `failFlash`, the final reidentify
   result) must check the guard before mutating or emitting, exactly
   like the sibling code paths, and silently drop the write if the
   state is no longer live.

## Acceptance Criteria

- [ ] `FlashPhase` reidentify sequencing: after a successful write,
      phase advances to `"reidentifying"` (emitted via the existing
      flash-progress channel) before any `flash-result` is sent.
- [ ] `flash-result` on success carries `classification`/`name`
      reflecting the **post-flash** identity — a test asserts the
      classification differs from the pre-flash one when the fake
      link's post-reidentify banner differs, and that no intermediate
      snapshot in between shows the old type as if flashing had
      already completed.
- [ ] Reidentify uses a distinct timeout (not the 3s open timeout) and
      retries exactly once on a `null` identify before giving up.
- [ ] A reidentify that never succeeds (both attempts return `null`)
      emits `flash-result { status: "ok", classification: { type:
      "unknown", ... }, reidentify: "timeout" }` — **not**
      `status: "error"` — since the write itself succeeded.
- [ ] `flashStatus` is cleared exactly once, at the final
      `flash-result` emission (success or error) — not earlier, tested
      by asserting `flashStatus` is still present in the snapshot
      during the `"reidentifying"` phase.
- [ ] Every state-mutating step inside `runFlash` (progress, failure,
      and the new reidentify tail) checks the staleness guard;
      orphaning the state mid-flash (simulate a remove+add in a test,
      as `deviceRegistry.test.ts` likely already does for
      `resolveNameAndOpen`) results in no mutation of the live
      (re-added) endpoint's state and no `flash-result` emitted
      against the stale id.
- [ ] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/host/src/deviceRegistry.test.ts`
  in full (this ticket touches `runFlash` directly), full `npm test`.
- **New tests to write**: reidentify-success case (classification
  changes, no flicker); reidentify-timeout case (`reidentify:
  "timeout"`, status still `"ok"`); one-retry behavior (assert
  `identify()` is called exactly twice on a `null`/`null` sequence,
  not more); the orphaned-state guard test described above, mirroring
  whatever fixture pattern `resolveNameAndOpen`'s existing orphaning
  test already uses.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Write the orphaned-state guard first (small, mechanical,
directly testable in isolation against the current `runFlash`), then
build the reidentify tail on top of it, so the guard is already in
place protecting the new code as it's written rather than bolted on
after.

**Files to modify:**
- `packages/host/src/deviceRegistry.ts`
- `packages/host/src/deviceRegistry.test.ts`

**Documentation updates:** Update `requestFlash`/`runFlash`'s existing
doc comments (which currently describe "flashStatus is never left set
past the end of this task" and the mutex-scope rationale) to describe
the new reidentify tail and cite this ticket's fix for finding 5 in
the roadmap issue, so a future reader sees why `openLink`'s old
call-then-immediately-emit-result shape changed.
