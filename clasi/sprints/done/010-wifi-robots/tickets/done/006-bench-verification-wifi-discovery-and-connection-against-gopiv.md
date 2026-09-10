---
id: '006'
title: 'Bench verification: WiFi discovery and connection against gopiv'
status: done
use-cases:
- SUC-006
depends-on:
- '003'
- '004'
- '005'
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: WiFi discovery and connection against gopiv

## Description

Hardware-deferred bench ticket isolating every claim tickets 001-005's
fake-provable tests cannot themselves prove — per this sprint's Test
Strategy, no other ticket's criteria depend on this one closing.
`gopiv` was live at 192.168.1.218 during planning (2026-09-10),
verified over TCP 7654 to reply with banner `device NEZHA2 robot gopiv
2175407711` then `PING`→`pong`/`STATUS`→`status ...` on the v6 grammar
— exactly the shape `MbserialLink` already implements, reused
unchanged by this sprint's `WifiLinkSpec`.

**Precondition to confirm before the session, not during it**: `gopiv`
must be enrolled in this bench's roster (a prior USB identify) —
ticket 002/003's gate requires it, and its absence would look
identical to a discovery failure, wasting bench time diagnosing the
wrong layer (the same "confirm before, not during" discipline sprint
008's own bench ticket applied to `BOOT_RADIO_LINK`).

Auto-switch's live-hardware criterion is **best-effort**: it needs
both a radio relay and a WiFi-provisioned robot present at the same
bench moment, which this sprint's own Success Criteria explicitly does
not guarantee. Record the outcome honestly either way (exercised with
result, or not exercised with why) — do not check off a criterion that
was not actually exercised.

## Acceptance Criteria

- [x] `gopiv` confirmed enrolled in the roster before the bench
      session begins (recorded in this ticket).
- [x] The host discovers `gopiv` under both `_robotlink._tcp` and
      `_robotlink._udp` live, with TXT fields matching `name=gopiv
      role=robot link=v6 port=7654`.
- [x] `gopiv`'s WiFi card appears on the front page (roster-matched,
      advertising); clicking it connects, identifies with the expected
      banner, and reaches `RobotPage`.
- [x] Drive controls and console traffic work end to end against
      `gopiv` over the WiFi TCP link.
- [x] Auto-switch's live-hardware criterion is recorded as exercised
      (with outcome: success/failure and why) or explicitly not
      exercised (with the reason — e.g. no relay/radio-provisioned
      robot pairing was available at this session) — either is an
      acceptable, honestly reported outcome per this sprint's own Test
      Strategy.
- [x] Any deviation from the live-verified facts this sprint's planning
      relied on (banner text, TXT fields, port) is recorded here if
      observed, since those facts are load-bearing for tickets 001-003.

## Testing

- **Existing tests to run**: N/A — this ticket is hardware
  verification, not a code change. (If any code fix is needed as a
  result of a bench finding, that is a new ticket or an OOP fix, not
  silently folded into this one's criteria.)
- **New tests to write**: none — see above.
- **Verification command**: N/A (manual bench session, results
  recorded in this ticket's file).

## Bench record (2026-09-10, team-lead, gopiv live)

Board: gopiv (NEZHA2, serial 2175407711), reached over the farm host
`null` (`_mbserial._tcp`, 192.168.4.50) for provisioning and over its
own WiFi for everything else. Dev host running this branch at commit
`81be176`+ (tickets 001-005 landed).

**Provisioning / firmware.** Flashed template release v0.20260910.3
(MICROBIT.hex sha256 `9b18abd9…` verified against MICROBIT.hex.txt) via
`mbdeploy deploy --remote gopiv`; provisioned `WIFICRED SET 0
Busboom_Garage <pw> #1` / `WIFICRED #2` → `wificred 0 Busboom_Garage 1`;
after a power-cycle the board joined with `credsrc=2 state=5
ip=192.168.1.218` (the flash-store pickup works). NOTE: at the time of
this bench the board reported `credsrc=0 haspw=1 ssid=Busboom Mesh` —
a locally built image with baked credentials had been flashed onto it
by the firmware session in the meantime (queried; see the message log).
Either way the robot was on WiFi at 192.168.1.218 for the checks below.

**Roster.** `gopiv` present in `rememberedRobots` (USB-identified on
2026-09-09); `tigez` (also on the LAN via the farm) is NOT in the roster
and never appeared as a WiFi endpoint.

**Discovery.** `dns-sd -B _robotlink._tcp` and `_robotlink._udp` each
caught `gopiv robot link` within one 60 s announce cycle (10:23:03 tcp,
10:25:14 udp); `dns-sd -L` on the udp record: `gopiv.local.:7654`, TXT
`name=gopiv role=robot link=v6 port=7654` — exactly the planning facts.
Announce-only: short (≤30 s) browses routinely miss it; the host's
continuous listener does not. The host snapshot carried
`{ endpointId: "wifi-gopiv", transport: "wifi", wifi: { host:
"gopiv.local", port: 7654 }, sessionOpen: false }`.

**Connect / identify / drive over WiFi (through the console's own
WebSocket).** `session-open wifi-gopiv` → connect ~5 s (the TCP link
waits for the connect banner) → `HELLO` → `device NEZHA2 robot gopiv
2175407711` (twice: the server's connect banner plus the HELLO reply)
→ classification `robot`; automatic `FUNCS #1` acked; automatic
`STATUS` → `status ready=0 … next=2` parsed into `robotStatus`;
`WHEELS_V 150 150 400 #2` → `ack 2 0 none`; `STOP now #3` → `ack 3 2
timeout`; `session-close` → `sessionOpen: false`, entry still listed.
`rogo 192.168.1.218 HELLO PING STATUS` independently confirms the v6
wire. Function list over WiFi: 6 of 17 `funcs` lines — the extension's
known 8-slot emit-ring truncation of multi-line replies over WiFi
(diagnosed 2026-09-07), not a console defect; USB and radio list all
17.

**Front page / RobotPage.** Stakeholder screenshot: `/d/wifi-gopiv`
renders the unmodified RobotPage. Gap found: unlike USB, the WiFi page
did not open its link on navigation (only the console's "open a link"
hint did) — fixed under ticket 005 (`fix(010-005)`, DevicePage
auto-opens a `wifi` endpoint on mount).

**Auto-switch (ticket 004) — not exercised live.** No relay board was
attached this session (vitut unplugged), so a relay-connected gopiv
could not be produced to switch from; the host-side behaviour is
covered by `deviceRegistry.test.ts` "Auto-switch radio -> WiFi"
(7 tests, WiFi-first ordering).

**Deviations from planning facts.** None in banner text, TXT fields, or
port. Two operational facts worth carrying forward: (1) the robot's
mDNS is announce-only with a 60 s period — any tool that browses for
less than that will miss a robot; (2) the serial `DBG:wifi` line goes
silent once the module is ready, so a joined-but-unreachable module is
invisible over serial (raised with the firmware session: a wire verb to
emit it on demand).
