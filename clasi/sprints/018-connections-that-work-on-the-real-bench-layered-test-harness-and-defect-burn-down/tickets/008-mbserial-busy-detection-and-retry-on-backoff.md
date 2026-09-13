---
id: 008
title: mbserial busy detection and retry on backoff
status: open
use-cases:
- SUC-005
depends-on:
- '007'
github-issue: ''
issue: bench-mbserial-single-client-and-retry.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# mbserial busy detection and retry on backoff

## Description

Second transport fix (SUC-005), depending on and cross-referencing
ticket 007's IPv4-connect fix: the farm bridges this ticket hardens
(`loki` for `gopiv`, `magni` for `tigez`, `hodr` for `vevov`) are reached
by the exact same `.local`-hostname mbserial links ticket 007 fixes, and
the team-lead's confirmed root cause for `loki.local` (IPv6 link-local
address returned first, `net.connect` erroring in 338 ms with no IPv4
fallback) "plausibly explains the intermittent mbserial failures" this
issue's own evidence describes. Ticket 007 must land first so this
ticket's busy/retry logic is tested against a transport that actually
connects reliably by IP — otherwise a real `ERR busy` and a spurious
IPv6-routing failure would be indistinguishable at this layer.

This ticket's own defect, on top of that: the farm bridges accept
exactly one TCP client; a second client gets `ERR busy` then the
connection resets, or silence. The host currently misreports this as
"no banner" (`mbserial-gopiv` `failed` "produced no banner", fail_count
1, no retry — evidenced while another host process was still connected)
and does not retry a failed mbserial link at all.

Fix:
- Recognize `ERR busy` as its own case, reported as "another app is
  connected to this bridge," distinct from "no banner."
- A failed mbserial link on an owned robot retries on backoff until it
  connects, including when the device has no other connected link
  (today it does not retry at all).
- Two host processes never silently fight over one bridge: the loser
  reports the contention rather than a misleading generic failure.

## Acceptance Criteria

- [ ] `ERR busy` is recognized distinctly and reported in the link's
      `state_reason` as contention ("another app is connected to this
      bridge"), never as "no banner" or "transport closed."
- [ ] A failed mbserial link on an owned robot retries with backoff
      (matching the existing capped-at-60s backoff pattern used
      elsewhere in the reconciler) until it connects, with no manual
      reconnect required.
- [ ] Two host processes contending for the same bridge each see and
      report the contention state rather than one silently misreporting
      "no banner."
- [ ] Unit tests: a fixture transcript ending in `ERR busy` classifies
      as contention, not no-banner; a failed mbserial link's next
      scheduled retry attempt is asserted via the reconciler's
      table-driven tests (per architecture.md §11's existing pattern).
- [ ] **Harness command and evidence**: `scripts/bench/run.sh --report
      /tmp/bench-report.md` run against the real farm bridges with
      `gopiv` (via `loki`) and `tigez` (via `magni`) reachable; the
      report shows both mbserial paths passing Layer 2 and Layer 3,
      connecting within about 1 s, per the team-lead's acceptance
      target, and — if a second client is attached during the run to
      simulate contention — the resulting `ERR busy` state reads as
      contention, not "no banner."

## Implementation Plan

**Approach**: extend the mbserial link adapter's reply classification to
recognize `ERR busy` before falling through to a generic no-banner
failure; extend the reconciler's retry/backoff policy (already applied
to other transports per architecture.md §8 item 4) to cover mbserial
links that have never connected, not only ones that were previously
`connected`.

**Files to modify**:
- the mbserial link adapter (wherever `ERR busy` would currently be
  read as an unrecognized reply — likely alongside `tcpStream.ts` or a
  dedicated `link/adapters/mbserial.ts`)
- `packages/host/src/connect/reconciler.ts` (retry/backoff for a
  never-yet-connected mbserial link)

**Testing plan**: `vitest` unit tests for the `ERR busy` classification
and for the reconciler's retry scheduling on a failed, owned, mbserial
link. Scoped run: `npx vitest run packages/host/src/link
packages/host/src/connect`. Bench pass per the harness command above,
ideally with a second TCP client attached to one bridge during the run
to force a real `ERR busy`.

**Documentation updates**: none beyond this ticket's completion notes.
