---
id: '005'
title: 'Flash via mbregistry: send_hex + flash'
status: open
use-cases: [SUC-008]
depends-on: ['001', '004']
github-issue: ''
issue: retire-direct-usb-flash-and-names-via-mbregistry.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Flash via mbregistry: send_hex + flash

## Description

Stakeholder decision (2026-09-24): pull the `send_hex`/`flash` half of
`retire-direct-usb-flash-and-names-via-mbregistry.md` forward into this
sprint so `main` never loses the ability to flash a board once
`usbWatcher` is disabled (ticket 006) — without this ticket landing
first, ticket 006 would leave any board only discoverable through
mbregistry unflashable until Sprint 019 closes. Design:
mbtools `docs/design/registry-api.md` §"Remote flash and hex staging"
and §"Remote TCP control plane"; `docs/design/
robot-console-integration.md` §3.3-§3.4 (mbtools repo).

Flash requests for an `mbregistry`-transport link — local or remote —
go to the *owning instance's remote TCP port* (never the local Unix
socket; `send_hex`/`flash` are remote-TCP-only ops per registry-api.md)
using `send_hex` then `flash` (streamed `{"type":"log"}` lines, then one
terminal `{"type":"result"}`), mapped onto the exact same
`FlashPhase`/`FlashOutcome`/`flash-progress`/`flash-result` plumbing the
existing dapjs path already feeds — no new UI code.

