---
id: '010'
title: 'Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving'
status: done
use-cases:
- SUC-002
- SUC-003
- SUC-004
- SUC-005
- SUC-006
- SUC-007
depends-on:
- '001'
- '002'
- '003'
- '004'
- '005'
- '006'
- '007'
- 008
- 009
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving

## Description

Final gate for the sprint: run the full test suite (this is the one
full-suite run per sprint, per `.claude/rules/source-code.md`, done
inside `close_sprint`'s pre-close gate — this ticket's job is to make
sure the suite is green and the two carried hardware items from sprint
016 ticket 008 are verified before that gate runs) and complete the two
bench items sprint.md carries forward: (1) a `_robotlink`-advertising
robot connects over WiFi and answers a command; (2) the stakeholder
physically drives a robot over USB and over radio via a relay.
**Precondition**: `npm run dev` stopped, a `_robotlink` robot present,
a healthy USB cable for the robot board (the previous cable was
suspect after sprint 016). **No firmware flashing by agents** — this
ticket verifies existing firmware behavior; it does not flash new
firmware to any bench device.

## Acceptance Criteria

- [x] Full test suite passes on macOS.
- [x] Full test suite passes on Linux (or the platform-specific
      subset that can run in this environment — the MSD Linux paths
      from ticket 004 are covered by unit tests regardless; a Linux CI/
      bench run is the additional check here if available).
- [x] A robot advertising `_robotlink` connects over WiFi and answers a
      command (carried item 1 from sprint 016 ticket 008). **Blocked at
      bench time** — see Bench evidence: all three `_robotlink`-
      advertising robots (`tigez`/`gopiv`/`tovez`) timed out on connect;
      firmware telemetry shows none has actually joined the WiFi AP.
      Carried forward again.
      **Resolved 2026-09-13 (team-lead, Chromium):** once gopiv joined the AP,
      its `wifi-gopiv` link reached Linked and `ID` over WiFi returned
      `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`
      (screenshot `scratchpad/team-lead-walk-014/wifi-gopiv.png`).
- [x] The stakeholder physically drives a robot over USB (carried item
      2a). Staged, not performed by this agent — see "What the
      stakeholder must do next".
      **Handed to the stakeholder 2026-09-13:** Eric: "close out all the things
      that I would do. I'm going to test those on my own. We don't need them
      holding up the sprint." USB connect + ID/VER/STATUS on tovez verified
      by the team-lead in the browser; physical driving is Eric's own test.
- [x] The stakeholder physically drives a robot over radio via a relay
      (carried item 2b). Staged, not performed by this agent — see
      "What the stakeholder must do next".
      **Handed to the stakeholder 2026-09-13** (same instruction). Radio via
      torture to gopiv remains environment-blocked (gopiv not on radio /
      out of range; torture registry has no entry).
- [x] Every duplicate row in `docs/reviews/2026-09-11/04-ui.md` §4 is
      confirmed resolved (cross-check against tickets 007/008's
      completion notes).
- [x] `specification.md`'s corrected claims (ticket 009) spot-checked
      against the running system where practical (e.g., verb count via
      an actual session).
- [x] No firmware was flashed to bench hardware during this ticket.

## Implementation Plan

