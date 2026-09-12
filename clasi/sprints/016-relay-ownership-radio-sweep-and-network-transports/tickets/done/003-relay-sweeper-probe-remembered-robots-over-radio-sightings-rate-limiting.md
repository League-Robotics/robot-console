---
id: '003'
title: 'Relay sweeper: probe remembered robots over radio, sightings, rate limiting'
status: done
use-cases:
- SUC-003
depends-on:
- '002'
github-issue: ''
issue: rearch-10-relay-sweeper-radio-sightings.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay sweeper: probe remembered robots over radio, sightings, rate limiting

## Description

Build `packages/host/src/watchers/relaySweeper.ts` (new): the stakeholder's
headline ask. For each idle, `usb`-transport, `kind='relay'` link (idle
per ticket 001's rule — no lease held), acquire the `sweep` lease and
probe remembered robots over the relay's command plane, never entering
the data plane and never sending `HELLO`:

- Candidate list: owned robots with no `connected` `usb`/`wifi`/
  `mbserial` link, ordered oldest `sightings.at` first. Back off names
  that fail several consecutive sweeps.
- Per candidate: resolve address via the same `override → registry →
  derived` order as everywhere else (this ticket does not yet thread a
  real registry location through — see ticket 006 — so this degrades to
  `override → derived` until then, same as `session-open` does today).
  `!CG ch grp` (via `RelayCommandPlane.ts`'s already-exported
  `setChannelGroup`) → wait ≤ 500 ms for confirmation. `> ID` (build via
  `buildRadioSendLine("ID")`) → wait ≤ 500 ms for a `< id …` reply
  matching the candidate's name (parse with `@robot-console/protocol`'s
  existing `parseIdReply`).
- Record `sightings(radio, via_link_id=relay, ok, detail)`; on success
  upsert `links(radio, state=connectable, address={relayLinkId, channel,
  group})`; on failure, leave any existing radio link and bump its
  `fail_count`.
- Rate limit: at most one `!CG` per relay per `SWEEP_MIN_INTERVAL_MS`
  (default 30 s) until ticket 007's capability detection lands (that
  ticket drops this to 2 s once a relay advertises it — this ticket
  builds the rate-limit mechanism itself, gated on a capability flag
  ticket 007 will set).
- After the candidate list is exhausted: release the lease, sleep a quiet
  period, re-acquire.
- If the relay does not answer `?` on lease acquisition (parked in the
  data plane by a prior crash), perform ticket 002's reset step once,
  then continue.
- Register the sweep's `AbortController` with the shared revocation seam
  (`connect/relayLeaseRevocation.ts`, new — a small
  `Map<relayLinkId, AbortController>` both this module and ticket 004's
  takeover logic depend on; see sprint.md's Design Rationale for why this
  is an in-process seam, not a schema column). Between probes, check the
  abort signal; on abort, finish the current wait (≤ 500 ms), release the
  lease, and return without a further write.
- Heartbeat a `tasks` row per probe pass (architecture.md §3 rule 5:
  every long-lived task has a heartbeat).

This ticket builds the probe loop and its rate limiting; it does **not**
yet cover the takeover-within-one-probe end-to-end scenario (ticket 004)
or the projection/UI rendering of "idle · sweeping"/"Radio via <relay>"
(also ticket 004) — this ticket's own acceptance criteria are the probe
mechanics and the revocation registration, testable with a fake relay and
no UI involved.

## Acceptance Criteria

- [x] Fake relay answering `!CG` with the echo line and `> ID` for a
      subset of names: after one pass, `sightings` has one row per
      candidate; answering names get a `links(radio, connectable)` row;
      non-answering names show `fail_count = 1`.
- [x] The sweep never sends `!GO` or `HELLO` to the fake relay — assert
      this directly against the fake's received-lines log, not just the
      absence of a failure.
- [x] With the default rate limit, the fake relay sees no two `!CG`
      writes closer together than `SWEEP_MIN_INTERVAL_MS`.
