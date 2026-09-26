---
id: '027'
title: 'mbregistry link identity: gone boards, own-UID identify, and MCP/Wi-Fi fixes'
status: done
branch: sprint/027-mbregistry-link-identity-gone-boards-own-uid-identify-and-mcp-wi-fi-fixes
use-cases:
- SUC-001
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
issues:
- gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md
- mbregistry-own-uid-link-never-identifies.md
- mcp-send-command-does-not-return-robot-replies.md
- wifi-dialog-show-hide-has-nothing-to-show.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 027: mbregistry link identity: gone boards, own-UID identify, and MCP/Wi-Fi fixes

## Goals

Make an mbregistry link's UID the sole basis of its identity end to end,
so a board that goes away can no longer be impersonated by, or flash,
whatever board takes its port — and get a robot's *own* board reliably
identified on open. Two smaller fixes ride along: MCP `send_command`
returning robot replies, and the Wi-Fi dialog's Show/Hide having a
password to show.

## Problem

Two related mbregistry link-identity bugs, observed live on 2026-09-25
against hodr/tigez/zugit, both traced (in the linked issues) past the
watcher-level poll that already exists uncommitted on `main`:

1. **Gone board re-attributed to the next board on its port**
   (`gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md`,
   primary). A link whose UID the registry reports gone/disconnected
   stays open, gets attached to whatever banner answers next on that
   port (connector/identify path has no UID guard; `store.upsertLink`
   COALESCEs `device_id`), renders as a second live-looking icon on the
   *wrong* device's card, and gets picked by the flash path — which
   flashes a UID that isn't attached, hangs, and is SIGKILLed
   (`exit -9`) by mbtools' watchdog.
2. **A robot's own-UID link never identifies**
   (`mbregistry-own-uid-link-never-identifies.md`, primary). Even with
   nothing else holding the port, the link sits in `failed`,
   "no banner within the identify budget," although the board answers
   `ID` immediately over direct serial. `nextRetryAt` also passes
   without a retry firing. Suspects per the issue: whether the connector
   actually sends `ID` on an mbregistry stream (vs. only on direct
   serial), and stream-open DTR/RTS handling — mbtools opens the port
   with DTR/RTS held low, so the board never re-announces on its own
   and must be prompted.

Both issues sit on top of mbtools' now-fixed counterpart (mbtools
0.20260925.3, commit 95c70bd, being deployed to the Pis): `lock`/
`stream`/`flash` on a disconnected UID fails fast with code `not_found`
("`<uid>` is not attached (last seen on `<port>`)"), and an open stream
closes (EOF) when its UID leaves the port. The console does not yet
honor that contract (re-lock by UID on EOF, never by port; treat
`not_found` as gone) anywhere in the flash or connector path.

Two smaller, independent issues ride along because they came out of the
same investigation session and are small: MCP `send_command` swallows
the robot's reply lines, forcing agents to bypass the console and read
serial directly; and the Set Wi-Fi dialog's Show/Hide toggle has nothing
to show because the dialog never prefills a saved password.

## Solution

**First piece of work, before any new code**: commit the existing,
finished, tested, uncommitted fix already in the working tree on `main`
(`packages/host/src/mbregistry/client.ts`,
`packages/host/src/watchers/mbregistryWatcher.ts`,
`mbregistryWatcher.test.ts`), authored out-of-process by another session
(robot-console-e6). It adds a 1 s `list()` poll with fingerprint-skip
reconciliation, moves a missing-UID link to `stale` and closes its
session (`markGone`), revives stale peer links, and gives `watch()` its
own dedicated connection (previously any `list`/`find`/`lock` after
`watch()` hung — this is also what unblocked the flash path's `find()`
in practice). Commit essentially as-is after verifying its tests pass;
do not redo it. Credit robot-console-e6 in the commit message.

On top of that foundation, close the remaining gaps the two primary
issues identify:
- Guard the connector/identify path so a banner answering on UID X can
  only ever update device X's link — never re-home a link's `device_id`
  to a different robot's row just because that robot's banner answered
  on the same port.
- Make the flash path (`resolveFlashLinkTarget`/`resolveFlashPlan` in
  `server.ts`, `link/adapters/mbregistryStream.ts`) resolve against the
  device's current, present board UID, and refuse a gone/stale link
  with a clear message instead of hanging into a `pyocd` watchdog kill.
- Make a gone board's link leave the card, or render unambiguously as
  gone — never as a second live-looking mbregistry icon on another
  device.
