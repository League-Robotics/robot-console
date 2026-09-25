---
status: pending
split_from: use-mbregistry-for-boards-locks-and-flashing.md
sprint: 025
tickets:
- 024-005
- 024-009
---

# Retire direct USB: flash and names via mbregistry, delete the old paths

Second half of `use-mbregistry-for-boards-locks-and-flashing.md`. Depends on the mbregistry client, watcher and stream adapter landing first. Design: mbtools `docs/design/robot-console-integration.md` §3.3, §3.4, §6 items 4-5.

**Flashing moved into Sprint 024** (stakeholder decision, 2026-09-24, ticket `024-005`): `send_hex`/`flash` via the owning host's remote port is delivered by Sprint 024 rather than here, so `main` never loses the ability to flash a board once Sprint 024 disables `usbWatcher`. The dapjs/MSD flashing path itself is retired here (item 3) once Sprint 024's replacement has landed.

## Work in robot-console

1. ~~Flashing via `send_hex` + `flash` on the owning host's remote port~~ — delivered by Sprint 024, ticket `024-005`.
2. **Names** via `names_get` / `names_set` on the local socket (no create-on-read). Replaces `mbrelayRegistry.ts`.
3. **Delete** `usbWatcher`, `swdName`, the serialport / node-hid / dapjs paths, `mbrelayRegistry.ts`, and the `_mbserial` / `_mbrelay` / `_mbflash` branches of `mdnsWatcher` (WiFi `_robotlink._tcp` stays). The dapjs/MSD flashing path is part of this deletion, safe to remove once Sprint 024's mbregistry-based flashing (`024-005`) has landed.
4. **Shrink** `board_owner` / `relay_leases` to arbitration inside one process (sweep ↔ student session), or replace with the in-memory `keyedMutex` + pre-emption logic.
5. Update `docs/design/architecture.md`; §12 currently lists multi-host coordination as out of scope.

## Acceptance

- robot-console no longer opens any USB serial or HID device directly; serialport / node-hid / dapjs are gone from package.json.
- Flashing a local and a remote board works through mbregistry — delivered by Sprint 024 (`024-005`); this issue's own acceptance is that removing the dapjs/MSD code causes no regression.
- Radio names read without creating entries.
- Hardware acceptance on the bench: system mbregistry running and not running, two clients contending for one board.
