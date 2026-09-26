---
id: '005'
title: Log and fix the own-UID mbregistry identify handshake; retry failed links at
  nextRetryAt
status: done
use-cases:
- SUC-005
depends-on:
- '003'
github-issue: ''
issue: mbregistry-own-uid-link-never-identifies.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Log and fix the own-UID mbregistry identify handshake; retry failed links at nextRetryAt

## Description

Two related symptoms on the SAME own-UID link (tigez's own board,
`hodr`/`/dev/ttyACM1`), from `mbregistry-own-uid-link-never-identifies.md`:

1. The link sits `failed` with "produced no banner within the identify
   budget," although a direct serial `ID\n` (with nothing else holding
   the port) gets an immediate reply: `id diffdrive
   calibration-0.20260919.6 1.20260914.1 tigez`.
2. After that failure, `next_retry_at` passes with no retry attempted —
   the link sat `failed` for 10+ minutes.

### Part A — confirm/fix the identify handshake, with logging

`connect/connector.ts`'s `attempt()` already resends `HELLO` on a fixed
schedule for every transport (`link/bootWindowIdentify.ts`'s
`identifyWithBootWindowRetry`, offsets `[0, 750, 1500, 2500]`ms,
`resendHello` calling `link.session.connect()` + `link.sendLine()`) —
this exists precisely to cover a board that will not re-announce on its
own, which is exactly what mbtools' DTR/RTS-low stream open means (no
reset, no boot banner). There is no transport-specific gate anywhere in
that path today, so on paper `mbregistry` already gets the same
prompting `usb` does.

What is NOT yet confirmed: whether those `HELLO` bytes actually reach
the board over an mbregistry stream in practice, and in what shape.
Add logging (gated the same way this codebase already gates wire-level
tracing elsewhere — check for an existing debug-log convention before
inventing a new one) of the exact bytes written on
`link/adapters/mbregistryStream.ts`'s `write()` (or at the point
`resendHello`/`link.identify()` writes to the link), scoped to the
mbregistry transport, so a real-bench retry of this issue has direct
evidence instead of re-guessing.

