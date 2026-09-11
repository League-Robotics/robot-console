# Rearchitecture plan — sprint arc for the `rearch-*` issues

Date: 2026-09-11. Companion to `architecture.md` (the design) and
`docs/reviews/2026-09-11/` (the evidence). This document groups the
eighteen `clasi/issues/rearch-*.md` issues into a sprint arc with
dependency order. Sprint planning creates the sprints and tickets from
it; nothing here is a ticket.

## Goal of the arc

When a machine becomes reachable over any link, the console notices
within seconds, records it, and shows it. When a machine goes away or a
link drops, the console says so once and recovers on its own. All of
that state lives in one SQLite database on the host, written by a few
long-lived watcher tasks and rendered by the UI. Every screen a student
uses today keeps every feature it has.

## Decisions already made

See `architecture.md` §2. In one line each: WiFi visibility requires a
prior USB plug-in on this host; `node:sqlite` on Node ≥ 22.13;
in-process tasks, no threads; mbrelay and mbserial become real; clean
break on the wire contract; old host tests are deleted with the code;
radio overrides move to the host DB; relay firmware changes are allowed.

## Sprint A — Store, watchers, one connector, new contract

The keystone. Everything after it depends on it. Exit criterion: feature
parity with today's UI (checklist `docs/reviews/2026-09-11/04-ui.md` §1)
on top of the new host, with `deviceRegistry.ts` deleted.

| Order | Issue | Why here |
|---|---|---|
| 1 | `rearch-17` build hygiene (engines ≥ 22.13, lockfile, Linux tests) | Unblocks `node:sqlite`; makes CI trustworthy before the rewrite |
| 2 | `rearch-01` SQLite store, migrations, importers, change feed | Everything writes here |
| 3 | `rearch-04` LineLink core + adapters | Parallel with 01; connector needs it |
| 4 | `rearch-15` protocol hygiene | Parallel; `receive()`, relay reply grammar, `>` builder feed 04/09/10 |
| 5 | `rearch-02` USB watcher | First watcher; proves the pattern |
| 6 | `rearch-03` mDNS watcher | Second watcher; re-query, aging, address updates |
| 7 | `rearch-05` connector, reconciler, harvester; retire registry | The rewrite proper |
| 8 | `rearch-06` snapshot contract, projection, thin server | Host is now complete |
| 9 | `rearch-08` radio overrides in DB | Small; needed before UI drops `localStorage` |
| 10 | `rearch-07` UI renders the snapshot | Parity gate; includes the disconnected banner |

Suggested split if Sprint A is too large for one sprint: A1 = 17, 01, 04,
15, 02, 03 (host has rows and a link core, old registry still running);
A2 = 05, 06, 08, 07 (cut over). A1 is testable without any UI change.

## Sprint B — Relay ownership, sweep, network transports

Exit criterion: UC-015 and UC-016 pass on real hardware; a student can
connect through a relay while a sweep is running and take it over within
one probe.

| Order | Issue | Why here |
|---|---|---|
| 1 | `rearch-09` relay leases, idle state, reset between candidates | Prerequisite for any sweep; fixes the Linux failover bug |
| 2 | `rearch-10` relay sweeper and radio sightings | The stakeholder's headline ask |
| 3 | `rearch-11` mbrelay and mbserial as real transports | Same watcher and connector; low marginal cost |
| — | `rearch-12` relay firmware non-persisting tune | Cross-repo; start early, land whenever; 10 rate-limits until it does |

## Sprint C — Leaves and hygiene

Exit criterion: no known "silently wrong" behaviour left in the leaves;
docs true of the code.

| Order | Issue |
|---|---|
| 1 | `rearch-13` firmware availability watcher with ETag/backoff |
| 2 | `rearch-14` flash/SWD timeouts, platform MSD fallback, board owner |
| 3 | `rearch-16` UI shared components |
| 4 | `rearch-18` specification corrections |

## Existing open issues and where they land

| Issue | Disposition |
|---|---|
| `background-roster-sweep-over-radio-and-firmware-tcp-slots.md` | Superseded by `rearch-09` and `rearch-10`; its firmware note about TCP client slots stays open as a robot-firmware item |
| `no-disconnected-from-host-banner-in-the-ui.md` | Folded into `rearch-07` |
| `host-rejects-robot-template-release-asset-naming.md` | Remaining step folded into `rearch-13` |
| `wificred-provisioning-affordance-for-usb-connected-robots.md` | Unchanged; lands on the new `capabilities.provisionWifi` flag after Sprint A |
| `wifi-drops-burst-lines-calibration-apply-lost.md` | Robot firmware; unchanged |

## Dependency graph

```
17 ─┐
01 ─┼─▶ 02 ─┐
04 ─┤       ├─▶ 05 ─▶ 06 ─▶ 08 ─▶ 07 ─▶ 16
15 ─┴─▶ 03 ─┘        │
                     ├─▶ 09 ─▶ 10 ◀─ 12 (optional)
                     │    └──▶ 11
                     ├─▶ 13
                     └─▶ 14
18 (any time)
```

## Risks

- **Sprint A size.** It is the whole host core. The A1/A2 split above
  keeps each half independently testable; do not start A2 until A1's
  watcher rows are visible in a debug dump.
- **Hardware verification.** Sprints A and B each need a bench pass with
  a real relay, a real robot on USB and WiFi, on both macOS and Linux.
  The Linux failover bug and the macOS boot-window bug were both
  invisible to the existing tests.
- **Name collisions.** The DB keys on chip id; the radio and mDNS worlds
  key on name. The linking rule (exactly one owned device with that
  name, else hidden) is conservative; a classroom with a real collision
  will need a manual disambiguation UI later.
- **CLASI availability.** These issues were written by hand because the
  CLASI MCP server was unreachable in the authoring session. They follow
  the existing issue file format; if the server needs them registered,
  do that before sprint planning.
