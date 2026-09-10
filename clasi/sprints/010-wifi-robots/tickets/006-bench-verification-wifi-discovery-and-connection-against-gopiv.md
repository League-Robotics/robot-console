---
id: '006'
title: 'Bench verification: WiFi discovery and connection against gopiv'
status: open
use-cases: [SUC-006]
depends-on: ["003", "004", "005"]
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

- [ ] `gopiv` confirmed enrolled in the roster before the bench
      session begins (recorded in this ticket).
- [ ] The host discovers `gopiv` under both `_robotlink._tcp` and
      `_robotlink._udp` live, with TXT fields matching `name=gopiv
      role=robot link=v6 port=7654`.
- [ ] `gopiv`'s WiFi card appears on the front page (roster-matched,
      advertising); clicking it connects, identifies with the expected
      banner, and reaches `RobotPage`.
- [ ] Drive controls and console traffic work end to end against
      `gopiv` over the WiFi TCP link.
- [ ] Auto-switch's live-hardware criterion is recorded as exercised
      (with outcome: success/failure and why) or explicitly not
      exercised (with the reason — e.g. no relay/radio-provisioned
      robot pairing was available at this session) — either is an
      acceptable, honestly reported outcome per this sprint's own Test
      Strategy.
- [ ] Any deviation from the live-verified facts this sprint's planning
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
