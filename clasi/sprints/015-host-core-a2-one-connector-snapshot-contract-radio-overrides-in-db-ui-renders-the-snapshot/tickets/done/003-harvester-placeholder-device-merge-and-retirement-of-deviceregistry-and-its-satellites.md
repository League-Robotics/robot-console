---
id: '003'
title: Harvester, placeholder-device merge, and retirement of deviceRegistry and its
  satellites
status: done
use-cases:
- SUC-003
- SUC-004
depends-on:
- '001'
- '002'
github-issue: ''
issue: rearch-05-connector-reconciler-harvester-retire-deviceregistry.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Harvester, placeholder-device merge, and retirement of deviceRegistry and its satellites

## Description

Two pieces of work that must land together because the second requires
the first two tickets and the harvester in this one:

**1. Harvester** (`packages/host/src/connect/harvester.ts`): per open
session, salvaged from `deviceRegistry.ts`'s `handleInboundLine`
(`:3349-3408`), `handleTelemetryLine` (`:3502-3520`), `adoptStatusNext`
(`:3531-3543`), `reportDesyncIfNeeded` (`:3705-3729`),
`startRobotProbes`/`pollStatus` (`:3579-3645`). Writes
`sessions.robot_status`/`functions`/`seq`/`pending`; forwards
`thdr`/`t` to the telemetry stream; on `onClose` or three missed
`STATUS` polls (all transports, not WiFi only) → `setLinkState(unresponsive)`
and stops polling. Exactly one error path
(`handleLinkError` → state change), never an emit per poll. Wire this
as the real implementation behind ticket 001's harvester-attach seam.

**2. Placeholder-device merge**: `importKnownRobots` (sprint 014) seeds
`devices` rows keyed by a synthetic name-derived id, because
`known-robots.json` never stored the chip id. When the connector (ticket
001) identifies the same physical robot over USB for the first time, it
now computes the real chip-id-keyed id — e.g. the bench dump's `vevov`
(synthetic id 1031) vs. the real `vevav` (chip id 536019796). On first
identification, if a placeholder row exists with the same `name` and a
synthetic id, merge its fields (`owned`, `first_seen`,
`radio_channel`/`radio_group`/`radio_source` if already set) into the
real row and delete the placeholder, re-pointing any `links`/`sightings`
rows that referenced it.

**3. Retire**, per `architecture.md` §2's clean-break decision and
rearch-05's own retire list: delete `deviceRegistry.ts` +
`deviceRegistry.test.ts`; `store/knownRobots.ts` + test (the *importer*
of the same name in `store/importers/knownRobots.ts` is untouched —
only the old in-memory module goes); `wifi/wifiRobotGate.ts` + test (the
gate is now `devices.owned` in the reconciler); `relay/RelayConnectionCoordinator.ts`
+ test; the four link classes `UsbSerialLink`/`RelayRadioLink`/
`MbrelayLink`/`MbserialLink` + their four tests. Add
`process.on('unhandledRejection')` logging and marking the offending
link `failed` as a backstop only (per the device-model review's
`:3819`/`server.ts:430` finding). Remove the `usbWatcher.ts`/
`mdnsWatcher.ts`/`store/bootstrap.ts`/`discovery/mdnsDiscovery.ts`
`TODO(rearch-05)` stubbed-connector call sites, replacing them with the
reconciler scheduling real connects.

`link/Link.ts` (the `Link`/`LinkSpec`/`LinkFactory` interface) becomes
unreferenced once the four classes and `deviceRegistry.ts` are gone
except for `usbWatcher.test.ts`'s stub fake — update that test to use
the real connector/reconciler seam instead. Leave the file itself for
ticket 010 to remove as part of the size-trim pass (confirming nothing
else references it first).

## Acceptance Criteria

