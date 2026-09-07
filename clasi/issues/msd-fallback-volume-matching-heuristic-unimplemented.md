---
status: pending
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

## Verification

With two micro:bits attached, a forced SWD failure on one of them falls
back to MSD and flashes the correct board, leaving the other untouched.