Separately: the bench's own direct-serial reply line (`id diffdrive
calibration-0.20260919.6 1.20260914.1 tigez`) does not match either
grammar `packages/protocol/src/banner.ts` parses (`COLON_FORM`:
`DEVICE:...`, `SPACE_FORM`: `device ...`) — it starts lowercase `id `,
a third shape. Investigate whether this is: (a) a distinct, currently-
unparsed reply dialect the board only emits for a legacy `ID` query
verb (as opposed to the `HELLO` this connector actually sends), in
which case `banner.ts` needs a documented reason for why it is out of
scope, or (b) simply what a direct-serial manual probe happens to
elicit and irrelevant to the `HELLO`-based identify path this connector
actually uses. Record the finding either way — this ticket's acceptance
does not require re-running against live hardware (fakes only, per
Constraints), but it must not silently assume (b) without checking.

### Part B — confirm nextRetryAt-driven retry actually fires

`reconciler.ts`'s `plan()` already retries a `failed` link once `now >=
link.nextRetryAt` (`isAutoConnectEligible`), on every change-feed event
and a 5 s tick — this looks structurally correct. The likely explanation
for the observed non-retry, per sprint.md's Design Rationale: `plan()`'s
`deviceHasActiveLink` gate ("nothing for that device is connected") was
reading a **false positive** from the *other*, wrongly-re-homed
zugit-uid link showing `connected` under tigez's own `deviceId` — ticket
002's guard removes that false positive at the source. The issue itself
notes retry was still broken "after the stale zugit session ... was
closed," which argues this is not the *whole* story — treat it as an
open question, not an assumed-fixed side effect of 002/003, and add a
direct regression test.

## Acceptance Criteria

- [x] Byte-level logging of what is actually written on an mbregistry
      stream during identify (the initial `HELLO` and every scheduled
      resend) lands, gated appropriately, and is exercised by a test
      (a fake `ByteStream` capturing what `write()` received).
- [x] A finding is recorded (in this ticket, on completion) on whether
      the bench's `id ...` reply line is a distinct unparsed dialect or
      an artifact of the direct-serial manual probe — with a citation
      to `banner.ts`'s `COLON_FORM`/`SPACE_FORM` and why the observed
      line does or doesn't match either.
- [x] If the handshake itself is found to need a fix (wrong verb, wrong
      timing against DTR/RTS-low open, or a genuinely unparsed reply
      dialect), it is implemented and covered by a fake-stream test
      asserting a banner is now recognized.
- [x] A `reconciler.test.ts` case with a fake clock: a `failed`
      mbregistry link whose `next_retry_at` has elapsed, with no other
      link for the same device reading as active, produces a fresh
      `connect` Job from `plan()`.
- [x] No real hardware, no real mbregistry daemon, no live serial probe
      in any new test — fakes only, per this sprint's Constraints.

## Finding (recorded on completion, 2026-09-25)

### Part A — the handshake itself needed no code fix

Code review of the actual send path confirms the connector's own claim
("no transport-specific gate anywhere in that path") is correct, and
that it exclusively sends `HELLO`, never `ID`:

- `link/bootWindowIdentify.ts`'s `identifyWithBootWindowRetry` calls
  `LineLink.identify()` once (sends the initial `HELLO`) and
  `resendHello()` at each later schedule offset — both routes format
  the line via `protocol/src/v6/session.ts`'s `Session.connect()`,
  whose own doc comment says it is "the ONLY way this class ever
  formats a `HELLO` line," returning `encodeLine("HELLO", [])` =
  `"HELLO\n"` (`protocol/src/v6/codec.ts`).
- `LineLink.paceWrite()` hands that string, byte-for-byte, to whatever
  `ByteStream.write()` the transport supplied — for `mbregistry`,
  `link/adapters/mbregistryStream.ts`'s `MbregistryByteStream.write()`,
  which frames it (`encodeFrame(FRAME_DATA, Buffer.from(bytes, "utf8"))`)
  and writes the frame to the socket unmodified — no transport-specific
  rewriting, delay, or drop anywhere in that chain.

So mechanically, an own-uid mbregistry link's identify path is byte-
identical in shape to usb/wifi/mbserial's. Added byte-level logging to
make this provable on a real bench rather than by code review alone:
`ConnectorDeps.mbregistryWriteLog?: (linkId, bytes) => void`
(`connect/connector.ts`), wired via a new `withWriteLog()` wrapper
around the stream `buildStreamPlan` builds for the plain `"mbregistry"`
case only (an own-uid link's own identify stream, never the
radio/mbrelay relay-physical case). No pre-existing wire-level-tracing
convention exists anywhere in this codebase to match (checked: no
`DEBUG`/`NODE_DEBUG`/logger-package usage under `packages/host/src/link`,
`connect/`, `mbregistry/`) — this follows the closest existing pattern
instead: an optional injected callback, the same shape
`connect/unhandled.ts`'s and `supervisor/supervisor.ts`'s own `log?:`
fields already use. `runtime.ts` wires a real `console.error` sink
gated by `ROBOT_CONSOLE_MBREGISTRY_WIRE_LOG` (unset/`"0"`/`"false"` =
off), matching this codebase's own `ROBOT_CONSOLE_*` opt-in env-var
convention (`supervisor/cli.ts`'s own table) rather than inventing a
new one. Tested in `connector.test.ts` ("mbregistry identify write
logging (027-005)": reports the initial `HELLO` plus every scheduled
resend verbatim, scoped to the link's own id, and never fires for a
`usb` link) and `runtime.test.ts` ("mbregistryWriteLog (027-005)": off
by default, off for `"0"`/`"false"`, on and logging to `console.error`
for a truthy value, and overridable by a caller-supplied
`connectorDeps.mbregistryWriteLog`).

### Part A — the `id diffdrive ...` dialect question: (b), not (a)

`packages/protocol/src/banner.ts`'s two grammars are:

```
COLON_FORM = /^DEVICE:([^:\s]+):([^:\s]+):([^:\s]+):([^:\s]+)$/
SPACE_FORM = /^device (\S+) (\S+) (\S+) (\S+)$/
```

The bench's manual-probe line, `id diffdrive calibration-0.20260919.6
1.20260914.1 tigez`, matches neither: it starts lowercase `id ` (not
`DEVICE:` or `device `), and its four fields are a program name, two
version strings, and a robot name — not `SPACE_FORM`'s
`role/commonName/name/serial` shape at all. This is not a third banner
dialect banner.ts is missing; it is the documented reply shape for the
legacy, distinct `ID` query verb (`docs/design/specification.md` §7.3's
own sweep pseudocode: `"> ID → wait \"< id …\" whose name matches"`,
`i.e. lowercase id ..." is that verb's own reply, never a boot/HELLO
banner). The connector's identify path never sends `ID` — per the
above, it exclusively sends `HELLO` — so this reply shape is simply not
reachable from `connectAndIdentify` at all.