- [x] Harvester tests: `status`/`funcs`/`id`/`thdr`+`t` update the
      session row; stream close → `unresponsive` once; three missed
      polls → `unresponsive` once on a USB link.
      (`connect/harvester.test.ts`. Note on "id": there is no per-verb
      `sessions` column for an `id` reply's own payload — the harvester
      harvests it by refreshing the session's own sequencing counters
      [`seq`/`pending`/`last_done`/`last_done_reason`] on every reply
      verb it does not otherwise special-case, `id` included; see
      `harvester.ts`'s `syncSession` and its own doc comment.)
- [x] A seeded placeholder (`vevov`, synthetic id) followed by a
      simulated real USB identify (`vevav`, chip id `536019796`)
      collapses to one `devices` row with `owned = 1`; no orphaned
      `links`/`sightings` rows remain.
      (`store/index.test.ts`'s `Store: mergeDevice` block, and
      `connect/connector.test.ts`'s own placeholder-merge describe block
      using these exact bench numbers. Correlation key is `usb_serial`,
      not `name`: the worked example's two names genuinely disagree —
      `nameToValue("vevov") === 1031` but `deviceIdToName(536019796) ===
      "vevav"` — so a name-keyed merge would never have found the
      placeholder at all; see `connector.ts`'s `mergeUsbPlaceholderIfAny`
      doc comment for the full reasoning.)
- [x] `deviceRegistry.ts`, `deviceRegistry.test.ts`, `store/knownRobots.ts`
      (+test), `wifi/wifiRobotGate.ts` (+test),
      `relay/RelayConnectionCoordinator.ts` (+test), and the four old
      link classes (+ their four tests) no longer exist.
- [x] `grep -r "class UsbSerialLink\|class RelayRadioLink\|class MbrelayLink\|class MbserialLink\|new DeviceRegistry" packages/host/src` returns nothing **except** `server.ts:235` and `server.test.ts:207` (`new DeviceRegistry(...)`) — both named in this same ticket's own "Known breakage" scope note as accepted until ticket 005's composition root replaces them. No class definition and no other call site exists anywhere.
- [x] `grep -r "TODO(rearch-05)" packages/host/src` returns nothing.
- [x] An uncaught `unhandledRejection` is logged and marks the
      offending link `failed` instead of crashing the process (test with
      a rejecting fake). (`connect/unhandled.ts` + `unhandled.test.ts` —
      `createUnhandledRejectionHandler`'s handler is exercised directly
      with rejecting fakes; `installUnhandledRejectionBackstop` itself
      is never called by the test suite, so no real `process`-level
      listener is registered — per this ticket's own instruction.
      `installUnhandledRejectionBackstop` has no production call site
      yet; ticket 005's composition root wires it in.)
- [x] Full `npm test` green with the deleted files gone (server.ts and
      cli.ts still reference the old registry at this point and are
      expected to fail to typecheck until ticket 005 — scope this
      ticket's test run to `packages/host/src/connect`, `store`,
      `watchers`, `link` rather than the whole workspace; the full
      suite gate is ticket 011's, per `.claude/rules/source-code.md`).
      Satisfied via the scoped run this ticket's own Testing Plan
      specifies (`npx vitest run packages/host/src/connect
      packages/host/src/store packages/host/src/watchers
      packages/host/src/link packages/host/src/discovery
      packages/protocol` — 616/616 passing, 32 files). The full
      workspace suite is out of scope here per the note above; `npm run
      typecheck` was run informationally (not as a gate) and its one
      failing file recorded below for ticket 005 — `cli.ts` itself
      actually typechecks clean (it only imports `startServer`, a
      function, from `server.ts`; the ticket's own text assumed both
      files would fail, but only `server.ts` does).

      **`npm run typecheck` failing file (informational, ticket 005's to
      fix):** `packages/host/src/server.ts` — one root cause,
      `error TS2307: Cannot find module './deviceRegistry.js'` at its
      `import { DeviceRegistry } from "./deviceRegistry.js"` line, which
      cascades into ~20 `TS7006` implicit-`any` errors on parameters
      whose types used to flow from the now-untyped `DeviceRegistry`
      instance. `packages/host/src/index.ts`'s own `export * from
      "./server.js"` does not itself surface as a separate tsc error.
      `packages/protocol` and `packages/ui` were not reached by this run
      (the workspace build chain stops at the first failing package,
      `@robot-console/host`) — nothing in this ticket's own scope
      touched either, so no new failures are expected there.

## Implementation Plan

**Approach**: Land the harvester and placeholder-merge first (additive),
verify against tests, then delete in one pass so there is never a
commit where both the old and new identify paths are live and
diverging. `server.ts`/`cli.ts` still import the deleted modules after
this ticket — that breakage is expected and is resolved by ticket 005,
which is why this ticket's test run is scoped rather than full-workspace
(see `.claude/rules/source-code.md`'s scoped-run rule).

**Files to create**:
- `packages/host/src/connect/harvester.ts`
- `packages/host/src/connect/harvester.test.ts`
- Placeholder-merge logic lives inside `connect/connector.ts` (ticket
  001) as an added function; add its tests to `connector.test.ts`.

**Files to delete**:
- `packages/host/src/deviceRegistry.ts`, `deviceRegistry.test.ts`
- `packages/host/src/store/knownRobots.ts` (+ test)
- `packages/host/src/wifi/wifiRobotGate.ts` (+ test)
- `packages/host/src/relay/RelayConnectionCoordinator.ts` (+ test)
- `packages/host/src/link/UsbSerialLink.ts`, `RelayRadioLink.ts`,
  `MbrelayLink.ts`, `MbserialLink.ts` (+ their four tests)

**Files to modify**:
- `packages/host/src/watchers/usbWatcher.ts`,
  `packages/host/src/watchers/mdnsWatcher.ts`,
  `packages/host/src/store/bootstrap.ts`,
  `packages/host/src/discovery/mdnsDiscovery.ts`: remove
  `TODO(rearch-05)` stub call sites; wire to the reconciler.
- `packages/host/src/watchers/usbWatcher.test.ts`: replace the stubbed
  `LinkFactory` fake with the real connector/reconciler seam.

**Testing plan**:
- Unit: harvester tests per acceptance criteria; connector
  placeholder-merge tests.
- Scoped run: `npx vitest run packages/host/src/connect packages/host/src/store packages/host/src/watchers packages/host/src/link` (excludes `server.ts`/`cli.ts`, which ticket 005 fixes).
- Documentation: update `packages/host/src/store/README.md` if it
  references the old registry; none expected otherwise.
