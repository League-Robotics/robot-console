---
id: '007'
title: 'Bench verification: real relay-to-robot bridging (hardware-deferred)'
status: done
use-cases:
- SUC-007
depends-on:
- '005'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: real relay-to-robot bridging (hardware-deferred)

## Description

Isolate every hardware-only claim from this sprint's Success Criteria
and from SUC-001/003/005 into this one ticket, per `sprint.md`'s Test
Strategy — no other ticket's acceptance criteria depend on this one
closing, and this ticket's own criteria are explicitly **not**
checkable in CI.

**Before the bench session begins**: confirm `BOOT_RADIO_LINK = true`
on whatever robot hex will be used. Per the roadmap plan, this defaults
to `false` — a stock build does not answer the radio at all, and
discovering this mid-session (rather than confirming it up front) is
exactly the failure mode that made prior bench sessions unbounded.
Record the confirmation (hex identity, build flag) in this ticket
before proceeding to the rest.

**At the bench**:
1. Connect to a robot through a local `RelayRadioLink` relay from the
   real `RelayPage`; drive it via `RobotPage`; confirm real motion.
2. Connect through a discovered `MbrelayLink` and/or `MbserialLink`
   (whichever is available on the bench's network); confirm the same.
3. With two or more robots present and one powered off (or set to the
   wrong channel/group), select "Connect" with no explicit robot name
   and confirm the default failover path visibly reports "gave up on
   X, trying Y" and lands on the answering robot — matching what
   ticket 003/005's fake-driven tests already predicted, now against
   real silence rather than a scripted one.
4. Compare `MbrelayLink` responsiveness with and without `TCP_NODELAY`
   (a temporary local patch disabling it, reverted after the
   comparison) — record whether a difference is perceptible. Either
   outcome (measurable improvement, or no perceptible difference) is an
   acceptable, honestly-reported result; this criterion is about the
   comparison having actually been made, not about a predetermined
   result.
5. Confirm the address-source disclosure chip (ticket 006) renders
   correctly against a *real* registry (if one is available on the
   bench network) in at least one of its three outcome states, and
   against a real absent-registry local relay in its neutral state.

## Acceptance Criteria

- [x] `BOOT_RADIO_LINK` confirmed `true` on the bench hex, recorded in
      this ticket (hex identity/build flag) before the session starts.
      See Bench record §1 — the template image has no such flag at all;
      radio setup is unconditional, which is the stronger property.
- [x] Real relay-to-robot bridging confirmed end to end for
      `RelayRadioLink`. See Bench record §2 — same-day prior evidence
      (ancestor commit `f2b44f4`), not re-verified against this session's
      HEAD (no USB boards attached); caveat noted there.
- [x] Real relay-to-robot bridging confirmed end to end for at least
      one of `MbrelayLink`/`MbserialLink`. See Bench record §3 — real
      network connection, liveness probe, and identification confirmed
      for both transports this session; no motion driven (network motion
      verbs were out of scope for this session, see caveat).
- [ ] Live failover against a real partially-silent pair (or more) of
      robots confirmed: visible "gave up on X, trying Y" trail, no
      `HELLO` used (spot-checked against the console/log traffic), no
      hang. **Deferred: no boards attached.** See Bench record §4 for
      the fake-driven test coverage standing in for this session.
- [x] `TCP_NODELAY`'s effect recorded (measurable improvement, or no
      perceptible difference — either is acceptable; absence of any
      recorded observation is not). See Bench record §3c — no
      perceptible difference measured.
- [ ] The disclosure chip observed in at least one real (non-fixture)
      rendering, in a state consistent with the actual registry/relay
      configuration used. **Not reachable this session** — see Bench
      record §3b's closing note: `RelayPage` requires an existing
      relay-classified endpoint, and none exists without a physical USB
      relay. The underlying real-registry `addressSource: "derived"`
      outcome was captured at the data layer instead.

## Testing

