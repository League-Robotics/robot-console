---
status: pending
---

# `gopiv` advertises `_mbserial._tcp` but no `_robotlink._tcp` at all — a board on the network with no WiFi path

## Evidence (2026-09-18, sprint 020 ticket 003)

Repeated full `dns-sd -B` browses across all three service types, over
roughly 45 minutes:

```
_robotlink._tcp (WiFi):   tovez robot link         <- only ever this one
_mbserial._tcp (bridge):  tigez, gopiv, tovez-2
_mbrelay._tcp (radio):    torture
```

`gopiv` appears on `_mbserial._tcp` on every browse — **the board is
alive, powered, and on the network** — and never on `_robotlink._tcp`.

Direct checks agree, twice, ten minutes apart:
- `nc -z -v -w3 192.168.1.218 7654` → connection refused.
- Ten minutes later `dscacheutil -q host -a name gopiv.local` returned
  **no record at all** (not a refused port — not mDNS-resolvable), and a
  follow-up ping failed.
- `lsof` confirmed no lingering connections of ours in either window, so
  this is not our own contention.

Earlier the same day `gopiv` *did* answer on 7654 (verified at
192.168.1.218 immediately after Eric parked it on the secondary field),
so the WiFi path worked and then stopped.

## Why this is its own defect, not bench flakiness

This was very nearly folded into a general "bench contention /
intermittent fixture" note. It should not be. As the peer session
working `pxt-nezha-diffdrive` put it: **a board that advertises mbserial
but has no robotlink at all is a specific failure, not general
flakiness.**

The distinction matters because the two have different causes and
different fixes:
- *Flaky* would mean the service appears and disappears, or answers
  slowly — which is what `[[bench-wifi-robot-discovery-waits-for-announcement]]`
  is about, and what sprint 020 fixed on the host side.
- *Absent* means the robot's own WiFi service is not running. No amount
  of host-side discovery work can find a service that is not being
  advertised.

Conflating them would have let sprint 020's verification failure be
blamed on discovery — the very defect the sprint had just fixed —
producing a false negative against its own fix.

## Consequence for sprint 020

`gopiv` was parked on the secondary field by Eric **specifically** to be
the WiFi fixture for ticket 003's ten-run measurement. Its WiFi being
down meant the only robot on the bench with a live WiFi path was
`tovez` — the one another session was using — which blocked the sprint's
closing verification until Eric released it.

## What to investigate

- Is this the same failure as `vevov`'s? Per the fleet migration plan,
  `vevov` has **no working ESP module** ("80 s over magni: empty
  `reply=` for every AT command, `wifi=0` in all STATUS lines; both
  credential slots intact"). If `gopiv`'s module has failed the same
  way, that is two of four robots, and it is a hardware-attrition story
  rather than a configuration one.
- Read `gopiv`'s own `STATUS` over its still-working mbserial bridge and
  check the `wifi` flag — that distinguishes "module dead" from "module
  fine, credentials or bring-up failed". `[[wifi-robot-drops-under-motor-load]]`
  records that this firmware can report `wifi=1` while being off the
  network, and never re-runs bring-up; a board that stops advertising
  after working earlier fits that shape.
- Whether a reset restores it, and whether it survives the next reset.

## Related

- [[bench-wifi-robot-discovery-waits-for-announcement]] — the host-side
  discovery defect. **Distinct from this.** Keeping them separate is the
  point of this issue.
- [[bench-exclusivity-census-is-unsound]] — the other reason ticket 003
  could not simply use a different robot.
