---
status: in-progress
split_into:
- retire-direct-usb-flash-and-names-via-mbregistry.md
sprint: 024
tickets:
- 024-001
- 024-002
- 024-003
- 024-004
- 024-005
- 024-006
- 024-007
- 024-008
- 024-010
- 024-011
---
## Description

mbregistry (in the mbtools repo) now owns USB enumeration, identity, locks
across the fleet, serial streaming, flashing and the radio name registry.
robot-console duplicates all of this with a single-host SQLite lock, and it
competes with mbregistry for serial ports when both run on one machine. The
design is in mbtools `docs/design/robot-console-integration.md`. The
mbregistry prerequisites were delivered by mbtools sprint 007 (spawn flags,
instance naming) and sprint 008 (`watch`, lock `label`/`since`,
`unlock --force`, local-socket `stream`).

This issue is the first half: connect to mbregistry. Flashing, names and
deleting the old paths are split into
`retire-direct-usb-flash-and-names-via-mbregistry.md`.

## Work in robot-console

1. **`mbregistryClient`:** JSON-lines over a Unix socket, named pipe or TCP.
   It resolves the registry in this order:
   1. `$ROBOT_CONSOLE_MBREGISTRY`
   2. the user socket, then the system socket (or pipe)
   3. a console-owned socket
   4. otherwise, spawn `mbregistry run --instance <host>-console --socket …
      --db … <all ports 0> --no-peering --ready-json --exit-with-parent`

   mbtools is a declared prerequisite, installed separately. Find
   `mbregistry` via `$MBREGISTRY_BIN`, then `PATH`, and check it against a
   declared minimum version. If it is missing or too old, fail with a clear
   error naming the required version. Do not bundle or auto-install it.
   Document the prerequisite in the README. A setting
   (`mbregistry.shareBoards`) turns peering on for the spawned instance.
2. **`mbregistryWatcher`:** replaces `usbWatcher` at runtime assembly
   (deletion comes in the follow-up issue). It writes `devices` rows and
   `links` rows with `transport = "mbregistry"`, `address = {endpoint, uid}`.
   It calls `list`, then uses the `watch` op for updates.
3. **`mbregistryStream` adapter:** `lock` (with a `label`), then `stream`,
   then binary frames. The lock is held for the whole session. On a `locked`
   reply, show the holder's label and how long it has held the board. If the
   lock looks stale, also show the `mbregistry unlock --force <name>` command
   to run on the owning host. Do not offer a take-over button. `sendBreak`
   maps to a `BREAK` frame, and reset uses DTR/RTS instead of DAPLink HID.
   Use the local instance's remote port on 127.0.0.1 for local boards until
   the local-socket `stream` op is available.
4. Add `mbregistry` to the link preference order in place of `usb`,
   `mbserial` and `mbrelay`. Auto-connect a local, owned board.
5. **Keep the "owned" rule:** a device is owned if it was ever local to the
   console's registry instance, since `list` now returns the whole fleet.
6. Make the console's own port (4795) configurable, so two consoles can run
   on one machine.

## Acceptance

- With a system mbregistry running, robot-console lists and opens local and
  remote boards through it. A second client trying to open a board already in
  use sees "in use by <label>".
- With no mbregistry running, robot-console starts one, uses it, and it exits
  when robot-console exits.
- With mbregistry missing or too old, startup fails with a clear message
  naming the required version.