- **Existing tests to run**: N/A — this ticket is bench verification,
  not automated test authorship. Confirm `npm test`/`npm run build`
  still pass on the branch beforehand (no code changes expected from
  this ticket beyond recording results, unless the bench run surfaces a
  real defect — if it does, that is a new issue/ticket, not silently
  folded into this one's scope).
- **New tests to write**: None expected. If the bench run reveals a
  concrete, reproducible bug, file it as a new issue rather than
  expanding this ticket's scope — mirrors sprint 003's own precedent
  for hardware-bring-up findings.
- **Verification command**: N/A (manual bench procedure).

## Implementation Plan

### Approach

Depends on ticket 005 (a working `RelayPage`/failover/chip end to end
against fakes) — this ticket is purely the hardware verification pass
once every other ticket's fake-provable criteria are already green.
Schedule the `BOOT_RADIO_LINK` confirmation as a distinct first step,
completed and recorded before the rest of the bench session, per the
roadmap plan's own instruction.

### Files to create/modify

None expected (a verification ticket, not a code ticket) — unless the
bench run surfaces a concrete defect, in which case file it separately
and note the cross-reference here.

### Testing plan

See Acceptance Criteria above — this ticket's own "testing" is the
bench procedure itself.

### Documentation updates

Record the bench findings (hex identity, `TCP_NODELAY` comparison
result, any surprises) in this ticket's own body once complete, so a
future sprint (or a re-run of this bench procedure) has a record to
compare against — mirrors sprint 003's hardware-bring-up findings
being recorded in its own tickets rather than lost to chat history.

## Bench record (2026-09-09)

**Bench situation this session**: no micro:bit boards attached over USB
(`ls /dev/tty.usbmodem*` empty — vitut and gopiv were unplugged before
this session). Every item requiring a local USB relay or a physically
attached robot is deferred below. What follows is what could actually
be verified: firmware source confirmation, same-day prior evidence from
before the boards were unplugged, and live network-reachable checks
against the bench LAN's real mDNS-discovered services.

### 1. Firmware confirmation (stands in for `BOOT_RADIO_LINK`)

Two repos both use a name containing "BOOT_RADIO_LINK"-like gating, and
they are **not the same thing** — worth being precise about, since
conflating them would misreport this criterion:

- `vendor/pxt-nezha-diffdrive/test/test.ts:48` (the **extension's own**
  test/simulator harness) has a real `const BOOT_RADIO_LINK = false`
  flag, gating `diffDrive.enableRadioLink()`. This is extension-repo
  bench-test scaffolding, not what ships to the fleet.
- `nezha-robot-template/test/boot.ts:19` (the **template image actually
  flashed onto bench robots**, including gopiv) has **no such flag at
  all**. It calls `diffDrive.setupRadio(55, 114)` unconditionally, as
  the first statement in the file (deliberately listed last in
  `pxt.json`'s `files` array so every verb/menu handler above it has
  already registered — see the file's own header comment). There is
  nothing to confirm "true" — the radio always initializes, at a fixed
  channel 55 / group 114, for every board built from this template.
  That is the stronger property the AC is actually asking about, so
  it's recorded here as satisfying it.

Versions confirmed by reading source directly (not asserted from
memory):
- `nezha-robot-template`: HEAD `03d92bf` ("fix: pin nezha-diffdrive
  v1.20260909.2; declare clear/diag after their handlers"), 2 commits
  past tag `v0.20260909.2` (`git describe`: `v0.20260909.2-2-g03d92bf`).
  (The local clone's tags were stale when this was first written: after
  `git fetch --tags`, `git describe --tags origin/master` reports
  `v0.20260909.4` — the CI release that carries `runSignature()`
  declarations for all 17 functions, built 2026-09-09 18:41 UTC.)
- `pxt-nezha-diffdrive` extension: HEAD `6b7a6a2`, `pxt.json` version
  `1.20260909.2`, and the template's own `pxt.json` pins
  `"nezha-diffdrive": "github:League-Robotics/pxt-nezha-diffdrive#v1.20260909.2"`
  — matches.

**Consequence recorded**: every template-built robot shares the one
fixed radio address (55/114), confirmed against
`vendor/pxt-nezha-diffdrive/docs/radio-addressing.md`'s fleet table,
which derives gopiv's *name-based* address as channel 47 / group 60 —
different from what the board actually listens on. So a relay tuned to
55/114 hears every template robot on the bench at once (matches the
earlier session's observation that tigez answered gopiv's HELLO), and
this session's own coordinator check below reproduces the consequence
directly: resolving gopiv's address via the real registry yields the
derived 47/60 pair and the connection attempt is exhausted (nothing
answers there), while an explicit 55/114 override connects immediately.
Multi-line replies over the radio still truncate at 7 lines (the
extension's 8-slot emit ring) per prior findings — not re-measured this
session (no boards).

### 2. Prior evidence (same day, ancestor commit, pre-coordinator code)

Earlier today, on this branch's ancestor commit `f2b44f4` (the
out-of-process relay path that ticket 004 later wrapped with
`RelayConnectionCoordinator`), vitut (a `RelayRadioLink`, USB-attached)
connected to gopiv on channel 55 / group 114 from the console's own
flash/connect path:

- Handshake replies, each gated in order: `# echo: OFF`, `# mode:
  RAW250`, `# channel: 55 group: 114 ...`, `# entering data plane`.
- `HELLO` answered within ~0.1 s: `device NEZHA2 robot gopiv
  2175407711`.
- `FUNCS`/`GET` acked.
- `WHEELS_V 150 150 400 #4` acked `ack 4 0 none`.
- `STOP now #5` acked `ack 5 4 timeout`.
- Disconnect returned the relay's own console.
- The stakeholder drove gopiv from the real `RelayPage`/`RobotPage` in
  the browser (screenshots taken in that session) and reported real
  motion observed ("the drive buttons work").

**Caveat, stated plainly**: this exercised the pre-coordinator code
path. The current HEAD's `RelayConnectionCoordinator`-wrapped path
(ticket 004 onward) has only fake-driven tests so far — this session
did not re-exercise `RelayRadioLink` end to end against real hardware
through the coordinator, because no USB boards were attached. The
protocol-level behavior (handshake, HELLO, WHEELS_V/STOP acks) is
unchanged by the coordinator wrapping (it only adds resolution/failover
logic in front of the same `Link` implementations), but that equivalence
was not independently re-confirmed at the bench this session.

### 3. Network-reachable checks (this session, live)

Restarted the dev host on this branch (`pkill -f scripts/dev.mjs`, then
`nohup npm run dev > /tmp/dev-008.log 2>&1 &`); confirmed `host
listening on http://127.0.0.1:4795` before proceeding. Left running at
the end of this session (see closing note).

**3a. Live mDNS discovery.** Connected a small Node script (`ws`
package) to `ws://127.0.0.1:4795/` and read the first `endpoints`
message's `discoveredServices`. Exact contents observed:

```json
"discoveredServices": {
  "relays": [
    { "instanceName": "torture", "host": "torture.local", "port": 8760, "registryPort": 8761 }
  ],
  "robots": [
    { "instanceName": "gopiv", "host": "loki.local", "port": 33333 },
    { "instanceName": "tigez", "host": "hodr.local", "port": 33661 }
  ]
}
```

One `_mbrelay._tcp` relay ("torture") and two `_mbserial._tcp` robots
(gopiv, tigez) live on the bench LAN. `endpoints` (physical/USB) was
empty, consistent with no boards attached.

**3b. Coordinator path against the real registry/services.** Wrote a
temporary `tsx` script (deleted after use, not committed) constructing
a `RelayConnectionCoordinator` with a `linkFactory` mirroring
`deviceRegistry.ts`'s `defaultLinkFactory` (real `MbserialLink`/
`MbrelayLink`, no fakes), and called `connect([...])` with candidates
built directly from the discovered services above. Only `PING`
(liveness probe) and `HELLO` (identify, sent only after a successful
probe) were ever sent — never a motion verb, per this session's
instruction.

| candidate | result | notes |
|---|---|---|
| `mbserial` gopiv @ `loki.local:33333` | **connected** (602–951 ms) | classification `{type: robot, role: NEZHA2, commonName: robot, dialect: space}` |
| `mbserial` tigez @ `hodr.local:33661` | **connected** (595–876 ms) | same classification shape |
| `mbrelay` gopiv via `torture.local:8760`, address resolved via the real registry at `torture.local:8761` | **exhausted** | registry returned `{channel: 47, group: 60, outcome: "derived"}` — gopiv's *name-derived* address, not what the board (fixed 55/114, §1) actually listens on. `failoverTrail`: `"no liveness reply from gopiv after 3 probe attempt(s)"`. This is the §1 consequence, reproduced live. |
| `mbrelay` gopiv via `torture.local:8760`, address **explicit override** `{channel: 55, group: 114}` | **connected** (916 ms), `addressSource: "explicit"` | same classification shape |

So: real end-to-end bridging is confirmed for both `MbserialLink` (two
independent robots) and `MbrelayLink` (one robot, once addressed
correctly). No motion was driven over either — this session's own
instruction was PING/HELLO/STATUS only, never a motion verb, over the
network. "End to end" here means real TCP connect + real liveness probe
+ real banner identify against a real, non-fixture robot; it does not
mean driven motion (that remains USB-relay-only evidence, §2).

The registry-derived-vs-fixed-address mismatch above is not a new bug —
it is exactly the already-documented, intentional-for-now inconsistency
`RelayConnectionCoordinator.ts`'s own module doc comment names ("OOP
2026-09-09: today's robot image listens on a fixed 55/114, not the
name-derived address") and which is why the `address` override field
exists at all. Recording the live reproduction here rather than filing
it as a new issue, per this ticket's own Testing note.

**Disclosure chip (AC 6): not reachable this session.** `RelayPage.tsx`
is mounted at `/d/:endpointId` for an already-existing **relay-
classified endpoint**, and `deviceRegistry.ts#requestOpen`'s relay
branch (`openRobotViaRelay`) is likewise keyed on an existing relay
`endpointId` — both require a physical relay to already be listed in
`endpoints`, which was empty all session (no USB relay attached). A
discovered `_mbrelay._tcp`/`_mbserial._tcp` service is not itself an
openable top-level endpoint; it only ever appears as an option *inside*
`RelayPage`'s already-open relay session. So there was no way to reach
the chip's actual browser rendering this session at all, independent of
whether the coordinator path itself worked (it did, above). What was
captured instead is the real `addressSource: "derived"` value the chip
would consume, straight from the real registry — one of its three
non-explicit outcome states — but not the rendered chip itself.

**3c. `TCP_NODELAY` comparison.** Since the `mbrelay` explicit-override
candidate above connected successfully, ran the comparison against it.
Measured `PING`→`pong` round-trip time, 10 samples each, against
`torture.local:8760` (channel 55 / group 114):

- `TCP_NODELAY = true` (shipped default, `MbrelayLink.ts:265`): avg
  25.7–28.1 ms across two runs (`[30,26,27,23,24,24,23,28,28,24]`,
  `[35,29,27,25,27,29,26,32,23,28,28,28,29,28,28,28,28,28,28,27]`).
- `TCP_NODELAY = false` (temporary one-line local patch,
  `socket.setNoDelay(false)`, reverted immediately after measurement —
  confirmed via `git diff` showing zero net change to `MbrelayLink.ts`):
  avg 28.1 ms (`[31,28,28,28,27,29,29,27,27,27]`).

**Result: no perceptible difference** on this LAN (all three runs land
in the same ~24–32 ms band). Either outcome was acceptable per this
ticket's own text; this is an honestly-reported null result, not a
predetermined one. Noted in passing: an earlier attempt at this same
measurement hung indefinitely with no output at all (killed after ~5
min) — most likely rapid successive connect/close cycles against the
same physical relay-radio bridge from the preceding §3b runs, not
Nagle/TCP_NODELAY itself (the retry, run standalone a few seconds later
with a per-ping timeout added for visibility, completed cleanly in
under a second per ping with either NODELAY setting). Recorded for
completeness rather than silently retried away.

Confirmed after reverting the patch: `npx vitest run
packages/host/src/link/MbrelayLink.test.ts
packages/host/src/relay/RelayConnectionCoordinator.test.ts
packages/host/src/mbrelayRegistry.test.ts --no-coverage` — 3 files, 47
tests, all passing.

### 4. Deferred items (no boards attached)

- USB-relay drive (ticket's bench step 1, `RelayRadioLink` real motion
  against gopiv/vitut) — deferred. Same-day prior evidence exists (§2)
  but was not re-exercised against this session's HEAD.
- Two-robot failover with one powered off/wrong channel (bench step 3)
  — deferred, no boards to power off. Host-side behavior for exactly
  this scenario is covered by fake-driven tests, listed here so a
  reviewer can find them without re-deriving which ones apply:
  - `packages/host/src/relay/RelayConnectionCoordinator.test.ts`:
    `"the first two candidates never answer within their retry budget;
    the third does, with a two-entry failoverTrail"`;
    `"a candidate list that exhausts entirely resolves with a failure
    result carrying the full trail -- never throws, never hangs"`.
  - `packages/host/src/deviceRegistry.test.ts`:
    `"exhausted candidates report an error, create no synthesized entry,
    and reopen the relay's own session"`;
    `"default failover (no robotName): candidates are every remembered
    robot name most-recently-seen-first, then every discovered
    _mbserial._tcp instance name not already listed"`.
  - `packages/ui/src/pages/RelayPage.test.tsx`:
    `"renders a visible failover trail (two given-up-on candidates, one
    success) via the chip, not hidden behind a disclosure"`.

### Closing state

Dev server restored to running on this branch at session end (`node
scripts/dev.mjs`, confirmed `host listening on
http://127.0.0.1:4795` and a `200` from a direct curl at the time of
writing this record). No temporary scripts or patches left in the
working tree — `git status --short` shows only the pre-existing
`.clasi/.clasi.db` and `sprint.md` (left unstaged per instruction) plus
this ticket file's own edits.
