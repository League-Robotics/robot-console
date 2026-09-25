---
id: '007'
title: 'relayBridger: DTR/RTS/BREAK reset via mbregistryStream'
status: open
use-cases: [SUC-007]
depends-on: ['003', '004']
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# relayBridger: DTR/RTS/BREAK reset via mbregistryStream

## Description

`connect/relayBridger.ts` currently resets a relay board over DAPLink
HID (`vendor/dapjs`) before every bridge candidate — see its
`chooseResetMethod`. Once a relay is discovered via `mbregistryWatcher`
(ticket 002) instead of `usbWatcher`, robot-console no longer has
permission to open that board's HID interface directly (mbregistry holds
an exclusive per-board claim) — the reset must go over the same locked
`mbregistryStream` connection instead, using the `sendBreak()`/
`setDtr()`/`setRts()` methods ticket 003 adds.

Add an mbregistry branch to `chooseResetMethod`: when the relay's
physical link (resolved the same way `connector.ts`'s
`resolveRelayPhysical` resolves it, ticket 004) is `transport:
"mbregistry"`, reset via that stream's DTR/RTS toggle (or `BREAK`,
matching whichever primitive this codebase's existing serial-break
branch already prefers on this platform — reuse that platform decision,
don't re-derive it). The existing DAPLink-HID and serial-break branches
are unchanged — still used for a relay reached over legacy `usb`/
`mbrelay` (before mbregistry is available, or during the 018→019 gap for
any relay this sprint didn't move over).

Per sprint.md's Design Rationale: reuse the *same* `mbregistryStream`
connection already open for the candidate being bridged — do not open a
second, reset-only mbregistry connection (a second connection would need
its own lock and would race the first for the same board).

## Acceptance Criteria

- [ ] A relay discovered only through mbregistry resets between bridge
      candidates via `SET_DTR`/`SET_RTS`/`BREAK` frames on the existing
      locked connection — no silent skip of the reset step.
- [ ] The existing DAPLink-HID and serial-break branches are unmodified
      and their existing tests still pass unchanged, for a relay still
      reached over legacy `usb`/`mbrelay`.
- [ ] No second mbregistry connection/lock is opened for the reset step —
      a test asserts exactly one `lock` call for the whole bridge
      attempt (reset + data).
- [ ] `relayBridger.test.ts`'s existing multi-candidate failover tests
      are extended with at least one mbregistry-backed relay candidate.

## Implementation Plan

- **Approach**: extend `chooseResetMethod`'s existing dispatch (it
  already branches on the relay's own transport/platform) with an
  `"mbregistry"` case calling the stream's exposed reset methods;
  reuse the existing per-candidate reset-then-preamble-then-identify
  loop structure unchanged.
- **Files to modify**: `packages/host/src/connect/relayBridger.ts`,
  `packages/host/src/connect/relayBridger.test.ts`.
- **Testing plan**: extend the existing fake-`ByteStream`-based test
  harness with a fake `mbregistryStream` exposing `sendBreak`/`setDtr`/
  `setRts`, asserting the right sequence of calls per candidate.
- **Documentation updates**: none beyond code comments; sprint.md's Open
  Questions #3 already flags this branch's eventual removal in Sprint
  019 once `usbWatcher` is fully gone.
