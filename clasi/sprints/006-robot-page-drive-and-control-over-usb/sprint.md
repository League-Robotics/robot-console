---
id: '006'
title: 'Robot page: drive and control over USB'
status: roadmap
branch: sprint/006-robot-page-drive-and-control-over-usb
use-cases: []
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 006: Robot page: drive and control over USB

## Goals

Build the robot page's drive-and-control surface against USB — the one
transport where verification is cheap — so sprint 7 can reuse it
**unchanged** once relay/radio transport exists. This is arc position 6
of the 8-sprint roadmap recorded in
`robot-console-two-level-ui-and-multi-transport-roadmap.md` (linked
above), which itself corrects a boundary error in
`docs/design/specification.md` §7: the original plan bundled the
transports (`RelayRadioLink`, `MbrelayLink`, mDNS) together with the
control surface (drive/stop/estop/`STATUS`/`GET`/`SET`) into one
sprint. **That boundary is wrong**, and this sprint exists specifically
to correct it.

Under the two-level UI those two halves land on different pages with
different dependencies: the robot page's control surface needs only
USB and the device-type/endpoint model sprint 4 introduces, while the
transport half needs mDNS, a registry client, and a relay on a bench.
Bundled, the control surface cannot ship until the transports work,
which — given the current state of hardware and the `pxt-nezha-diffdrive`
release pipeline (see the dependency risk below) — could stall
indefinitely. Split, the drive surface is designed and verified once
against USB, and sprint 7 reuses it as-is against relay/radio
transport.

**Stated design constraint, because it is the entire payoff of this
split:** `RobotView` must never know what transport it sits on. The
stakeholder's requirement that a relay-connected robot "shows the same
page as a directly connected robot" is only cheap to satisfy in sprint
7 if the component built here has no USB-specific assumptions baked
into its rendering or interaction logic — only into the `Link` it is
handed. If this sprint accidentally couples the UI to USB specifics
(e.g. assuming synchronous local latency, or reaching past the `Link`
abstraction), sprint 7 inherits a rewrite instead of a reuse.

Concretely, this sprint gives the robot page: drive controls, an
always-reachable e-stop, `STATUS`/`GET`/`SET`, and visible
sequence/ack/nack state — by finally wiring the UI to
`packages/protocol/src/v6/session.ts`, the reliability/sequencing layer
that has been unit-tested since sprint 1 but has never yet driven a
UI.

## Problem

`deviceRegistry.ts` currently uses **none** of what `UsbSerialLink`
already exposes for reliable, sequenced communication — `sendCommand`
(sequenced), `sendUnsequenced`, `checkLiveness`, `onAckNack`, and
`session` itself. It only ever calls `sendLine`. There is a fully
built, fully tested session/sequencing layer
(`packages/protocol/src/v6/session.ts`, covering
`SEQUENCED_VERBS` — the eleven id-bearing verbs including `RUN` —
retransmit, and the `nack N` → `seq = N-1` arithmetic) sitting unused
behind a UI that has no drive controls, no e-stop, and no visibility
into ack/nack/sequence state at all.

Layered on top of that gap are several protocol subtleties the UI must
respect and that a naive implementation would get wrong:

- **`HELLO` is a reset, not a health check.** It resets the robot's
  sequence state to 1, and `Session.sendUnsequenced()` already refuses
  the verb outright for this reason. Liveness must be checked with
  `STATUS` or `PING`, never `HELLO`.
- **Nothing is unsolicited** except the boot banner, subscribed
  telemetry, and `DBG:` lines. An idle link is completely silent, so
  the UI cannot treat absence of traffic as evidence of a dead robot.
- **Writing flat out at 115200 overruns the board.** Frames must be
  paced at roughly 10ms apart, enforced host-side — not left to
  whatever rate the UI happens to send commands.
- Radio (sprint 7) is fire-and-forget with no retransmit and a hard
  frame cap. USB does not yet enforce that cap, but messages should
  stay small now so the control surface does not need reshaping when
  sprint 7 attaches it to radio.

## Solution

Attach `Session` to the robot page via the three wiring points
`UsbSerialLink` already demonstrates — this is integration work, not
new protocol design. The session/reliability layer
(`packages/protocol/src/v6/session.ts`) and the wire codec
(`packages/protocol/src/v6/codec.ts`: `encodeLine`/`decodeLine`,
`MAX_LINE_BYTES = 240`, `classifyLine`) are built and tested; this
sprint is where a UI first consumes them.

- **Drive controls** — a `RobotView` that sends drive commands through
  `UsbSerialLink.sendCommand` (sequenced), so every drive command
  participates in the same ack/nack/retransmit discipline as any other
  sequenced verb, with no bespoke path.