- [x] A relay found parked in the data plane on lease acquisition gets
      one reset (ticket 002's reset step) before sweeping resumes.
- [x] The sweeper registers its `AbortController` with
      `relayLeaseRevocation` for the duration of each pass and
      deregisters it on release (verifiable directly against the seam's
      own map, independent of ticket 004's end-to-end takeover test).
- [x] Names that fail several consecutive sweeps are probed less often
      than ones that answer (a concrete backoff, table-tested).
- [x] `npx vitest run packages/host/src/watchers packages/host/src/connect`
      passes.

## Implementation Plan

**Approach**: Build the pure candidate-ordering/backoff function first
(table-testable, no I/O), then the per-candidate probe step (a thin
wrapper over `RelayCommandPlane.ts`'s `setChannelGroup` plus a new
`sendAndWaitForIdReply`-shaped helper — check whether this belongs in
`RelayCommandPlane.ts` itself, alongside `sync`/`setChannelGroup`/`go`,
or in `relaySweeper.ts` directly; it is protocol-adjacent enough that
`RelayCommandPlane.ts` is the more consistent home), then the task
loop (start/stop/heartbeat, mirroring `watchers/usbWatcher.ts`'s/
`watchers/mdnsWatcher.ts`'s own task shape).

**Files to create/modify**:
- `packages/host/src/watchers/relaySweeper.ts` (new).
- `packages/host/src/connect/relayLeaseRevocation.ts` (new — the shared
  seam; small enough to build here since ticket 002's `relayBridger.ts`
  only needs to *read* it, not populate it, until ticket 004).
- `packages/host/src/link/RelayCommandPlane.ts` (a probe-and-wait-for-id
  step, if that is where it belongs per the Approach note above).
- `packages/host/src/runtime.ts` (wire the sweeper into the composition
  root, started/stopped alongside the existing watchers).

**Testing plan**:
- `watchers/relaySweeper.test.ts` (new): fake relay with a scripted
  `!CG`/`> ID` reply set; the rate-limit, no-`!GO`/`HELLO`, and backoff
  acceptance criteria above.
- `connect/relayLeaseRevocation.test.ts` (new): register/lookup/clear
  semantics, independent of any relay fake.
- Scoped run: `npx vitest run packages/host/src/watchers
  packages/host/src/connect`.

**Documentation updates**: none beyond this ticket's own completion notes.

## Implementation notes

**New files**: `packages/host/src/watchers/relaySweeper.ts`,
`packages/host/src/watchers/relaySweeper.test.ts`,
`packages/host/src/connect/relayLeaseRevocation.ts`,
`packages/host/src/connect/relayLeaseRevocation.test.ts`.

**Where the probe-and-wait-for-`< id` step lives**: `link/RelayCommandPlane.ts`,
next to `sync`/`setChannelGroup`/`go`, per the Implementation Plan's own
"consistent home" call — a new exported `probeRadioId(name, options):
Promise<boolean>`. It sends `> ID` (`buildRadioSendLine`) and waits up to
`options.timeoutMs` (default 500ms, `DEFAULT_PROBE_TIMEOUT_MS`) for a
reply whose parsed name matches. Deliberately resolves `false` on
timeout rather than throwing — a non-answering candidate is an ordinary
sweep outcome the caller records as a failed sighting, not a handshake
failure the way a `!CG` rejection is. Parsing the reply required a new
protocol-level function, `parseRadioIdReply` (`packages/protocol/src/relay/commands.ts`):
`deviceType.ts` already had a `parseIdReply(fields: string[])` — the
ticket's brief assumed this was already wired for a relay's `< <text>`
framing, but it only ever parsed already-tokenized fields with no `<`
prefix handling (a direct v6 session's own `ID` reply shape). Rather than
duplicate the `id <product> <program> <version> <name>` grammar,
`parseRadioIdReply` strips the `< ` receive prefix, tokenizes, drops the
leading `id` verb token, and hands the rest to `deviceType.ts`'s existing
`parseIdReply` — one grammar, parsed in one place, reused from the relay
pass-through framing.

**Rate limiting, precisely**: one `!CG`+probe per remembered candidate,
per pass, with the wait between successive candidates computed as
`lastCgAt + intervalMs - now()` — `lastCgAt` is captured **after** the
`!CG` write's own confirmation wait (and the `> ID` probe) complete, not
before. Measuring before systematically understates the actual on-wire
gap by however long the paced write takes to reach the transport (caught
by this ticket's own rate-limit test going flaky at ~30ms tolerance on
authoring); measuring after only ever adds margin, never subtracts, so
"no two `!CG` writes closer than `SWEEP_MIN_INTERVAL_MS`" holds
unconditionally. `SWEEP_MIN_INTERVAL_MS` defaults to 30s; `SWEEP_FAST_INTERVAL_MS`
(2s) is defined now for ticket 007 to switch to once it writes the
capability flag.

**The capability-flag read ticket 007 must populate**: `isFastSweepEnabled(store,
relayLinkId)` reads `store.getSetting(fastSweepSettingKey(relayLinkId))`
(key shape `` `relaySweepFast:${relayLinkId}` ``), `true` only for the
literal string `"1"` — anything else (unset, malformed) defaults off.
Per-relay, not global, since a classroom can have mixed relay firmware at
once. Ticket 007's own job: after detecting the `?`/status reply's
capability token (e.g. `caps: CGT`), call `store.setSetting(fastSweepSettingKey(relayLinkId),
"1")`. This is a deliberate departure from sprint.md's Step 4 "No ERD"
sketch (in-memory, re-detected per lease acquisition) — the task
description for this ticket asked for a `settings`/device field read
specifically, so the read contract is a `settings` row; ticket 007 is
free to re-derive the value fresh on every lease acquisition and simply
write it here rather than caching it itself.

**Chosen backoff table** (`sweepBackoffMs`, pure, table-tested in
`relaySweeper.test.ts`): `0` for a name with no consecutive failures;
otherwise `60s * 2^(consecutiveFailures - 1)`, capped at 30 minutes (1
min, 2 min, 4 min, 8 min, 16 min, capped). `isSweepCandidateBackedOff`
reads a candidate's own `links(radio)` row (`failCount`, `lastSeen`) for
this relay to decide whether its window has elapsed; `failCount` resets
to `0` on a success (a fresh success clears any prior consecutive-failure
streak) and increments by 1 on a failure — the existing link `state` is
left untouched on failure ("leave any existing radio link"), only
`fail_count` moves.

**Testability seam**: the per-relay probe pass itself is factored into an
exported `createRelaySweepPassRunner(store, deps, opts) ->
{ runOnePass(relayLinkId, passController) }`, separate from
`startRelaySweeper`'s own scan-tick/loop-lifecycle layer — this is what
lets `relaySweeper.test.ts` drive one pass directly (real timers, small
injected ms values, exactly `relayBridger.test.ts`'s own established
convention) without waiting on a real scan interval. `startRelaySweeper`
constructs one pass runner and calls it from its own per-relay
forever-loop (pass → quiet period → re-acquire), scanning `links` every
`scanIntervalMs` for newly-idle `usb`/`kind='relay'` links to start a
loop for, and stopping a loop if the relay stops being idle (taken over,
removed) — a small addition beyond the ticket's own letter, but a
natural consequence of the watcher-shaped task convention and harmless
(ticket 004 layers the actual takeover handshake on top).

**Reset-once verified**: `ensureCommandPlaneReady` calls `sync()`
(`RelayCommandPlane.ts`) on lease acquisition; on failure it reuses
ticket 002's own `chooseResetMethod`/`performReset`/`defaultHidReset`
(all now exported from `connect/relayBridger.ts` for this reuse,
mirroring that module's own reuse of `connector.ts`'s helpers), then
confirms `sync()` once more before proceeding. A relay still unresponsive
after that single reset abandons the pass for this cycle (lease
released, retried after the quiet period) rather than looping
indefinitely.

**`runtime.ts` wiring**: `createRelayLeaseRevocation()` is constructed
once per runtime and handed to `startRelaySweeper` as its `revocation`
dep — the same instance ticket 004 will also hand to the bridger.
`runtime.test.ts` mocks both `createRelayLeaseRevocation` and
`startRelaySweeper` (never the real defaults), so the composition-root
suite never risks a live sweep timer touching its own minimal fake
store; the real `scanOnce()` tick is additionally wrapped in its own
`try`/`catch` as defense in depth for any other caller that supplies an
incomplete store for a collaborator it doesn't otherwise exercise.
`stop()` now stops the sweeper between the reconciler and the watchers.

**Not done in this ticket** (explicitly deferred, per its own
Description): the sweep-takeover handshake itself (waiting on the
revocation seam's `AbortController` and racing the ≤1.5s handback) and
the relay/robot projection/UI rendering — both ticket 004. The firmware
capability *detection* itself (parsing `caps: CGT` from a `?` reply) —
ticket 007; this ticket only defines the `settings`-backed read/off
default described above.
