---
id: '007'
title: Relay page, radio transport, network discovery
status: roadmap
branch: sprint/007-relay-page-radio-transport-network-discovery
use-cases: []
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 007: Relay page, radio transport, network discovery

## Goals

**This is a large sprint — arc position 7 of the 8-sprint roadmap** in
`robot-console-two-level-ui-and-multi-transport-roadmap.md` (linked
above). Its goal: make a relay — local over USB, or remote over the
network — a way to reach a robot, such that **that robot renders the
same `RobotView` page as a directly-connected robot** (the page sprint
6 builds, reused unchanged). The relay page has exactly two states:
connected to a robot, or not. It carries a dropdown of known robot
names (fed by sprint 5's roster) and, by default, tries the first
robot it finds, preferring one that answers, and falls over to the
next if it doesn't.

Concretely this sprint delivers three transports sharing one
command-plane preamble, mDNS browse infrastructure for two service
types, a read-only registry client, and the relay page itself with its
connected/not-connected states and failover behavior.

Depends on sprint 4 (resource-key model, `Link` abstraction, endpoint
model), sprint 5 (the roster that feeds the dropdown), and sprint 6
(the `RobotView` page this sprint reaches into — must stay
transport-blind for the reuse to hold).

## Problem

A relay sits between the console and a robot with **no in-band escape
route**: once the command-plane preamble (`!ECHO OFF`, `!MODE RAW250`,
`!CG <ch> <grp>`, `!P 7`, `!GO`) hands off to the data plane, a break
cannot be sent over TCP at all, and even locally the only way back to
the command plane is a reset. That is why the `Link` abstraction
(sprint 4) deliberately has **no `retarget()`** — switching the
dropdown's robot must be close-session → new `LinkSpec` → open-session,
never an in-place retarget.

Three findings from live-network verification this session change the
design from what the original spec assumed:

1. **The mbrelay registry lookup is a write, not a read.**
   `httpapi.py:146` returns `registry.resolve(name)`, and `resolve()`
   derives the address locally on a miss, writes it into `_learned`,
   calls `save()`, and returns HTTP 200 with `source: derived`. So "the
   HTTP call succeeded" does not mean "the registry knew" — treating
   success as authority would present a locally-derivable guess as
   fact, exactly the failure UC-004 exists to prevent. And because a
   lookup *enrolls* the name, prefetching for the dropdown would inject
   an entry per student per robot into shared classroom state.
   `registry.py` has a non-mutating `get()` the HTTP route doesn't use;
   this sprint's client stays read-only regardless (no `POST`/`DELETE`
   — the API has no auth).

2. **Registry discovery is itself an mDNS lookup, not a port
   convention.** Verified live: `_mbrelay._tcp` advertises instance
   `torture` at `torture.local.:8760` with TXT
   `txtvers=1 version=0.20260831.1 node=torture registry=8761` — the
   registry port travels in the TXT record. `_mbserial._tcp` advertises
   bare five-letter instance names (`vevov`, `gopiv`) directly.

3. **Failover is a heuristic against a silent link, not a clean
   yes/no.** Radio is fire-and-forget with no retransmit, and nothing
   on an idle link is unsolicited — so one unanswered probe does not
   prove a robot is absent. Compounding this, four independent failure
   modes present **identically as silence**: wrong channel/group; the
   robot build having `BOOT_RADIO_LINK = false` (the default — a stock
   build does not answer the radio at all); a misconfigured relay; or
   the robot simply being off. Diagnosability has to be budgeted for
   deliberately or the bench session is unbounded.

## Solution