- Adopt the mbtools EOF/`not_found` contract in the console's stream
  handling: re-lock by UID (never by port) on stream EOF; treat
  `not_found` as board-gone (stale, no retry storm, not flashable).
- For own-UID identify: confirm (with logging) that `ID` is actually
  sent on an mbregistry stream open, fix the identify handshake if it
  isn't (or isn't timed right against DTR/RTS-low open), and make
  `nextRetryAt` actually trigger a retry for a `failed` link.

Plus the two independent fixes:
- `send_command` returns the reply line(s) correlated to the request
  (by `#seq`), plus unsolicited lines seen within a short window.
- `WifiCredentialsDialog` asks with `reveal: true` (matching
  `ConfigurationPage`'s Wi-Fi tab) and prefills the saved password, so
  Show/Hide has something to act on.

Exact ticket boundaries and architectural detail (module/data-model
impact of the identity-guard and EOF-handling changes, if any) are
decided in Detail Mode, after re-testing the two primary issues against
the freshly committed watcher fix — the issues themselves note the
picture may change once it lands.

## Success Criteria

- The uncommitted watcher/client fix is committed to `main` (or the
  sprint branch, per normal flow) with its existing tests passing, and
  robot-console-e6 credited.
- A board that goes gone/disconnected: its link does not get re-homed to
  another robot's card, is not offered for flashing, and either leaves
  the card or renders unambiguously as gone.
- Flashing refuses a stale/gone link with a clear message; it does not
  hang for 60 s and exit -9.
- A robot's own current board link identifies reliably on open, and a
  `failed` link is retried at `nextRetryAt`.
- `send_command` returns the robot's reply lines correlated to the
  request.
- The Set Wi-Fi dialog's Show/Hide reveals the actual saved password.

## Scope

### In Scope

- Committing the existing out-of-process watcher/client fix
  (`client.ts`, `mbregistryWatcher.ts`, `mbregistryWatcher.test.ts`) as
  this sprint's first piece of work.
- UID-guarding the connector/identify re-home path.
- Flash-path validation against the current, present board UID
  (`resolveFlashLinkTarget`/`resolveFlashPlan`, `mbregistryStream.ts`).
- Gone-link card rendering/removal.
- Adopting the mbtools EOF/`not_found` contract (re-lock by UID, treat
  `not_found` as gone) in the console's stream handling.
- Own-UID identify handshake fix (confirm `ID` is sent on mbregistry
  streams; fix if not) and `nextRetryAt`-driven retry for `failed`
  links.
- MCP `send_command` reply-line return.
- `WifiCredentialsDialog` prefill with `reveal: true`.

### Out of Scope

- `pair-joystick-to-robot-at-flash-time.md` — untracked, explicitly not
  part of this sprint; leave it alone.
- Any other pending issue in `clasi/issues/` not listed above.
- Deploying the mbtools fix itself to the Pis (already in progress
  outside this sprint; console-side work should treat it as landing but
  is not responsible for the rollout).
- Fixing `daemon/cli.test.ts` (fails while a real console runs on port
  4795) or `client.test.ts`'s 18 pre-existing failures against a live
  mbregistry daemon on clean `main` — both are known, pre-existing, and
  not part of this sprint's remit unless a ticket's own change is what
  regresses them further.

## Test Strategy

- Verify the committed-as-is watcher/client fix's own existing test
  suite (`mbregistryWatcher.test.ts` and any `client.ts` tests it
  touches) passes before committing it.
- Re-test both primary issues live (hodr/tigez, or equivalent bench
  setup) after that fix lands, since both issues note the picture may
  change once `watch()` has its own connection and disconnected UIDs
  go stale promptly.
- Unit/integration coverage for the UID-guarded connector re-home logic
  and the flash-path present-UID check (link state transitions:
  connected → stale/gone → not flashable).
- Regression coverage for the EOF/`not_found` re-lock-by-UID behavior
  once the mbtools contract is adopted.
- Manual or scripted verification of own-UID identify (send `ID` on
  stream open, confirm banner/reply) and `nextRetryAt` firing a retry.
- Do not restore `.clasi/.clasi.db` from git mid-sprint. Do not treat
  the two known-pre-existing test failures above as introduced by this
  sprint's work.

## Architecture

**Substantial** — by module count and by a genuine new cross-cutting
invariant. Six existing modules are touched (`mbregistry/client.ts`,
`watchers/mbregistryWatcher.ts`, `connect/connector.ts`,
`link/adapters/mbregistryStream.ts`, `server.ts`'s flash path,
`mcp/tools/connect.ts`) plus two UI files, and the sprint introduces one
new rule that cuts across three of them (connector, stream adapter,
flash resolution): **an mbregistry link's identity is its UID, and
nothing may write a different device's identity onto it**. That rule
does not exist anywhere in the code today (`connect/connector.ts`'s own
banner-vs-known-`deviceId` guard, added 2026-09-13 for `usb` links only,
never widened to `mbregistry`), so this is a real architectural gap, not
merely N independent bugfixes riding the same commit — unlike sprint
020's "many modules, no new composition" case, a diagram earns its
place here because it shows *where* the existing pipeline lacked the
guard and where each ticket closes it.

Read against `docs/design/architecture.md` §5 (link states), §6.5
(mbregistry watcher), §8 (connector and reconciler): no section is
replaced or contradicted. This sprint closes gaps within the documented
design — no new module, no new transport, no new table, no changed
dependency direction. `docs/design/architecture.md` itself is not
edited by this sprint; the gaps below are bugs in an otherwise-correct
design, not a design change.

### What Changed

1. **Foundation (ticket 001, no design change)**: commits
   robot-console-e6's already-written, already-tested fix to
   `mbregistry/client.ts` (`watch()` gets its own dedicated connection)
   and `watchers/mbregistryWatcher.ts` (a 1 s `list()` poll, reconciled
   against fingerprinted store rows, ages a missing UID `stale` and
   calls `markGone`). This is not new architecture — it is the
   already-designed §6.5 behavior, simply not yet on `main`. Every later
   ticket in this sprint is written and tested against this fix already
   being in place.

2. **Identity guard on the connector's identify path (ticket 002)**:
   `connect/connector.ts`'s `attempt()` already refuses to let a fresh
   banner silently overwrite a `usb` link's previously-known `deviceId`
   (the "banner identity disagrees with SWD name" check, ~line 1280) —
   this exists specifically because a USB banner read can be corrupted
   by a flaky cable and must never be trusted over a link's own prior
   identity. The same hazard exists for `mbregistry`, by a different
   mechanism: `link.id` is stable and keyed by UID
   (`mbregistry-<uid>`), but the *stream's bytes* come from whatever
   physical board mbtools currently has attached to that UID's last
   port — if mbtools' own port-vs-UID bookkeeping is stale for even one
   read (the exact window the gone-board issue caught live), the banner
   decoded off that stream can name a different device than the link's
   own UID claims. `store.upsertLink`'s `device_id = COALESCE(excluded
   .device_id, links.device_id)` then happily overwrites the link's
   `device_id` with that different device's id — the mechanism the
   gone-board issue traces byte-for-byte. The fix widens the existing
   guard's condition from `link.transport === "usb"` to also cover
   `"mbregistry"`, so a banner whose serial disagrees with the link's
   own already-known `deviceId` is treated exactly like the USB
   cable-corruption case: recorded as a failure, never upserted as a
   device/link identity change. No new module — one existing guard's
   condition widened to the transport it always should have covered.

3. **Adopting mbtools' `not_found`/EOF contract (ticket 003)**: mbtools
   0.20260925.3 now fails `lock`/`stream`/`flash` on a disconnected UID
   fast with `MbregistryError` code `not_found`, and closes (EOF) an
   open stream whose UID leaves its port. `link/adapters/
   mbregistryStream.ts`'s `translateError` already special-cases the
   `"locked"` code into a plain-language message; every other code
   (including `not_found`) already passes through unchanged, `.code`
   intact. The gap is on the *receiving* side: `connect/connector.ts`'s
   `attempt()` funnels every identify/stream failure through
   `recordFailure`, which always writes `failed` + exponential backoff —
   correct for a transient failure, wrong for `not_found`, which is a
   *durable* fact ("this UID is not attached") that the connector should
   treat exactly like `watchers/mbregistryWatcher.ts`'s own `markGone`
   (state `stale`, no retry storm) rather than retry with backoff
   against a UID mbtools has already said is gone. The fix adds one
   branch ahead of the generic `recordFailure` call sites in the
   `mbregistry`-transport identify path: a caught `MbregistryError` with
   `code === "not_found"` sets the link `stale` (mirroring
   `markGone`) instead of `failed`. Because links are already addressed
   by UID everywhere in this codebase (`mbregistryWatcher`'s
   `mbregistryLinkId(uid)`, `buildStreamPlan`'s `mbregistry` case,
   `resolveFlashLinkTarget`'s `mbregistry` branch), "re-lock by UID,
   never by port" is already the structural default — there is no
   port-keyed re-lock path anywhere to remove. This ticket is a failure-
   classification fix, not a re-addressing fix.

   `packages/ui/src/deviceDisplay.ts`'s `cardLinks` already filters out
   every `stale` link (ticket 018-010, already shipped) — a gone
   board's link rendering as a second live-looking icon on the wrong
   device's card is a **downstream symptom** of items 2 and 3 above, not
   a separate rendering defect: once a gone UID's link is never re-homed
   (item 2) and reliably reaches `stale` promptly (item 3, plus the
   ticket 001 foundation's own poll-driven `markGone`), the existing UI
   filter already hides it correctly. No UI change is needed for this;
   tickets 002 and 003 each carry a card-rendering regression test
   (`deviceDisplay.test.ts`/`FrontPage` level) as an acceptance criterion
   instead of a dedicated ticket, per this sprint's own "split or merge"
   latitude.

4. **Flash-path present-UID validation (ticket 004)**: `server.ts`'s
   `resolveFlashLinkTarget` already redirects a `usb` link to its
   device's current non-stale `mbregistry` link (added for exactly this
   "don't race mbregistry for the same port" reason) — but its own
   `mbregistry` branch (~line 620) does the opposite of that discipline:
   it builds a `FlashTarget` straight from the link row's stored
   address with **no check of `linkRow.state` at all**, so a `stale`
   mbregistry link — the gone board's own link, in the observed bug —
   resolves to `{ok: true, ...}` just as readily as a live one, and the
   60 s `pyocd` hang / `exit -9` follows. The fix mirrors the `usb`
   branch's own existing redirect pattern: if the resolved link is
   `stale`, look up the same device's current non-stale `mbregistry`
   link and redirect to it (recursion, same shape as the `usb` branch);
   if none exists, return `{ok: false, reason: "<uid> is not currently
   attached"}` instead of a target. Since `mcp/tools/flash.ts`'s own
   precondition check calls this exact function (sprint 019's own design
   point — one precondition set, not two), the MCP `request_flash` path
   gets the same refusal for free.

5. **Own-UID identify handshake and retry (ticket 005)**: the connector
   already resends `HELLO` on a fixed schedule
   (`link/bootWindowIdentify.ts`'s `identifyWithBootWindowRetry`,
   offsets `[0, 750, 1500, 2500]`ms) covering exactly the case mbtools'
   DTR/RTS-low mbregistry stream open describes — a board that will not
   re-announce on its own must be prompted, and the connector already
   prompts it, on every transport including `mbregistry`, with no
   transport-specific gating anywhere in that path. Whether this
   actually reaches the wire for an mbregistry stream, and in what
   shape, is exactly what the issue asks to confirm with logging before
   assuming a fix is even needed here — the bench evidence's own reply
   line (`id diffdrive calibration-... tigez`) does not match either
   banner grammar `packages/protocol/src/banner.ts` parses (`device
   ...`/`DEVICE:...`), which is either a second, unparsed reply dialect
   this path has never seen, or a symptom of item 2's re-homing bug
   masking the real link's own retries during the observed session (the
   issue itself: "That was still true after the stale zugit session
   ... was closed" argues against this being *only* item 2, so this
   ticket treats it as a genuine open question, not an assumed fix).
   `next_retry_at`'s own firing depends on `reconciler.ts`'s
   `deviceHasActiveLink` gate, which — before item 2's fix — could be
   held true by the *other*, wrongly-re-homed link under the same
   device, permanently starving the real link's own backoff-elapsed
   retry (architecture.md §8 rule 1's "nothing for that device is
   connected" gate reading a false positive). This ticket depends on
   items 2/3 landing first so that gate reflects reality, and adds its
   own regression test against the residual, independent identify-
   handshake question with logging + fakes, not live hardware.

6. **MCP `send_command` reply correlation (ticket 006, independent)**:
   `mcp/tools/connect.ts`'s `send_command` handler calls
   `sessionOps.ts`'s `sendCommand`, which returns only the line it
   transmitted. `LineLink` already exposes `onAckNack` (seq-correlated
   ack/nack, for a sequenced verb) and `onInboundLine` (every raw
   inbound line, for an unsequenced query's reply or unsolicited `DBG:`
   lines) — both already used elsewhere in this codebase
   (`server.ts`'s student console broadcast, item G). No new capability
   is needed on `LineLink`; `send_command`'s handler subscribes to both
   for a short window after sending and returns the correlated reply
   line(s) alongside `sent`.

7. **Wi-Fi dialog prefill (ticket 007, independent)**:
   `WifiCredentialsDialog.tsx` calls `send({type: "get-wifi-
   credentials"})` with no `reveal: true`, unlike `ConfigurationPage.tsx`
   (`send({type: "get-wifi-credentials", reveal: true})`), so
   `server.ts`'s handler (~line 1352) never includes the saved
   `password` field in its reply and the dialog's password input has
   nothing to prefill. The fix makes the dialog ask the same way
   `ConfigurationPage` already does, and prefills `password` from the
   revealed value alongside the existing `ssid` prefill.

### Component diagram

```mermaid
flowchart LR
    subgraph mbtools["mbtools (external, out of scope)"]
        REG["mbregistry daemon\n(not_found / EOF contract, 95c70bd)"]
    end

    subgraph host["packages/host/src"]
        CLIENT["mbregistry/client.ts\n(001: dedicated watch() connection)"]
        WATCHER["watchers/mbregistryWatcher.ts\n(001: list() poll + markGone)"]
        STORE[("store (links, devices)\n(002: no unguarded device_id COALESCE)")]
        CONNECTOR["connect/connector.ts\n(002: UID guard · 003: not_found -> stale · 005: identify logging)"]
        STREAM["link/adapters/mbregistryStream.ts\n(003: not_found passthrough, already in place)"]
        RECONCILER["connect/reconciler.ts\n(005: retry once deviceHasActiveLink reflects reality)"]
        FLASHPATH["server.ts: resolveFlashLinkTarget\n(004: refuse stale, redirect to current link)"]
        MCP["mcp/tools/connect.ts: send_command\n(006: correlated reply lines)"]
    end

    subgraph ui["packages/ui/src"]
        CARD["deviceDisplay.ts: cardLinks\n(already filters stale -- no change)"]
        WIFI["WifiCredentialsDialog.tsx\n(007: reveal:true + prefill)"]
    end

    REG -->|list / watch events| WATCHER
    REG -->|lock+stream / not_found / EOF| STREAM
    WATCHER -->|upsertLink, markGone| STORE
    CONNECTOR -->|upsertLink, setLinkState| STORE
    CONNECTOR --> STREAM
    STREAM --> CONNECTOR
    RECONCILER -->|reads links/devices/sessions| STORE
    RECONCILER -->|connectAndIdentify| CONNECTOR
    FLASHPATH -->|reads links/devices| STORE
    STORE -->|snapshot/projection| CARD
    CLIENT -.->|watch() / list() / stream()| REG
    WATCHER --> CLIENT
    STREAM --> CLIENT
    FLASHPATH --> CLIENT
```

No entity-relationship diagram: no table, column, or foreign key
changes. No dependency-graph diagram: no module gains or loses a
dependency on another — every arrow above already exists in
`docs/design/architecture.md` §3/§8; this sprint changes what several
of those existing arrows *carry* (a guarded write instead of an
unguarded one, a `stale` write instead of a `failed` one), not which
modules talk to which.

### Design Rationale

**Decision: widen the existing USB deviceId-mismatch guard to
`mbregistry`, rather than write a new, mbregistry-specific identity
check.**
- *Context*: both transports have the same underlying hazard (a byte
  stream can, transiently, carry a different physical board's identity
  than the link row already believes), and `connect/connector.ts`
  already has one well-tested check for it, scoped only to `usb`.
- *Alternatives considered*: (a) a separate mbregistry-only check
  comparing the banner's serial against the link's own stored `uid` via
  `deviceIdToName`/decode — rejected, because it would duplicate the
  existing check's logic under a different name for no behavioral
  difference; (b) validating identity one layer down, in
  `mbregistryStream.ts`, against the registry's own `list()` output at
  stream-open time — rejected, because that only catches a mismatch
  that exists *at open time*; the observed bug is a mismatch that
  develops *during* an already-open stream (the port's occupant changed
  underneath a still-locked-by-UID session), which only a check against
  the link's own last-known identity (the existing guard's exact shape)
  catches regardless of when the drift happened.
- *Why this choice*: one guard, one place, already tested for the
  analogous USB case; widening its condition is a one-line change with
  a clear, narrow blast radius.
- *Consequences*: a genuine first-time identify (link has no prior
  `deviceId` yet) is unaffected — the guard's existing `!== undefined &&
  !== null` condition already only fires once a link has a prior
  identity to disagree with, which is exactly the case that matters
  (the gone-board bug's link *had* a prior identity, zugit's).

**Decision: classify `not_found` as `stale`, not as another `failed`
retry, ahead of the generic `recordFailure` call.**
- *Context*: `recordFailure`'s exponential backoff exists for
  transient failures (a busy bridge, a boot-window miss) where retrying
  soon is the right instinct. `not_found` is mbtools affirmatively
  saying the UID is not attached at all right now.
- *Alternatives considered*: leaving `not_found` to flow through
  `recordFailure` unchanged and letting the backoff cap (60 s) bound the
  retry storm — rejected; the issue's own bench evidence
  ("`0f0a31a9` never re-enumerated ... marking known-blank" after three
  attempts) shows this is not merely "eventually slow," it actively
  drives a stuck flash attempt into mbtools' own watchdog three times
  before giving up, which is the exact symptom to close.
- *Why this choice*: matches the watcher's own already-shipped
  `markGone` semantics (same target state, `stale`, same "no retry
  storm" reasoning) — one consistent meaning for "this UID is gone"
  across the two places that can observe it (the watcher's poll, the
  connector's identify attempt).
- *Consequences*: reviving a `stale` mbregistry link back to
  `connectable`/`discovered` is already the watcher's own job
  (ticket 001's `reconcile`, the `revivable` branch) — this ticket adds
  no second revival path, it only makes the connector defer to the same
  one that already exists.

### Migration Concerns

None. No schema change, no data migration, no wire-protocol version
bump. `MbregistryError`'s `not_found` code already exists on the wire
today (mbtools 95c70bd is what changed, not this codebase); this sprint
only changes how the console reacts to a code it could already receive.
Deployment sequencing: ticket 001 (the uncommitted watcher/client fix)
must land, on `main`, before tickets 002-005 are implemented against it
— captured as ticket 001 having no dependents *skipped*, but every
later mbregistry ticket's own Test Strategy assumes it is already in
place, per the "Depends On" column in the Tickets table below.

## Use Cases

### SUC-001: mbregistry watcher stays current without blocking later `list`/`find`/`lock` calls
Parent: UC-014 (A robot goes away)

- **Actor**: robot-console host (automatic)
- **Preconditions**: `startRuntime` has connected an `MbregistryClient`;
  the uncommitted `client.ts`/`mbregistryWatcher.ts`/
  `mbregistryWatcher.test.ts` changes are applied.
- **Main Flow**:
  1. The watcher calls `client.list()` once at start and every 1 s
     thereafter, reconciling each entry against the store by fingerprint
     (unchanged entries cost no write).
  2. `watch()` runs on its own dedicated connection, so a `list`/`find`/
     `lock` call issued while `watch()` is active (e.g. the flash path's
     own `find()`) resolves normally instead of hanging behind the
     shared control connection.
  3. A UID that disappears from `list()` (and is not already `stale`)
     is aged `stale` and its session closed (`markGone`).
- **Postconditions**: The store's mbregistry link/device rows reflect
  the registry's own list within one poll interval; nothing else
  waiting on the control connection is blocked by an open `watch()`.
- **Acceptance Criteria**:
  - [ ] `mbregistryWatcher.test.ts` (as already written, uncommitted)
        passes.
  - [ ] `tsc` is clean across the affected packages.
  - [ ] The commit lands on `main` crediting robot-console-e6.

### SUC-002: A gone board's UID never re-homes another robot's link
Parent: UC-014 (A robot goes away)

- **Actor**: robot-console host (automatic)
- **Preconditions**: Two mbregistry-backed boards have shared one
  physical port over time (board A unplugged, board B plugged into the
  same port); board A's link previously identified with a known
  `deviceId`.
- **Main Flow**:
  1. A stream nominally addressed to board A's UID (still locked, not
     yet aged `stale`) yields bytes that decode to a banner naming
     board B.
  2. `connect/connector.ts`'s identify guard compares the banner's
     serial against board A's link's own already-known `deviceId`,
     finds a mismatch, and refuses: no `upsertDevice`/`upsertLink`
     writes B's identity onto A's link, no `owned`/`connected` state
     change.
  3. The mismatch is recorded as a link failure (`state_reason`), not
     silently dropped.
- **Postconditions**: Board A's link is never shown connected as, or
  offered for flashing as, board B. Board B's own link (keyed by its
  own UID) is unaffected.
- **Acceptance Criteria**:
  - [ ] A `connector.test.ts` case: an mbregistry link with a known
        `deviceId` receiving a banner with a different serial does not
        call `store.upsertLink`/`upsertDevice` with the new identity,
        and records a failure.
  - [ ] A `deviceDisplay.test.ts`/`FrontPage`-level regression:
        board A's link, left `stale` per SUC-001/SUC-003, does not
        appear in `cardLinks` for board B's device.
  - [ ] No real hardware or real mbregistry daemon in the test.

### SUC-003: `not_found` marks a link gone, not merely "failed and retrying"
Parent: UC-017 (A link drops under an open session)

- **Actor**: robot-console host (automatic)
- **Preconditions**: An mbregistry link's UID is no longer attached to
  any port mbtools tracks (unplugged, or moved to a peer host with no
  local trace yet).
- **Main Flow**:
  1. A `lock`/`stream` attempt against that UID rejects with
     `MbregistryError` code `not_found`.
  2. `connect/connector.ts`'s identify path recognizes that code ahead
     of its generic `recordFailure` call and sets the link `stale`
     (mirroring `markGone`) instead of `failed` + backoff.
  3. An already-open stream that receives EOF because its UID left the
     port is reconnected, when retried, by the same UID-keyed link — no
     port-keyed re-lock path exists to fall back to.
- **Postconditions**: A gone UID's link does not retry with escalating
  backoff against a board that is not there; it is picked back up by
  the watcher's own `list()`-driven revival (SUC-001) once the UID
  reappears.
- **Acceptance Criteria**:
  - [ ] A `connector.test.ts` case: a `not_found` `MbregistryError` from
        `client.stream()`/`client.lock()` results in `state: "stale"`,
        not `state: "failed"`.
  - [ ] No retry-storm regression: the link's `next_retry_at` is not set
        by this path (it is not a `failed` link).
  - [ ] Fakes only (a fake `MbregistryClient` that rejects with
        `MbregistryError("not_found", ...)`), no real daemon.

### SUC-004: Flashing refuses a board that is not currently attached
Parent: UC-002 (Install firmware on a blank micro:bit)

- **Actor**: Student (via the flash pop-up) or an MCP caller (via
  `request_flash`)
- **Preconditions**: A device has a `stale` mbregistry link (its board
  went away) and, in the common case, a live current mbregistry link
  for the same device.
- **Main Flow**:
  1. A flash is requested against the device's stale linkId (a stale
     UI reference, or a caller that hasn't refreshed).
  2. `resolveFlashLinkTarget`'s `mbregistry` branch sees `state ===
     "stale"`, finds the device's current non-stale mbregistry link,
     and redirects to it — mirroring the existing `usb`-to-`mbregistry`
     redirect already in this function.
  3. If no current link exists for the device, the call returns
     `{ok: false, reason: "... is not currently attached"}` instead of
     a flash target.
- **Postconditions**: A flash never starts against a UID mbtools does
  not currently have attached; the failure is a clear, immediate
  message, never a 60 s hang ending in `pyocd exit -9`.
- **Acceptance Criteria**:
  - [ ] A `server.test.ts` (or equivalent) case: flashing a `stale`
        mbregistry linkId with a live sibling link redirects and
        succeeds against the live one.
  - [ ] A case with no live sibling link returns `ok: false` with a
        plain-language reason, never starting a flash task.
  - [ ] `mcp/tools/flash.ts`'s own precondition check (calling the same
        function) is covered by the same test or an equivalent MCP-level
        one — no second, divergent precondition set.

### SUC-005: A robot's own current board link identifies reliably and retries on failure
Parent: UC-001 (Connect and identify a device over USB) — extended to
the mbregistry transport it already covers structurally.

- **Actor**: robot-console host (automatic)
- **Preconditions**: A robot's own board is the only thing on its port;
  its mbregistry link has no competing, wrongly-re-homed sibling
  (SUC-002/SUC-003 already landed).
- **Main Flow**:
  1. `connect/connector.ts` opens the mbregistry stream and runs
     `identifyWithBootWindowRetry`, sending `HELLO` at `[0, 750, 1500,
     2500]`ms — logged (exact bytes) for the mbregistry transport so a
     failure to identify is diagnosable without live serial access.
  2. The board's reply is parsed as a banner and the link reaches
     `connected`.
  3. If identify still fails, the link goes `failed` with
     `next_retry_at` set; the reconciler's `tick()` dispatches a fresh
     connect job once `next_retry_at` elapses and
     `deviceHasActiveLink` no longer reads a false positive from an
     unrelated (previously mis-homed) link.
- **Postconditions**: Opening a robot's current mbregistry link
  identifies it as reliably as a direct serial `ID` probe does, or logs
  exactly what was sent/received so the remaining gap (if any) is
  diagnosable; a `failed` link is retried at `next_retry_at`, not left
  for 10+ minutes.
- **Acceptance Criteria**:
  - [ ] Logging of the exact bytes sent on an mbregistry stream's
        identify path lands and is exercised by a test (a fake
        `ByteStream` asserting the written bytes).
  - [ ] A `reconciler.test.ts` case with a fake clock: a `failed`
        mbregistry link with an elapsed `next_retry_at` and no active
        sibling link produces a fresh `connect` job.
  - [ ] Findings on the reply-dialect question (whether the bench's
        `id ...` line is a distinct, currently-unparsed dialect) are
        recorded in the ticket even if the root cause turns out to be
        fully explained by SUC-002 in this specific bench session —
        this SUC's own acceptance is the logging + retry-dispatch tests,
        not a live-hardware re-run.

### SUC-006: `send_command` returns the robot's own reply
Parent: none (sprint-scoped) — no existing top-level use case covers
MCP tool behavior; nearest sibling is UC-003 (Drive a robot over USB)
for the wire-command mechanics `send_command` rides on.

- **Actor**: An MCP agent
- **Preconditions**: `open_session` has succeeded on a linkId.
- **Main Flow**:
  1. The agent calls `send_command` with a verb (e.g. `STATUS`, `ID`, a
     query verb).
  2. The host sends the wire line and, for a short window, collects the
     correlated ack/nack (sequenced verbs, via `LineLink.onAckNack`) or
     the next inbound line(s) (unsequenced queries, via
     `LineLink.onInboundLine`).
  3. `send_command` returns `{ok, sent, reply}` — `reply` carrying the
     collected line(s), rather than only the request's own echo.
- **Postconditions**: An agent can read `WIFICRED`/`ID`/`STATUS`
  replies and `DBG:` lines through the console, without opening serial
  directly.
- **Acceptance Criteria**:
  - [ ] A `connect.test.ts` case with a fake session: `send_command` on
        a query verb returns the reply line(s) the fake session's link
        emits after the send.
  - [ ] A case with no reply within the window returns `reply: []` (or
        equivalent), not an error — an unanswered query is not a
        `send_command` failure.

### SUC-007: The Wi-Fi dialog's Show/Hide has a password to act on
Parent: none (sprint-scoped) — no existing use case covers Wi-Fi
credential provisioning UI specifically.

- **Actor**: Student or instructor
- **Preconditions**: A Wi-Fi password is already saved on the host for
  the network the dialog will prefill.
- **Main Flow**:
  1. Opening `WifiCredentialsDialog` sends `get-wifi-credentials` with
     `reveal: true`, matching `ConfigurationPage`'s Wi-Fi tab.
  2. The dialog prefills both `ssid` and `password` from the revealed
     response.
  3. The Show/Hide toggle now has visible text to reveal or mask.
- **Postconditions**: The user can see, before writing it to the robot,
  exactly which password will be sent.
- **Acceptance Criteria**:
  - [ ] A `WifiCredentialsDialog` test: with a stored password, the
        password field is prefilled and Show reveals the real value.
  - [ ] `server.ts`'s existing `get-wifi-credentials` handler is
        unchanged (already supports `reveal`); only the dialog's own
        request and prefill effect change.

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On | Issue |
|---|-------|------------|-------|
| 001 | Commit robot-console-e6's uncommitted mbregistry watcher/client fix | — | gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md, mbregistry-own-uid-link-never-identifies.md |
| 002 | Guard the mbregistry identify path against banner-driven device re-homing | 001 | gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md |
| 003 | Classify mbtools not_found as stale, not a retrying failure | 002 | gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md |
| 004 | Refuse or redirect a stale mbregistry link in the flash path | 003 | gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md |
| 005 | Log and fix the own-UID mbregistry identify handshake; retry failed links at nextRetryAt | 003 | mbregistry-own-uid-link-never-identifies.md |
| 006 | MCP send_command returns correlated robot reply lines | — | mcp-send-command-does-not-return-robot-replies.md |
| 007 | Prefill the revealed Wi-Fi password in WifiCredentialsDialog | — | wifi-dialog-show-hide-has-nothing-to-show.md |

Tickets execute serially in the order listed. 006 and 007 are
independent of the mbregistry-identity chain (001-005) and of each
other — listed last only because they were planned last, not because
anything blocks them; a future execution pass could run either earlier
without consequence.
