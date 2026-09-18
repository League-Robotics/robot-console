---
id: 009
title: 'Full-sprint verification gate: bench harness re-run and end-to-end MCP tool
  surface smoke test'
status: done
use-cases:
- SUC-001
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
github-issue: ''
issue:
- mcp-server-for-robot-connections.md
- bench-relay-port-contention-sweeper-vs-session.md
- bench-wifi-robot-discovery-waits-for-announcement.md
- harvester-has-no-teardown-seam.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Full-sprint verification gate: bench harness re-run and end-to-end MCP tool surface smoke test

## Description

Sprint exit gate, mirroring sprint 018 ticket 011's role: not new
feature work, but the point where every prior ticket's evidence is
assembled and re-checked together, on the real bench where hardware
permits. Depends on every other ticket in this sprint.

Three things this ticket must produce:

1. **Carry-over defect re-verification** against the current bench
   roster: ticket 001's relay-lease-takeover fix (hardware-conditional —
   requires a physically attached USB relay, absent as of 2026-09-17),
   ticket 002's WiFi on-demand discovery fix (`tigez` as the fixture,
   `gopiv`/`vevov` reconfirmed or explicitly recorded as still
   unreachable), and ticket 003's harvester teardown regression test
   (already covered by ticket 003's own unit test — this ticket's job
   is to confirm it's still green after everything else in the sprint
   landed, not to re-derive it).
2. **End-to-end MCP tool surface smoke test**: inspect → connect/
   command → drive (executes immediately, no approval step) → flash
   (executes immediately, no approval step), run against a fake/in-
   memory store per the host's existing test convention (per
   `sprint.md`'s Test Strategy), plus a live smoke test against a real
   running host if a real MCP client is available to drive it. Per
   `sprint.md`'s Architecture Revision, tickets 006-008 dropped the
   `pending_actions`/approval design this criterion originally
   referenced — there is no Approve/Deny/expire to simulate. What this
   ticket verifies instead: `request_drive`/`request_flash` reach the
   robot/board immediately, and each executed call is durably recorded
   in `agent_actions` with correct attribution.
3. **Sprint 018 carry-forward item**: UC-016's radio-via-host-attached-
   relay failover path, unverified at 018's close purely because no USB
   relay was attached. Verify it now if a relay is attached at execution
   time; if not, state so explicitly and carry it forward again rather
   than silently dropping it.

## Acceptance Criteria

- [x] `scripts/bench/run.sh` is re-run on a genuinely exclusive bench
      (no `npm run dev`, no concurrent harness run — verified via `lsof`
      the way the harness already checks); the report is attached/cited
      in this ticket's closing notes.
- [x] Ticket 001's relay-lease-takeover fix: verified against a
      physically attached USB relay if one is available at execution
      time; if not, this criterion is marked explicitly
      unverified-hardware-absent, with the date, not silently checked
      off. **Marked unverified-hardware-absent, 2026-09-18** — see
      Verification below.
- [ ] Ticket 002's WiFi fix: `tigez` passes Layer 3 across at least ten
      consecutive runs (per ticket 002's own criterion) — cite the
      report rows here rather than re-deriving new evidence.
      `gopiv`/`vevov` reachability is reconfirmed at execution time.
      **Not met — 2 pass / 8 fail across 10 valid runs, 2026-09-18. Not
      checked off; recorded and routed (not silently accepted) — see
      Verification below and the updated issue
      `bench-wifi-robot-discovery-waits-for-announcement.md`.**
      `gopiv`/`vevov` reachability *is* reconfirmed (still unreachable
      over WiFi specifically; both reachable over mbserial/radio).
- [x] Ticket 003's harvester regression test is confirmed still green
      after every other ticket's changes (a full scoped run of
      `connect/harvester.test.ts` and `runtime.test.ts`, not a re-audit).
- [x] An end-to-end scripted test exercises, against a fake store:
      `list_devices` → `open_session` → `send_command STATUS` →
      `request_drive {verb, fields}` → confirm the extracted
      `sendCommand` function was called immediately, with no
      intermediate state and no wait, and that the fake session/robot
      actually received the verb → confirm exactly one `agent_actions`
      row was written with the correct `kind: 'drive'`, `caller`,
      verb/fields, and `executed_at` → `close_session`; and separately,
      `request_flash {deviceId, firmwareRef}` → confirm the extracted
      `startFlash` function was called immediately → confirm the `flash`
      snapshot overlay carried `origin: 'mcp'`/`caller` for the
      operation's duration → confirm exactly one `agent_actions` row was
      written with `kind: 'flash'` and correct attribution. Both paths
      also confirm a rejected call (a non-allowlisted verb, malformed
      fields, an unflashable target) never reaches `sendCommand`/
      `startFlash` and writes no `agent_actions` row.
