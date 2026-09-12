---
id: '006'
title: mbserial verification and registry-aware radio address resolution
status: done
use-cases:
- SUC-006
depends-on:
- '005'
github-issue: ''
issue: rearch-11-mbrelay-mbserial-real-transports.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbserial verification and registry-aware radio address resolution

## Description

Completes rearch-11. Two independent halves:

**mbserial verification.** Reading `watchers/mdnsWatcher.ts`'s
`handleMbserial` (already links an `_mbserial._tcp` instance to the one
`owned` device with that name, the same rule as `handleWifi`),
`connect/reconciler.ts`'s `AUTO_CONNECT_TRANSPORTS` (already includes
`"mbserial"`), and `connect/connector.ts`'s `buildStreamPlan` (already
opens it as a plain `tcpStream`, no preamble) strongly suggests mbserial
already works end to end as a side effect of sprint 015's generic
connector/reconciler — see sprint.md's Architecture Step 1 and Step 7
open question 1. Sprint 015's own bench ticket never actually opened a
session over an mbserial link, only observed the discovered row. This
ticket's first job is to verify that reading against a real mbserial
robot (`gopiv`/`tigez` per the bench roster) — a `session-open` that
actually connects, exchanges `send-command`, and closes — and to write
any missing test coverage or fix any gap the bench pass surfaces. If the
reading is confirmed correct, this half of the ticket is verification and
test-writing, not new production code — report this plainly rather than
inventing work to justify the ticket.

**Registry-aware radio address resolution.** `radioOverride.ts`'s own doc
comment states its `override → registry → derived` resolver "is not yet
wired into any production call site" — `server.ts`'s `session-open`
handler calls `resolveDeviceRadio` but never supplies a `registry`
location, so every resolution today silently skips the registry tier.
Now that ticket 005 gives an mbrelay pool a real device row carrying its
`registryPort` (from `links.address`), thread that location into
`resolveDeviceRadio`'s `registry` argument at all three call sites that
need it: `server.ts`'s `session-open` handler, `relayBridger.ts`, and
`relaySweeper.ts` — the last one only for a named default-address lookup
when not already resolved by a sighting; the sweeper still must never
issue a registry GET during a probe itself (rearch-10's own constraint,
already covered by ticket 003).

## Acceptance Criteria

- [x] Real-hardware or fake-mDNS-backed test: an mbserial-discovered
      owned robot connects, exchanges at least one `send-command`
      round trip, and closes cleanly — confirming (or correcting)
      the Step 1 reading that this already works.
- [x] An un-owned mbserial advertisement stays hidden with no connection
      attempt (regression guard on the existing `uniqueOwnedDeviceIdByName`
      rule).
- [x] With a fake registry reachable via a discovered mbrelay pool's
      `registryPort`, a `session-open {relayLinkId, name}` bridge for a
      robot with no override resolves through the registry, not straight
      to derived.
- [x] A stored override still wins outright regardless of registry
      reachability, at all three call sites (`session-open`,
      `relayBridger`, `relaySweeper`).
