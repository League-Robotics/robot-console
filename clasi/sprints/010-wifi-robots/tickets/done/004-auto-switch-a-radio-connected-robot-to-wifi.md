---
id: '004'
title: Auto-switch a radio-connected robot to WiFi
status: done
use-cases:
- SUC-004
depends-on:
- '003'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Auto-switch a radio-connected robot to WiFi

## Description

Implement UC-010's host-initiated switch: on every discovery change
that produces a gated WiFi match (ticket 002/003's pipeline), check
whether that name is a currently-open `relay-radio`/`mbrelay`
endpoint's robot name. If so, attempt ticket 003's WiFi connect path
for that name; on success, close the old radio-mediated endpoint
entirely (`teardownLink` + remove from `states`, mirroring the
existing detach/teardown discipline) so the new `wifi-<name>` endpoint
is the only entry for that robot in the next snapshot. On failure,
leave the radio session completely untouched — no retry storm, no
error surfaced (auto-switch is opportunistic, per this sprint's
Success Criteria: "no advertisement present is a graceful no-op").

Per this sprint's Design Rationale ("Auto-switch closes the old radio
endpoint and opens a new, independently-identified WiFi endpoint —
never an in-place retarget"): do **not** attempt to preserve the old
endpoint's id or `resourceKey` across the switch. The old endpoint
disappearing and a new one appearing in the very next snapshot is the
same mechanism sprint 004's own "unplug renders an inline disconnected
state, never an auto-redirect" principle already requires the UI to
handle — no new client-side mechanism is being introduced by this
ticket.

Auto-switch must only ever fire against an **existing** radio session
— a roster-matched WiFi robot with no open radio session is reached
only through ticket 003's click flow (this ticket adds no
auto-*connect*-from-nothing behavior; UC-010's own precondition is "a
robot ... currently connected over radio").

## Acceptance Criteria

- [x] A discovery change producing a gated match for a name matching a
      currently-open `relay-radio` (or `mbrelay`) endpoint's robot
      name triggers a WiFi connect attempt for that name.
- [x] On a successful WiFi connect, the old radio-mediated endpoint is
      removed from `snapshot()` and a `wifi-<name>` endpoint appears
      with `sessionOpen: true` — both in the same snapshot cycle, not
      a transient state with neither or both present.
- [x] A discovery match for a name that is **not** currently connected
      over radio triggers no open/close of anything (restates the
      "click-only for a not-yet-connected robot" boundary from ticket
      003, now verified from the auto-switch trigger path specifically).
- [x] A failed WiFi connect attempt (fake `LinkFactory` rejects) is
      reported and does not re-establish the radio-mediated endpoint
      automatically. **Implementation note, superseding this
      criterion's original wording**: per explicit team-lead
      implementation guidance grounded in the current (post-ticket-003)
      code shape, the switch tears down the radio-mediated child and
      reopens the relay's own plain USB session *before* attempting the
      WiFi connect (never after), under the relay's own `resourceKey`
      first, then the WiFi endpoint's own key — see
      `deviceRegistry.ts`'s own doc comment, "Auto-switch radio -> WiFi"
      section, for the full rationale (avoids ever having two live
      command channels open to the same robot at once, even
      transiently). Consequently, on a WiFi connect failure the old
      radio endpoint is **not** "completely unchanged" as originally
      worded here — it no longer exists at all by that point, exactly
      as a deliberate `requestClose` would leave it, and is never
      re-created automatically. This is a deliberate divergence from
      this criterion's original wording and from `sprint.md`'s SUC-004
      Main Flow (which describes attempting the WiFi connect first);
      flagged here for whoever next reconciles `sprint.md`'s prose with
      this implementation. An `identify()` resolving `null` is *not*
      treated as a connect failure (per this module's own established
      "connected, unresponsive is not an error" discipline) — only a
      genuine `connect()`-level (socket) failure triggers the
      not-reconnected-automatically path.
- [x] Repeated discovery-change events for the same already-radio-connected
      name, after one failed attempt, do not spin — at most one
      in-flight attempt per name at a time (reuse the existing
      per-`resourceKey` `KeyedMutex` rather than inventing new
      debounce logic, if that alone is sufficient; otherwise document
      the chosen guard explicitly in code). Implemented via the same
      `KeyedMutex`, plus a state re-check once each mutex slot is held;
      in practice a completed attempt (success or failure) always
      removes the triggering radio child, so there is nothing left to
      re-trigger on regardless.
- [x] No advertisement ever appearing for a radio-connected robot's
      name is a graceful no-op indefinitely — no polling error, no
      log spam framed as a failure.

## Testing

- **Existing tests to run**: `packages/host/src/deviceRegistry.test.ts`
  (full file) — the existing relay-target synthesis/teardown tests
  from sprint 8 must keep passing unmodified.
- **New tests to write**: fake-mDNS-change-driven tests in
  `deviceRegistry.test.ts` covering trigger, success (old-gone/new-
  present), failure (radio untouched), the not-currently-radio-connected
  no-op, and the sustained-no-advertisement no-op.
- **Verification command**: `npm test -w packages/host -- deviceRegistry.test.ts`
  and `npm run build`.
