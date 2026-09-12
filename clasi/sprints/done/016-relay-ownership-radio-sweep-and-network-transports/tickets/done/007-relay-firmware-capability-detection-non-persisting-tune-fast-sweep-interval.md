---
id: '007'
title: 'Relay firmware capability detection: non-persisting tune, fast sweep interval'
status: done
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

- [x] Against a fake relay whose `?`/status reply advertises the
      capability token, the sweeper's retune interval drops to 2 s and
      it uses `!CGT` (via `buildTransientChannelGroupLine`).
- [x] Against a fake relay with no capability token, the sweeper stays at
      the 30 s default and uses the persisting `!CG`
      (`buildSetChannelGroupLine`).
- [x] The relay card (or an equivalent snapshot field/UI element) shows
      which rate the sweep is currently running at.
- [x] The upstream GitHub issue (`League-Robotics/microbit-radio-relay#1`)
      is referenced in this ticket's frontmatter and is **not** closed by
      this ticket — confirm its state is unchanged (still open) after
      this ticket's work lands.

      **Observed state differs from the assumption above — see
      Implementation notes.** The issue was found already `CLOSED`
      (`stateReason: COMPLETED`) *before* this ticket's own work began —
      a firmware PR merged upstream and closed it via `Fixes #1`,
      independent of anything in this repository. This ticket did not
      touch the issue (no comment, no edit, no close call was made from
      here) and its state is unchanged across this ticket's own session
      (CLOSED before, CLOSED after) — but it was never "still open" the
      way this criterion assumed. `completes_issue: false` is left as-is
      regardless, per this ticket's own Description: closing/completing
      `rearch-12` from this repository's side is still not this ticket's
      call to make, merge or no merge.
- [x] `npx vitest run packages/protocol packages/host/src/link
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

## Implementation notes

**Upstream issue state observed**: `gh issue view 1 --repo
League-Robotics/microbit-radio-relay --json state,closedAt,stateReason`
showed `state: CLOSED`, `stateReason: COMPLETED`, closed by a merged PR
(`mergedAt` identical to `closedAt`) whose body is a firmware PR
implementing option (a) from the issue exactly: `!CGT <ch> <group>`
applies channel/group immediately via the existing live retune path
without calling `saveConfig()`, and advertises support as a single
token on the `?` reply's trailing capability list: `caps: CGT` (e.g. `#
channel: 47 group: 60 mode: RAW250 power: 7 caps: CGT`). Option (b)
(`!TX` one-shot probe) was not implemented — only (a). This resolved the
token-format ambiguity the ticket description anticipated ("`caps: CGT`
or `caps: TX` ... or both defensively if the format isn't pinned down
yet") in favor of a single, now-settled format: `caps: CGT`. This repo's
own `hasTransientTuneCapability`/`parseRelayCapabilities` still parse a
general, whitespace-or-comma-separated token list (not hardcoded to a
single token), since the issue's own PR body describes `caps:` as "an
extensible feature list" — so a future additional token needs no parser
change here, even though only `CGT` exists today. **The issue was
already closed before any of this ticket's own work began** — this
ticket made no comment, edit, or close call against it (`gh issue view`
was the only call made, per the read-only instruction); see the
Acceptance Criteria section above for how the "confirm unchanged/still
open" criterion is satisfied given that starting state.

**Capability parsing** (`packages/protocol/src/relay/commands.ts`):
`parseRelayCapabilities(line): RelayCapabilities | null` extracts the
trailing `caps: <TOKEN...>` field off any relay reply line (case-
insensitive on both the `caps:` label and the tokens themselves, tokens
split on whitespace and/or commas), returning `null` — never an empty
token list — when the field is absent or has nothing usable after it.
`hasTransientTuneCapability(line): boolean` is a thin, named convenience
over that parser for the one capability this sprint's sweeper actually
acts on (`tokens.includes("CGT")`). Both are pure, zero-I/O, alongside
`parseRelayStatusLine`/`classifyRelayReply` as the module's own doc
comment describes.

**Where the sweeper reads capability from — reusing ticket 003's own
sync exchange, not a second round trip**: `RelayCommandPlane.ts`'s
`sync()` already sends `?` and waits for a status-shaped reply on every
lease acquisition (ticket 003's `ensureCommandPlaneReady`). Rather than
changing `sync()`'s return type (which would have broken its own
existing `.resolves.toBeUndefined()` test contract and every call site),
`RelaySyncOptions` gained an optional `onStatusLine?: (line: string) =>
void` callback, invoked with the raw status-line reply each time `sync()`
observes one. `relaySweeper.ts`'s `ensureCommandPlaneReady` now accepts
and forwards this callback to both of its own `sync()` calls (the initial
check and, if needed, the one after ticket 002's reset), and `runOnePass`
passes a closure that captures the last-seen status line. Once
`ensureCommandPlaneReady` reports ready, `hasTransientTuneCapability` is
run against that captured line to decide `capabilityDetected`.

**Non-persisting tune** (`RelayCommandPlane.ts`): a new
`setChannelGroupTransient(channel, group, options)`, a direct sibling of
`setChannelGroup` — same confirmation predicate (the merged firmware
echoes the identical `# channel: ... group: ... mode: ... power: ...`
status line for `!CGT` as for `!CG`), only the wire line differs
(`buildTransientChannelGroupLine`, already present since ticket 001).
`relaySweeper.ts`'s `runOnePass` picks between `setChannelGroupTransient`
and `setChannelGroup` (`tuneChannelGroup`) based on `fastEnabled`, once
per pass, and uses that one function for every candidate in the pass's
own queue.

