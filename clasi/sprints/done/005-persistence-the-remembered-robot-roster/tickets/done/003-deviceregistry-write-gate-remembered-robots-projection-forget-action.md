---
id: '003'
title: 'DeviceRegistry: write gate, remembered-robots projection, forget action'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on:
- '001'
- '002'
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# DeviceRegistry: write gate, remembered-robots projection, forget action

## Description

Wire `KnownRobotsStore` (ticket 001) into `deviceRegistry.ts`, per
`sprint.md`'s Architecture (Step 3, "deviceRegistry.ts additions") and
Step 5 ("What Changed"). This is the ticket that actually makes the
roster durable in response to live USB activity, and derives the
front-page-facing "remembered" view from it.

**Construction**: `DeviceRegistryOptions` gains an optional
`knownRobotsStore?: KnownRobotsStore` seam, defaulting to
`new KnownRobotsStore()` (the real, state-dir-backed store) — mirrors
every other injected seam on this class (`resolveName`, `createLink`,
`getFirmwareConfig`, `flash`, `consumeUpload`). Tests inject a store
pointed at a temp directory, or a fully fake object satisfying the same
narrow interface.

**Write gate** (`sprint.md`'s Design Rationale: "the write gate is
`classification.type === "robot"`, with no separate `evidence` check"):
add a private method
```ts
private maybeRecordKnownRobot(state: EndpointState): void {
  if (state.name === null) return;
  if (state.classification.type !== "robot") return;
  this.knownRobotsStore.recordSighting({
    name: state.name,
    usbSerial: state.device.serialNumber,
    role: state.classification.role,
  });
}
```
Call it from **both** places `state.classification` is assigned from a
live banner:
- `connectAndIdentify`, immediately after
  `state.classification = classifyBanner(banner);` (around line 1228).
- `succeedFlash`, immediately after `state.classification = classification;`
  (around line 955) — a flash can turn an `unknown` device into a
  correctly-classified `robot` (e.g. flashing robot firmware onto a
  blank board), and the post-flash reidentify is exactly as much "a
  successful USB identify with banner evidence" as the plain attach
  flow.

Do **not** call it from `reidentifyAfterFlash`'s early-return branches
that call `succeedFlash(..., classifyBanner(null), ...)` on a
reconnect/timeout failure — `succeedFlash` itself already only records
when the classification it was called with is `type: "robot"`, so this
falls out of the guard automatically and needs no special-casing.

**`rememberedRobots()` projection**:
```ts
rememberedRobots(): RememberedRobotEntry[] {
  const attachedNames = new Set(
    [...this.states.values()]
      .map((s) => s.name)
      .filter((n): n is string => n !== null),
  );
  return this.knownRobotsStore
    .list()
    .filter((r) => !attachedNames.has(r.name))
    .map((r) => ({
      name: r.name,
      lastSeenAt: r.lastSeenAt,
      lastSeenVia: r.lastSeenVia,
      lastRole: r.lastRole,
      lastUsbSerial: r.lastUsbSerial,
    }));
}
```
This is the "don't duplicate what's currently attached" filter from
`sprint.md`'s Architecture — it needs `states` (private to this class),
which is exactly why this projection lives here and not in
`KnownRobotsStore` itself.

**Forget action**:
```ts
requestForgetKnownRobot(name: string): void {
  this.knownRobotsStore.forget(name);
  this.emitDevices();
}
```
Synchronous and not run through `KeyedMutex` — it touches no physical
resource, only the store's in-memory map (see `sprint.md`'s Step 7 open
question on the forget/recordSighting race, which is accepted as-is).
`emitDevices()` triggers the existing `devicesListeners` → `server.ts`
broadcast path; no new event type is needed.

## Acceptance Criteria

Label each criterion explicitly, per `sprint.md`'s Verification note.

- [x] (provable without hardware) A `FakeLink` identifying with
      `banner({ role: "NEZHA2", commonName: "robot" })` and a resolved
      name results in `registry`'s injected `KnownRobotsStore.list()`
      containing a record for that name (assert via a real
      `KnownRobotsStore` pointed at a temp dir, or a fake store
      recording calls — either is acceptable; prefer the real store for
      an end-to-end check plus a fake for call-shape assertions).
- [x] (provable without hardware) A `FakeLink` identifying with the
      existing default `banner()` fixture (role `RADIORELAY`, commonName
      `relay`) does **not** enrol anything — `list()` stays empty. This
      is the sprint's explicitly-required negative case.
- [x] (provable without hardware) A device whose name resolution fails
      (`state.name === null`) never enrols even when its classification
      is `type: "robot"`.
- [x] (provable without hardware) A device that identifies as `robot`,
      is then flashed, and re-identifies (via `reidentifyAfterFlash`) as
      `robot` again still enrols/refreshes correctly through
      `succeedFlash`'s call site.
- [ ] (needs a board) A **real** robot identifying over USB actually
      enrols end to end. Hardware-deferred — no robot is currently
      attached (all three boards on hand classify as `relay`). Do not
      check this off until a robot board is available; the fake-link
      cases above are what stand in for it this sprint.
- [x] (provable without hardware) `rememberedRobots()` returns a known
      name that is not currently attached, and excludes a known name
      that *is* currently attached (construct a registry with a
      pre-populated store record whose name matches a currently-attached
      fixture device's resolved name, and assert it's absent from
      `rememberedRobots()` but present in `snapshot()`).
- [x] (provable without hardware) `requestForgetKnownRobot` removes the
      record from a subsequent `rememberedRobots()` call and triggers a
      `devicesListeners` notification (assert the registered
      `onDevicesChanged` callback fires).
- [x] (provable without hardware) `requestForgetKnownRobot` for a name
      not in the roster does not throw and does not notify spuriously in
      a way that breaks any existing assertion (a notification firing
      is fine; an exception is not).

## Testing

- **Existing tests to run**: `npm test -w @robot-console/host`, in
  particular the full `deviceRegistry.test.ts` suite — confirm no
  regression from the two new `maybeRecordKnownRobot` call sites (a
  `DeviceRegistry` constructed with no `knownRobotsStore` override must
  still work exactly as before, now writing to the real default state
  dir; existing tests that don't care about persistence should inject a
  throwaway `KnownRobotsStore` pointed at a per-test temp directory, or
  a fake, so they don't pollute a real `~/.local/state` during CI).
- **New tests to write**: extend `deviceRegistry.test.ts` with the cases
  above, using the file's existing `FakeLink`/`banner()`/`device()`
  fixtures. Use a real `KnownRobotsStore` pointed at `os.tmpdir()`-based
  per-test directories (cleaned up in `afterEach`) for the enrollment/
  round-trip cases, and a minimal fake object for the "is
  `recordSighting` called with the right arguments" call-shape
  assertions.
- **Verification command**: `npm test -w @robot-console/host` and
  `npm run build`.