- [x] If a real MCP client is available (e.g. Claude Code itself, via a
      temporary `.mcp.json` entry pointed at a locally running `npx
      robot-console`), a live smoke test connects, lists devices, and
      calls `get_device_status` for at least one real robot; documented
      manually in this ticket's closing notes. Not blocking if no client
      is conveniently available at execution time — state so explicitly.
- [x] Sprint 018's UC-016 (radio-via-host-attached-relay failover) is
      verified if a USB relay is attached at execution time; otherwise
      explicitly recorded as still-carried-forward, with the date, for
      whichever future sprint next has bench access to a relay.
      **No USB relay attached at any point during this verification
      session (2026-09-18) — carried forward again.**
- [x] `docs/design/architecture.md` gains a consolidated section for the
      MCP subsystem (transport, tool categories, the audit/visibility
      mechanism, the new `agent_actions`/`sessions` columns),
      synthesizing tickets 004-008's design rather than restating
      `sprint.md`'s own Architecture section verbatim — per the
      `consolidate-architecture` convention this project already
      follows sprint-over-sprint.
- [x] One full `npm test` run happens as part of `close_sprint`'s own
      pre-close gate (per `.claude/rules/source-code.md`) — this ticket
      does not itself run the full suite; it names the scoped test files
      above.

## Verification (programmer, 2026-09-18)

All evidence (reports, stdout logs, screenshots, MCP client scripts) is
kept in the session scratchpad, not deleted:
`/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/6bf21790-2015-49cb-920c-f51e1b81fc20/scratchpad/019-009/`.

**Bench re-check at start**: `_mbserial._tcp`/`_mbflash._tcp` advertise
`gopiv`, `tigez`, `tovez`, `vevov`; `_mbrelay._tcp` advertises `torture`;
`_robotlink._tcp` advertises `vevov` and `tigez`. No USB serial device
attached at any point this session (`ls /dev/cu.usbmodem*` empty,
`system_profiler SPUSBDataType` shows no DAPLink/micro:bit device),
re-checked at both the start and the end of the session.

**Mid-run topology change**: partway through, `tigez`'s mbserial bridge
moved from `naught.local:44511` to `magni.local:36491` (a deliberate
stakeholder change, relayed mid-task and independently re-verified via
a fresh `dns-sd -B`/`-L` probe before acting on it, per this project's
own prompt-injection caution — the claim was verified true, not taken
on faith). No prior observation in this ticket's own evidence was
discarded because of it; the harness runs below span both addresses
and the host picked the new one up correctly for mbserial (list_devices
showed `mbserial-tigez` → `magni.local:36491`, `reason:
"process-restarted"`, immediately usable).