**Re-detection, no persistence, per lease acquisition** (`relaySweeper.ts`):
exactly as ticket 003's own notes specified the read contract, this
ticket writes `store.setSetting(fastSweepSettingKey(relayLinkId),
capabilityDetected ? "1" : "0")` **every** successful `runOnePass` —
never only on a positive detection — so a relay that stops advertising
the capability (firmware downgrade, or swapped for a different unit on
the same USB port/link id) falls back to the slow/persisting path on the
very next lease acquisition rather than being stuck on a stale cached
"fast". `isFastSweepEnabled`/`fastSweepSettingKey` (ticket 003) are
otherwise unchanged. `SWEEP_MIN_INTERVAL_MS`/`SWEEP_FAST_INTERVAL_MS`
(30s/2s, ticket 003's own constants) are used exactly as ticket 003 named
them for this purpose.

**Surfacing the rate to the UI — chosen route and why**: the sprint's own
"No ERD" position and the ticket's own framing left this as a "pick the
least-invasive route" call between an in-process/`tasks`-heartbeat-detail
seam and a typed `settings` read. Since ticket 003 had *already* chosen a
`settings` row (`relaySweepFast:<relayLinkId>`) as this flag's read/write
contract (its own notes: "a deliberate departure from sprint.md's Step 4
'No ERD' sketch ... the task description for this ticket asked for a
settings/device field read specifically"), reading that same row back out
in the projection was the smallest addition — no new cross-module
coupling, no `tasks.detail` string to parse/format. `store/index.ts` gained
`ProjectionRows.fastSweepByRelayLinkId: ReadonlyMap<string, boolean>`,
populated by a single `SELECT key, value FROM settings WHERE key LIKE
'relaySweepFast:%'` query in `projectionRows()` (the only new SQL; no SQL
outside `store/`, per the ticket's own constraint) — the `relaySweepFast:`
prefix is duplicated here as a literal rather than imported from
`watchers/relaySweeper.ts`'s own `fastSweepSettingKey`, mirroring the
existing `WIFI_CREDENTIALS_SETTING_KEY` precedent immediately above it in
the same file (importing would point `store/index.ts` at a `watchers/*`
module, which itself depends on `store/index.ts` — a cycle).
`projection.ts`'s `buildRelays()` reads this map per relay link and sets
the new `SnapshotRelay.sweep` field to `null` (no entry — no
lease-acquisition sync has completed against this link yet) or `{ rate:
"fast" | "slow" }`. `wsMessages.ts`'s `SnapshotRelay.sweep` is declared
**optional** (`sweep?: ...`), not required like `lease`, specifically so
every pre-ticket-007 `SnapshotRelay` object literal across the existing
test suite (`RelayPage.test.tsx`/`FrontPage.test.tsx`, mostly) keeps
type-checking and passing completely unmodified — only the golden fixture
and the two `projection.test.ts` assertions that do a full `toEqual` on
`snapshot.relays` needed updating (to the now-explicit `sweep: null`
`buildSnapshot` itself always produces).

**UI label**: `deviceDisplay.ts`'s new `sweepRateSuffix(relay)` returns
`` " (fast)" ``/`` " (slow)" ``/`""` (absent or `null` sweep), shared by
both `RelayPage.tsx` and `FrontPage.tsx`'s `RelayQuickConnect` — appended
after the existing `findSweepingCandidateName` name, so the full label
reads e.g. `"idle · sweeping vevov (fast)"` or, with no inferable
candidate, `"idle · sweeping (slow)"`. Only rendered when `lease ===
"sweep"`, matching the ticket's own framing ("shows which rate the sweep
is *currently running* at") — a relay's known-but-currently-idle rate is
not surfaced as a standalone "(fast)"/"(slow)" next to plain "idle", to
avoid implying an inactive sweep is running at some rate right now.

**Files touched**: `packages/protocol/src/relay/commands.ts` (+test) --
`parseRelayCapabilities`/`hasTransientTuneCapability`;
`packages/host/src/link/RelayCommandPlane.ts` (+test) --
`RelaySyncOptions.onStatusLine`, `setChannelGroupTransient`;
`packages/host/src/watchers/relaySweeper.ts` (+test) -- capability
re-detection/write, `!CGT`-vs-`!CG` selection, fast-interval switch;
`packages/host/src/store/index.ts` (+test) --
`ProjectionRows.fastSweepByRelayLinkId`; `packages/host/src/projection.ts`
-- `SnapshotRelay.sweep` derivation; `packages/host/src/wsMessages.ts` --
`SnapshotRelay.sweep` field; `packages/host/src/projection.test.ts` +
`projection.fixtures/golden-snapshot.json` -- updated/added assertions;
`packages/ui/src/deviceDisplay.ts` (+test) -- `sweepRateSuffix`;
`packages/ui/src/pages/RelayPage.tsx` (+test) and
`packages/ui/src/pages/FrontPage.tsx` (+test) -- rendering.

**Test commands run in the foreground**:
- `npx vitest run packages/protocol packages/host/src/link
  packages/host/src/watchers packages/host/src/projection.test.ts
  packages/host/src/wsMessages.test.ts packages/ui` — 50 files, 1062
  tests, all passing. (Required `npm run build -w @robot-console/protocol`
  first — `main`/`types` point at `dist/`, and running `vitest` directly
  bypasses the root `pretest` hook that normally does this build.)
- `npx vitest run packages/host/src/store/index.test.ts` — 44 tests,
  passing (extra safety net since `store/index.ts` itself changed; this
  file is outside the ticket's own specified scoped-run list).
- `npm run typecheck` — clean (protocol/host/ui all build/typecheck with
  no errors; one `exactOptionalPropertyTypes` fix was needed for the new
  `onStatusLine` forwarding — an unconditional spread had to become a
  conditionally-included property, mirroring `RelayCommandPlane.ts`'s own
  existing `signal`-spread convention).

**Observed pre-existing flake, not a regression**: one of the scoped runs
logged an "Unhandled Rejection: Error: database is not open" from
`relaySweeper.ts`'s `runRelayLoop` → `store.heartbeat`, inside
`relaySweeper.test.ts`'s `startRelaySweeper` suite (real `setInterval`
timers racing a test's own `store.close()`). It never failed a test (all
1062 passed both times the full scoped command was run) and did not
reproduce at all when `relaySweeper.test.ts` was run alone twice more —
an existing test-isolation timing sensitivity in the `startRelaySweeper`
real-timer tests (unmodified by this ticket), not something introduced
here.
