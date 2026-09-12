---
id: '007'
title: 'Relay firmware capability detection: non-persisting tune, fast sweep interval'
status: in-progress
use-cases:
- SUC-007
depends-on:
- '003'
github-issue: League-Robotics/microbit-radio-relay#1
issue: rearch-12-relay-firmware-non-persisting-tune.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Relay firmware capability detection: non-persisting tune, fast sweep interval

## Description

rearch-12 is fundamentally a cross-repository firmware change
(`League-Robotics/microbit-radio-relay`, already filed as
`League-Robotics/microbit-radio-relay#1`) — this ticket ships only the
robot-console (host) side of it, and does **not** complete the issue:
the issue stays open/tracked until the upstream firmware PR actually
merges, since the capability this sprint's host code detects does not
exist in any shipped firmware yet. `completes_issue: false` reflects
this — do not close `rearch-12` from this ticket.

Host-side work:

- Extend `packages/protocol/src/relay/commands.ts`'s reply-parsing (or
  add a sibling parser) to recognize a capability token in the relay's
  `?`/status reply — the firmware issue proposes `caps: CGT` or
  `caps: TX`; parse whichever token format the upstream issue's accepted
  resolution actually specifies once known, or both defensively if the
  format isn't pinned down yet (check the linked GitHub issue's current
  state before implementing).
- `buildTransientChannelGroupLine` (already present in `commands.ts`)
  becomes ticket 003's sweeper's `!CG` call when the capability is
  detected.
- Ticket 003's `SWEEP_MIN_INTERVAL_MS` drops from the 30 s default to 2 s
  once a relay's capability is detected (a per-relay flag, re-detected on
  each lease acquisition — no persistence, per sprint.md's "No ERD"
  position).
- The relay card should surface which rate the sweep is currently running
  at (fast/slow), so a slow classroom-wide pass has a visible, diagnosable
  reason rather than looking like the sweeper is simply slow for no
  reason.

This ticket can land whether or not the upstream firmware PR has merged —
it only ever activates on a live capability token a fake (or, once it
exists, real) relay actually sends.

## Acceptance Criteria

- [ ] Against a fake relay whose `?`/status reply advertises the
      capability token, the sweeper's retune interval drops to 2 s and
      it uses `!CGT` (via `buildTransientChannelGroupLine`).
- [ ] Against a fake relay with no capability token, the sweeper stays at
      the 30 s default and uses the persisting `!CG`
      (`buildSetChannelGroupLine`).
- [ ] The relay card (or an equivalent snapshot field/UI element) shows
      which rate the sweep is currently running at.
- [ ] The upstream GitHub issue (`League-Robotics/microbit-radio-relay#1`)
      is referenced in this ticket's frontmatter and is **not** closed by
      this ticket — confirm its state is unchanged (still open) after
      this ticket's work lands.
- [ ] `npx vitest run packages/protocol packages/host/src/link
      packages/host/src/watchers` passes.

## Implementation Plan

**Approach**: Check the current state of
`League-Robotics/microbit-radio-relay#1` first (has the firmware team
settled on a token format? has anything merged?) before implementing the
parser, so this ticket parses whatever format is actually agreed rather
than guessing. Add the capability parser as a pure function
(`parseRelayCapabilities` or similar) alongside `parseRelayStatusLine` in
`commands.ts`, then thread the detected flag through
`relaySweeper.ts`'s rate-limit logic.

**Files to modify**:
- `packages/protocol/src/relay/commands.ts` (capability token parser).
- `packages/host/src/link/RelayCommandPlane.ts` (expose the parsed
  capability from a lease-acquisition sync/status check, if that is
  where the sweeper reads it from — check ticket 003's actual
  implementation first).
- `packages/host/src/watchers/relaySweeper.ts` (interval switch,
  `!CGT` vs `!CG` selection).
- `packages/host/src/projection.ts` / UI relay card (surfacing the
  current rate).

**Testing plan**:
- `packages/protocol/src/relay/commands.test.ts`: the capability token
  parser, both present and absent cases.
- `watchers/relaySweeper.test.ts`: the interval-switch acceptance
  criteria against a fake relay with/without the token.
- Scoped run: `npx vitest run packages/protocol packages/host/src/link
  packages/host/src/watchers`.

**Documentation updates**: none in this repository. If the upstream
firmware issue's own documentation (`docs/radio-relay-protocol.md` in the
other repo) needs updating, that is out of this repository's scope per
this sprint's own Out of Scope section ("the firmware PR itself lands in
the microbit-radio-relay repo, not this one").