The issue's own evidence supports (b) directly: mbtools' own probe of
this exact board (uid `3b43773c...`) captured `raw_announcement:
"device NEZHA2 robot tigez 3527777815"` — a well-formed `SPACE_FORM`
banner, from the same physical board, on the same day. The bench's `id
diffdrive ...` line came from a *separate* manual `pyserial` probe that
explicitly sent `"ID\n"` (a different verb) directly on the raw port,
bypassing the connector entirely. So the board plainly can and does
answer with a parseable banner when queried the way the connector
queries it (or the way mbtools' own probe does); the `id ...` line is
an artifact of the manual probe having used a different query verb, not
evidence of a HELLO-reply dialect this path has never seen.
**Conclusion: (b) — `banner.ts` needs no third grammar, and the
identify handshake's use of `HELLO` (never `ID`) is correct.**

### Part B — retry-at-nextRetryAt: confirmed via a fake-clock test and read-only live evidence

`reconciler.ts`'s `plan()`/`isAutoConnectEligible`/`deviceHasActiveLink`
were unchanged by this ticket — code review (post-002/003/004) finds no
remaining structural bug: rule 4's backoff check (`now >=
link.nextRetryAt`) is transport-agnostic, and `mbregistry` is already
first in `AUTO_CONNECT_TRANSPORTS`. Added the two cases the acceptance
criteria ask for directly to `reconciler.test.ts`'s pure `plan()` suite
(no timers, no store — a fixed sequence of `now` values is the "fake
clock", the same technique the file's own pre-existing `usb`/`mbserial`
backoff cases already use):

1. A failed `mbregistry` link with no other link on the device produces
   no job before `next_retry_at`, and a `connect` job at/after it.
2. A failed `mbregistry` link's backoff-elapsed retry is correctly
   *withheld* once another link for the same device (`wifi`) is already
   `connected` — `deviceHasActiveLink`, not a bug.

Read-only live diagnosis (`node bin/robot-console.js --dump-store`
against the currently-running console; `mbregistry list`; no port
opened, nothing locked, nothing flashed) found tigez's own mbregistry
link (`mbregistry-99063602...3b43773c...`) currently `failed` /
"produced no banner within the identify budget", `fail_count: 16`,
`next_retry_at` elapsed roughly two hours ago with no further retry —
at first glance a live reproduction of the original "stuck, no retry"
symptom. It is not: the same snapshot shows `wifi-tigez` `connected`
with an open `sessions` row for the same `device_id` (3527777815), so
`deviceHasActiveLink` correctly reads true and `plan()` correctly
declines to open a second, redundant link automatically (architecture.md
§8 rule 1 / 018-008's own "never open a second link automatically" —
case 2 above is exactly this scenario). Separately, `fail_count`
reaching 16 (each failure capped at the 60 s backoff ceiling) is itself
evidence that `next_retry_at`-driven retry *did* fire repeatedly over
time before wifi connected — i.e. the retry mechanism the issue
reported as stuck is observably working in the currently-running build
(which already includes tickets 001-004).

**Uncertain / needing live re-verification**: whether the *original*
issue's exact scenario — the mbregistry link failing repeatedly with
**no** other link ever active on the device, for many consecutive
backoff cycles — is now fully resolved end-to-end on real hardware
(i.e. whether `HELLO` reliably gets a banner back over the real
mbtools-mediated stream, not just that the bytes reach the wire
correctly per the code review above). The current live system does not
present that exact precondition (wifi is connected), and per this
ticket's own Constraints, deliberately reproducing it (e.g. taking
tigez off wifi) is out of scope for this ticket's acceptance. A future
bench session reproducing "mbregistry-only reachability, no wifi" for
tigez, with `ROBOT_CONSOLE_MBREGISTRY_WIRE_LOG=1` set, would give a
direct, first-party answer.

## Testing

- **Existing tests to run**: `connector.test.ts` (identify path,
  boot-window retry schedule), `reconciler.test.ts` (`plan()`'s
  `isAutoConnectEligible`/`deviceHasActiveLink` cases), `link/
  bootWindowIdentify.test.ts` if present.
- **New tests to write**: a fake-`ByteStream` logging assertion (Part
  A); a `reconciler.test.ts` fake-clock retry-dispatch case (Part B); if
  a handshake fix is needed, a `connector.test.ts` or `banner.test.ts`
  case covering the corrected behavior.
- **Verification command**: run the workspace's vitest scripts scoped to
  `packages/host/src/connect/connector.test.ts`,
  `packages/host/src/connect/reconciler.test.ts`, and
  `packages/protocol/src/banner.test.ts` — do not run the full suite,
  and do not attempt a live bench re-run of the original issue as part
  of this ticket's own acceptance.
