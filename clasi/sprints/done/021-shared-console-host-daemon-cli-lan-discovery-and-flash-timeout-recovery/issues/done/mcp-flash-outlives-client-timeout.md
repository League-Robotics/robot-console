---
status: done
sprint: '021'
tickets:
- 021-004
---

# `request_flash` outlives a default MCP client timeout, so the awaited outcome never reaches the caller

## Evidence (ticket 019-008 live verification, 2026-09-18)

A real MCP client flashed `tigez` over `mbserial-tigez` (via
`naught.local:44511`). The flash **succeeded** — settled around
`2026-09-18T16:08:56Z`, `program` moved to `calibration-0.20260914.5`,
board healthy and reconnected on its own.

But **the client's own MCP call exceeded its 60 s default timeout**
before the flash settled. Server-side execution is unconditional by
design and kept going, so the board was flashed correctly — the caller
simply never received the result.

## Why this matters

This partially defeats the design decision ticket 008 was built around.
`request_flash` deliberately **awaits the flash task's terminal promise
and returns the outcome in its MCP response**, rather than exposing a
pollable status. The reasoning was sound and still is:
`server.ts`'s `finishFlash`/`failFlash` delete the `flash` overlay from
the snapshot the instant a flash settles, and `flash-progress`/
`flash-result` are broadcast only to WebSocket clients an MCP caller is
not subscribed to — so a polling agent can poll a moment too late and be
unable to distinguish "just finished" from "never started".

The awaited-promise design solves that **only if the client is still
listening when the promise resolves.** At default timeouts, it is not.
So the agent is left in precisely the state the design set out to
prevent: a flash it started, with no way to learn the outcome. Worse, a
timeout *looks* like a failure, so an agent could reasonably retry a
flash that actually succeeded.

## Options to weigh (not yet decided)

- **Document a required client timeout.** Cheapest, but it only works
  for clients we control, and a flash's duration is not bounded by
  anything we own.
- **Return promptly with a durable handle, and make the outcome
  retrievable.** This is the polling design that was deliberately
  rejected — but the objection was specifically that *nothing durable
  survived the settle*. `agent_actions` (ticket 019-006) now **is** that
  durable record: it already stores `result` and `result_reason` for
  every executed flash. A lookup keyed by the returned handle would not
  reintroduce the approval-gate machinery that was removed; it would
  read an audit row that already exists.
- **Both**: return the outcome inline when the flash settles in time,
  and always write the `agent_actions` row so a timed-out caller can
  recover the result afterwards.

Note the second option must not become a `status: pending` lifecycle
column on `agent_actions` — that table is append-only and every row
describes something that already happened
([[mcp-server-for-robot-connections]], sprint 019's Revision note). A
recovery read is not a pending state.

## Related

Surfaced alongside [[tigez-custom-firmware-overwritten]]. Both came out
of the same ticket-019-008 live verification run.
