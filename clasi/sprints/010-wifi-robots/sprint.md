---
id: '010'
title: WiFi robots
status: roadmap
branch: sprint/010-wifi-robots
use-cases: []
issues:
- robot-console-two-level-ui-and-multi-transport-roadmap.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 010: WiFi robots

## Goals

**Arc position 9 of the 10-sprint roadmap** in
`robot-console-two-level-ui-and-multi-transport-roadmap.md` (linked
above). Give a robot that already carries WiFi credentials — set by
some means outside this console — a way to be discovered on the LAN
and switched to automatically from radio, per UC-010. This sprint sits
here rather than after calibration because its blocker is a
**precondition** (provisioning happens outside the console, by design)
rather than a missing artifact, unlike calibration which is gated on a
hex that does not exist. It also reuses sprint 7's mDNS browse
infrastructure while that work is fresh.

Depends on sprint 5 (the remembered-robot roster that gates displayed
advertisements) and sprint 7 (mDNS browse infrastructure, the
`Link`/`LinkSpec` model a new transport plugs into).

## Problem

`docs/design/specification.md` §4.4 and UC-010 previously described a
WiFi discovery path that matches nothing a robot actually advertises.
Two robots, `vevov` and `gopiv`, were observed live on the network
while planning this arc, and their real advertisements corrected the
spec (sprint 3, ticket 004) in ways this sprint must build to rather
than rediscover:

- Both robots advertise under **both** `_robotlink._tcp` **and**
  `_robotlink._udp` simultaneously — not `._udp` alone.
- Resolving either service type yields host `<name>.local.`, port
  **7654**, and TXT `name=<name> role=robot link=v6 port=7654`.
- **The TXT record carries `link=v6`, not `link=v6-udp`.** A browse
  filtering on the old, wrong value matches nothing and looks
  indistinguishable from a network fault — this is the specific bug
  the spec correction exists to prevent from being reintroduced.
- The robot runs a **TCP server on the same port 7654**, so a TCP link
  is a legitimate alternative to `WifiUdpLink`, not a hypothetical.

Separately, the stakeholder was explicit that a classroom is full of
robots advertising over WiFi, radio, and mbdeploy all at once, and
**only robots this machine has previously seen over USB should ever
be displayed** as WiFi candidates. Sprint 5's roster exists precisely
to answer that question, and it was deliberately written so that only
a USB identify populates it — never an mDNS sighting — so that an
advertisement cannot enroll a robot and then pass its own filter. This
sprint is the first consumer of that guarantee for network discovery;
getting the gate wrong here (e.g. by displaying anything that
resolves) would silently defeat the roster's whole purpose.

`_mbserial._tcp` also advertises `vevov`/`gopiv` under bare five-letter
instance names — that is mbdeploy discovery, sprint 7's concern, not
this one. Conflating the two service families would put unrelated
peers in the same list.

## Solution

**Discovery.** `mdns.ts` browses **both** `_robotlink._tcp` and
`_robotlink._udp` (§4.4, corrected). A matching service record is
parsed for `name`, `role`, `link`, and `port` from its TXT fields;
records are matched to sprint 5's roster by `name` before being shown
anywhere — an advertisement for a name not in the roster is discarded
at the parsing/filtering boundary, not merely hidden in the UI, so
there is no code path that can leak an unrecognized robot into a
dropdown or a session. This is the **only** place in the whole arc
where discovery is gated: the relay dropdown (sprint 7) is
purely roster-driven with no discovery to filter, because a radio
robot advertises nothing at all. The two mechanisms must stay visibly
distinct in this sprint's design — conflating them puts the filter in
the wrong layer.

**Transport choice — UDP vs TCP, decided explicitly, not assumed.**
The specification names `WifiUdpLink` (UDP to :7654, bound locally to
:7655) as the transport in `packages/host/src/link/`, but the robot
serving the identical v6 line grammar over TCP on the same port makes
TCP a real alternative rather than a fallback of last resort. This
sprint's detail-planning must pick one as the implemented path and
record *why* rather than defaulting to UDP because the spec mentions
it first — the two have different failure characteristics (UDP: no
delivery guarantee, matches the radio robot's fire-and-forget model
the rest of the codebase is built around; TCP: ordered/reliable but a
new connection-management surface). Whichever is chosen, it reuses
sprint 4's `Link`/`LinkSpec` abstraction and resource-key model
unchanged — `WifiUdpLink`'s (or its TCP sibling's) `resourceKey` keys
on the **local bind port** (`udp-local-7655` or equivalent), not the
remote host, since only one socket can bind it locally.

