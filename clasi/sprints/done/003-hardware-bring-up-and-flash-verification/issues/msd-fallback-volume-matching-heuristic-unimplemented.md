---
status: in-progress
sprint: '003'
tickets:
- 003-002
- 003-006
---

# MSD flash fallback cannot find the volume: matching heuristic unimplemented

## Description

`packages/host/src/flash.ts` (sprint 002, ticket 004) implements the MSD
volume-copy fallback path — the backstop used when a SWD attach or
program fails — but the function that decides *which* mounted volume
corresponds to *which* attached micro:bit,
`defaultResolveVolumePath`, is a documented placeholder. It is never
exercised by any test.

The fallback's plumbing is real and tested with an injected resolver:
`flash()` correctly tries SWD first, falls back only on attach/program
failure, and absorbs MSD write failures into a classified outcome. What
is missing is the real resolver. In production, the fallback will not
find a volume, so a board whose SWD path fails has no working recovery.

## Cause

Deliberate deferral, not an oversight. Sprint 002's planning recorded
the volume-to-device matching heuristic as an open question, and
resolving it properly needs a physical board — ideally two attached at
once, since the hard part is not "find a MICROBIT volume" but "find the
one belonging to *this* device" when several are mounted. No micro:bit
was available during sprint 002 (see
`sprint-001-hardware-criteria-unverified-no-announcing-board.md`).

## Proposed fix

Implement `defaultResolveVolumePath` against real hardware, with at
least two boards attached simultaneously so the matching is actually
proven rather than assumed. `radio_relay/scripts/flash-local.js` in the
microbit-radio-relay project is the named template
(`specification.md` §4.5). The DAPLink volume carries a `DETAILS.TXT`
whose unique id can be joined against the device's serial — that join,
not a bare volume-name match, is what makes this correct with more than
one board present.

## Status after sprint 003 - the resolver is done; the end-to-end fallback is not

**Implemented and verified against two real boards** (sprint 003, tickets 002
and 006). `defaultResolveVolumePath` now joins `DETAILS.TXT`'s `Unique ID`
against `DaplinkDevice.serialNumber` on an exact string match. With both boards
attached:

| device | serial | resolved volume |
|---|---|---|
| `vevav` | `99063602...6e052820` | `/Volumes/MICROBIT` |
| `zapig` | `990636020005282007d057b7d6d99f53000000006e052820` | `/Volumes/MICROBIT 1` |

Each board's own `DETAILS.TXT` `Unique ID` matched its own USB serial exactly.

**The join decided it, not luck** - raw `readdir("/Volumes")` order put
`MICROBIT` before `MICROBIT 1`, so a naive "first `MICROBIT*` match" would have
returned `/Volumes/MICROBIT` for *both* devices. It did not. The space in
`MICROBIT 1` also confirmed the `startsWith("MICROBIT")` discovery filter and
produced no quoting bug.

**What remains unverified:** no MSD *write* was attempted, and no SWD failure
was forced to exercise the fallback branch. So `flash()` choosing MSD after a
real SWD failure, writing the hex to the correct volume, and leaving the other
board untouched is still only unit-tested with an injected resolver.

That remainder is the whole of what this issue now covers.

## Verification

With two micro:bits attached, a forced SWD failure on one of them falls
back to MSD and flashes the correct board, leaving the other untouched.
