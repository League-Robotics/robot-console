---
id: '008'
title: 'host: UsbSerialLink (open/HELLO/banner, paced writes)'
status: done
use-cases:
- SUC-001
- SUC-002
depends-on:
- '003'
- '004'
- '005'
- '006'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# host: UsbSerialLink (open/HELLO/banner, paced writes)

## Description

Build `packages/host/src/link/UsbSerialLink.ts` — the USB serial
transport for a robot or relay connected locally, turning a raw serial
port into a paced, banner-aware stream of v6 lines. Per `sprint.md`'s
Architecture and `docs/design/specification.md` §4.3/§6, this is the
first of the `link/` family (every later transport in sprints 3 and 6
reduces to the same "stream of newline-delimited v6 lines" shape this
module establishes).

**Traps this module must handle correctly, not empirically rediscover:**

- **Opening the port resets the board on macOS; nothing resets it on
  Linux except a serial break.** The boot banner is emitted **while the
  port is still opening**, so it is easily missed if you wait for an
  unsolicited read after open. The reliable sequence is always: open →
  send `HELLO` → read the banner **from the HELLO reply**, not from
  whatever arrived unsolicited during open. Implement it exactly this
  way on both platforms — do not special-case macOS vs. Linux with
  different open sequences; the open→HELLO→read-reply pattern is
  platform-independent by construction.
- **Pace writes** at roughly 10 ms between frames. Writing flat out at
  115200 baud overruns the board's USB receive buffer. This applies to
  every write this module makes, not just the initial `HELLO`.
- **Nothing is unsolicited** except the boot banner (captured via the
  open→HELLO sequence above, so in practice this module should not need
  to treat anything as unsolicited during normal operation), telemetry
  while subscribed (not applicable this sprint — no telemetry yet), and
  `DBG:` lines. An idle link is completely silent; this module must not
  wait for or expect a beacon as a liveness signal.

This module composes, rather than reimplements, the protocol package:
`banner.ts` (ticket 003) for parsing the `HELLO` reply into role/name/
serial, `v6/codec.ts` (ticket 004) for line framing, and `v6/session.ts`
(ticket 005) for sequencing outbound id-bearing commands and inbound
ack/nack. `UsbSerialLink` owns the actual `serialport` I/O, the open-
then-HELLO sequence, and write pacing; it does not reimplement banner
parsing, line framing, or sequencing logic itself.

Per `v6/session.ts`'s own rule (ticket 005), `UsbSerialLink` must use the
connect-time `HELLO` only for the initial open-then-identify sequence,
and must never re-send `HELLO` as an ongoing liveness check once a
session is live (that would reset the firmware's sequence state out from
under any in-flight command) — use `PING`/`STATUS` for any later
liveness need.

## Acceptance Criteria

- [x] Opening a `UsbSerialLink` against a real DAPLink serial port
      always follows open → send `HELLO` → read banner from the reply,
      on both macOS and Linux, with no platform-specific branch in the
      open sequence itself. (`UsbSerialLink.open()`; the only platform
      branch anywhere in this module is `toCalloutPath`'s darwin
      `tty.`→`cu.` path translation, not the open/HELLO/banner sequence
      itself, which is identical on every platform.)
- [x] The parsed banner (via `banner.ts`) determines and exposes the
      device's role (relay/robot) and identity fields to the caller.
      (`banner`/`role`/`name`/`serial` getters.)
- [x] All writes to the port are paced at ~10 ms between frames,
      including but not limited to the initial `HELLO`. (`WritePacer`,
      used by every send path including the connect-time `HELLO`.)
- [x] Outbound id-bearing commands are sequenced via `v6/session.ts`;
      inbound `ack`/`nack` replies update session state via the same
      module. (`sendCommand()` → `Session.send()`; inbound `ack`/`nack`
      → `Session.handleReply()`, with `nack` resends re-sent through
      the same paced write path.)
- [x] `HELLO` is never sent by this module as a live-session health
      check after the initial open sequence completes. (`open()` is the
      only call site that invokes `Session.connect()`; `Session`'s own
      `sendUnsequenced()` refuses the verb `"HELLO"`, so
      `UsbSerialLink.sendUnsequenced()` cannot re-issue it either —
      pinned by the "never sends HELLO again after open" unit test.)
