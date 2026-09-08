---
id: '002'
title: 'Link abstraction: connect/identify split and transport extraction'
status: done
use-cases:
- SUC-002
- SUC-003
- SUC-005
depends-on:
- '001'
github-issue: ''
issue:
- port-lock-contention-between-identify-and-user-open.md
- robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue:
  robot-console-two-level-ui-and-multi-transport-roadmap.md: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Link abstraction: connect/identify split and transport extraction

## Description

Replace `UsbSerialLinkLike.open(): Promise<ParsedBanner>` (throws on a
silent board) with a `Link` interface split into
`connect(): Promise<void>` (throws only on transport failure — the
port itself failing to open) and
`identify(): Promise<ParsedBanner | null>` (resolves `null` on a
`HELLO` timeout, **never throws**). This turns "transport healthy, no
answering banner" into a normal, representable state instead of an
exception — required for the unknown/relay pages to render sensibly,
and it is also the fix for
`port-lock-contention-between-identify-and-user-open.md`: today,
`deviceRegistry.ts#openLink`'s failure branch closes the link and a
later retry opens a brand-new port, which is where OS-level lock
contention has been observed. After this ticket, `connect()` opens the
port once and the link stays open across `identify()` attempts/retries
— no repeated open/close cycle on the same physical port.

Also extract the transport-agnostic pieces `UsbSerialLink.ts` already
implements into their own modules, per the roadmap issue's "four links
must not each reimplement the nack arithmetic":
- `packages/host/src/link/lineStream.ts` — `LineReassembler`
  (unchanged behavior, moved verbatim).
- `packages/host/src/link/pacing.ts` — `WritePacer`, `Scheduler`,
  `realScheduler` (unchanged behavior, moved verbatim).
- `packages/host/src/link/LineRouter.ts` — the decode → classify →
  ack/nack-to-session → resend path currently inlined in
  `UsbSerialLink#handleLine` (lines ~535-568 today), extracted so a
  future relay/TCP/UDP link composes it instead of reimplementing it.
- `packages/host/src/link/Link.ts` — the new `Link` interface
  (`connect()`, `identify()`, plus the existing `close()`/`sendLine()`/
  `sendCommand()`/`sendUnsequenced()`/`checkLiveness()`/`onLine()`/
  `onAckNack()`/`onError()` surface, unchanged).

`UsbSerialLink.ts` itself is reshaped to implement `Link`: `open()` is
replaced by `connect()` (port-open + attach listeners only — no
`HELLO`, no banner wait) and `identify()` (sends `HELLO`, waits up to
`openTimeoutMs`, resolves `null` on timeout instead of rejecting).
Internal composition uses the three extracted modules instead of
private fields/methods.

**No new transport is added this sprint** (`RelayRadioLink`,
`MbrelayLink` are sprint 7) — this ticket only prepares the shape they
will implement. Per `sprint.md`'s Architecture Design Rationale,
`packages/protocol/src/relay/commands.ts` is deliberately **not**
created here — it would have zero consumers until sprint 7.

## Acceptance Criteria

- [x] `Link` interface defined in `link/Link.ts` with `connect()`
      throwing only on transport failure, and `identify()` resolving
      `ParsedBanner | null`, never throwing.
- [x] `UsbSerialLink` implements `Link`; `connect()` no longer sends
      `HELLO`; `identify()` sends `HELLO` and resolves `null` on
      timeout (verify: calling `identify()` again after a `null`
      resolution re-sends `HELLO` without re-opening the port — assert
      the underlying fake port's `open`/`close` call counts are each
      exactly 1 across two `identify()` attempts).
- [x] `LineReassembler`, `WritePacer`/`Scheduler`/`realScheduler` moved
      to `link/lineStream.ts`/`link/pacing.ts` with no behavior change
      — existing `UsbSerialLink.test.ts` cases for reassembly and
      pacing still pass unmodified (import paths updated only).
- [x] `LineRouter` extracted to `link/LineRouter.ts`, unit-tested
      directly (decode → classify → ack/nack → resend), independent of
      `UsbSerialLink`.
- [x] `deviceRegistry.ts`'s attach flow calls `connect()` then
      `identify()` instead of `open()`; a `null` identify result is
      treated as "connected, unresponsive" (not an error state) —
      `sessionOpen: true`, `classification: { type: "unknown",
      evidence: "none", ... }`, no `sessionError` set. (A transport
      failure from `connect()` itself still produces today's
      `sessionError`-set, `sessionOpen: false` state.)
- [x] Port-lock regression test: open a link, let `identify()` time
      out, then call `identify()` again (or trigger a user-initiated
      retry) with **no intervening close/reopen of the underlying
      fake port** — assert this succeeds against the fake, documenting
      the fix for `port-lock-contention-between-identify-and-user-open.md`.
- [x] `npm test` and `npm run build` pass in full.

## Testing

- **Existing tests to run**: `packages/host/src/link/UsbSerialLink.test.ts`,
  `packages/host/src/deviceRegistry.test.ts`, full `npm test`.
- **New tests to write**: `link/lineStream.test.ts`,
  `link/pacing.test.ts` (or keep colocated if extraction makes that
  cleaner — programmer's judgment, but coverage must not regress),
  `link/LineRouter.test.ts`, and new `UsbSerialLink.test.ts` cases for
  `connect()`/`identify()` split behavior including the no-reopen
  regression case above.
- **Verification command**: `npm test && npm run build`

## Implementation Plan

**Approach:** Extract-then-split: first move `LineReassembler`/
`WritePacer`/`Scheduler` verbatim into their new files (pure
refactor, tests should pass unmodified except import paths — do this
as a distinct, easily-reviewable step), then extract `LineRouter`
from `handleLine`'s body, then finally change `open()` into
`connect()`/`identify()` on top of the now-decomposed pieces. Update
`deviceRegistry.ts`'s `openLink` (likely renamed to reflect the new
two-step call) last, once `Link` itself is proven correct in
isolation.

**Files to create:**
- `packages/host/src/link/Link.ts`
- `packages/host/src/link/lineStream.ts` (+ test)
- `packages/host/src/link/pacing.ts` (+ test)
- `packages/host/src/link/LineRouter.ts` (+ test)

**Files to modify:**
- `packages/host/src/link/UsbSerialLink.ts`
- `packages/host/src/link/UsbSerialLink.test.ts`
- `packages/host/src/deviceRegistry.ts` (attach-flow call sites only —
  the broader endpoint/session model reshape is ticket 003)
- `packages/host/src/deviceRegistry.test.ts`

**Documentation updates:** `UsbSerialLink.ts`'s module doc comment
currently describes "open → HELLO → read-banner-from-reply" as one
sequence inside `open()` — rewrite to describe `connect()`/
`identify()` as two steps and explain why `identify()` never throws
(mirrors this ticket's Description). Note the port-lock-contention fix
explicitly in a comment at the call site that stopped closing the link
on a timeout.
