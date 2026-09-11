---
id: '002'
title: 'Host: set/clear relayBridge across openRobotViaRelay''s connect/reset/handshake
  sequence'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '001'
github-issue: ''
issue: relay-card-must-show-radio-connection-state-not-just-linked.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Host: set/clear relayBridge across openRobotViaRelay's connect/reset/handshake sequence

## Description

Implement the state transitions designed in `sprint.md`'s Architecture
("State flow" diagram and Design Rationale) inside
`packages/host/src/deviceRegistry.ts`'s private `openRobotViaRelay`
(around line 2122) and its `toEntry` projection (around line 919), using
the `relayBridge` field ticket 001 added to `EndpointListEntry`/
`EndpointState`.

`EndpointState` itself (the in-memory type, distinct from the wire
`EndpointListEntry`) needs its own `relayBridge` field mirroring ticket
001's wire shape -- add it near `synthesizedRelayTarget` (around line
864), with a doc comment cross-referencing `openRobotViaRelay` the same
way `synthesizedRelayTarget` cross-references it. `toEntry` projects
`state.relayBridge` onto the wire entry, present-only-when-set, the same
way it already handles `nameError`/`sessionError` (see lines 956-961).

**Transitions to implement in `openRobotViaRelay`** (method body starts
at line 2122; step letters below match the existing lettered comments
already in the method):

1. **Connecting -- set immediately, before existing step (a).** After
   the existing early-return validation checks (no such device, wrong
   classification, no physical device, no serial port -- these must
   NOT set `relayBridge`; they reject the attempt via `emitError` alone,
   unchanged), set `relayState.relayBridge = { state: "connecting",
   ...(target.robotName !== undefined ? { robotName: target.robotName }
   : {}) }` and call `emitDevices()` -- before step (a)'s existing
   teardown of any previous synthesized child. This is what makes
   "Connecting to `<name>`…" appear immediately per SUC-001's acceptance
   criteria; see sprint.md's Design Rationale for why it goes here and
   not later.
2. **No-candidates path (around line 2198).** When
   `candidates.length === 0`, set `relayState.relayBridge = { state:
   "failed", error: <same message already passed to emitError> }`
   (build the message once, pass it to both -- see sprint.md Open
   Questions) before calling `connectAndIdentify(relayState)` and
   returning. `emitDevices()` must run with `relayBridge` set to
   `"failed"` at this point -- check whether `connectAndIdentify` itself
   calls `emitDevices()` (it likely does, as part of its own open flow)
   and confirm the failed state survives that call rather than being
   silently overwritten; if `connectAndIdentify` constructs a fresh
   partial state update, verify it doesn't clobber `relayBridge`.
3. **Exhausted path (around line 2213, `result.outcome === "exhausted"`).**
   Same treatment: build `triedNames` from `candidates.map(c => c.name)`
   (already computed for the existing `emitError` call), set
   `relayState.relayBridge = { state: "failed", ...(target.robotName !==
   undefined ? { robotName: target.robotName } : {}), triedNames, error:
   <same string already built for emitError> }`, before
   `connectAndIdentify(relayState)` and return. Do not remove or alter
   the existing `emitError` call -- both fire (per sprint.md Scope: "in
   addition to, not instead of").
4. **Success path (around line 2257-2274, after `synthesizedState` is
   built and `this.states.set(synthesizedId, synthesizedState)` runs).**
   Explicitly clear `relayState.relayBridge = undefined` before the
   final `emitDevices()` call at the end of the method, so the same
   snapshot that introduces the child endpoint never also carries a
   stale `"connecting"`/`"failed"` `relayBridge` -- see sprint.md's
   Design Rationale and SUC-002's acceptance criteria ("`relayBridge` is
   absent on the relay's entry in the same snapshot that introduces the
   child endpoint").

**Do not touch**: `requestClose` (around line 2295) and
`autoSwitchRadioToWifi` (around line 1662) tear down the synthesized
child through a different path than `openRobotViaRelay`'s own success
branch; per sprint.md Scope, this sprint doesn't change those flows, and
`relayBridge` should already be `undefined` by the time either runs
(cleared at step 4 above). Confirm this holds rather than adding new
clearing logic to either method -- if a gap is found where `relayBridge`
could still be `"connecting"`/`"failed"` when one of those runs, note it
in the ticket's completion notes rather than silently patching those
methods' unrelated logic.

## Acceptance Criteria

- [x] `EndpointState` (deviceRegistry.ts, near `synthesizedRelayTarget`)
      has a `relayBridge` field mirroring ticket 001's wire shape, with
      a doc comment.
- [x] `toEntry` projects `state.relayBridge` onto `EndpointListEntry`,
      present only when set.
- [x] `openRobotViaRelay`'s four early-validation error returns (no such
      device / wrong classification / no device / no port) do NOT set
      `relayBridge` -- confirmed by a test asserting `relayBridge` stays
      absent across each.