**Transports and shared preamble.** `RelayRadioLink` (local USB relay),
`MbrelayLink` (TCP to `_mbrelay._tcp`, **must set `TCP_NODELAY`** — the
command-plane handshake is latency-sensitive line-at-a-time traffic),
and `MbserialLink` (TCP to `_mbserial._tcp`). All three share the
command-plane preamble and a small state machine, extracted as pure,
I/O-free line-builders in `packages/protocol/src/relay/commands.ts` per
sprint 4's plan — unit-testable with zero I/O, and not reimplemented
per-transport. `!CG` rejection must leave the relay in the command
plane and `!GO` must never hang un-timed-out if it doesn't confirm.
Radio frames are capped (≤16 bytes MAKECODE, ≤247 bytes RAW250) —
oversized frames are refused, never silently fragmented. The `<`
line-prefix stripping `LineReassembler` already does unconditionally
applies here too.

**Discovery.** mDNS browse for `_mbrelay._tcp` and `_mbserial._tcp`.
Registry discovery rides the same browse: the registry's host and port
come out of the `_mbrelay._tcp` TXT record (`registry=<port>`), not a
fixed convention, so "registry unreachable" includes "no relay
advertising on the LAN at all."

**Registry client** (`packages/host/src/mbrelayRegistry.ts`,
`resolveRobotAddress(name, opts) → ResolvedAddress`, never throws).
**Three outcomes, not two**: `config`/`registry` (authoritative);
`derived` (registry replied but only echoed back our own derivation —
surfaced as prominently as a fallback, because the failure mode it
represents is identical to one); `local-derived` (registry unreachable
entirely). Resolution is **lazy, at connect time, for one name only** —
never prefetched for the dropdown. Read-only against the registry
(`get()`, no `POST`/`DELETE`). Short client-side timeout (~1.5s;
mbrelay's own client uses 3s, too long to block a click) and a short
TTL cache so a re-click doesn't re-trigger a registry write.

**Fallback disclosure, tuned against alarm fatigue.** For a local USB
relay there is usually no mbrelay daemon at all, so `local-derived` is
the *normal* classroom path, not an exceptional one — the indicator
will be lit most of the time. A persistent inline chip (e.g. `Address:
ch 37 / grp 3 · derived (no registry)`) is styled **neutrally** when no
registry was ever configured, and as a **warning** only when a registry
was configured and either failed or answered `derived`. The chip must
never be silent (spec §6, UC-004), but silence and alarm fatigue are
both failure modes here — the design has to avoid both.

**Failover.** "Try the first robot, prefer one that answers, try the
next if not" is implemented as a liveness probe using `STATUS` or
`PING` — **never `HELLO`, which resets the sequence** — with explicit
retries and a timeout, because one unanswered probe doesn't prove
absence on a fire-and-forget link. "Gave up on X, trying Y" is surfaced
visibly, not swallowed. Given the four silence-alike failure modes
above, the page keeps the fallback-in-use flag, the current `(channel,
group)`, and the failover trail on screen at all times — this is a
diagnosability requirement, not a nice-to-have.

**Relay page.** Two states only: connected to a robot, or not. A
dropdown of known robot names (sprint 5's roster). When connected, it
renders sprint 6's `RobotView` unchanged. When not connected, there is
little to do beyond setting a manual channel/group.

**Resource keying.** A relay's `resourceKey` **is** the relay's
`usb-<serial>` (sprint 4's model) — driving through the relay and
flashing the relay are mutually exclusive through the existing
`KeyedMutex`, with no new mechanism needed.

## Success Criteria

- All three transports (`RelayRadioLink`, `MbrelayLink`, `MbserialLink`)
  share one command-plane implementation with zero duplicated preamble
  or nack-arithmetic logic.
- The registry client's three outcomes (`config`/`registry`, `derived`,
  `local-derived`) are test-provable against an injected fetch
  function, including that a lookup is never issued speculatively for
  the dropdown.
- The relay page never silently hides a fallback: the address-source
  chip is visible in both its neutral (no registry) and warning
  (registry configured but not authoritative) states.
- Failover visibly reports "gave up on X, trying Y" and never uses
  `HELLO` as a liveness probe.
- Frame-size refusal (>16 bytes MAKECODE, >247 bytes RAW250) and `!CG`
  rejection / `!GO` timeout handling are test-provable against a fake
  link.
- **Hardware-deferred, not checked off until exercised on a bench**:
  that a real relay actually bridges radio traffic to a real robot;
  that failover against a live, partially-silent classroom of robots
  behaves as designed; that `TCP_NODELAY` measurably fixes any latency
  problem it's meant to address. `BOOT_RADIO_LINK` must be confirmed
  true on whatever hex is used for bench verification **before** the
  bench session, not discovered during it.

## Scope

### In Scope

- `RelayRadioLink` (local USB relay).
- `MbrelayLink` (TCP to `_mbrelay._tcp` on the advertised port,
  `TCP_NODELAY` set).
- `MbserialLink` (TCP to `_mbserial._tcp`).
- Shared command-plane preamble and state machine
  (`packages/protocol/src/relay/commands.ts`).
- mDNS browse for `_mbrelay._tcp` and `_mbserial._tcp`.
- mbrelay registry client (read-only, lazy, three-outcome).
- Relay page: connected / not-connected states, robot dropdown fed by
  sprint 5's roster, address-source disclosure chip.
- First-robot-found default with liveness-probe failover.

### Out of Scope

- `WifiUdpLink` and `_robotlink._*` discovery — sprint 9.
- Telemetry — sprint 8.
- Calibration wizards — sprint 10.
- Any change to `RobotView` itself — reused unchanged from sprint 6.

## Dependencies and risk

Depends on sprint 4 (resource key, `Link`/`LinkSpec` abstraction,
endpoint model), sprint 5 (roster feeds the dropdown), and sprint 6
(the `RobotView` page this sprint reaches — its transport-blindness is
what makes reuse here "unchanged" rather than a rewrite).

**Splitting at detail-planning time.** This sprint bundles three
genuinely separable concerns — (a) the three link transports plus
shared command-plane preamble, (b) mDNS browse + registry client
discovery infrastructure, and (c) the relay page UI with dropdown and
failover — that could reasonably become two or three tickets-worth of
sub-sequencing, or even a formal split, if detail-planning finds the
combined scope too large for one sprint branch:
- **(a) is a prerequisite for (b) and (c)** and is independently
  test-provable with zero I/O (pure line-builders), so it is the
  natural first slice regardless of split.
- **(b) and (c) could plausibly separate** — discovery/registry
  plumbing is testable against injected fetch/mDNS fakes without any
  UI; the relay page's dropdown and connected-state rendering is where
  hardware-dependent judgment calls (failover tuning, disclosure
  copy) concentrate. If detail-planning finds the combined ticket count
  unwieldy, split along this seam rather than by transport.
- The bench-verification risk (four silence-alike failure modes) is
  sprint-wide and does not itself suggest a split — it argues instead
  for front-loading the `BOOT_RADIO_LINK` hardware check, per the
  original issue's instruction, before detail-planning locks scope.

## Test Strategy

(Describe the overall testing approach for this sprint: what types of tests,
what areas need coverage, any integration or system-level testing needed.)

## Architecture

(Architecture for this sprint's change, sized to the change — a
one-paragraph note for a trivial sprint, a fuller write-up with
component/data-model detail for a substantial one. May read "N/A —
trivial" when the change has no architectural impact.)

### Architecture Overview

(High-level structure and component relationships, if applicable.)

### Design Rationale

(Significant decisions with alternatives considered and reasoning, if
applicable.)

### Migration Concerns

(Data migration, backward compatibility, deployment sequencing — or
"None" if not applicable.)

## Use Cases

(Use cases sized to the change — may read "N/A — trivial" for small
sprints that don't warrant new or updated use cases.)

### SUC-001: (Title)
Parent: UC-XXX

- **Actor**: (Who)
- **Preconditions**: (What must be true before)
- **Main Flow**:
  1. (Step)
- **Postconditions**: (What is true after)
- **Acceptance Criteria**:
  - [ ] (Criterion)

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|

Tickets execute serially in the order listed.
