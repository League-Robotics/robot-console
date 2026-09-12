---
id: '006'
title: mbserial verification and registry-aware radio address resolution
status: open
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

- [ ] Real-hardware or fake-mDNS-backed test: an mbserial-discovered
      owned robot connects, exchanges at least one `send-command`
      round trip, and closes cleanly — confirming (or correcting)
      the Step 1 reading that this already works.
- [ ] An un-owned mbserial advertisement stays hidden with no connection
      attempt (regression guard on the existing `uniqueOwnedDeviceIdByName`
      rule).
- [ ] With a fake registry reachable via a discovered mbrelay pool's
      `registryPort`, a `session-open {relayLinkId, name}` bridge for a
      robot with no override resolves through the registry, not straight
      to derived.
- [ ] A stored override still wins outright regardless of registry
      reachability, at all three call sites (`session-open`,
      `relayBridger`, `relaySweeper`).
- [ ] The sweeper still never issues a registry GET during a probe pass
      (regression guard against ticket 003's own acceptance criterion).
- [ ] `npx vitest run packages/host` passes.

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