**Auto-switch (UC-010).** When an advertised, roster-matched name
matches a robot currently connected over radio, the host opens the
WiFi link and switches the active session to it; the Devices/Console
surfaces reflect the robot as connected over WiFi rather than radio.
If no matching advertisement ever appears, the robot continues on
radio indefinitely — WiFi is opportunistic, never required, and the
absence of an advertisement must never be treated as an error.

**Provisioning stays out, by design, not by oversight.** §9 open
question 2 is unchanged: `kWifiSsid`/`kWifiPassword` are `constexpr`
empty strings rewritten in a deploy-time scratch copy by
`tools/make_deploy.py`, with no `SET` field and no `uBit.storage`
record backing them at runtime. There is no wire verb this sprint
could call to provision a robot, and patching a compiled hex is
fragile and explicitly not worth attempting. An unprovisioned robot
therefore never advertises `_robotlink._*` at all — this sprint simply
does not apply to it, and the console has no path to fix that. This is
a precondition gap, not a missing feature, which is exactly why this
sprint can be built now rather than waiting.

**Security note to carry into detail-planning, not to design around
now.** `WifiUdpLink` (or its TCP sibling) binds a LAN-reachable port in
a host process whose entire security posture today is
"localhost-only" — `server.ts` binds `127.0.0.1` deliberately for the
UI-facing WebSocket. The WiFi link's socket, by contrast, must be
reachable from the robot on the LAN, so it should bind a specific
interface where the platform allows it, and treat every inbound
datagram/segment as untrusted input. The v6 codec's existing discipline
of dropping foreign and malformed lines is the right existing defense
here — record that as the answer rather than inventing a second
validation layer.

## Success Criteria

- Browsing `_robotlink._tcp` and `_robotlink._udp` and parsing their
  TXT records (`name`, `role`, `link=v6`, `port=7654`) is correct
  against fixtures built from the live `vevov`/`gopiv` observations,
  for both service types.
- An advertised robot never seen over USB (absent from sprint 5's
  roster) never appears anywhere in the UI or is ever eligible for
  auto-switch — proven by a test asserting the negative, not just the
  positive case.
- An advertised, roster-matched name that matches a robot currently on
  radio triggers an automatic switch to WiFi, and the UI reflects the
  new transport.
- No advertisement present is a graceful no-op: the robot stays on
  radio, with no error surfaced.
- The chosen transport (UDP or TCP) is stated with its rationale in
  this sprint's Architecture section at detail time, not left implicit.
- **Hardware/network-deferred, not checked off until exercised live**:
  that a real provisioned robot on the LAN is actually reachable and
  controllable over the chosen WiFi transport. `vevov` and `gopiv` are
  available on the network right now, which is unusually favorable —
  but since this console cannot provision a robot itself, that
  availability is not guaranteed to persist through detail-planning or
  execution, and the sprint must not be blocked if it doesn't.

## Scope

### In Scope

- mDNS browse for `_robotlink._tcp` and `_robotlink._udp`.
- Service-record parsing for both service types (`name`, `role`,
  `link=v6`, `port=7654`).
- Gating displayed advertisements against sprint 5's remembered-robot
  roster (by `name`) before any advertisement is shown or acted on.
- A WiFi link to a discovered, roster-matched robot (UDP or TCP —
  decided explicitly at detail time; see Solution).
- Auto-switching a named robot from radio to WiFi when it appears
  (UC-010), with the Devices/Console tabs reflecting the new
  transport.
- Binding the WiFi link's local socket defensively (specific interface
  where possible) given it is LAN-reachable, unlike the rest of the
  host's localhost-only surface.

### Out of Scope

- **Provisioning.** §9 open question 2 is unchanged and
  stakeholder-gated — no `SET`/`uBit.storage` path exists in firmware,
  and patching a compiled hex is explicitly not worth doing. An
  unprovisioned robot is simply out of this sprint's reach.
- Relay and radio transports — sprint 7.
- Telemetry decoding over any transport — sprint 8.
- Calibration wizards — sprint 10.
- `_mbserial._tcp` discovery — that is mbdeploy, sprint 7's concern.

## Test Strategy

**Test-provable, and expected to be genuinely complete on its own**:
service-record parsing for both `_robotlink._tcp` and
`_robotlink._udp` against fixtures modeled on the live `vevov`/`gopiv`
TXT records; roster gating, including the negative case — an
advertised robot never seen over USB stays hidden and ineligible for
auto-switch, proven against an injected roster fixture; auto-switch
matching an advertised name to a currently-connected radio robot;
graceful no-op behavior when nothing advertises at all.

**Needs hardware/network, not test-provable**: an actual provisioned
robot answering on the chosen WiFi transport end-to-end. `vevov` and
`gopiv` are available now, which is unusually favorable for this arc,
but their continued presence is not guaranteed and the sprint must not
be planned as if it were.

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
