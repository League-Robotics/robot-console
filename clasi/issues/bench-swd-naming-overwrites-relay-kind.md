---
status: pending
---

# USB SWD naming overwrites a relay's `kind` with `robot`

## Evidence (team-lead, 2026-09-13, stakeholder's real state dir)

- `devices` row `536019796 vevav` has `kind: robot, owned: 0`. vevav is a RADIOBRIDGE relay
  (identified as such over its banner in sprints 014–016).
- Its USB link `usb-…2e78…` is stuck `connecting` with `fail_count 7`: the reconciler
  auto-connects it as a robot and identify fails.
- The front page renders vevav as a relay card with "Connection to gopiv lost: Error: No
  such file or directory, cannot open /dev/cu.usbmodem2121202" and Switch/Disconnect.
- Cause in code: `packages/host/src/watchers/usbWatcher.ts` ~line 230 calls
  `store.upsertDevice({ …, kind: "robot", … })` unconditionally on every successful SWD
  read, and `upsertDevice` overwrites `kind` on conflict.

## Expected

SWD naming never downgrades a known relay. A board first seen over SWD is recorded
without asserting a kind (or keeps the existing kind); only banner identification sets
`kind`. A relay stays idle per 016-001 and is never auto-identified as a robot.
