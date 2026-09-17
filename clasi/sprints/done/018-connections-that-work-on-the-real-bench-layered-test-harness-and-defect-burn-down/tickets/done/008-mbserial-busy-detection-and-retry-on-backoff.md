---
id: 008
title: mbserial busy detection and retry on backoff
status: done
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

- [x] `ERR busy` is recognized distinctly and reported in the link's
      `state_reason` as contention ("another app is connected to this
      bridge"), never as "no banner" or "transport closed." (Also
      covers a bare close/reset with no banner and no `ERR busy` text
      at all -- both shapes the real farm bridges produce -- for
      `wifi`/`mbserial` only; `usb`/`radio`/`mbrelay` are unaffected,
      confirmed by a regression-guard test against the pre-existing
      "closed stream during identify" usb case, which still reports
      "no banner.")
- [x] A failed mbserial link on an owned robot retries with backoff
      (matching the existing capped-at-60s backoff pattern used
      elsewhere in the reconciler) until it connects, with no manual
      reconnect required. (Root cause: `plan()` picked only the single
      first-*existing* link in transport preference order and tested
      eligibility on that one alone, never falling through to a
      lower-priority transport -- a robot with both a `wifi` and an
      `mbserial` link whose `wifi` link sat non-actionable starved its
      own `mbserial` retry forever. Fixed to walk preference order for
      the first *eligible* link. Rule implemented, written down in
      `reconciler.ts`'s own doc comment: a device with no connected
      link retries its best eligible link, falling through past a
      higher-priority link that exists but isn't actionable right now;
      a device that already has a connected link never opens a second
      one automatically -- unchanged.)
- [x] Two host processes contending for the same bridge each see and
      report the contention state rather than one silently misreporting
      "no banner." (Live two-host proof below.)
- [x] Unit tests: a fixture transcript ending in `ERR busy` classifies
      as contention, not no-banner; a failed mbserial link's next
      scheduled retry attempt is asserted via the reconciler's
      table-driven tests (per architecture.md §11's existing pattern).
      (`connector.test.ts`'s new "mbserial/wifi bridge contention
      (018-008)" cases; `reconciler.test.ts`'s new "018-008" cases,
      including the fall-through/no-second-link table.)
- [x] **Harness command and evidence**: `scripts/bench/run.sh
      --skip-held --allow-shared-bench --report bench-report-008.md`
      run against the real farm bridges with `gopiv` (via `loki`) and
      `tigez` (via `magni`) reachable. `gopiv` mbserial: L1/L2/L3 all
      pass, `toConnectedMs: 1`, `toReplyMs: 23` (already connected by
      the time Layer 2 asked -- reconciler auto-connect). `vevov`
      mbserial: L1/L2/L3 all pass, `toConnectedMs: 330`, `toReplyMs:
      15`. Both comfortably within the ~1s target. `tigez` mbserial:
      fails at L1 ("timeout waiting 3000ms for a HELLO reply (no
      banner, not ERR busy either)") -- confirmed **environment, not
      contention**: `lsof -nP -iTCP -sTCP:ESTABLISHED -p 82496` showed
      the stakeholder's `scripts/dev.mjs` (pid 82496) holding only
      `192.168.1.184:7654` (vevov's WiFi) and its own Vite ports, no
      connection at all to `magni.local:43837` (tigez's mbserial
      bridge, resolved via `dns-sd -L`) -- system-wide `lsof` found no
      process connected to that port either. tigez's own robot/bridge
      is simply not answering; the bench harness's own report labels
      this row "contention" only because `--allow-shared-bench` labels
      every failure that way categorically, not because this ticket's
      new busy/close detection actually fired (the reason text itself
      says "not ERR busy either"). Live two-host contention proof
      (separate from the harness, per this ticket's own dispatch): host
      A (state dir A, port 4941) opened `mbserial-gopiv` via `loki` in
      330ms; host B (state dir B, port 4942), started 279ms after host
      A settled, requested the same link and received `state: "failed",
      reason: "another app is connected to this bridge"` 21ms later;
      host A was then stopped, and host B auto-connected `mbserial-
      gopiv` 1.77s afterward with no manual action, via its own backoff
      retry (`nextRetryAt` ~1s after the failure, matching the
      exponential-backoff-capped-at-60s policy).

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
