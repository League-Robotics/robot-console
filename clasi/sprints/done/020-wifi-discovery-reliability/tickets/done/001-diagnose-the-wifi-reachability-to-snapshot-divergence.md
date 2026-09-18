---
id: '001'
title: Diagnose the WiFi reachability-to-snapshot divergence
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: bench-wifi-robot-discovery-waits-for-announcement.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Diagnose the WiFi reachability-to-snapshot divergence

## Description

019-009's own ten-run gate against `tigez` measured 2 pass / 8 fail,
with Layer 2 (WS `session-open` / live snapshot) failing in 5 of the 8
failures — not only Layer 3 (browser row). Layer 1's raw direct dial
passed 10/10, so the robot's WiFi radio was reachable throughout. The
gap is between `probeWifiOnDemand` resolving `found` and a `wifi` link
row being visible in what Layer 2/3 actually read. 019-002 already
patched this symptom once, closed on one anecdotal 206ms success, and
019-009 showed that fix holds only 2/10 — so this ticket's job is to
find the *actual* divergence point with evidence, not to patch again on
a guess. This ticket produces evidence only; it changes no production
behavior (instrumentation may be added and is expected to be removed or
gated before ticket 002's fix lands, per its own plan).

Sprint architecture Step 2 lists five candidate mechanisms to check,
none pre-confirmed:
1. `uniqueOwnedDeviceIdByName(name)` in `watchers/mdnsWatcher.ts`'s
   on-demand `.then()` callback resolves `deviceId` at the moment the
   probe *settles*, not when it started. If that lookup can return
   `null` for a name that was uniquely owned moments earlier,
   `upsertLinkAndDetectChange` still creates the link row, but
   `projection.ts`'s owned gate ("hides any wifi/mbserial link whose
   device is not owned") would drop it from every snapshot read —
   matching "no link found in the snapshot" more precisely than "no
   link was ever created."
2. `ageAndPruneOnce` (30s TTL-driven aging/pruning) runs from the same
   `browseCycle` tick as `triggerWifiOnDemandProbes`, but the on-demand
   path's `last_seen` bookkeeping might not match what the passive
   `handleWifi` path guarantees for an mDNS-observed link — check
   whether a freshly-created on-demand link can be aged/pruned sooner
   than intended.
3. `wifiOnDemandInFlight` (per-name in-flight guard) could leave a name
   permanently excluded if a probe's promise never settles within the
   run window (its own internal timeouts should prevent this, but
   confirm against real run timing, not just the code's stated
   contract).
4. Layer 2 and Layer 3 may not read the live snapshot the same way (one
   broadcast-driven, one per-request) — 019-009's own table shows them
   disagreeing (run 1: L2 pass/L3 fail; run 4: L2 fail/L3 pass), which
   a single shared read path wouldn't produce as often as two
   independently-timed reads would.
5. Something not listed above — the diagnosis is not limited to
   confirming only these four.

## Acceptance Criteria

- [x] A specific module/function/state-transition is named as the
      divergence point, backed by at least one piece of concrete
      evidence (a trace, log excerpt, or minimal reproduction) — not
      conjecture restated as a finding.
- [x] Each of the five candidate mechanisms listed above is explicitly
      addressed in the closing notes as confirmed, ruled out, or
      indeterminate, with the evidence for that call.
- [x] If more than one contributing cause is implicated, all of them are
      named, not just the first one found.
- [x] Evidence artifacts (traces/logs/reproduction scripts) are saved to
      the session scratchpad and cited by path in this ticket's closing
      notes, the same discipline 019-009 used.
- [x] No production behavior changes as a result of this ticket — any
      instrumentation added is either removed before closing or clearly
      marked as diagnostic-only (e.g. behind a debug log level) so
      ticket 002 starts from a clean, understood baseline.

## Closing Notes (programmer, 2026-09-18)

**Divergence point, named**: `watchers/mdnsWatcher.ts`'s
`triggerWifiOnDemandProbes()` fires one `discovery/wifiOnDemand.ts`
`probeWifiOnDemand(name)` call **per owned, non-relay device,
unawaited, concurrently, with no concurrency cap** — five simultaneous
`dns.lookup(<name>.local, {family:4})` calls against this bench's five
owned robots, at every watcher start and every 30s tick. Node's
`dns.lookup` runs on the libuv **threadpool** (`UV_THREADPOOL_SIZE`,
default 4) — five concurrent lookups alone oversubscribe it.
`lib/withTimeout.ts` bounds each call with a **plain, independent
`setTimeout`** racing the promise (not a cancellation of the underlying
work), so under threadpool contention the 2000ms deadline elapses while
the lookup is still queued for a worker thread — producing a false
`"not-found"` indistinguishable, at the caller, from a genuinely
unreachable robot. This is candidate 5 ("something not listed").

**Direct A/B evidence** (real, unmodified `runtime.ts` `startRuntime`,
real `bonjour-service` backend, real known-robots.json, real network,
against `tigez`/`tovez` — property-selected as the only two owned
robots with a live WiFi path at run time, confirmed via a standalone
`probeWifiOnDemand` call before this ticket's own reproduction began):

| Condition | Iterations | On-demand probe outcome (tigez+tovez) |
|---|---|---|
| Default `UV_THREADPOOL_SIZE` (unset → 4), full runtime | 5 | 0/10 succeeded — every attempt (t≈0 and the t≈30s retry) timed out at exactly 2000ms |
| Default threadpool, `startFirmwareWatcher` replaced with a no-op | 3 | 0/6 succeeded — rules out firmwareWatcher as a *necessary* contributor; the wifi probes' own concurrency (5 names > 4 threads) is sufficient alone |
| `UV_THREADPOOL_SIZE=32`, otherwise identical | 2 | 4/4 succeeded, settling in 55–95ms, matching the robots' own proven sub-400ms reachability |

No source file was edited to produce this evidence — every measurement
used `startRuntime`'s own existing `startMdnsWatcher`/
`startFirmwareWatcher` injection seams plus two already-public `Store`
reads (`snapshotRows()`, `buildSnapshot`). Full logs, scripts, and the
standalone fixture-selection probe are at
`<scratchpad>/020-001/EVIDENCE-SUMMARY.md` (the index) and, beside it,
`repro.mjs`/`pilot-run.log`, `repro2.mjs`/`repro2-run1.log`,
`repro3-nofirmware.mjs`/`nofirmware-test.log`,
`bonjour-interference.mjs`, `threadpool32-test.log`,
`probe-candidates.mjs` (session scratchpad, not committed — cited by
path per 019-009's own discipline).

**This also explains 019-009's own puzzling details**: Layer 1 passes
10/10 because its raw dial runs in a short-lived process with nothing
else competing for the threadpool. Layer 2 and Layer 3 disagree
independently in 019-009's table (run 1: L2 pass/L3 fail; run 4: L2
fail/L3 pass) because `scripts/bench/layer2/index.ts` and
`scripts/bench/layer3/index.ts` each spawn their **own separate host
process** against its own fresh state dir — confirmed by reading both
files — so each is an independent roll of the same threadpool race, not
a code-level read-path divergence (both ultimately call the identical
`buildSnapshotFromRows(store.projectionRows(), seq, at)`,
`server.ts:658` / `projection.ts:110`). The failure rate getting worse
rather than better across ten runs is consistent with contention timing
noise, not an announcement race that should resolve with more wall-clock
time.

**The five candidates**:

1. **Owned-gate hiding a link whose `deviceId` resolved null at
   probe-settle time — RULED OUT.** `openStoreWithImportsFn` completes
   synchronously before `startMdnsWatcherFn` is called
   (`runtime.ts:280` vs `:297` — independently re-verified, not
   inherited). `Store.upsertLink`'s `ON CONFLICT` clause is
   `device_id = COALESCE(excluded.device_id, links.device_id)`
   (`store/index.ts:1091`), so a null at settle time can only stick on a
   link's first-ever insert, never clobber an existing correct value.
   The literal "transient multi-owned-name" mechanism the architecture
   doc flagged as a hypothesis does not occur: `Store.mergeDevice`
   (`store/index.ts:922-982`) re-points every affected link and
   **deletes** the placeholder device row inside one
   `BEGIN IMMEDIATE`/`COMMIT` transaction, and Node's single-threaded
   execution means no other code can observe an intermediate duplicate.
   Empirically, across 13 reproduced iterations the raw `wifi-*` link
   row was never observed with `device_id = null`; every failure was
   "row never created at all" (the threadpool timeout), not "row exists,
   hidden."
2. **Aging/pruning race — indeterminate beyond the harness's own
   observation window; not implicated in any reproduced failure.**
   `DEFAULT_WIFI_TTL_MS` is 180s; the harness's own Layer 2 `settle()`
   bound is 90s max, and no reproduction here ran a live link past ~40s.
   No link was ever observed transitioning to `state: "stale"` shortly
   after creation. Not fully ruled out for a longer-lived host process,
   but not the cause of any failure this ticket reproduced.
3. **`wifiOnDemandInFlight` starving a retry — RULED OUT.** Probe
   logging recorded both the t≈0 call and the t≈30000ms retry firing for
   every owned name in every iteration, with no gaps — the in-flight
   `Set` cleared reliably via its own `.finally()` every time
   (`mdnsWatcher.ts:546-548`). Retries fired exactly on schedule; they
   individually kept losing the same threadpool race.
4. **Layer 2 vs Layer 3 reading the snapshot differently — RULED OUT as
   a distinct code-level defect.** Both read the identical
   `buildSnapshotFromRows` output; the observed disagreement is fully
   explained by independent host-process instances sampling the same
   race at different moments (see above), not a code-level divergence.
5. **Something not listed — CONFIRMED as the actual root cause.** See
   above: unbounded concurrent `dns.lookup` calls from
   `triggerWifiOnDemandProbes` oversubscribing Node's default libuv
   threadpool, combined with `withTimeout`'s queueing-blind deadline.

**No production behavior changed**: every source file this ticket read
was left unmodified (verified: `npx vitest run mdnsWatcher wifiOnDemand
projection --no-coverage` — 3 files, 76 tests, all passing, same as
before this ticket started). All instrumentation lived in throwaway
scratchpad scripts driving the real code through its own existing
dependency-injection seams.

**Recommendation for ticket 002** (stated as what the evidence
supports): bound `triggerWifiOnDemandProbes`'s own concurrency (e.g. a
small per-tick concurrency cap, or staggering probe starts) so it never
fires more simultaneous `dns.lookup` calls than the process can actually
service promptly, and/or raise `withTimeout`'s bound for this specific
call site to something threadpool-queueing-tolerant, and/or (more
robust against classroom fleet size and any other threadpool consumer,
per the "not fixable by another retry" framing in this sprint's own
Goals) switch `discovery/wifiOnDemand.ts`'s resolution off the
threadpool entirely — e.g. `dns.resolve4`/`dns.Resolver`, which use
c-ares' own async I/O rather than libuv's worker threads and would not
compete with any other component's threadpool usage at all. Confidence:
**high** that the threadpool-contention mechanism above is the real,
primary cause of 019-009's 2/10 pass rate on this bench, based on a
direct, repeatable A/B (same code, same live robots, only
`UV_THREADPOOL_SIZE` changed) plus an isolation test ruling out
`startFirmwareWatcher` as a necessary co-factor. Lower confidence that
it is the *only* possible contributing factor in every environment
(classroom hosts may have different owned-device counts, other
threadpool consumers, or OS-level differences) — ticket 002 should
re-confirm the fix's effect with the same kind of before/after
measurement this ticket used, not assume the numbers here transfer
unchanged to a different bench.

## Implementation Plan

**Approach**: Read the current code paths first
(`watchers/mdnsWatcher.ts`, `discovery/wifiOnDemand.ts`, `store/index.ts`
aging/pruning, `projection.ts`'s `buildSnapshot`/owned gate, and
whatever Layer 2's `session-open` handler and Layer 3's browser driver
each actually read) to confirm or correct this ticket's own candidate
list before touching anything. Then choose whichever of (a) targeted
logging added at the five candidate points, run through repeated
`scripts/bench/run.sh` cycles, or (b) a smaller, faster reproduction
outside the full harness (e.g. driving `mdnsWatcher`/`store` directly in
a script against a real or faked backend) reaches a confirmed answer
fastest — the sprint architecture does not mandate one approach over the
other, only that the answer be evidenced. Re-confirm the current
WiFi-reachable robot roster at run time (`tigez` was the fixture as of
2026-09-18; do not assume it still is).

**Files likely read/instrumented** (diagnosis only — revert
instrumentation before closing, or gate it behind an existing debug log
level):
- `packages/host/src/watchers/mdnsWatcher.ts` (`triggerWifiOnDemandProbes`,
  `upsertLinkAndDetectChange`, `ageAndPruneOnce`)
- `packages/host/src/discovery/wifiOnDemand.ts` (confirm timing only —
  already proven reliable)
- `packages/host/src/store/index.ts` (aging/pruning, `upsertLink`)
- `packages/host/src/projection.ts` (`buildSnapshot`, owned gate)
- `packages/host/src/connect/reconciler.ts`, `sessionOps.ts`,
  `wsMessages.ts` (Layer 2's actual read path)
- `scripts/bench/` (Layer 2/3 drivers, to confirm what each actually
  reads)

**Testing Plan**:
- **Existing tests to run**: `mdnsWatcher.test.ts`, `wifiOnDemand.test.ts`
  (if present), `projection.test.ts`/equivalent golden tests — scoped to
  these modules, not the full suite (full suite runs once at
  `close_sprint`).
- **New tests to write**: none required for this ticket if diagnosis
  stays read-only/instrumentation-only; if the diagnosis produces a
  minimal reproduction script, it may be added as a new (skipped or
  bench-only) test that ticket 002 can un-skip once the fix lands —
  optional, at the implementer's judgment.
- **Verification command**: `npm test --workspace=@robot-console/host -- mdnsWatcher wifiOnDemand projection` (adjust to the actual scoped test invocation for touched files).
- **Documentation updates**: none to `docs/design/` — this ticket
  produces sprint-scoped evidence, not a permanent architecture change.
  The finding is recorded in this ticket's closing notes and referenced
  by ticket 002.