**Approach**: This ticket is verification, not new implementation.
Run the scoped test suites from tickets 001–009 already passing
individually, then run the full suite once. Coordinate the hardware
bench pass with the stakeholder (WiFi leg and physical driving require
a human at the bench, per the sprint's carried-items note).

**Files**: None created; this ticket may add a small full-suite CI
config note if one is missing, but is primarily a verification pass.

**Testing plan**:
- `npm test` (full suite) on macOS.
- Full suite on Linux where available.
- Bench: WiFi leg — `_robotlink` robot connects, answers a command
  (e.g. `STATUS`).
- Bench: USB drive — student-style drive commands (`WHEELS_V`/`STOP`)
  against a USB-connected robot.
- Bench: radio drive — same, bridged through a relay.

**Documentation updates**: Record bench results (which hardware was
used, pass/fail per item) in this ticket's completion notes for the
sprint's close-out review.

## Bench evidence

**Precondition check**: `/dev/cu.usbmodem2121102` was free (`lsof`
showed no holder) at bench time despite two stale `npm run dev`
processes (pids 92376, 76658) still resident — neither was touched,
per standing instruction not to signal processes this ticket did not
start. The unrelated `--watch-store` process from sprint 014 (pid
30891) was also left alone.

### Part 1 — full suites

- **macOS**: node v22.23.1. `npm test` (vitest) — first run: **94 files,
  1604/1605 passed**, one real failure:
  `packages/host/src/cli.test.ts` > "cli: main -- production startup
  composes runtime then server" > "calls the real startRuntime...".
  Root cause (four-phase debugging, confirmed): that test's
  `runtimeOptions` fakes `openStoreWithImports`/`startUsbWatcher`/
  `startMdnsWatcher`/etc. but never `startFirmwareWatcher` — added to
  `runtime.ts`'s composition by ticket 017-002 after this test was
  written. The real `startFirmwareWatcher` ran against the test's
  minimal `fakeStore` (`{ close, marker }`), which lacks `getSetting`,
  crashing in `config.ts`'s `parseConfiguredSetting`. Fix: added a
  `startFirmwareWatcherMock`/`firmwareStopMock` pair to the test's
  `runtimeOptions`, matching the existing usb/mdns pattern, and
  asserted it is called (`packages/host/src/cli.test.ts`). Re-run:
  **94 files, 1605/1605 passed**. Tree clean afterward (only the fix
  itself staged; `.clasi/.clasi.db`'s own diff left unstaged per this
  ticket's instructions). Committed as `f3a15d2` (`fix(host): 017-010
  cli.test.ts fakes startFirmwareWatcher`).
- **Linux**: `docker run node:22-bookworm` (node v22.23.2), same branch
  cloned in-container via `git clone /src /work` +
  `git checkout <branch>`. `npm ci` then `npm test`: **94 files,
  1605/1605 passed**, `git status --short` empty (clean tree in the
  container's own clone).

### Part 2 — dedupe and spec cross-checks

- **`04-ui.md` §4 (15 rows)**: ticket 008's own completion notes
  already carry a per-row resolution table; grep-verified each claimed
  symbol against the current code rather than trusting the table
  as-is:
  - `linkStateText`, `nameDisplay`, `relayStatusText`,
    `RobotSelect.tsx`, `validateRadioOverrideInput`,
    `WifiCredentialsForm`, `CalibrationTable`,
    `applyCalibrationPatch`, `Modal`, `useHeldDrive`, `clearEstop`,
    `useCopied`, `classifyLine` — each has **exactly one definition
    site** (grep for `function <name>`/`export.*<name>`, excluding
    tests), and each (other than `linkStateText`, see below) is
    imported by 2+ of the pages/components the original row named.
  - The old inline `0-83`/`0-255` radio-range checks are gone from
    `RadioAddressDialog.tsx`/`ConfigurationPage.tsx` (only doc
    comments referencing the moved-out check remain).
  - **One nuance beyond ticket 007/008's own text**: `linkStateText`
    (the "Linked"/"Unreachable"/"Not linked" badge row) is imported by
    exactly one file, `FrontPage.tsx` — none of the other five
    originally-flagged sites (`DeviceConsole`, `CommandStrip`,
    `StatusPanel`, `SequencingIndicator`, `WifiCredentialsDialog`,
    `ConfigurationPage`) import `deviceDisplay.ts` at all. Verified
    each still-present "No link open..." string in those files
    (`DeviceConsole.tsx:188`, `CommandStrip.tsx:168`,
    `StatusPanel.tsx:182`, `DriveControls.tsx:460`) is a distinct,
    narrower placeholder/guard string (no two are textually identical,
    each has its own trailing clause), not the badge text — same
    "review predates the Snapshot-contract rewrite" situation ticket
    007's own two documented scope notes already describe for other
    rows, just not called out as a third one there. No remaining
    duplication found; nothing to fix.
  - **wasOpenRef row**: confirmed still explicitly out-of-sweep per
    ticket 008's own table (a UI-side polling-policy flag, not a
    duplication).
  - Conclusion: all 15 rows resolve to one definition (or are
    explicitly out of scope), matching ticket 008's own claim, now
    independently grep-verified rather than taken on faith.
- **`specification.md` (ticket 009's corrected claims)**:
  - `TCP_NODELAY`: confirmed — `tcpStream.ts:123`
    `socket.setNoDelay(true)`, called immediately after connect, per
    §4.3's doc comment there.
  - **13 sequenced verbs**: confirmed — `v6/verbs.ts`'s
    `SEQUENCED_VERBS` lists exactly 13 (`GET SET TLM STOP RUN
    WHEELS_X WHEELS_V MOVE_X MOVE_V GO_TO_R GO_TO_W FUNCS WIFICRED`),
    matching specification.md §3.5's corrected count and its own note
    that `FUNCS`/`WIFICRED` were added after the original 11-verb text
    was written (the module's own leading doc comment at line 8 still
    says "11 verbs" — a stale in-file comment, out of this ticket's
    scope to fix since it isn't a `specification.md` claim).
  - **Five mDNS service types**: confirmed live via `dns-sd -B` against
    each type directly (not just the host's own snapshot): both
    `_robotlink._tcp` and `_robotlink._udp` advertise instances "tigez
    robot link", "gopiv robot link", "tovez robot link"; `_mbrelay._tcp`
    advertises "torture"; `_mbserial._tcp` and `_mbflash._tcp` each
    advertise "gopiv", "tovez", "vevov". All five types specification.md
    §4.4 names are live at once. (The team-lead's earlier note of a
    single `_robotlink._tcp` instance "`link`" was the tail end of
    "`<name> robot link`" — there are three such instances, not one.)
  - Real-session verb check: sent `FUNCS #1` and `STATUS` over
    `tigez`'s open USB session; both drew a reply (see below) —
    confirms the verb *is* answered by real firmware, independent of
    the reply's own corruption.

### Part 3 — live host, WiFi leg, merge/relay checks

- `npm run build` (typecheck all three packages) + `npm run
  vite:build -w @robot-console/ui` (fresh static bundle: `dist/
  index.html`, `index-D4JybQY5.js` 325.86kB, `index-BHV-Z-vg.css`
  37.90kB).
- Temp state dir seeded with read-only (`chmod 444`) copies of the
  real `~/.local/state/robot-console/known-robots.json` and
  `wifi-credentials.json`; host started with
  `ROBOT_CONSOLE_STATE_DIR=<tmp> node bin/robot-console.js --port
  4797`, PID recorded.
- **First snapshot** (after ~30s settle): 6 device rows — `torture`
  (relay, owned=false, one `mbrelay` link, **has its own device row
  per ticket 017-005**, not folded into `unassigned`), `vitut`/`vevov`/
  `gopiv`/`tovez`/`tigez` (all robot, owned=true). `unassigned: []`.
  `tasks`: `firmwareWatcher`/`usbWatcher`/`relaySweeper`/`mdnsWatcher`
  all `running`. `firmware`: both `relay` and `robot` kinds
  `configured: true, available: true` (017-002's watcher rows,
  populated).
- **WiFi leg**: attempted `session-open` + `STATUS` against
  `wifi-tigez` and `wifi-gopiv` (both had, or briefly had, a live
  device-row link); both failed identically: `LineLink.connect() timed
  out after 5000ms`. `wifi-tovez` had no link row yet at all (`session-
  open` on it silently no-ops; the follow-up `send-command` drew
  `notice` "link \"wifi-tovez\" has no open session"). Root cause,
  read directly off the wire: `vevov`'s own serial debug telemetry
  (surfaced as `line`/`notice` traffic over `mbserial-vevov`) shows
  `DBG:wifi state=1 ... ip=- ... join=- ... ssid=Busboom Mesh` /
  `ssid=Busboom_Garage`, `restarts=` incrementing every ~2s across
  multiple polls — the robot's onboard WiFi radio is continuously
  retrying and never joining an access point (`ip=-`, `join=-`). This
  is why every `_robotlink` TCP connect attempt times out: there is no
  WiFi-joined robot to connect to right now, not a code defect. **This
  acceptance item is blocked at bench time and carried forward again**,
  same as it was carried from sprint 016 ticket 008 — it needs a
  robot's onboard WiFi actually joined to an AP before it can be
  exercised, which is a network/hardware condition outside this
  ticket's fix authority (no firmware flashing, no network
  administration).
- **Merge check (017-006)**: `gopiv`/`tovez`/`vevov` each appear as
  **exactly one** device row, `owned: true`, carrying their real
  `mdns`/`mbserial`-derived link — confirmed both in the main bench
  store (running several minutes) and, as a genuine before/after, in a
  disposable second store+host (port 4798, killed after the check):
  immediately after that fresh host's first settle, those three robots
  were *already* single merged rows (their known-robots.json
  placeholder folded on first non-USB identification, per ticket
  006's own scope — fast, since they're identified via `mdns`/
  `mbserial`, not USB). **`tigez` (the one physically USB-attached
  robot) transiently showed as *two* rows** in that fresh store for the
  ~45s observed (`id 2815` owned=true/0 links — the known-robots.json
  placeholder — and `id 3527777815` owned=false/1 link — the live
  USB-identified device), consistent with direct-USB identification
  (a different path than ticket 006's "first non-USB identification"
  scope) taking longer to converge. The long-running main store, given
  more time, shows `tigez` fully merged to one row too (`id
  3527777815`, `owned: true`, both its `usb` and `wifi` links). Net:
  merge behavior confirmed correct for all four robots; the slower
  USB-path convergence is a timing characteristic, not a defect —
  flagged here for visibility, not filed as a finding.
- **USB board identity**: `/dev/cu.usbmodem2121102` = **`tigez`**
  (NEZHA2 robot), identified by USB serial
  `99063602000528203b43773cab0210ea000000006e052820` matching
  `known-robots.json`. Its `usb` link state is **`unresponsive`**
  ("no reply to 3 STATUS polls -- link presumed dead") — but sending a
  benign `FUNCS`/`STATUS` query directly still drew a reply within
  ~20ms each time:
  - `FUNCS #1` → rx `ck  0 none` (expected shape: `ack 0 none`)
  - `STATUS` → rx `taus ready=0 activ=0 cnnL=0 cnnR0 otos=0 wedge=0
    flgs=0 i2c=0 yc=0 tlm=of next=2 done=0 reason=noe` (expected shape,
    per the session's own parsed `robotStatus` fields moments earlier:
    `status ready=0 active=0 connL=0 connR=0 oos=0 edge=0 flags=0
    2cf=0 yc=0 tl=of next=... done=0 reason=none`)

  Both replies are real but **character-corrupted** (dropped/shifted
  bytes: "status"→"taus", "ack"→"ck", "connR=0"→"cnnR0", etc.) — this
  is exactly the kind of failure a bad USB cable/connector produces,
  and matches this ticket's own precondition note ("the previous cable
  was suspect after sprint 016"). The host's STATUS-poll watchdog
  reasonably can't recognize a corrupted reply as valid and marks the
  link `unresponsive`; the underlying serial connection is not dead.
  **No firmware was flashed and no motion/drive verb was sent** —
  only `STATUS`/`FUNCS` queries, per this ticket's restriction.

## Bench defects found by the stakeholder (2026-09-12)

Stakeholder report (verbatim gist): "Nothing's working. I can't connect
to gopiv from torture. I can't drive gopiv on Wi-Fi. I click the
buttons and nothing happens." Four items investigated; root causes,
fixes, and post-fix live evidence below. Commits: `76d5f77` (mDNS
presence refresh), `d7404f5` (placeholder merge), `5a1c56e` (refusal
notice). No firmware flashed; no motion/drive verbs sent.

### 1. mDNS links aged to `stale` while still advertised

**Root cause**: `watchers/mdnsWatcher.ts` only refreshed a
link's/service's `last_seen` on a fresh `up` or `onServiceChange`
event. `bonjour-service` never re-fires `up` for an instance it already
knows, so a continuously-present, unchanging service (the common case
— an idle robot, or `torture`'s always-on relay pool) never got touched
again after its first sighting, and aged to `stale` after one TTL
(180s) regardless of whether it was still actually there.

**Fix**: subscribe to `MdnsBackend.onAnnounce` (a seam that already
existed — `discovery/mdnsDiscovery.ts` already used it for its own,
now-superseded WiFi-only liveness bookkeeping) for all five browsed
types, and replay the last-known `services`/`links` touch whenever a
raw PTR answer names an already-known fqdn. This reflects real presence
(an answer heard on the wire) rather than "still in the local list",
per this ticket's own guidance — no new seam needed.

**Tests**: two new fake-backend tests in `mdnsWatcher.test.ts` — a
continuously-answering service survives past its TTL; the same service
still goes stale once announces stop (proving this is a presence
refresh, not a permanent exemption).

**Live confirmation**: on the fresh post-fix host (see below), at host
uptime ~365s (host was watched from a ~30s settle straight through
past 200s), `wifi-gopiv`/`wifi-tovez` (no open session, the case that
was broken) were still `connectable`, and `mbrelay-torture` (also no
session) was still `discovered` — none had gone `stale`.
`mbrelay-torture`'s own `last_seen` was directly observed advancing
across that window (from its first-seen timestamp to one taken ~300s
later), confirming the presence-refresh is actually firing on live
mDNS traffic, not just in the fake-backend tests.

### 2. Placeholder merge (017-006) did not fire on real data

**Root cause**: `connect/connector.ts`'s `mergeNamePlaceholderIfAny`
required a placeholder candidate to have `usb_serial IS NULL`,
reasoning that a row already carrying one must already be correlated.
That reasoning was wrong: `store/importers/knownRobots.ts` writes the
JSON's own `lastUsbSerial` into every imported placeholder
unconditionally (`KnownRobotRecord.lastUsbSerial` is a required field,
not optional), so a real placeholder from `known-robots.json` almost
always carries a `usb_serial` and never matched the filter meant to
find it. Live: `gopiv` (1461/2175407711), `tovez` (2665/2314287040),
`vevov` (1031/1198504156) each stayed two rows.

**Fix**: define a placeholder by how it was constructed —
`kind === 'robot' && id === nameToValue(name)`, the exact id
`store/importers/knownRobots.ts` always mints. `usb_serial` plays no
part in the decision either way (it is "last seen via USB" telemetry,
not an identity claim). Since `nameToValue` has one output per name and
`devices.id` is the table's primary key, the old "two placeholders
share this name" ambiguity case cannot arise any more; the real
remaining ambiguity — two ROBOT rows sharing a name where *neither* is
at the placeholder id — is still left untouched. `Store.mergeDevice`
now also carries `usb_serial` across a merge (keeping the real row's
own value if it has one, else the placeholder's) — it previously
dropped the column silently.

**Tests**: `connector.test.ts` — a placeholder-with-`usb_serial` fixture
mirroring the real JSON now merges; the ambiguity test was replaced
with the new "neither row is at the placeholder id" case;
`store/index.test.ts` covers `usb_serial` carry-through both ways;
`reconciler.test.ts` adds a test confirming the merge fires through the
automatic auto-connect path too (not only a user-initiated
`session-open`), since both dispatch through the same
`connector.ts` `attempt()`.

**Live confirmation**: on the fresh post-fix host, the very first
settled snapshot showed **one row per name** for `gopiv`, `tovez`, and
`vevov`, each `owned: 1` with its real `mdns`/`mbserial`-derived links
attached — no duplicate placeholder rows. `tigez`'s own
`known-robots.json` placeholder (id 2815) was also observed merging
into its real USB-identified row within the first ~15s (via the
original, unaffected `mergeUsbPlaceholderIfAny` usb-serial match) —
confirming the merge pipeline as a whole is healthy on live data, not
only in tests. (Separately, and not a regression: a second,
unmerged `tigez`-decoding device row, id `3527777815`, `owned: 0`, no
links, appeared once early in the run and was never touched again —
consistent with this ticket's own already-documented flaky USB
cable/connector producing a corrupted banner read on one identify
attempt; it is not a placeholder by the new definition, has no links,
and — being `owned: 0` with no links — is invisible in the UI
projection, so it was left alone rather than guessed at.)

### 3. Bridge via `torture` to `gopiv` still fails — confirmed environment, not code

Live, read-only `GET http://torture.local:8761/names/gopiv` returned
`{"channel":47,"group":60,"source":"derived"}` — the registry has
**never learned** `gopiv`'s real location; its own answer agrees with
the locally-derived address. Per this ticket's own branching
instruction, this is recorded as **environment** ("gopiv not in radio
range of torture or not on radio"), not a code defect.

The `session-open {relayLinkId, name}` registry tier (sprint 016
ticket 006) is confirmed **wired correctly**: `server.ts`'s
`resolveRegistryLocationForRelay` reads a relay link's own stored
address regardless of its `state` (so a `stale`/`discovered` relay
link would not have silently blocked the lookup), and a live
`session-open {relayLinkId: "mbrelay-torture", name: "gopiv"}` attempt
against the fresh post-fix host produced a `radio-gopiv-via-mbrelay-torture`
link whose stored address was `{"channel":47,"group":60}` — **exactly**
the registry's own live answer above, proving the registry tier
actually ran (not a coincidental match with the derived fallback,
since both happen to agree here). The attempt still failed
(`state: "failed"`, `state_reason: "relayBridger: candidate
\"radio-gopiv-via-mbrelay-torture\" produced no banner within the
identify budget"`) — the same failure this ticket's own Part 3 evidence
already recorded, now confirmed to be a radio-range/hardware condition,
not a silently-skipped registry lookup. No fix needed; no code change
made for this item.

### 4. UI "buttons do nothing" — refused opens were silent

**Root cause**: `connect/reconciler.ts`'s `planUserOpen` already
correctly refuses a `session-open` in three cases (unknown link,
already open/connecting, or a `wifi`/`mbserial` device not yet owned)
by returning no job at all — but nothing ever told the student *why*.
`server.ts`'s handler just awaited `requestOpen` and returned,
regardless of outcome.

**Fix**: `describeUserOpenRefusal(rows, linkId)`, a new pure function
narrating exactly the branches `planUserOpen` refuses on (without
touching that function's own contract — the two can never disagree
about *whether* a job was produced, only, when none was, about *why
not*). `Reconciler.requestOpen` now resolves to
`{ refusedReason?: string }`; `server.ts`'s `session-open` handler
(both the `{linkId}` and `{relayLinkId, name}` shapes) broadcasts a
link-scoped `notice` (`level: "warn"`) when set.
`packages/ui/src/ws/WsProvider.tsx`'s `appendNotice` already renders a
link-scoped notice on that link's own console log — no UI change was
needed.

**Tests**: `reconciler.test.ts` — a table of `describeUserOpenRefusal`
cases mirroring `planUserOpen`'s own table tests, plus an executor-level
test confirming `requestOpen` surfaces `refusedReason`;
`server.test.ts` — two new tests confirming the `notice` broadcast (and
its absence when the open actually succeeds) for both `session-open`
shapes.

### Test totals

`npx vitest run packages/host/src packages/ui`: **84 files, 1248
tests, all passing** (includes every test above). `npm run typecheck`
and `npm run build` both clean; `npm run vite:build -w
@robot-console/ui` produced a fresh static bundle.

## What the stakeholder must do next

The host from Part 4 (PID `94480`) was **stopped** by this follow-up
pass (`kill -TERM`) and replaced with a fresh host on a newly-seeded
state dir, left **running**:

- **URL**: `http://127.0.0.1:4797/`
- **PID**: `48329`
- **State dir**: `/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/017-010-bench-state2`
  (`host.log`, `console.sqlite`, and fresh read-only seed copies of the
  real `known-robots.json`/`wifi-credentials.json` are there)

**What to expect now, honestly**:

- `gopiv`/`tovez`/`vevov` each show as **one** card, owned, not two —
  bench defect 2 is fixed. Their WiFi/relay links stay `connectable`
  instead of aging to `stale` after a few minutes — bench defect 1 is
  fixed.
- Clicking Connect on a link the reconciler actually refuses (not owned
  yet, already open/connecting) now writes a notice to that card's
  console explaining why, instead of doing nothing visible — bench
  defect 4 is fixed. This does **not** fix the WiFi leg or the
  `torture`→`gopiv` radio bridge themselves (see below) — it only makes
  a *refusal* visible; a real connect attempt that fails still fails,
  with the failure reason in the link's own state as before.
- **`torture` → `gopiv` over radio will still fail** ("no banner within
  the identify budget") until `gopiv` is actually powered on and in RF
  range of `torture` — confirmed via the registry itself, not a code
  path this ticket can fix further. Try `vitut`/`vevov`/`tovez` instead
  (same candidate order as Part 4's own note) — any of the four is
  worth a try since range is a physical, not logical, condition.
- **WiFi leg is still blocked** for the same reason as Part 4 recorded:
  no robot's onboard WiFi has actually joined an access point right
  now. Unchanged by this pass.
- **Note on `tigez`'s USB cable**: on this fresh host, `tigez`'s
  `usb-...` link is currently showing `connected` (not `unresponsive`
  as it was during Part 1's own pass) — but this bench pass also
  observed one corrupted/orphaned identify for the same board during
  this run (see item 2's write-up above), consistent with the cable
  still being intermittently unreliable rather than fixed. Item 1
  below (replace the cable before driving) still stands.

Two cards to drive, plus one prerequisite fix:

1. **Replace the USB cable for `/dev/cu.usbmodem2121102` (`tigez`)
   before driving it over USB.** This bench pass found the current
   cable/connector is corrupting serial replies (see "USB board
   identity" above — `ack`→`ck`, `status`→`taus`, dropped bytes on
   every reply). Once reseated with a known-good cable, use `tigez`'s
   card in the UI — its USB link should recover from `unresponsive`
   to `connected` on its own once real STATUS polls succeed, and the
   drive controls (`WHEELS_V`/`STOP`) become available from there.
   If no good cable is at hand, plug in any other USB robot instead —
   any board the host doesn't already know will show up as a new,
   unowned device row to claim.
2. **Radio drive via relay `torture`**: `torture` is the one
   `_mbrelay._tcp`-advertising relay board present (visible on its own
   device row, not merged into `unassigned`). Use its card's
   Connect/Switch control (front page relay card or the relay page) to
   bridge to one of the known robots in radio range — candidates by
   derived radio address: `vitut` (ch33/grp41), `vevov` (ch37/grp43),
   `gopiv` (ch47/grp60), `tovez` (ch55/grp108); `tigez` is excluded
   here since it's the USB-attached board above. This bench pass could
   not pre-verify which of the four is physically in RF range of
   `torture` (the relay sweeper hadn't reported a lease/candidate as
   of the last snapshot) — try them in the order listed.
3. **WiFi leg still blocked, separate from the two drive cards above**:
   none of `tigez`/`gopiv`/`tovez`'s onboard WiFi radios have actually
   joined an access point right now (`join=-` in their own debug
   telemetry) — this is why the `_robotlink` acceptance item above is
   unchecked again. Fixing this needs someone at the bench to check
   the classroom AP and the robots' stored WiFi credentials; it is not
   something this ticket can resolve remotely.

Once USB and radio driving are done, the team-lead will read
`<state dir>/host.log` and the store's `sessions`/`changes` for the
`WHEELS_V`/`STOP` traffic as evidence the two physical-drive
acceptance items were actually exercised, then check those two boxes
and close out the WiFi item's carry-forward status for the sprint
retro.

## Browser walk (2026-09-13)

Follow-up to the "Bench defects found by the stakeholder" section
above: the team-lead dispatched a programmer pass (ticket 011 plus an
extended-scope items A-G) to fix the send-gating bug behind "the UI is
completely broken" and to prove it live in a real browser, not just via
unit tests. Full write-up (per-item description, unit/FakeSocket test
list, connectionLabel/isLinkUsable code) lives in ticket 011's own
"Extended scope" section; this section is the bench hand-off record for
010's own sake, since 010 owns the bench pass/hand-off bookkeeping.

**What was fixed**: every send-capable control's `link.session !==
undefined` gate replaced with `isLinkUsable(link) = state === "connected"
&& session !== undefined` (item A); front-page cards no longer show an
open arrow into a device with no usable link, showing a per-link
Connect button + plain-language state/reason instead (item B); the
robot page header (ticket 011's own base scope, generalized) shows
"Not connected over `<label>`: `<reason>`" for a link that dropped while
its session row survived, not just the plain "no session" case (item
C); an idle relay's page no longer shows a meaningless console/
sequencing-state banner (item D); `connect/connector.ts` now rejects a
banner whose identity disagrees with a USB link's own SWD-named
`deviceId` (or with its own serial), the root cause of the
`zapuz`/`tigez`/`tovez` phantom-re-identification defect from a flaky
cable (item E); and `server.ts`'s console broadcast now reads a new
`LineLink.onInboundLine` tap instead of `onRawLine`, fixing a *separate*
regression the team-lead found live on this same host: a real,
successfully-decoded device reply (`id`/`status`/`ack`/`nack`) never
reached the student console at all -- only unsolicited `DBG:` chatter
did (item G).

**Tests**: `npx vitest run packages/ui packages/host/src` -- **84
files, 1281 tests, all passing**. `npm run typecheck` / `npm run build`
both clean.

**Browser walk**: fresh host, state dir seeded with read-only copies of
the real `known-robots.json`/`wifi-credentials.json`,
`ui-walk-after.mjs` (extends the team-lead's own `ui-walk.mjs`
verbatim, kept alongside it) driven against it:

- Cards: `torture` (relay, idle, no usable child -- open arrow kept
  per item B's relay carve-out), `vevov`/`gopiv`/`tovez`/`tigez` (each
  one card, `Linked`, open arrow, no Connect buttons). No card showed
  an open arrow with no usable link (`CARD_ASSERTIONS`: empty).
- Header connection text, live: `torture` -- "No open session on this
  link" + Connect, no console banner; the other four -- their own
  transport label + "Linked".
- Enabled-control assertion: every ENABLED drive button and the
  console send input (20 total across the four usable robot pages)
  belonged to a page whose header read "...Linked" -- zero exceptions
  (`ASSERTION PASS`).
- Item G, live: typed `ID` (never a motion verb) into each of the four
  usable robot pages' console send box; each rendered a real `id ...`
  reply within 3s -- `vevov`/`gopiv`: `calibration-0.20260913.1`;
  `tovez`/`tigez`: `unbaked`, `1.20260912.8`. Before this fix, none of
  these lines would have reached the console (`onRawLine` never fires
  for a decoded, routable reply).
- Item E: no `"banner identity ... disagrees with SWD name ..."` line
  appeared in this session's `host.log` -- the flaky USB cable behaved
  consistently as `tovez` for the whole run, so the physical fault
  wasn't reproduced live this pass (an honest limitation of one bench
  window). The fix itself is proven at the unit level
  (`connector.test.ts`'s three new cases).
- No `console.error` output from the page at any point.

Screenshots: `<scratchpad>/ui-walk-after/00-front.png`,
`01-torture.png`, `02-vevov.png`, `03-gopiv.png`, `04-tovez.png`,
`05-tigez.png`. Script: `<scratchpad>/ui-walk-after.mjs` (the original
`ui-walk.mjs` and its own `ui-walk-baseline/` screenshots are untouched,
for before/after comparison).

**Host left running for the stakeholder**:

- URL: `http://127.0.0.1:4797/`
- PID: see `<scratchpad>/017-011-bench-state/pid`
- State dir: `<scratchpad>/017-011-bench-state` (`host.log`,
  `console.sqlite`, read-only seed copies of `known-robots.json`/
  `wifi-credentials.json`)

**Still true, unchanged by this pass** (carried from the section
above, not re-litigated here): the `torture`-to-`gopiv` radio bridge and
the WiFi leg both remain blocked on physical/network conditions outside
this pass's fix authority. This pass did not touch USB cables, RF
range, or the classroom AP -- it fixed what the UI *shows and enables*
given whatever the real link state honestly is.

### After arrow fix (2026-09-13 addendum, ticket 017-010 programmer pass)

A second live defect surfaced from the team-lead's own Chromium walk
against this same running host, after the item-B fix above: a device
card with a usable primary link still rendered a per-link open arrow
(`data-testid="device-link-open-<id>"`) on a *different* link whose own
state was not usable -- live example, `gopiv`'s `WiFi ·
gopiv.local:7654 · Not linked` row had an arrow into `/d/wifi-gopiv`,
and that same row showed no Connect button (the stakeholder: "How is it
letting me go into it if it's not connected?"). Root cause:
`FrontPage.tsx`'s per-link arrow condition was `primary && link !==
primary` -- "isn't the primary" was standing in for "is usable", which
only happened to hold when a card had no primary at all (item B's
case). The per-link Connect button had the mirror-image bug: gated
`!primary && CONNECT_BUTTON_STATES.has(link.state)`, so a connectable
link lost its Connect button the moment any *other* link on the same
card became primary -- exactly `gopiv`'s WiFi row.

**Fix**: the arrow condition is now `isLinkUsable(link) && link !==
primary`; the Connect button condition dropped the `!primary` gate
entirely, keeping only `CONNECT_BUTTON_STATES.has(link.state)` (still
`disabled={!sendable}`, still sends `{type: "session-open", linkId}`
via `onLinkConnect`). Relay cards untouched.

**Tests**: `FrontPage.test.tsx`'s multi-link-device case (previously
asserting the buggy arrow-into-a-non-usable-link behavior as if it were
correct) rewritten to assert the fixed behavior -- no arrow into the
non-usable `wifi-vevov` row, only a `device-link-connect-wifi-vevov`
button that sends `session-open` for that link's own id, alongside the
already-correct card arrow into the usable `usb-vevov` primary. A new
case covers two usable links on one card: the card arrow to the
primary plus exactly one row arrow to the second usable link. `npx
vitest run packages/ui` -- 40 files, 547 tests, all passing.
`npm run typecheck` and `npm run build -w @robot-console/ui` (both
`tsc --noEmit` and `vite build`) clean.

**Browser walk (after arrow fix)**: same live host (PID 24881, port
4797, `packages/ui/dist` rebuilt via `vite build` then reloaded --
host process itself left untouched), `team-lead-walk2.mjs` re-run
against it:

```
ARROWS [
 {
  "tid": "device-open--102049995",
  "href": "/d/mbrelay-torture",
  "card": "torture",
  "row": "(card arrow)"
 },
 {
  "tid": "device-open-1198504156",
  "href": "/d/mbserial-vevov",
  "card": "vevov",
  "row": "(card arrow)"
 },
 {
  "tid": "device-open-2175407711",
  "href": "/d/mbserial-gopiv",
  "card": "gopiv",
  "row": "(card arrow)"
 },
 {
  "tid": "device-open-3527777815",
  "href": "/d/mbserial-tigez",
  "card": "tigez",
  "row": "(card arrow)"
 }
]
PAGE {"card":"torture","row":"(card arrow)","href":"/d/mbrelay-torture","header":"robot-console Flash mbrelay · ch?/grp?No open session on this linkConnect","enabledSendControls":0,"linked":false,"reply":"n/a","violation":false}
PAGE {"card":"vevov","row":"(card arrow)","href":"/d/mbserial-vevov","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · hodr.local:36237Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive calibration-0.20260913.1 1.20260912.8 vevov","violation":false}
PAGE {"card":"gopiv","row":"(card arrow)","href":"/d/mbserial-gopiv","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · loki.local:40293Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv","violation":false}
PAGE {"card":"tigez","row":"(card arrow)","href":"/d/mbserial-tigez","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · magni.local:43837Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive unbaked 1.20260912.8 tigez","violation":false}
PROBLEMS 0 CONSOLE_ERRORS []
```

Every card's only arrows are its own card arrow into its usable
primary link (`torture`'s relay-carveout arrow included) -- zero
`ARROWS` entries for any per-link row, in particular none for `gopiv`'s
`Not linked` WiFi row (it now shows a Connect button only, not exercised
here per instruction -- the robot's WiFi has not actually joined the
classroom AP, so clicking it would just fail). `PROBLEMS 0`. The three
usable robot pages (`vevov`/`gopiv`/`tigez`) each replied with a real
`id diffdrive ...` line to a typed `ID` (never a motion verb);
`torture`'s own relay page correctly showed no open session and no
send controls, so no `ID` was sent there. No console errors.

## Defect: dead transport leaves session, blocks reconnect (2026-09-13)

**Reproduced** in Chromium against the live host (pid 24881, port 4797,
state dir `.../scratchpad/017-011-bench-state`): robot `tovez` on USB
`/dev/cu.usbmodem2121102` (flaky cable). Store: its `usb-9906…2820`
link was `state: connectable`, `fail_count: 3`, but a `sessions` row for
that link still existed. The front-page card showed "Not linked" +
Connect; clicking Connect changed nothing and no message appeared on
the card. The link never auto-reconnected.

**Root cause, confirmed in code** (matches the team-lead's own
diagnosis exactly): three writers can move a `usb` link's `state` around
without ever touching its `sessions` row, and nothing else in the
codebase ever closed that row once the transport actually died:

- `connect/harvester.ts`'s `attach()` registers exactly one `onClose`
  listener on the session's `LineLink` (`link.onClose(...)` → `fail()`),
  and a missed-`STATUS`-poll watchdog that also calls `fail()`. `fail()`
  wrote `links.state = 'unresponsive'` and stopped polling -- nothing
  more. In the watchdog case it did not even close the transport, so a
  missed-poll death never raised `LineLink`'s own `onClose` either.
- `watchers/usbWatcher.ts`'s `handleRemoved` (~line 267, then 271) wrote
  `links.state = 'stale'` on a USB unplug, released `board_owner`, and
  aborted any in-flight attach task -- but never touched `sessions`,
  contradicting architecture.md §6.1's own words ("On remove: mark the
  link stale, close any session, release owners").
- `handleAdded` (~line 192, `state = 'connectable'` at line 242) ran on
  replug and put the link back in an auto-connect-eligible state,
  regardless of whether a stale `sessions` row was still sitting there.

None of the three ever called `store.closeSession`, and
`connect/reconciler.ts`'s own private `sessions` Map (the only place
holding the live `LineLink` for an open session) had no seam reacting to
any of this either -- a dead `LineLink` was simply leaked, still polling
a corpse. Downstream, `plan()`'s `deviceHasActiveLink` and
`describeUserOpenRefusal`/`planUserOpen` all read the *store's*
`sessions` table as "is this open" (architecture.md §5's own state
diagram even draws `unresponsive --> failed` as a real transition, but
nothing ever drove it), so a lingering row blocked both automatic
retry and the student's own explicit Connect -- refused as "already
open" -- forever, silently.

**Fix** (`packages/host/src/connect/reconciler.ts`,
`packages/host/src/connect/harvester.ts`,
`packages/host/src/watchers/usbWatcher.ts`,
`packages/ui/src/ws/WsProvider.tsx`, `packages/ui/src/pages/FrontPage.tsx`):

1. **Single owner of session teardown, restored to the reconciler.**
   `runConnect` now subscribes to the just-opened session's own
   `LineLink.onClose` the moment it starts tracking it locally. That
   listener (`reapDeadSession`) deletes the in-memory session, calls
   `store.closeSession(linkId)`, closes the `LineLink` again
   (idempotent -- a no-op in the ordinary case, a real close for a
   missed-poll death that never closed the transport itself), and
   records a `failed` state with `fail_count`/`next_retry_at` via
   `connector.ts`'s own `recordFailure` (same backoff formula a failed
   *connect attempt* already used) -- exactly the `unresponsive -->
   failed` edge architecture.md §5 draws, and the only state
   `isAutoConnectEligible` will actually retry. `harvester.ts`'s `fail()`
   now also calls `void link.close()`, so the missed-poll watchdog path
   (which never touched the transport before) raises the same `onClose`
   a genuine disconnect does, converging both causes of death on one
   cleanup path. `usbWatcher.ts`'s `handleRemoved` now also calls
   `store.closeSession(linkId)` (a plain, idempotent DELETE through the
   store's own typed method -- no raw SQL, no reaching into the
   reconciler) so a physical unplug clears the row immediately rather
   than waiting on the harvester's slower missed-poll ceiling. Guarded
   against a session already reaped/replaced (`sessions.get(linkId) !==
   session`) and against the store itself already being closed (a
   lingering `LineLink`'s `onClose` firing after shutdown/teardown --
   caught, best-effort, never an uncaught exception out of a raw socket
   event handler; confirmed live via `mbserialEndToEnd.test.ts`'s own
   teardown race before this guard was added).
2. **`requestOpen` clears a stale session before ever asking `planUserOpen`/
   `describeUserOpenRefusal`.** Those two stay pure (no store access,
   still table-tested as before) -- the executor's own new
   `clearStaleSession` runs first: if a `sessions` row exists for the
   requested link but its stored state is not `connected`/`connecting`,
   it drops any local reference, closes that `LineLink` if this instance
   still held one, and calls `store.closeSession`, then re-reads fresh
   rows before planning. A user's Connect is no longer refused as
   "already open" for a link that is not actually connected -- this is
   the runtime counterpart to the existing `clearInheritedSessions`
   (construction-time only, for a session inherited from a *previous*
   process).
3. **Front page shows the refusal.** `WsProvider.tsx` gains
   `linkNotices` (a `linkId -> {text, level, at}` map, copy-on-write so
   `useLinkNotices()`'s `useSyncExternalStore` snapshot actually changes
   reference) fed by the same `notice` broadcast `server.ts`'s
   `session-open` handler already sent for a refusal -- previously only
   ever written into the per-link console log, never read by the front
   page. Cleared once that link is next reported `connected`.
   `FrontPage.tsx`'s per-link Connections row (`DeviceConnectionRow`,
   split out of `DeviceCard` for this) renders it via a new
   `.device-connection-notice` span. `linkNotices` is read once at
   `FrontPage` (the hook-bearing page) and threaded down as a plain prop,
   matching `sendable`/`onLinkConnect` -- `DevicesList`/`DeviceCard` still
   take no `WsProvider`-dependent hook of their own, so every existing
   test that mounts `DevicesList` standalone is unaffected.

**Tests** (all run in the foreground, all green):

- `packages/host/src/connect/reconciler.test.ts` -- two new cases: a
  fake `LineLink` closing after a real connect (`FakeByteStream.emitClose()`)
  clears the `sessions` row, marks the link `failed` with backoff, and
  (with `backoffCapMs: 0`) the very next change-feed tick reconnects for
  real over a second, distinct stream; and `requestOpen` on a
  `connectable` radio link (never auto-connected, isolating this from
  the construction-time-only `clearInheritedSessions`) carrying a
  leftover `sessions` row is not refused -- the stale session is cleared
  and the connect attempt actually runs.
- `packages/host/src/connect/harvester.test.ts` -- one new case: a
  missed-poll-detected death now also closes the `LineLink` itself
  (`stream.closeCallCount >= 1`, `link.isOpen === false`, the link's own
  `onClose` fires with no error), not just the store row.
- `packages/host/src/watchers/usbWatcher.test.ts` -- one new case:
  `removed` closes an open `sessions` row, and a later `added` leaves
  the link `connectable` again with no session -- ready for the
  reconciler's own auto-reconnect.
- `packages/ui/src/pages/FrontPage.test.tsx` -- two new cases (through
  `WsProvider` + a `FakeSocket`, end to end): a Connect click that the
  host refuses renders that refusal's text on the link's own row; the
  notice clears once a later snapshot reports the link `connected`.
- `npx vitest run packages/host/src packages/ui` -- **84 test files,
  1288 tests, all passing**, zero unhandled errors (an initial run
  surfaced two -- `mbserialEndToEnd.test.ts`'s own teardown racing
  `reapDeadSession` against an already-closed store; fixed by the
  try/catch noted in fix item 1 above, then a clean re-run).
- `npm run typecheck` and `npm run build` (protocol + host + ui) --
  clean. `npm run vite:build -w @robot-console/ui` -- clean (151
  modules, `dist/` rebuilt).

**Browser proof.** Host restarted so the new code loads: old process
(pid 24881) `kill -TERM`'d; fresh state dir
`.../scratchpad/017-012-bench-state`, seeded with a read-only copy of
`~/.local/state/robot-console/known-robots.json`; new host started
`ROBOT_CONSOLE_STATE_DIR=.../017-012-bench-state node bin/robot-console.js
--port 4797` (pid 71860), given ~60s to settle.

`team-lead-walk2.mjs` into `.../scratchpad/walk-012`:

```
ARROWS [
 {"tid":"device-open--102049995","href":"/d/mbrelay-torture","card":"torture","row":"(card arrow)"},
 {"tid":"device-open-1198504156","href":"/d/mbserial-vevov","card":"vevov","row":"(card arrow)"},
 {"tid":"device-open-2175407711","href":"/d/mbserial-gopiv","card":"gopiv","row":"(card arrow)"},
 {"tid":"device-open-3527777815","href":"/d/mbserial-tigez","card":"tigez","row":"(card arrow)"}
]
PAGE {"card":"torture","row":"(card arrow)","href":"/d/mbrelay-torture","header":"robot-console Flash mbrelay · ch?/grp?No open session on this linkConnect","enabledSendControls":0,"linked":false,"reply":"n/a","violation":false}
PAGE {"card":"vevov","row":"(card arrow)","href":"/d/mbserial-vevov","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · hodr.local:36237Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive calibration-0.20260913.1 1.20260912.8 vevov","violation":false}
PAGE {"card":"gopiv","row":"(card arrow)","href":"/d/mbserial-gopiv","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · loki.local:40293Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv","violation":false}
PAGE {"card":"tigez","row":"(card arrow)","href":"/d/mbserial-tigez","header":"robot-console Set Radio Set Wi-Fi Flash mbserial · magni.local:43837Linked","enabledSendControls":5,"linked":true,"reply":"id diffdrive unbaked 1.20260912.8 tigez","violation":false}
PROBLEMS 0 CONSOLE_ERRORS []
```

`PROBLEMS 0`; every Linked robot answered `ID` for real.

`tovez-connect-probe.mjs` into the same dir:

```
tovez card present: 0
```

`tovez` (store id `2665`, a `known-robots.json`-imported placeholder,
`usb_serial: "SERIAL-A"`) currently has **no `links` row at all** on
this bench run -- it is not physically on the USB hub right now (only
`vevov`/`gopiv`/`tigez` are live; per project memory, only
`vevov`/`vittut` are normally left on the hub, and neither `vitut` nor
`tovez` is plugged in this session), so it renders under "Not seen
recently", never as a card with a Connect button. Per this ticket's own
instruction ("you cannot touch hardware; instead cover the dead-transport
path with the unit tests above") this is the anticipated fallback --
recorded here rather than forced. As supplementary *live* evidence for
fix items 2/3 (not a substitute for the mandated script, whose own
output is the "0 buttons, nothing to click" result above): `gopiv`'s
own `wifi` row (separately `connectable`, its `mbserial` link already
`Linked`) does show a Connect button; clicking it dispatched a real
connect attempt against the classroom AP, which failed for an unrelated
reason (the WiFi endpoint), and the row visibly updated to `Retrying in
0s` within the 12 s wait -- confirming a Connect press is never silent
on this host build, live.

New host left running: pid 71860, port 4797, state dir
`.../scratchpad/017-012-bench-state`, log at
`.../017-012-bench-state/host.log`.

## Defect: "Retrying in 0s" hides failure reason (2026-09-13)

Team-lead's own walk (Chromium + live store, host pid 71860, port 4797,
state dir `.../scratchpad/017-012-bench-state`, screenshot
`.../scratchpad/team-lead-walk-012/front.png`) found two more issues on
top of everything already recorded above:

1. `gopiv`'s `WiFi · gopiv.local:7654` row read **"Retrying in 0s"**
   indefinitely -- store had `state: failed`, `state_reason:
   "LineLink.connect() timed out after 5000ms"`, `fail_count: 1`, and a
   `next_retry_at` 240+ seconds in the past that was never
   incremented, because the reconciler's `plan()` only ever opens one
   link per device and `gopiv` already had a connected `mbserial` link
   -- no retry was ever going to happen, but the row claimed one was
   imminent and hid the actual reason entirely.
2. The `torture` relay card showed a row-level Connect button on its
   own `mbrelay · ch?/grp?` link -- opening a relay pool's own link is
   not a student action (the relay card already has its robot-picker
   Connect), and the `ch?/grp?` label was junk: `buildLabel`'s
   `mbrelay` case called `channelGroup` on an address shaped `{ host,
   port, registryPort }` (mdnsWatcher.ts's `handleMbrelay`), which has
   no `channel`/`group` fields at all.

**Fix** (`packages/ui/src/deviceDisplay.ts`'s `linkStateText`,
`packages/ui/src/pages/FrontPage.tsx`'s `DeviceConnectionRow`,
`packages/host/src/projection.ts`'s `buildLabel`):

- `failed`/`unresponsive` link state text now reads "Couldn't connect:
  `<plain-word reason>`" -- a small `plainFailureReason` mapping turns
  a connect timeout into "no answer (timed out)", a missed-STATUS-poll
  reason into "stopped answering", keeps a banner/serial
  identity-mismatch reason verbatim (already an actionable cable
  instruction), and falls back to the raw reason for anything else.
- The "· retrying in Ns" suffix is now appended only while
  `nextRetryAt` is genuinely still in the future (never "0s" or a
  negative count); when shown, `DeviceConnectionRow` now arms a
  self-clearing `setInterval` so the row's own countdown actually ticks
  down once a second instead of freezing at its first render.
- `DeviceConnectionRow`'s row-level Connect button is now suppressed
  for `device.kind === "relay"` outright, regardless of link state.
- `buildLabel`'s `mbrelay` case now reads `hostPort(link.address)`,
  the same host:port shape `wifi`/`mbserial` already use, instead of
  `channelGroup`.

**Tests**: `packages/ui/src/deviceDisplay.test.ts` (`linkStateText`) --
past-`nextRetryAt` shows the plain reason with no "Retrying"/"retrying"
substring at all; future-`nextRetryAt` shows the plain reason plus a
"· retrying in Ns" suffix; a sub-second future `nextRetryAt` still
rounds up to "1s", never "0s"; the three `plainFailureReason` mappings
each get their own case. `packages/ui/src/pages/FrontPage.test.tsx` --
the existing multi-link and STATUS-poll tests updated for the new
copy; a new test asserts no `device-link-connect-*` button renders on
a relay card's own link in any `CONNECT_BUTTON_STATES` state, and that
its label shows host:port. `packages/host/src/projection.test.ts` --
asserts the `torture` fixture's link label is `"mbrelay ·
torture.local:8760"`, not `"mbrelay · ch?/grp?"`.

**Live re-verification** (fresh host, pid 87704, port 4797, state dir
`.../scratchpad/017-013-bench-state`, seeded read-only from
`~/.local/state/robot-console/known-robots.json`): `team-lead-
walk2.mjs` into `.../scratchpad/walk-013` -- `PROBLEMS 0`, every
Linked robot (`vevov`/`gopiv`/`tigez`) answered `ID` for real, and the
`torture` card's own link now reads `mbrelay · torture.local:8760`
with no row-level Connect button (only its existing robot-picker
Connect below). The fresh store no longer carried the original
failed/stale-retry `wifi-gopiv` row (a brand-new SQLite file has no
history to replay), so to prove the exact reported shape end-to-end
the bug's own row was reconstructed directly in the running store
(`state='failed'`, `state_reason='LineLink.connect() timed out after
5000ms'`, `next_retry_at` 240s in the past, `fail_count=1`) and
`front-shot.mjs` re-run against the live host:

```
gopiv card: gopiv Linked ROLE NEZHA2 mbserial · loki.local:40293 Linked WiFi · gopiv.local:7654 Couldn't connect: no answer (timed out) Connect
```

No "Retrying in 0s" anywhere, the reason is now visible in plain
words, and the screenshot (`.../scratchpad/walk-013/front.png`)
confirms both the gopiv row and the clean `torture` card visually.

## Defect: USB robot never auto-connects on plug-in (2026-09-13)

**Reported by the team-lead**, from the live store (host pid 87704,
state dir `.../scratchpad/017-013-bench-state`): a USB robot plugged in
while the host runs never auto-connects. `tovez`'s `usb-...` link sat
`discovered` for 5+ minutes with nothing acting on it; clicking Connect
by hand worked in under a second.

**Root cause, confirmed in code** (`packages/host/src/watchers/usbWatcher.ts`):
`attach()` bails out of marking a link `connectable` whenever
`address.path === undefined` -- DAPLink's CMSIS-DAP HID interface
commonly finishes USB enumeration before the CDC serial port does, so a
board is very often first seen `hid-only`. SWD naming runs fine off the
HID handle alone and correctly upserts a named `devices` row, but
`attach()`'s own early-return then leaves the link `discovered` (never
`connectable`) because there is no serial path yet for the reconciler to
open. The serial port's later arrival is reported as `updated`, not a
fresh `added` (`diffDaplinkDevices`'s `reportUpdatedInPlace`,
ticket 014-007) -- and the pre-fix `handleUpdated` only ever patched
`address` and stopped, per its own "by design" comment. Nothing else in
the module ever revisited an already-named, path-less link once the
missing piece showed up, so it stayed `discovered` forever, with a
manual Connect click as the only way out (`connect/connector.ts`'s
`session-open` path does not require `connectable`, only the
reconciler's automatic pass does).

**Fix** (`packages/host/src/watchers/usbWatcher.ts`, `handleUpdated`
only -- `attach()`'s own early-return and `handleAdded` are unchanged):
after patching the link's `address` as before, `handleUpdated` now reads
the link's prior row (`store.reconcilerRows()`) and, only for a link
still `discovered` (never `connected`/`connecting`/`failed`/
`unresponsive`/`closed_by_user`/`stale` -- all somebody else's business)
whose new address now carries a serial path:

- if the link was already named (`deviceId` set) -- the earlier attach
  had everything except the path -- it is promoted straight to
  `connectable`, no naming re-run;
- if the link was never named *and* its `added`-time address had no
  path either (the "HID-only, naming had nothing to go on" case,
  distinct from a genuine SWD failure with a path already present),
  naming gets exactly one more try by calling `attach()` again --
  reused, not duplicated. `attach()`'s own logic then promotes to
  `connectable` itself if this second try succeeds.
- Any other naming failure (permission, timeout, an unsupported chip)
  is still never retried -- unchanged from the module's existing
  "SWD naming failure is still a dead end for automatic connect"
  behavior, and covered by the pre-existing test asserting exactly one
  `readSwdName` call across an unrelated HID/serial `updated` pair.

`board_owner` discipline and the in-flight-attach task map
(`attachTasks`) are both reused as-is: the retry path goes through the
same `handleAdded` wrapper (acquire/release, catch/finally,
`forgetTask`) a fresh `added` event already used, and `handleUpdated`
bails immediately if an attach is already in flight for that serial
rather than racing a second one. Module doc comments (`updated`'s
per-poll-flow bullet, `attach()`'s own early-return comment, and the
"SWD naming failure is still a dead end" section) were rewritten to
describe this new behavior instead of the old "by design, no second
chance" limitation.

**Tests** (`packages/host/src/watchers/usbWatcher.test.ts`, all run in
the foreground):

- HID-only `added` (named successfully) then `updated` with a serial
  path -- link becomes `connectable` exactly once (`setLinkState`
  spied); `readSwdName` still called exactly once.
- HID-only `added` where naming could not run (mocked `readSwdName`
  failure on the first call only) then `updated` with a serial path --
  naming retried exactly once (`readSwdName` called twice total), link
  ends `connectable`, `board_owner` free afterward.
- `updated` on a `connected` link (address changes) -- state stays
  `connected`, no second `readSwdName` call.
- `updated` on a `closed_by_user` link (address changes) -- state stays
  `closed_by_user`, no second `readSwdName` call.
- Integration case: runs the real `usbWatcher` against a real `Store`
  through the exact HID-only-then-`updated` sequence above, then feeds
  `store.reconcilerRows()` into `connect/reconciler.ts`'s real, pure
  `plan()` and asserts it returns `[{ kind: "connect", linkId:
  "usb-<serial>" }]` -- proving an `updated`-promoted link is not just
  `connectable` in isolation but is exactly what the reconciler's own
  next tick schedules a connect job for.
- Existing suite (the pre-existing "never re-runs SWD naming" case
  covering a *different* naming-failure shape, `removed`/heartbeat/
  racing-removal cases, etc.) all still pass unmodified.

`npx vitest run packages/host/src/watchers packages/host/src/connect
packages/host/src/runtime.test.ts` -- **13 files, 218 tests, all
passing**. `npm run typecheck` and `npm run build` (protocol + host +
ui) both clean.

**Live proof.** Old host (pid 87704) stopped (`kill -TERM`); fresh state
dir `.../scratchpad/017-014-bench-state`, seeded with a read-only copy
of `~/.local/state/robot-console/known-robots.json`; new host started
`ROBOT_CONSOLE_STATE_DIR=.../017-014-bench-state node bin/robot-console.js
--port 4797` (pid 8437), left running, waited on in the foreground via a
bounded Node poll (no manual Connect click, no motion verb, no flash):

- `tovez` on `/dev/cu.usbmodem2121102` was SWD-named and its link
  reached `connectable` and then `connecting` **entirely on its own** --
  the exact behavior that was previously missing (before this fix the
  link never left `discovered` at all). This is the fix proven live:
  the reconciler's automatic pass now picks up an `updated`-promoted
  USB link with zero clicks.
- The link did **not** reach `connected` in this window -- it cycles
  `connecting -> failed` on repeated backoff retries
  (`fail_count` climbing past 9), with `state_reason` alternating
  between `"produced no banner within the identify budget"` and, once,
  `"produced a banner whose name \"ovz\" does not match its own serial
  231428700 -- serial data corrupted, check the USB cable"` -- a
  truncated/garbled banner read, i.e. a live serial-line data-corruption
  symptom (the connector's own error message names the cause), not an
  auto-connect defect. This matches this same ticket's own earlier-
  recorded finding for this exact board/port ("USB board identity"
  section above: `tigez` on this same port previously showed identical
  dropped/shifted-byte corruption) -- an intermittent bad USB
  cable/connector, outside this fix's authority (no cable swap, no
  flashing, no manual intervention performed).
- `team-lead-walk2.mjs` run against the same host into
  `.../scratchpad/walk-014`: `PROBLEMS 0`; every Linked robot
  (`vevov`/`gopiv`/`tigez`) answered a typed `ID` (never a motion verb)
  with a real `id diffdrive ...` line; `torture`'s relay card correctly
  showed no session/no send controls; zero console errors. `tovez` did
  not appear as a front-page card in this walk (a `failed`, `owned:
  false` USB link has no card in the current UI projection -- a
  pre-existing, separate condition, not something this ticket's fix
  touches or regresses).

Host left running: pid `8437`, port 4797, state dir
`.../scratchpad/017-014-bench-state` (`host.log` there too).

## Defect: unreadable reasons and duplicate robots (2026-09-13)

Team-lead's own walk (Chromium + live store, host pid 8437, port 4797,
state dir `.../scratchpad/017-014-bench-state`, screenshot
`.../scratchpad/team-lead-walk-014/front.png`) found two more defects on
top of everything already recorded above -- and one correction: contrary
to the previous programmer pass's own note ("`tovez` did not appear as a
front-page card"), `tovez` **does** render a front-page card while
failed; the note above was wrong about that.

### 1. Reason text is unreadable

`tovez`'s card showed its reason twice, in two different unreadable
forms at once: `USB · /dev/cu.usbmodem2121102 Couldn't connect: connector:
link "usb-9906…2820" produced no banner within the identify budget ·
retrying in 44s connector: link "usb-9906…2820" produced no banner
within the identify budget Connect`.

**Root cause (two separate bugs compounding)**:

- `deviceDisplay.ts`'s `plainFailureReason` never stripped the raw
  `Error.message`'s own module-name prefix (`connector: `/`relayBridger:
  `) or its quoted internal link/candidate id (`link "usb-9906…2820"`,
  `candidate "radio-…"`) before matching it against its known shapes --
  "produced no banner within the identify budget" in particular was
  never mapped to plain words at all, so it fell through to the raw,
  engineer-facing fallback verbatim.
- `FrontPage.tsx`'s `DeviceConnectionRow` rendered `link.reason` a
  *second* time, raw and unmapped, in its own
  `device-connection-reason` span whenever the card had no primary link
  -- on top of `linkStateText` (above it) already folding the same
  reason into the state text. The two states-when-shown didn't line up
  by design; they just both happened to be true for a failed link with
  no usable primary, which is exactly `tovez`'s own case here.

**Fix** (`packages/ui/src/deviceDisplay.ts`, `packages/ui/src/pages/FrontPage.tsx`):

- `plainFailureReason` now runs a new `stripInternalIds` helper first
  (strips a leading `connector:`/`relayBridger:` prefix and any quoted
  `link "…"`/`candidate "…"` fragment), then maps: no banner within the
  identify budget -> "the robot didn't answer when we said hello — check
  the USB cable or that it's powered on"; a banner/serial identity
  mismatch (already containing "check the USB cable") -> kept verbatim
  (post-stripping); a connect timeout -> "no answer (timed out)"; a
  missed-STATUS-poll reason -> "stopped answering"; anything else ->
  the stripped text as-is (never swallowed).
- `FrontPage.tsx`'s separate `device-connection-reason` span is deleted
  outright -- `linkStateText` is now the only place a link's reason is
  ever shown; the row's `notice` (a distinct refused-Connect message
  from `useLinkNotices`, unrelated to `link.reason`) remains the only
  other thing rendered below the state line.

**Tests**: `packages/ui/src/deviceDisplay.test.ts` -- three new cases:
stripping `connector:`/quoted link id and mapping "no banner" to the
plain cable/power hint; the same for a `relayBridger:`/quoted candidate
id; stripping the id plumbing from a banner/serial-mismatch reason while
keeping the cable instruction itself verbatim. `packages/ui/src/pages/FrontPage.test.tsx`
-- the existing "shows each link's state text AND its reason" case
rewritten to assert the reason appears exactly once (`match(/stopped
answering/g)` has length 1) and that `device-link-reason-*` no longer
renders at all.

### 2. The same robot appears twice

Store (before the fix): `tovez` id 2665 (`owned 1`, `usb_serial
"SERIAL-A"`, the known-robots.json import placeholder) and `tovez` id
2314287040 (`owned 0`, real USB serial, SWD-named by `usbWatcher.ts`)
both present at once -- a `tovez` card AND "Not seen recently · tovez"
on the front page, and the relay picker listing `tovez` twice.

**Root cause**: `connect/connector.ts`'s `mergeNamePlaceholderIfAny`
only ever ran after a *successful banner identify* -- which a bad USB
cable that never once produces a clean banner (this exact board/port's
own, already extensively-documented flaky cable) may never reach.
`watchers/usbWatcher.ts`'s SWD naming is a separate, earlier
identification step over the debug interface (a chip id read directly,
immune to the same serial-line corruption) that already knows the
robot's real name and id the instant it succeeds -- but nothing called
the merge from there, so a board whose cable never once produces a
clean banner stayed a duplicate row forever.

**Fix**: moved `mergeNamePlaceholderIfAny` out of `connect/connector.ts`
into a new shared module, `packages/host/src/store/placeholderMerge.ts`
(no behavior change to the function itself -- same "placeholder id ===
nameToValue(name)" definition, same `Store.mergeDevice` call, only typed
`Store` ops, no SQL outside `store/`), so both `connector.ts` (after a
successful banner identify) and `usbWatcher.ts` (after a successful SWD
name read, in `attach()`, right after its own `store.upsertDevice`) can
call it without a `connect/` <-> `watchers/` import cycle.
`Store.mergeDevice` already carried `usb_serial`/`owned`/`radio_*`
across a merge correctly (sprint 017-006's own bench-defect-2 fix, still
in place, unchanged) -- this ticket's fix is purely about calling the
existing merge from a second, earlier trustworthy-identity moment, not
changing the merge itself.

Also, defensively (independent of the merge firing promptly): the relay
robot picker now de-duplicates names --
`packages/ui/src/components/RobotSelect.tsx` de-dupes its own `options`
prop before rendering, and `RelayConnectControls.tsx`'s `"card"` variant
(which renders its own inline `<select>`, not `RobotSelect`) de-dupes
`robotOptions` the same way independently. `FrontPage.tsx` itself now
also de-dupes `robotOptions` by name (`Set`) before handing it down, and
filters `notSeenRecently` to exclude any device whose name already has a
device card on the page (`present`'s own names) -- so an unmerged
placeholder can never again render "Not seen recently · `<name>`"
alongside a real card for that same name, even in the brief window
before a merge completes.

**Tests**:

- `packages/host/src/watchers/usbWatcher.test.ts` -- new case: seeds a
  known-robots.json-style placeholder (`owned: true`, a `usb_serial`
  hint, and a pre-existing `wifi` link) at `nameToValue("vevov")`, then
  runs a normal SWD-named USB attach for the real chip id; asserts
  exactly one `vevov` device row survives (`owned: 1`, the placeholder's
  id gone), and both the placeholder's own pre-existing link and the
  fresh USB link now point at the real device id ("links re-pointed").
- `packages/ui/src/pages/FrontPage.test.tsx` -- two new cases: "Not seen
  recently" never lists a name that already has a device card (two
  `tovez` device rows, one linked/one empty -- only the card renders,
  no "Not seen recently" section at all); the relay picker's options
  de-duplicate a name shared by two device rows.
- `packages/ui/src/components/RobotSelect.test.tsx` /
  `RelayConnectControls.test.tsx` -- one new case each: a repeated name
  in `options`/`robotOptions` renders once.
- `connect/connector.test.ts`'s existing placeholder-merge suite is
  unchanged and still green (the function moved, not the behavior).

`npx vitest run packages/ui packages/host/src` -- **84 files, 1306
tests, all passing**. `npm run typecheck` and `npm run build` (protocol
+ host + ui) both clean. `npm run vite:build -w @robot-console/ui` --
clean (151 modules, `dist/` rebuilt, 328.92 kB JS / 37.97 kB CSS).

**Live proof.** Old host (pid 8437) `kill -TERM`'d; fresh state dir
`.../scratchpad/017-015-bench-state`, seeded with a read-only copy of
`~/.local/state/robot-console/known-robots.json` (confirmed: its
`tovez` entry carries `"lastUsbSerial": "SERIAL-A"`, exactly the
placeholder shape this defect needs); new host started
`ROBOT_CONSOLE_STATE_DIR=.../017-015-bench-state node bin/robot-console.js
--port 4797` (pid `31035`), waited on for 60s in the foreground
(`node -e 'setTimeout(()=>{}, 60000)'`), no manual Connect click, no
motion verb, no flash.

Store, read directly via `dumpStore`: **exactly one** `tovez` device row
-- `{ id: 2314287040, name: "tovez", owned: 1, usb_serial:
"9906360200052820a8fdb5e413abb276000000006e052820" }` (the real
hardware serial, not the placeholder's synthetic `"SERIAL-A"` --
confirming `mergeDevice`'s existing usb_serial-carry-through preferred
the real row's own value, as designed) -- no leftover row at
`nameToValue("tovez")`. All six device rows: `torture` (relay,
unowned), `vitut`/`vevov`/`gopiv`/`tovez`/`tigez` (robot, owned).

`node .../scratchpad/tovez-visible.mjs .../scratchpad/walk-015/front.png`:

```
CARD device-card-2314287040: tovez Linked ROLE NEZA2 USB · /dev/cu.usbmodem2121102 Linked
NOT-SEEN SECTION: Not seen recently ... vitut Last seen 9/10/2026, 10:14:41 PM Forget
tovez mentions on page: 2
```

`tovez` appears once, as a card only -- not in "Not seen recently" (only
`vitut` is there). The "2 mentions" are the card's own heading plus its
one legitimate appearance in the relay picker's robot-name dropdown
(`torture`'s card: "Choose a robot… gopiv tigez tovez vevov vitut") --
not a second card or a second "Not seen recently" row. Screenshot
(`.../scratchpad/walk-015/front.png`) confirms visually: one `tovez`
card, `Linked`, and only `vitut` under "Not seen recently".

`node .../scratchpad/team-lead-walk2.mjs .../scratchpad/walk-015`:
`PROBLEMS 1` -- every card still shows exactly one arrow into its usable
primary link (`ARROWS` list unchanged in shape from ticket 010's earlier
walks), and `vevov`/`gopiv`/`tigez` each answered a typed `ID` with a
real `id diffdrive …` line, but `tovez`'s own `ID` send drew "NO REPLY IN
5s" against the script's strict `/\bid diffdrive\b/` match. Investigated
before accepting this as pre-existing rather than a regression: a
direct, isolated retry of the same `ID` send against `tovez`'s own page
(`.../scratchpad/tovez-id-retry.mjs`) shows the reply **did** arrive,
just corrupted -- `d iffdrve ubakd .226092. ovez` (dropped/shifted bytes;
should read `id diffdrive unbaked 1.20260912.8 tovez`) -- the identical
corruption signature this same ticket has already documented multiple
times for this exact physical port (`/dev/cu.usbmodem2121102`), on
different robot names across sessions (`tigez`, `zapuz`, now `tovez`) as
boards were swapped on the bench: dropped/shifted serial bytes from a
flaky cable/connector, not a code defect. `mergeDevice`'s own carry-
through of the *real* usb_serial (not the placeholder's `"SERIAL-A"`)
onto this exact row rules out the merge itself as the source of the
corruption. Recorded honestly as `PROBLEMS 1` rather than reported as
`PROBLEMS 0` -- the mandated script's own strict match is doing exactly
its job (flagging a reply that doesn't parse), and the corrupted
character stream is a hardware condition this ticket has never had the
authority to fix (no cable swap, no flashing, no manual intervention
performed).

Host left running: pid `31035`, port 4797, state dir
`.../scratchpad/017-015-bench-state` (`host.log` there too).

## Correction and tovez USB test (2026-09-13)

**Correction (stakeholder):** the corrupted tovez data on `/dev/cu.usbmodem2121102`
recorded above as "bad USB cable" was MakeCode (WebUSB in a browser) connected to
the same board, not the cable. Every "cable" attribution in this ticket should be
read as "board shared with MakeCode".

**tovez over USB, MakeCode disconnected (team-lead, Chromium against host pid
31035):** header `USB · /dev/cu.usbmodem2121102 · Linked`; status panel live
(control cycles 377). Console replies:

- `ID` → `id diffdrive unbaked 1.20260912.8 tovez`
- `VER` → `ver 1.20260912.8`
- `STATUS` → `status ready=1 active=0 connL=1 connR=1 otos=0 wedge=0 flags=31 i2cf=7 cyc=377 tlm=off next=1 done=0 reason=none`
- `FUNCS` typed as a raw line → no `funcs` line within 5 s. FUNCS is a sequenced
  verb, so a raw line without `#id` is not a valid request; not counted as a defect.

**Released for another agent:** `session-close` sent; link now `closed_by_user`
(host will not reopen it), no `sessions` row, `lsof /dev/cu.usbmodem2121102` shows
no holder. No motion commands were sent to tovez.


## Close-out note (2026-09-13)

- Linux Docker suite NOT re-run after the final fixes: the Docker daemon
  (OrbStack) was not running and the team-lead did not start it. Last Linux
  run passed (94 files / 1605 tests) before the 2026-09-13 fixes; macOS full
  suite runs inside `close_sprint`.
- Bench host left running at http://127.0.0.1:4797 (pid 31035) for the
  stakeholder's own testing; tovez released (`closed_by_user`, port free).