- [x] The sweeper still never issues a registry GET during a probe pass
      (regression guard against ticket 003's own acceptance criterion).
- [x] `npx vitest run packages/host` passes.

## Implementation Plan

**Approach**: Verification first (mbserial), against either the bench or
a faithful fake-mDNS/fake-TCP-stream test if bench time is unavailable
this ticket. Then the registry-wiring change, which is additive to three
existing call sites (each already calls `resolveDeviceRadio`; this ticket
only supplies the `registry` argument each was missing).

**Files to modify**:
- `packages/host/src/server.ts` (`session-open` handler: look up the
  target's relay pool's `registryPort`, if any, and pass it).
- `packages/host/src/connect/relayBridger.ts` (same, for a bridge's own
  address resolution).
- `packages/host/src/watchers/relaySweeper.ts` (same, for a candidate's
  address resolution, never during the probe itself).
- No changes expected to `radioOverride.ts`/`mbrelayRegistry.ts` — their
  resolution order and caching are unchanged; only new callers supply an
  argument the function already accepted.

**Testing plan**:
- `watchers/mdnsWatcher.test.ts`/a new integration-style test: mbserial
  connect/send-command/close against a fake TCP stream.
- `server.test.ts`: `session-open` resolving through a fake registry when
  a pool's `registryPort` is known.
- `connect/relayBridger.test.ts`/`watchers/relaySweeper.test.ts`: same
  registry-argument wiring, each in its own call site's test file.
- Scoped run: `npx vitest run packages/host`.
- If a bench pass is done here rather than deferred to ticket 008, record
  it the same way sprint 015 ticket 011 recorded its own bench evidence
  (a "Bench evidence" section in this ticket's completion notes).

**Documentation updates**: if the mbserial reading in this ticket's
Description turns out to be wrong in any respect, update sprint.md's
Architecture Step 1 finding to match reality (do not leave a stale claim
in the sprint's own planning document).

## Implementation notes

**mbserial verification — Step 1's reading held, no bench pass done
here.** `packages/host/src/mbserialEndToEnd.test.ts` (new) drives a fake
mDNS backend advertising `_mbserial._tcp` for an owned robot, plus a real
loopback `net.createServer` (port 0, closed in `afterEach`) speaking just
enough of the v6 line protocol for `HELLO` → banner and one sequenced
`STOP` → `ack` round trip, through the REAL `mdnsWatcher`/`reconciler`/
`connector`/`server` stack (only the mDNS backend and the WebSocket
transport are fakes). `session-open {linkId}` connects and identifies,
`send-command {verb: "STOP"}` is written over the real socket and the
robot's `ack` updates the real `@robot-console/protocol` `Session`'s own
`lastDone` (0 → 7), and `session-close` tears the session down cleanly —
confirming Step 1's reading (`handleMbserial`'s name-match linking,
`AUTO_CONNECT_TRANSPORTS` including `mbserial`, `buildStreamPlan`'s plain
`tcpStream`) is correct as written; no production code change was needed
for mbserial itself. Also added `watchers/mdnsWatcher.test.ts`'s own
un-owned-mbserial regression test (mirrors the existing wifi one — same
shared `uniqueOwnedDeviceIdByName` gate). **This ticket does not run a
live bench pass against real `gopiv`/`tigez` hardware** — ticket 008 owns
that; the fake-mDNS-backed alternative is what the acceptance criterion's
own wording allows.

One incidental finding, noted but explicitly left alone (out of this
ticket's scope): a freshly mDNS-discovered `wifi`/`mbserial` link is
never automatically promoted from `discovered` to `connectable` by any
production code path (`mdnsWatcher.ts` only ever inserts a link at
`discovered`; nothing calls `setLinkState` to advance it) — `plan()`'s
own automatic-connect gate (`isAutoConnectEligible`) only ever fires for
`connectable`/`failed`, never `discovered`. `reconciler.test.ts`'s own
"executor integration" test papers over this by manually setting
`connectable` right after seeding the link. An *explicit* `session-open`
(what the UI's own "connect" click sends, and what this ticket's own
verification test uses) is unaffected — `planUserOpen` never gates on
`connectable` — so this is not a defect in what this ticket verifies, but
may be worth its own issue for whichever ticket owns real-world mDNS
auto-connect behavior.

**Registry-aware radio address resolution — narrower than planned, by
design.** Reading `connect/relayBridger.ts` and `watchers/relaySweeper.ts`
against the actual code (not just the ticket text) found both already
resolve their own radio address exclusively through
`resolveDefaultFailoverAddress`, which substitutes a hardcoded
`noRegistryResolve` for `radioOverride.ts`'s injectable `resolveRegistry`
seam — registry-free *by construction*, per rearch-09's own explicit "no
registry GET" acceptance criterion for default failover and rearch-10's
identical constraint for the sweeper (both already enforced and tested by
tickets 002/003 — see `connect/relayBridger.test.ts`'s own
"`resolveDefaultFailoverAddress` -- registry-free by construction" suite).
Neither call site has a `registry` argument that could ever reach a real
HTTP call, so "thread the registry into all three call sites" narrows to
one: **`server.ts`'s `session-open {relayLinkId, name}` handler is the
only genuine production wiring change** — it now reads the target
`relayLinkId`'s own discovered link row, parses `{host, registryPort}`
off its address (mdnsWatcher's `handleMbrelay` convention), and passes it
as `resolveDeviceRadio`'s `registry` option. `sprint.md`'s Step 2
responsibility 7 and the Step 3 "radio-address registry wiring" module
table row were updated to say this plainly rather than leave the stale
three-call-site claim standing.

Tests added: `server.test.ts`'s new "sprint 016 ticket 006" describe
block (registry resolves via a real loopback HTTP fake registry;
override wins outright even with that same registry reachable; a local
usb relay with no `registryPort` still resolves `override -> derived`
unaffected) — each test uses its own robot name, since
`mbrelayRegistry.ts`'s real `resolveRobotAddress` caches per-name in a
shared module-level `Map` this call site never overrides.
`watchers/relaySweeper.test.ts`'s two new tests (zero `fetch` calls
across a multi-candidate probe pass; a stored override still wins with
`fetch` spied to prove it's never even attempted) cover AC 4/5 at the
sweeper's own call site. AC 4 at `relayBridger`'s own call site was
already covered by ticket 002's existing suite (cited above), so no new
test was needed there.

**Files changed**: `packages/host/src/server.ts` (registry lookup +
threading in `session-open`), `packages/host/src/server.test.ts` (3 new
tests + a `waitFor` polling helper for the real-network case),
`packages/host/src/mbserialEndToEnd.test.ts` (new),
`packages/host/src/watchers/mdnsWatcher.test.ts` (1 new regression test),
`packages/host/src/watchers/relaySweeper.test.ts` (2 new tests),
`clasi/sprints/016-relay-ownership-radio-sweep-and-network-transports/sprint.md`
(Step 2/Step 3 corrections).

**Test run**: `npx vitest run packages/host/src` — 40 files, 633 tests,
all passing. `npm run typecheck` — clean. One pre-existing, unrelated
flake was observed and confirmed present on the unmodified codebase too
(reproduced independently, ~1 in 5 runs, on `main`/pre-ticket code): an
unhandled rejection ("database is not open") from
`watchers/relaySweeper.ts`'s `runRelayLoop` racing a test's own
`store.close()` in `watchers/relaySweeper.test.ts`'s `startRelaySweeper`
describe block — unrelated to this ticket's changes (verified by running
that file's original, unmodified version five times in isolation; it
reproduced four of five times there too). Left alone as out of scope;
flagged here rather than silently worked around.
