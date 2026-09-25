---
status: pending
sprint: 019
---

# Spawn mbregistry with `mbregistry service run` instead of `mbregistry run`

## Description

mbtools is moving the foreground daemon command under `service`
(mbtools issue `move-mbregistry-run-under-service-and-add-service-start-stop.md`):
`mbregistry run` becomes `mbregistry service run`, with the same flags, and the
top-level `run` is either dropped or kept as a hidden deprecated alias for one
release.

robot-console's spawn-on-demand path (`spawnMbregistry` in
`packages/host/src/mbregistry/client.ts`, sprint 018 tickets 001/006/010) runs
`mbregistry run --instance … --socket … --db … <ports 0> --ready-json
--exit-with-parent [--no-peering]`. It must switch to `mbregistry service run …`.

## Work in robot-console

1. Change the spawn argv to `["service", "run", …]`.
2. Bump `MIN_MBREGISTRY_VERSION` to the first mbtools release that has
   `service run` (confirm the version with the mbtools session when that
   sprint closes). The version check already runs before spawning, so an
   older mbregistry fails with the clear "requires >= X" error instead of an
   argparse error.
3. Update tests that assert the spawn argv, the README prerequisite
   paragraph, and any docs or bench notes that show `mbregistry run`.
4. Where the console tells an operator how to start a registry by hand, use
   the new commands (`mbregistry service run`, or `service start` for an
   installed service).

## Dependencies

Blocked on the mbtools change landing and being released. Planned for
sprint 019 alongside `retire-direct-usb-flash-and-names-via-mbregistry.md`.

## Acceptance

- robot-console spawns its own registry with `mbregistry service run` on the
  new mbtools release, and the spawned registry still exits when the console
  exits.
- An mbregistry older than the new minimum fails with the clear version error.