- [x] Immediately after a valid Connect is requested (named pick or
      no-pick), `relayBridge.state === "connecting"` is visible in the
      snapshot emitted before the reset/boot-delay/handshake sequence
      resolves -- asserted with a fake reset/link that resolves on a
      later tick.
- [x] On success, the final snapshot has the child endpoint AND
      `relayState.relayBridge === undefined` in the same emit.
- [x] On the no-candidates path and the exhausted path, `relayBridge ===
      { state: "failed", ... }` is set (and `emitError` still fires,
      unchanged) before the relay's own session is reopened via
      `connectAndIdentify`.
- [x] Switching robots (a second Connect while a child already exists,
      or immediately after a prior failure) overwrites `relayBridge`
      with a fresh `"connecting"` state -- no stale failure lingers past
      a new attempt.
- [x] `requestClose`/`autoSwitchRadioToWifi` are unmodified unless a real
      gap was found (see Description); if unmodified, a test confirms
      `relayBridge` is already absent when either runs in the normal
      (post-success) case.

## Completion Notes

- No gap found in `requestClose`/`autoSwitchRadioToWifi` -- both left
  unmodified, as the Description anticipated. `requestClose`'s
  synthesized-child branch never reads/writes `relayBridge` at all (that
  field lives only on the *relay's own* `EndpointState`, never the
  child's), and by the time a child exists to close, `relayBridge` was
  already cleared by `openRobotViaRelay`'s own success path (step 4).
  `requestClose`'s plain-endpoint branch (closing the relay directly)
  runs under the same `resourceKey`-keyed mutex slot as
  `openRobotViaRelay`, so it can never interleave with an in-flight
  "connecting" attempt. `autoSwitchRadioToWifi` only ever fires once a
  radio child is already open (`findSynthesizedRelayChildForName`),
  which likewise implies `relayBridge` was already cleared. Both claims
  are covered by an added assertion in each area's existing "normal,
  post-success" test rather than a new dedicated test, since the
  existing fixtures already set up exactly that precondition.
- The "no physical device recorded for relay" / "no serial port
  available for relay" early-validation branches are unreachable through
  `DeviceRegistry`'s normal attach/detach flow (a relay `classification`
  is only ever set after a successful identify over its own device's
  port in the first place -- see `openRobotViaRelay`'s own doc comment).
  Both are still defensive checks worth covering per the acceptance
  criteria, so their tests seed `DeviceRegistry`'s private `states` map
  directly (`(registry as unknown as { states: Map<...> }).states`) --
  the only way to reach them at all.

## Implementation Plan

**Approach**: Implement the four transition points above directly in
`openRobotViaRelay`, matching the existing method's style (mutate
`EndpointState` fields in place, call `emitDevices()` at existing
call sites where possible, add new ones only where the state flow
requires -- see step 1 above for the one genuinely new early emit).
Extend `toEntry` with one more present-only-when-relevant projection,
following the exact pattern already used for `nameError`/`sessionError`
immediately above it.

**Files to modify**:
- `packages/host/src/deviceRegistry.ts` -- `EndpointState` (new field),
  `openRobotViaRelay` (transitions), `toEntry` (projection).

**Testing plan**:
- Extend `packages/host/src/deviceRegistry.test.ts` with cases for: (a)
  connecting state appears immediately on a named-pick Connect; (b)
  connecting state appears on a no-pick Connect with no `robotName`;
  (c) success clears `relayBridge` in the same snapshot the child
  appears in; (d) no-candidates failure sets `relayBridge.state ===
  "failed"` with an `error` message; (e) exhausted-coordinator failure
  sets `relayBridge.state === "failed"` with `triedNames` and `error`;
  (f) the four early-validation error returns never set `relayBridge`;
  (g) a second Connect after a failure overwrites the failed state with
  a fresh connecting state.
- Run the full existing `openRobotViaRelay`-related test cases in the
  same file to confirm no regression to the existing
  candidate-building/coordinator/synthesis behavior.

**Documentation updates**:
- `openRobotViaRelay`'s own doc comment (starts around line 2095) --
  add a paragraph describing the `relayBridge` invariant (must be set
  before work begins, cleared on success, set on failure, never left
  stale), matching the existing doc comment's level of detail for the
  rest of the method's contract.

## Testing

- **Existing tests to run**: `npx vitest run packages/host/src/deviceRegistry.test.ts`
- **New tests to write**: see Implementation Plan's Testing plan (a-g)
  above, added to `deviceRegistry.test.ts`.
- **Verification command**: `npx vitest run packages/host/src/deviceRegistry.test.ts`
