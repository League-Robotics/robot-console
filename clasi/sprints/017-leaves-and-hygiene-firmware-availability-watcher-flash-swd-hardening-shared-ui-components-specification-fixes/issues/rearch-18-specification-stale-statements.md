---
status: in-progress
sprint: '017'
tickets:
- 017-009
---

# specification.md: correct the statements the code review found stale, and point §4 at architecture.md

## Description

`docs/design/specification.md` is a good record of the protocol traps but
several statements no longer match the firmware or the code
(`05-protocol.md` §2; `02-host-transport.md` §6):

- §3.6 says `TLM HDR` is the header-recovery path. The firmware has no
  such verb (`wire_handler.cpp parseTlmMode` accepts only
  OFF/POSE/FULL/NOW/AUTO/BUFFER); on `v1.20260909.2` it drew `err 2` and a
  nack. Recovery is the firmware's 20-frame `thdr` auto-refresh, which
  §3.6 also states. `telemetry.ts:91` repeats the wrong claim.
- §3.5 says "only 11 verbs take an id". The code has 13 (`FUNCS`,
  `WIFICRED`, `session.ts:152-166`), and "11" persists in error strings
  and test names.
- §4.3 lists `WifiUdpLink` (UDP :7654 bound to :7655). It was never built;
  WiFi is TCP via `MbserialLink` with `TCP_NODELAY` deliberately unset
  (`deviceRegistry.ts:539-540`). The v2 architecture keeps TCP and sets
  `NODELAY`.
- §3.7 assigns the `< ` prefix strip to `relay/commands.ts`; it lives in
  `host/link/lineStream.ts:44` (rearch-15 moves it into codec).
- §4.4 lists `_mbflash._tcp` as browsed; it is not (rearch-03 adds it).
- §6 "Opening the port resets the board on macOS; on Linux nothing does
  except a serial break" — correct, but the host never uses the break;
  rearch-09 does. Worth a sentence.
- §4.1–§4.7 describe `deviceRegistry.ts` and its device model, which
  `architecture.md` replaces.
- §9 open question 3 (a) and (d) are noted as "likely closable" pending
  stakeholder confirmation; still open.

## Proposed resolution

- Fix §3.5 (13 verbs; list them), §3.6 (remove `TLM HDR`; state the
  auto-refresh as the only recovery), §3.7 (strip lives in codec), §4.3
  (WiFi is TCP with `NODELAY`; no UDP link), §4.4 (five service types).
- Replace §4's host description with a short pointer: "The host's
  device and link model is specified in `architecture.md`; this section
  keeps only the transport traps (§6) and the leaf modules
  (`flash.ts`, `swdName.ts`, `releases.ts`)."
- §6: add the break-reset sentence and the relay command-plane `>`/`<`
  fact (a probe needs no `!GO`).
- Ask the stakeholder to confirm or close §9 items 3(a) and 3(d) in the
  same PR.
- `overview.md` "Roadmap" section: replace the six-sprint list with a
  pointer to the sprint arc that plans the `rearch-*` issues.

## Acceptance

- Every claim in `specification.md` §3–§4 that names a file, verb, or
  service type is true of the code on the branch after the arc lands
  (spot-checked by the reviewer against `05-protocol.md` §2's table).
- `grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/specification.md packages/protocol/src` → nothing.

## Depends on

Nothing; doc-only. Best done alongside rearch-15.

## References

- `docs/reviews/2026-09-11/05-protocol.md` §2
- `docs/reviews/2026-09-11/02-host-transport.md` §6 (`MbserialLink` row)
- `docs/design/architecture.md`