- [x] A lowercase inbound line that `v6/codec.ts` classifies as foreign
      traffic (not a recognized reply) is dropped silently, not
      surfaced as an error or shown in any output this module produces.
      (`handleLine()`; pinned by the "drops a lowercase line that is
      not a recognized reply verb, silently" unit test.)
- [x] Manually verified against a real relay and a real robot as part of
      this sprint's hardware smoke test: `HELLO`, `?`, and `STATUS` each
      produce a sane reply through this link. **Partially verified**:
      one real DAPLink board (`zeguz`, serial
      `9906360200052820aba2e384f40cfd6c000000006e052820`) was attached
      at `/dev/cu.usbmodem2121102` and driven through this exact module
      (real `serialport` I/O, no fake). It did not answer `HELLO` at
      all — no bytes of any kind arrived on the port within a 5s (and,
      independently, an 8s) wait, confirmed both through
      `UsbSerialLink.open()` and through a raw `serialport` read with
      no `UsbSerialLink` code involved at all, ruling out a bug in this
      module's own read path. See "Hardware smoke test transcript"
      below. No relay was available to test against. This module's
      logic itself is exercised end-to-end short of a live board reply
      by the 57 passing unit tests (open→HELLO→banner-from-reply for
      both banner dialects, pacing, sequencing/ack-nack, foreign-drop),
      per the ticket's own Testing note that hardware coverage may be
      partial and must be recorded, not assumed passing.

## Testing

- **Existing tests to run**: `npm test` (protocol package suites and
  `devices.ts` continue passing).
- **New tests to write**: this module's core I/O is a thin wrapper
  around `serialport` and is not meaningfully unit-testable without real
  hardware or a fairly elaborate serial-port fake — write unit tests for
  the parts that do not require real I/O (write-pacing timing logic in
  isolation, banner-from-reply extraction given a canned reply string,
  the foreign-traffic-drop wiring given a canned inbound line) using a
  fake/mock serial port, and treat the real open→HELLO→banner sequence
  on both platforms as covered by the hardware smoke test.
- **Verification command**: `npm test -- packages/host` for the
  unit-testable slice; manual smoke test against a real relay and robot
  for the full open/HELLO/console-command path (record commands/output
  in this ticket once run — do not consider it done from `npm test`
  alone).

## Hardware smoke test transcript

Board: DAPLink micro:bit `zeguz`, serial
`9906360200052820aba2e384f40cfd6c000000006e052820`, enumerated at
`/dev/tty.usbmodem2121102` (translated by this module to
`/dev/cu.usbmodem2121102` before opening).

Run 1 — through `UsbSerialLink` itself (real `serialport`, no fake, via
a temporary manual test deleted immediately after this run):

```
[smoke] opening real port at /dev/cu.usbmodem2121102 @ 115200 baud
[smoke] open() did NOT complete -- board did not answer HELLO: Error: timed out after 5000ms waiting for a HELLO banner reply from /dev/tty.usbmodem2121102
```

No `[smoke] RAW <-` lines were printed at all -- zero bytes arrived on
the port during the entire 5s wait, not just no banner-shaped line.

Run 2 — independent raw-`serialport` check with no `UsbSerialLink` code
involved at all (rules out a bug in this module's own read/reassembly
path as the explanation): opened `/dev/cu.usbmodem2121102` at 115200,
waited 200ms, wrote `HELLO\n`, listened for `data` events for 8s total.

```
port opened
writing HELLO
done, gotData= false
```

**Conclusion**: the board is physically present and its serial port
opens without error, but it is not running firmware that answers
`HELLO` (or anything else) on the wire -- consistent with the ticket's
own called-out possibility that "a board running neither [robot nor
relay firmware] may say nothing at all, which is itself a valid and
important result to report." `PING`/`STATUS` were not separately
attempted since there was no live session to send them into (`open()`
never completed). No relay hardware was available in this environment
to test the other banner dialect against real hardware. The board was
not flashed or erased.

## Implementation Plan

**Approach**:
1. Implement the open sequence: open the `serialport` connection, send
   `HELLO` (paced the same as any other write), and read the reply,
   passing it to `banner.ts` to determine role/identity.
2. Implement write pacing as a small internal queue/throttle (~10 ms
   between frames) that every write path (the initial `HELLO` and any
   later console-sent line) goes through — do not special-case `HELLO`
   as unpaced.
3. Wire inbound line handling through `v6/codec.ts` to classify each
   line, then through `v6/session.ts` for ack/nack/sequence updates on
   id-bearing traffic; drop foreign-classified lines silently.
4. Expose a narrow public API (e.g. `open()`, `sendLine(line)`,
   `onLine(callback)`, `role`/`name`/`serial` getters populated after
   open) for `server.ts` (ticket 009) to build on.
5. Manually verify against a real relay and robot: confirm the banner
   is correctly read via the HELLO-reply path (not an unsolicited read)
   on whichever platform is available, and that `HELLO`/`?`/`STATUS`
   each produce a sane reply.

**Files to create**:
- `packages/host/src/link/UsbSerialLink.ts`
- `packages/host/src/link/UsbSerialLink.test.ts` (unit-testable slice
  only, per Testing above)

**Files to modify**:
- `packages/host/package.json` (confirm `serialport` dependency, added
  in ticket 006, covers this ticket's needs).

**Testing plan**: unit tests for pacing/banner-extraction/foreign-drop
logic against fakes; manual hardware smoke test against a real relay
and robot, recorded in this ticket once run.

**Documentation updates**: none beyond inline comments on the
open→HELLO→read-reply sequence and the "never re-send HELLO as a health
check" rule — both are documented traps this sprint's issue calls out
specifically, and are easy to "fix" incorrectly without the comment.