**1. Bench harness**: `scripts/bench/run.sh` full run →
`bench-report.md` (cited path above). Result: **6 pass, 1 defect, 2
environment, 0 skipped, 1 contention** (sprint 018's baseline: 6 pass,
2 defect, 2 environment, 0 skipped, 0 contention — same total
defect+contention count, different composition; not a clear
regression). The one defect: `tigez / wifi` failed Layer 3 ("no
live-snapshot link of transport 'wifi' found for 'tigez'") — the same
shape as the carry-over item below. One minor report-generation
oddity noticed but not chased down (out of this ticket's scope): the
`tovez / mbserial` row is labeled `contention` even though its own
reason text says "not ERR busy either" and the report's own "Holders /
skips" section says no resource was held at Layer 1 run time — worth a
future look at `scripts/bench/report`'s labeling rule, not fixed here.

**2. Carry-over: ticket 002's WiFi fix, ten-run criterion.** Fixture
chosen by property (only `tigez` currently shows a live WiFi banner
match; `gopiv`/`vevov` both fail WiFi-by-name resolution —
`ENOTFOUND`). **Result: 2 pass / 8 fail across 10 valid,
`scripts/bench/run.sh` runs** (2 further attempts were refused outright
by the harness's own exclusivity check due to *other, unrelated*
sessions transiently holding `gopiv`'s or `tovez`'s bridge port —
neither started nor signaled by this session, both cleared within
seconds on their own, neither counted). Full per-run reports/logs:
`tigez-wifi-run-{1,2,4,5,6,7,8,9,10,12}.{md,stdout.log}`, summarized in
`tigez-wifi-10run-summary.log`. **This criterion is not met** — full
detail, and why this is not a fix-here-at-the-gate job (a structural,
intermittent async-discovery race), is in the updated issue
`bench-wifi-robot-discovery-waits-for-announcement.md`, carried forward
to the next sprint with bench access. Layer 1's own raw probe (the
harness's direct-TCP workaround for this exact gap) passed 10/10 — the
robot's WiFi radio itself was reachable the whole time; the defect is
specifically that the host's own live link/snapshot doesn't reliably
reflect that.

**3. Ticket 003 harvester regression**: `npx vitest run
packages/host/src/connect/harvester.test.ts
packages/host/src/runtime.test.ts` → **2 files, 38 tests, all passing**.
Still green after every other ticket's changes.

**4. End-to-end MCP tool surface (fake store)**:
`packages/host/src/mcp/endToEnd.test.ts` (new) exercises the real
production wiring (`createDefaultMcpServer`) against one real
`:memory:` store: `list_devices` → `open_session` → `send_command
STATUS` → `request_drive WHEELS_V` (confirms immediate `sendCommand`
call, exactly one `agent_actions` row with correct
kind/caller/verb/fields/executedAt) → `close_session`; separately
`request_flash` (confirms immediate `startFlash` call with the
`{origin: 'mcp', caller}` overlay, exactly one `agent_actions` row);
plus negative-space cases (a non-allowlisted drive verb, malformed
drive fields, an unflashable target) confirming no wire call and no
audit row. **5/5 passing.** Full scoped run including this file plus
every other `mcp/**/*.test.ts` and the harvester/runtime files: **9
files, 141 tests, all passing.** `npm run typecheck`: clean (exit 0).

**5. Live MCP client smoke test** (goes beyond the written criterion's
minimum, per the dispatch brief's own "must cover" list): a real
`@modelcontextprotocol/sdk` 1.30.0 `Client` +
`StreamableHTTPClientTransport` (not a fake) against a real,
freshly-started `robot-console` host on the real production state dir
(`/Users/eric/.local/state/robot-console`), port 4900. Scripts:
`mcp-live-client.mjs`, `mcp-live-drive.mjs`, `mcp-live-drive-output.log`.
Connected, listed all seven tools, called `list_devices` and
`get_device_status`, then against `tigez` (mbserial,
`magni.local:36491` — 100% reliable across every harness run this
session): `open_session` → `send_command STATUS` → **`request_drive
WHEELS_V [80, 80, 800]`** → wire reply `"WHEELS_V 80 80 800 #1"`, no
error → `send_command STATUS` again → `request_flash`-style negative
check via `request_drive ESTOP` (correctly rejected, directing to
`send_command`) → `close_session`. Exactly one `agent_actions` row was
written: `{kind: "drive", caller:
"019-009-live-drive-verification", params: {verb: "WHEELS_V", fields:
[80,80,800]}, result: "sent"}` — durable (still present in
`get_device_status` moments later) and correctly attributed; the
session's own `origin`/`caller` flipped to `"mcp"`/the caller name for
the call's duration, exactly as `FrontPage.tsx` reads it. **What this
does and does not prove**: the wire command was validated, wrote to the
real serial line, and was acknowledged with no error, through the exact
same `sendCommand` path the UI's own drive controls use (the same path
100+ harness passes this session already proved moves real robots).
This environment has no camera, so the actual physical wheel rotation
was not independently visually confirmed — that specific bit (motion
literally seen) is the one piece of criterion 3 in the dispatch brief
this session cannot close on its own. No board was flashed again during
this verification (per the dispatch brief's explicit instruction);
`request_flash`'s own client-timeout behavior is already filed and
unchanged (`clasi/issues/mcp-flash-outlives-client-timeout.md`).

**6. Browser walk** (headless Chromium via `playwright-core`, against
the same live host): screenshots in the scratchpad, none deleted.
  - `walk-01-frontpage-full.png` / `walk-02-frontpage-tigez-agent-popover.png`
    — ticket 005's `Agent: <caller>` label, confirmed live: hovering
    tigez's mbserial chip on the front page shows a popover reading
    "Bridge / mbserial · magni.local:36491 / Linked / Agent:
    019-009-screenshot-agent" (an MCP session opened via
    `mcp-open-for-screenshot.mjs` and left open for this screenshot,
    then closed via `mcp-close-screenshot-session.mjs`).
  - `walk-03-tigez-diagnostics-full.png` /
    `walk-04-tigez-recent-agent-activity-populated.png` — ticket 006's
    "Recent agent activity" (`data-testid="recent-agent-activity"`),
    populated case: shows both the `drive` row from step 5 above
    (`019-009-live-drive-verification`, "WHEELS_V 80 80 800 — sent")
    and ticket 008's own `flash` row (`ticket-008-live-verification`,
    "flash — sent"), each with a timestamp.
  - `walk-05-gopiv-diagnostics-full.png` /
    `walk-06-gopiv-recent-agent-activity-empty.png` — the empty case, on
    a device no agent has touched: "No agent activity recorded for this
    device yet." — no stray box, no spinner.
  - **Not captured**: ticket 006's flash-overlay attribution on
    `FlashControls` (`link.flash.origin === "mcp"`) is ephemeral,
    server-side-only state that exists only for the duration of an
    in-flight flash — capturing it live would require triggering a real
    flash, which the dispatch brief explicitly forbids repeating ("do
    not flash a board again just to test this"). Verified instead via
    `endToEnd.test.ts`'s own assertion that `startFlash` is called with
    exactly `{origin: "mcp", caller}` (`FlashControls.tsx:324-335` reads
    that same shape) and via code citation in
    `docs/design/architecture.md` §13.4 — a deliberate scope
    substitution, not an oversight.

**7. UC-016 (host-attached-relay failover) and ticket 001
(relay-lease-takeover)**: both hardware-conditional on a physically
attached USB relay. None was attached at any point in this session
(re-checked at start, middle, and end). Both marked
unverified-hardware-absent / carried-forward, dated 2026-09-18, per
this ticket's own acceptance-criteria wording — not silently checked
off.

**8. `docs/design/architecture.md`** gains new §13 ("MCP subsystem
(sprint 019)"), consolidating tickets 004-008's transport, tool
category, audit/visibility, and no-approval-step design, plus a
verification-note subsection citing this ticket's own evidence.

**Verdict**: six of this sprint's seven use cases (SUC-001, 003, 004,
005, 006, 007) are demonstrated live, not merely coded — real hardware,
a real MCP client, a real browser. SUC-002 (WiFi on-demand discovery)
is coded and unit-tested but **not** reliably demonstrated live — it
fails the majority of the time against the one robot with a live WiFi
path, a finding this gate exists to surface, now routed to a carried-
forward issue rather than accepted quietly. Two items (ticket 001,
UC-016) remain hardware-blocked, explicitly recorded rather than
skipped.

## Implementation Plan

**Approach**: assemble and cite evidence from every prior ticket, run
the harness fresh, write the new integration-style end-to-end test, and
write the consolidated architecture doc update. This ticket should
produce no substantial new production code beyond what wiring the
end-to-end test reveals is missing (if the end-to-end test finds a real
gap between tickets, fix it here and note why it wasn't caught earlier).

**Files to create**:
- An end-to-end test file, e.g. `packages/host/src/mcp/
  endToEnd.test.ts`, covering the full inspect → connect → drive
  (immediate execution) → flash (immediate execution) path against a
  fake store, including `agent_actions` attribution at each step.

**Files to modify**:
- `docs/design/architecture.md` — new MCP subsystem section.
- `scripts/bench/README.md` if the harness needs any note about the new
  MCP surface (likely not required — the harness tests the WS/UI path,
  not MCP — but confirm during implementation rather than assuming).

**Testing plan**:
- Scoped `vitest` run: the new end-to-end test, plus
  `connect/harvester.test.ts`/`runtime.test.ts` (re-confirm ticket 003),
  `mcp/**/*.test.ts` (re-confirm tickets 004-008) — not the full suite.
- Bench harness run per the acceptance criteria above, with hardware
  preconditions stated explicitly where unmet.
- Full `npm test` is `close_sprint`'s own job, not this ticket's.

## Documentation Updates

- `docs/design/architecture.md`: new consolidated MCP subsystem section
  (see Acceptance Criteria).
- `sprint.md`'s own Architecture/Use Cases sections stay as the
  sprint-scoped record; the consolidated doc update here is what carries
  the design forward past this sprint, per this project's existing
  `consolidate-architecture` pattern.