- **E-stop as an always-reachable, first-class affordance** — not a
  menu item or a corner button, but treated as a safety control from
  the start of the design: reachable regardless of what else is on
  screen, and understood by the UI as making a real safety claim (see
  Success Criteria).
- **`STATUS`, `GET`/`SET`** — surfaced through the same sequenced path,
  giving the operator visibility into robot state and configuration
  without introducing a second communication mechanism alongside
  `Session`.
- **Sequence/ack/nack state made visible in the UI** — expose what
  `session.ts` already tracks (current sequence, outstanding
  acks/nacks, retransmit activity) rather than hiding it, so a stuck
  or misbehaving link is diagnosable from the page instead of being
  silent.
- **Write pacing at ~10ms, enforced host-side** — in the host process
  (alongside or reusing `UsbSerialLink`'s existing pacing plumbing),
  not left to the browser or to however fast the UI emits commands.
- **Transport-blindness as a build discipline, not just a stated goal**
  — `RobotView` receives a `Link`-shaped dependency and renders off
  `Session`'s state; it must not import or branch on anything
  USB-specific. This is what makes the sprint-7 reuse "unchanged"
  claim checkable rather than aspirational.

## Success Criteria

- Drive commands, `STATUS`, and `GET`/`SET` all flow through
  `Session`'s sequenced path over USB, with sequence/ack/nack state
  visible in the UI.
- E-stop is reachable from the robot page regardless of other UI
  state.
- Host-side pacing holds writes to ~10ms apart under sustained input
  (e.g. held drive controls), verified by test against a fake link.
- **The full session/reliability contract is test-provable against a
  fake link**: the `nack N → seq = N-1` arithmetic, retransmit reusing
  its original id (byte-identical originals only), the 240-byte cap,
  lowercase-unknown-verb silent drop, pacing enforcement, and `HELLO`
  never being used as a liveness probe on a live session.
- **E-stop is a safety claim. It must not be marked verified against a
  fake link.** A fake link can prove the UI sends the correct
  sequenced e-stop command at the correct time; it cannot prove a
  robot actually stops. That claim is verified only against real
  hardware, and the sprint's verification section must say so
  explicitly rather than let a passing test suite imply a safety
  property it did not test.
- Drive commands moving a real robot, and e-stop actually stopping it,
  are recorded as hardware-deferred criteria, not checked off until
  exercised on a board.

## Scope

### In Scope

- Drive controls on the robot page.
- E-stop as an always-reachable, first-class affordance.
- `STATUS` and `GET`/`SET`, surfaced through the sequenced session
  path.
- Sequence/ack/nack state made visible in the UI.
- Host-side write pacing at ~10ms.
- Wiring `deviceRegistry.ts`/the robot page to the `Session` and
  `UsbSerialLink` capabilities that already exist
  (`sendCommand`, `sendUnsequenced`, `checkLiveness`, `onAckNack`,
  `session`) but are not yet used by anything.

### Out of Scope

- Any new transport: `RelayRadioLink`, `MbrelayLink`, `MbserialLink`,
  mDNS discovery, the registry client — all sprint 7.
- Telemetry decoding and charts — sprint 8.
- Calibration wizards — sprint 10.
- The relay's robot dropdown — sprint 7.

## Dependencies and risk

Depends on **sprint 4** (device model, robot page shell — provides the
type union and page this sprint's controls render into). Independent
of sprints 5 (persistence) and 7 (relay/radio/discovery) — this sprint
does not need the roster and produces nothing sprint 7 needs beyond
the `RobotView` component itself.

**Robot-hex sourcing must be resolved before this sprint is
detail-planned.** `League-Robotics/pxt-nezha-diffdrive` publishes
**zero** GitHub releases, so there is no obtainable robot hex through
the normal release path — the local-hex picker introduced in sprint 4
is the only currently-known route onto a board. Two robots (`vevov`,
`gopiv`) are reachable on the network and answer `FUNCS`, but only over
mDNS/WiFi, not USB, so they do not by themselves satisfy this sprint's
USB premise. This is recorded as an open question in
`docs/design/specification.md` §9 and is the most consequential
unresolved item blocking this sprint, sprint 7, sprint 8, and sprint
10.

**A USB-attached board cannot currently even be classified as a
robot.** Per `clasi/issues/flash-succeeds-but-board-never-announces.md`,
no board currently announces after a flash. That gap must be resolved
before this sprint's success criteria — which depend on identifying
and driving a real robot over USB — can be verified at all, hardware
availability aside.

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
