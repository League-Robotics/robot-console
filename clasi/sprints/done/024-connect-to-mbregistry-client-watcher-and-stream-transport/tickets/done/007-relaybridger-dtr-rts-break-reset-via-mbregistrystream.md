---
id: '007'
title: 'relayBridger: DTR/RTS/BREAK reset via mbregistryStream'
status: done
use-cases:
- SUC-007
depends-on:
- '003'
- '004'
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
`mbrelay` (before mbregistry is available, or during the 024→025 gap for
any relay this sprint didn't move over).

Per sprint.md's Design Rationale: reuse the *same* `mbregistryStream`
connection already open for the candidate being bridged — do not open a
second, reset-only mbregistry connection (a second connection would need
its own lock and would race the first for the same board).

## Acceptance Criteria

- [x] A relay discovered only through mbregistry resets between bridge
      candidates via `SET_DTR`/`SET_RTS`/`BREAK` frames on the existing
      locked connection — no silent skip of the reset step.
- [x] The existing DAPLink-HID and serial-break branches are unmodified
      and their existing tests still pass unchanged, for a relay still
      reached over legacy `usb`/`mbrelay`.
- [x] No second mbregistry connection/lock is opened for the reset step —
      a test asserts exactly one `lock` call for the whole bridge
      attempt (reset + data).
- [x] `relayBridger.test.ts`'s existing multi-candidate failover tests
      are extended with at least one mbregistry-backed relay candidate.
- [x] Extra acceptance criterion (added before starting, per team-lead):
      the flaky test in `packages/host/src/mbregistry/client.test.ts`,
      "step 2: standard client candidates", is fixed — test temp sockets
      use a short base dir (`/tmp` on non-Windows via `fs.mkdtempSync`)
      so the derived Unix socket path never exceeds the AF_UNIX
      `sun_path` limit on macOS, with no change to production defaults —
      and the fix is confirmed passing.

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
  025 once `usbWatcher` is fully gone.

## Implementation Notes

- Replaced the ticket-004 guard throw in `attemptCandidate`
  (`connect/relayBridger.ts`, "not yet supported here (sprint 024
  ticket 007)") with a real `"mbregistry"` branch: `chooseResetMethod`
  now returns `"mbregistry"` for a `physical.transport === "mbregistry"`
  relay, and `performReset` dispatches that to a new exported
  `mbregistryResetSequence(stream)`.
- **Reset primitive choice is centralized in one function
  (`mbregistryResetSequence`), by design, and left an open question**:
  it sends `BREAK` (via the stream's `sendBreak()`) as today's default —
  the same primitive the existing serial-break branch already uses, so
  behavior is at least consistent between the two paths. This is *not*
  settled: sprint.md's own Design Rationale describes the reset as
  "DTR/RTS" toggling, while mbtools' own `mbserial --reset` uses `BREAK`
  on a Linux-owned instance and a bare port reopen on a macOS-owned one
  — i.e. the right primitive may be dependent on the *owning
  mbregistry host's* platform, not this console's own. No DTR/RTS pulse
  sequence was invented for this ticket since neither this codebase nor
  mbtools documents one as known-good. **Sprint 024 ticket 009 (bench
  verification) must confirm `mbregistryResetSequence`'s `BREAK` actually
  resets a DAPLink board through both a macOS-owned and a Linux-owned
  mbregistry instance** before this is treated as settled; if it doesn't
  work on one of them, `mbregistryResetSequence` is the one function to
  change (its own doc comment lists the alternatives: `setDtr`/`setRts`
  pulses, or a platform-conditioned choice).
- `relayLinkTransport` (previously threw for a relay row of transport
  `"mbregistry"`, which would have made the ticket-004 guard
  unreachable through `bridge()`) now accepts `"usb"`/`"mbrelay"`/
  `"mbregistry"` rows.
- `RelayBridgerDeps` gained `createMbregistryStream`/`mbregistryClient`/
  `mbregistryLabel`, mirroring `connector.ts`'s `ConnectorDeps` exactly,
  including the default factory. Exactly one `createMbregistryStream`
  call happens per candidate attempt (asserted directly in the new
  single-candidate test) — the same returned stream is reused for both
  the reset (inside the `preamble` callback, over `openedStream`) and
  the data plane, never a second lock.
- Child-transport derivation for an `"mbregistry"`-transport relay
  (`radio` vs `mbrelay`) is recovered from the resolved
  `MbregistryAddress.endpoint`: `null`/`undefined` (a device local to
  this console's own mbregistry instance) maps to `"radio"` — this
  ticket's own primary scenario, replacing direct `usbWatcher`/HID
  access — and a set `{host, port}` (a remote peer) maps to `"mbrelay"`,
  mirroring the existing `connector.test.ts` "mbrelay: ... resolves to
  an mbregistry-transport row" case. `BridgeRequest`/
  `RelayBridgeCandidate` do not carry this distinction independently
  (`toBridgeRequest` never retains the original child link's own
  transport), so this is the only signal available; not exercised by any
  bench hardware yet.
- **Extra scope (flagged by team-lead before starting)**: fixed the
  flaky `packages/host/src/mbregistry/client.test.ts` "step 2: standard
  client candidates" test — its `freshTmpDir()` used `os.tmpdir()`,
  which on macOS resolves to a long per-user `/var/folders/.../T` path;
  once used as a fake `$HOME`, the derived
  `<home>/Library/Application Support/mbregistry/api.sock` candidate
  path routinely exceeded the ~104-byte `AF_UNIX` `sun_path` limit,
  failing `net.createServer().listen()` with `ENAMETOOLONG`. Fixed by
  creating every test temp dir under `/tmp` directly (via
  `fs.mkdtempSync`) on non-Windows platforms, with no production code
  touched. Confirmed passing: `packages/host/src/mbregistry/client.test.ts`,
  23/23.