1. **Wire-protocol leaf** — extend the target-resolution helper ticket
   003 factored out of `mbregistryStream.ts` (`resolveStreamTarget`, or
   whatever name it lands under: the local instance's own remote port on
   `127.0.0.1` for a local device, the device's own `endpoint` for a
   remote one) so this ticket can reuse it rather than re-deriving "which
   host/port do I dial for this uid" a third time. Add a new module,
   `packages/host/src/mbregistry/remoteFlash.ts`, exporting
   `flashViaMbregistry(target, uid, label, hexText, onProgress):
   Promise<FlashOutcome>`:
   - Open one fresh TCP connection to `target` (do not reuse the
     session's own `mbregistryStream` connection — see point 3 below on
     why it can't be reused anyway).
   - `{"op":"lock","uid":...,"kind":"flash","label":...}`. On
     `{"ok":false,"code":"locked",...}`, resolve a classified
     `FlashFailure` (`method: "mbregistry"`, `reason: "owner-unavailable"`)
     whose message names `holder.label` when present, else plain "in
     use" — mirrors `mbregistryStream.ts`'s own degrade-gracefully rule
     for a registry predating mbtools 008-002 (ticket 003).
   - `{"op":"send_hex","data":"<base64 hexText>"}` → `hex_path`.
   - `{"op":"flash","uid":...,"hex_path":...}`: read lines until the
     terminal one. Each `{"type":"log","line":...}` maps to a
     `FlashPhase` via a small best-effort classifier (substring match:
     "eras*" → `"erasing"`, "program"/"writ*" → `"writing"`, "reset*" →
     `"resetting"`, default → `"writing"`) forwarded through
     `onProgress` — coarser than nothing, exactly as coarse as the
     existing dapjs path's own phase reporting already is (`flash.ts`'s
     doc comment: "best-effort"). The terminal
     `{"type":"result","ok":...,"success":...,"exit_code":...,"error":...}`
     maps to `FlashOutcome` (`status:"ok"` / `status:"error", method:
     "mbregistry", reason: "flash-failed", error: <its error text>>`).
   - Close the connection once the terminal line arrives (registry
     releases the `flash`-kind lock unconditionally on its own, per
     registry-api.md — no separate `unlock` call needed, same as the
     local `flash` op's own contract).
2. **Session-lock cooperation (the part that needs explicit design, per
   the stakeholder's own call-out)**: registry-api.md's `locks.py` is
   explicit that a lock is exclusive **per uid regardless of kind** — a
   board this console has open (a `serial`-kind lock held by that link's
   own `mbregistryStream` connection, ticket 003) cannot also be
   `lock`ed `flash`-kind by a second, fresh connection while the first
   is still open. So a board locked by *this console's own session* must
   still be flashable: close that session first (releasing its
   `serial`-kind lock), exactly the way `connect/flasher.ts` already
   does today for the dapjs path (`reconciler.requestClose(linkId)`
   before ever touching the board_owner/flash lock) — reuse that same
   "close first" step, just skip `board_owner` entirely for this
   transport (sprint.md Architecture Step 5: `mbregistry`-transport uses
   `Exclusivity.kind: "none"`; mbregistry's own `flash`-kind lock is the
   sole exclusivity here, nothing else to acquire/release on the
   `store`). A board another client (or another host's session) already
   holds gets the `locked` classified failure from point 1 above, same
   as any other in-use board.
3. **`connect/flasher.ts`**: add `flashMbregistry(linkId, uid, target,
   label, hexText, onProgress): Promise<FlashOutcome>` alongside the
   existing `flash()` method — same `reconciler.requestClose(linkId)`
   first step, no `acquireBoardOwner`/`releaseBoardOwner` calls (point 2
   above), then delegates to `remoteFlash.ts`'s `flashViaMbregistry`.
   Keep this in the same module rather than a new one: both methods
   share the one "close the session before touching the board" seam
   this module already owns; only the leaf-level wire protocol differs
   (that's what `remoteFlash.ts` is for).
4. **`server.ts`'s `runFlashTask`**: today (`packages/host/src/
   server.ts` ~line 605) it hard-fails any link whose `transport !==
   "usb"`. Branch instead: `"usb"` keeps the existing
   `usbSerialFromLinkId`/`enumerateDaplinkDevicesFn`/`flasher.flash(...)`
   path unchanged; `"mbregistry"` reads the link's `uid`/`endpoint` from
   the `mbregistryWatcher`-authored device/link row (ticket 002 — not
   `usbSerialFromLinkId`, which is a `usb-<serial>`-only convention per
   ticket 004's own note) and calls
   `flasher.flashMbregistry(linkId, uid, target, label, hexText,
   onProgress)`; any other transport keeps today's descriptive failure
   message. `setFlashPhase`/`finishFlash`/`failFlash` and the
   `flash-progress`/`flash-result` ws broadcasts are untouched — both
   transports feed the same messages the UI already renders.
5. **Post-flash re-identify**: no special-casing needed, by design —
   once the flash connection closes (lock released), the freshly
   rebooted board reappears through `mbregistryWatcher`'s own
   `attach`/`identity` `watch` events (ticket 002) and the reconciler's
   existing automatic-connect pass picks it back up, exactly mirroring
   `flash.ts`'s own "no special reidentify" note for the USB path
   (`connect/flasher.ts`'s module doc comment) — just sourced from
   mbregistry's watch stream instead of USB re-enumeration. Call this
   out in a doc comment on `flashViaMbregistry` so it is not
   rediscovered as a "missing" step during review.
6. **Flash-eligibility gate**: `packages/host/src/projection.ts`'s
   `capabilities.flash: link.transport === "usb"` (the exact line
   sprint.md's Open Question #2 flagged as blocking a mbregistry-only
   board's flash button) becomes
   `link.transport === "usb" || link.transport === "mbregistry"`. No
   other change needed in `packages/ui/src/deviceDisplay.ts`'s
   `canBeFlashed` — it already just reads
   `link.capabilities.flash`.

## Acceptance Criteria

- [ ] A local `mbregistry`-transport board flashes successfully via
      `send_hex`/`flash` against the local instance's own remote port,
      producing the same `flash-progress`/`flash-result` ws messages a
      `usb`-transport flash produces today.
- [ ] A remote `mbregistry`-transport board (a peer's own board) flashes
      successfully by connecting directly to that host's `endpoint` —
      no proxying through the local instance.
- [ ] A board this console currently has an open session on (its own
      `mbregistryStream` `serial`-kind lock) can still be flashed: the
      session is closed first, the flash's own `flash`-kind lock then
      acquires cleanly, and the session is not left half-open.
- [ ] A board locked `flash`-kind (or any kind) by a *different* client
      returns a classified failure naming `holder.label` when present,
      else plain "in use" — no `undefined` in the message.
- [ ] `flash`'s streamed `log` lines map to `FlashPhase` values the
      existing `flash-progress` broadcast already carries; the terminal
      `result` maps to the existing `flash-result` `status: "ok"` /
      `status: "error"` shape.
- [ ] After a successful flash, the board re-identifies through
      `mbregistryWatcher`'s `watch` events and the reconciler
      auto-connects it again, with no bespoke reidentify code added.
- [ ] `projection.ts`'s `capabilities.flash` is `true` for an
      `mbregistry`-transport link; the existing `usb`-transport case is
      unchanged.
- [ ] Existing `usb`-transport flash tests (`flash.test.ts`,
      `connect/flasher.test.ts`, relevant `server.test.ts` cases) are
      unmodified and still pass.
- [ ] All new tests run against a fake JSON-lines TCP server (per
      sprint.md's Test Strategy) — no real mbregistry required.

## Testing

- **Existing tests to run**: `packages/host/src/flash.test.ts`,
  `packages/host/src/connect/flasher.test.ts`,
  `packages/host/src/projection.test.ts`, the flash-related cases in
  `packages/host/src/server.test.ts`.
- **New tests to write**: `packages/host/src/mbregistry/remoteFlash.test.ts`
  (fake TCP server covering lock/send_hex/flash, the `locked` case with
  and without `label`, log-line phase mapping, and the terminal
  `result` mapping for both success and pyocd failure);
  `connect/flasher.test.ts` cases for `flashMbregistry` (session-close
  ordering, no `board_owner` calls for this transport — asserted the
  same way ticket 004 asserts no `board_owner` row for `resolveExclusivity`);
  `server.test.ts` cases for the new `"mbregistry"` branch in
  `runFlashTask` (local target, remote target, unknown-transport
  fallback still fails descriptively); `projection.test.ts` case for
  `capabilities.flash` on an `mbregistry`-transport link.
- **Verification command**: this project's existing `npm test`/`vitest`
  invocation, scoped to the modules above per this project's
  per-ticket-scoped-test-run convention (`.claude/rules/source-code.md`).
