---
id: 009
title: 'Specification corrections: verbs, TLM HDR, WiFi transport, service types,
  host-model pointer'
status: in-progress
use-cases:
- SUC-008
depends-on: []
github-issue: ''
issue: rearch-18-specification-stale-statements.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Specification corrections: verbs, TLM HDR, WiFi transport, service types, host-model pointer

## Description

`docs/design/specification.md` no longer matches the firmware or the
code in several places: §3.6 claims a `TLM HDR` recovery verb the
firmware doesn't have (recovery is the 20-frame `thdr` auto-refresh);
§3.5 says "11 verbs take an id" when the code has 13; §4.3 describes a
`WifiUdpLink` that was never built (WiFi is TCP via `MbserialLink`
with `TCP_NODELAY` deliberately unset); §3.7 misattributes the `<`
prefix strip; §4.4 omits `_mbflash._tcp`; and §4.1–4.7 describe
`deviceRegistry.ts`, which `architecture.md` replaces. This ticket is
doc-only — no code dependency — and is best done once the rest of the
sprint's behavior is settled (per sprint.md's Dependencies section) so
the doc describes the finished system, though nothing here strictly
blocks on another ticket landing first.

## Acceptance Criteria

- [ ] §3.5 corrected to 13 verbs, with the list.
- [ ] §3.6: `TLM HDR` removed; the 20-frame auto-refresh stated as the
      only recovery path.
- [ ] §3.7: the `<` prefix strip attributed to `host/link/
      lineStream.ts`, not `relay/commands.ts`.
- [ ] §4.3: WiFi described as TCP via `MbserialLink` with `TCP_NODELAY`
      set (per the v2 architecture); no `WifiUdpLink`.
- [ ] §4.4: five service types listed, including `_mbflash._tcp`.
- [ ] §4's host description replaced with a short pointer: "The host's
      device and link model is specified in `architecture.md`; this
      section keeps only the transport traps (§6) and the leaf modules
      (`flash.ts`, `swdName.ts`, `releases.ts`)."
- [ ] §6 gains a sentence on the break-reset path (host never uses it;
      rearch-09 does) and the relay command-plane `>`/`<` fact (a probe
      needs no `!GO`).
- [ ] §9 open question 3(a) and 3(d) carry an explicit note asking the
      stakeholder to confirm or close them in this same change.
- [ ] `overview.md`'s "Roadmap" section replaced with a pointer to the
      sprint arc (`docs/design/rearchitecture-plan.md`) instead of the
      stale six-sprint list.
- [ ] `grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/
      specification.md packages/protocol/src` finds nothing.
- [ ] Spot-check against `docs/reviews/2026-09-11/05-protocol.md` §2's
      table passes.
- [ ] Flag (in the ticket's completion notes, for the stakeholder):
      `docs/design/usecases.md` UC-009 repeats the same stale `TLM HDR`
      claim this ticket corrects in `specification.md`; UC-009 is out
      of this ticket's stated scope (issue names `specification.md`/
      `overview.md` only) — ask whether to fix it here or as a
      follow-up issue.

## Implementation Plan

**Approach**: Direct text edits; no code changes. Cross-check every
claim against `docs/reviews/2026-09-11/05-protocol.md` §2's table and
`02-host-transport.md` §6, and against the actual verb list in
`session.ts` (13 verbs including `FUNCS`, `WICRED`).

**Files to modify**:
- `docs/design/specification.md` — §3.5, §3.6, §3.7, §4 (replace with
  pointer), §4.3, §4.4, §6, §9.
- `docs/design/overview.md` — "Roadmap" section.

**Testing plan**: No new automated tests (doc-only). Verification is
by grep (`grep -n "TLM HDR\|11 verbs\|WifiUdpLink" docs/design/
specification.md packages/protocol/src` → no output) and a manual
spot-check against `05-protocol.md` §2's table, both recorded in the
ticket's completion notes.

**Documentation updates**: This ticket *is* the documentation update.
