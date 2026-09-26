---
id: '005'
title: Log and fix the own-UID mbregistry identify handshake; retry failed links at
  nextRetryAt
status: open
use-cases: [SUC-005]
depends-on: ['003']
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

- [ ] Byte-level logging of what is actually written on an mbregistry
      stream during identify (the initial `HELLO` and every scheduled
      resend) lands, gated appropriately, and is exercised by a test
      (a fake `ByteStream` capturing what `write()` received).
- [ ] A finding is recorded (in this ticket, on completion) on whether
      the bench's `id ...` reply line is a distinct unparsed dialect or
      an artifact of the direct-serial manual probe — with a citation
      to `banner.ts`'s `COLON_FORM`/`SPACE_FORM` and why the observed
      line does or doesn't match either.
- [ ] If the handshake itself is found to need a fix (wrong verb, wrong
      timing against DTR/RTS-low open, or a genuinely unparsed reply
      dialect), it is implemented and covered by a fake-stream test
      asserting a banner is now recognized.
- [ ] A `reconciler.test.ts` case with a fake clock: a `failed`
      mbregistry link whose `next_retry_at` has elapsed, with no other
      link for the same device reading as active, produces a fresh
      `connect` Job from `plan()`.
- [ ] No real hardware, no real mbregistry daemon, no live serial probe
      in any new test — fakes only, per this sprint's Constraints.

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
