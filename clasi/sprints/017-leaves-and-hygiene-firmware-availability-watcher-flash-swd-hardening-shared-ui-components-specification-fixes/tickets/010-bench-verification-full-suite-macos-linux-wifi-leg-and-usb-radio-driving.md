---
id: '010'
title: 'Bench verification: full suite (macOS + Linux), WiFi leg, and USB/radio driving'
status: in-progress
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
- [ ] A robot advertising `_robotlink` connects over WiFi and answers a
      command (carried item 1 from sprint 016 ticket 008). **Blocked at
      bench time** — see Bench evidence: all three `_robotlink`-
      advertising robots (`tigez`/`gopiv`/`tovez`) timed out on connect;
      firmware telemetry shows none has actually joined the WiFi AP.
      Carried forward again.
- [ ] The stakeholder physically drives a robot over USB (carried item
      2a). Staged, not performed by this agent — see "What the
      stakeholder must do next".
- [ ] The stakeholder physically drives a robot over radio via a relay
      (carried item 2b). Staged, not performed by this agent — see
      "What the stakeholder must do next".
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

## What the stakeholder must do next

The host is left **running** (per Part 4 — not stopped by this
ticket) at:

- **URL**: `http://127.0.0.1:4797/`
- **PID**: `94480`
- **State dir**: `/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/017-010-bench-state`
  (`host.log`, `console.sqlite`, and the read-only seed copies of
  `known-robots.json`/`wifi-credentials.json` are there)

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
