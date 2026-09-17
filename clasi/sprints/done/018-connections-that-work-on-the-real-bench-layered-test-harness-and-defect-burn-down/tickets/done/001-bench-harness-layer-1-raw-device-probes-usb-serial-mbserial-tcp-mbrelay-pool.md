---
id: '001'
title: 'Bench harness Layer 1: raw-device probes (USB serial, mbserial TCP, mbrelay
  pool)'
status: done
use-cases:
- SUC-001
depends-on: []
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 1: raw-device probes (USB serial, mbserial TCP, mbrelay pool)

## Description

First ticket of the harness the whole sprint depends on (SUC-001). Build
`scripts/bench/layer1/` — a set of scripts that talk to every discovered
device **directly, with no host process involved**, per the issue's own
Layer 1 definition:

- **USB serial**: enumerate DAPLink devices the same way `usbWatcher.ts`
  does (read the SWD chip id, open the serial port, send `HELLO`, read
  the banner reply). This is read-only probing, not a replacement for
  the watcher.
- **mbserial TCP**: for each known farm bridge host:port (`loki`,
  `magni`, `hodr` or whatever the bench config names), connect over TCP,
  send `HELLO`/`ID`, and specifically detect and report `ERR busy`
  distinctly from a timeout/no-banner.
- **mbrelay pool**: connect to the pool's TCP endpoint (e.g.
  `torture.local:8760`), run the command-plane probe (`> HELLO`) and,
  separately, the full data-plane handshake (`!ECHO OFF`, `!MODE
  RAW250`, `!CG <ch> <grp>`, `!P 7`, `!GO` → `# entering data plane`,
  then `HELLO`/`ID`) against known robot addresses, exactly matching the
  team-lead's verified live-bench sequence.

Output: a structured (JSON) per-device, per-path reachability result
that Layers 2 and 3 (tickets 002-003) consume to decide what to attempt.
This ticket also builds the **exclusivity check**: before running
anything, use `lsof` to detect a process (e.g. `npm run dev`) already
holding a relevant USB/TCP port and refuse to run, saying which
process/port it is.

Never sends a motion/drive verb. Never flashes firmware.

## Acceptance Criteria

- [x] `scripts/bench/layer1` runs standalone (no host process, no UI)
      and produces a machine-readable (JSON) reachability report: one
      entry per device × path with pass/fail and, on failure, the raw
      reason (e.g. `ERR busy`, `timeout`, connection refused).
- [x] USB serial probe: `HELLO`/`ID` round-trip works against at least
      one real board on the bench (e.g. a relay-flashed board) with the
      banner captured verbatim.
- [x] mbserial probe: distinguishes `ERR busy` from a plain timeout in
      its reported reason (this distinction is what ticket 008 later
      relies on to fix the host's own busy handling).
- [x] mbrelay probe: demonstrates the full working handshake
      (`!ECHO OFF` … `!GO` → `HELLO`/`ID`) against the real `torture`
      pool for at least one radio-reachable name (`vevov` or `gopiv`,
      per this sprint's bench facts), matching the team-lead's manually
      verified sequence byte-for-byte in the captured transcript.
- [x] The harness refuses to run when `lsof` shows a relevant port held
      by another process (simulate by starting `npm run dev` or holding
      a port with `nc`, and confirm the harness exits with a clear
      message naming the process).
- [x] **Harness command and evidence**: `node scripts/bench/layer1/run.js
      --out /tmp/bench-layer1.json` (or the actual entry point built)
      run against the real bench; the resulting JSON/log is attached to
      this ticket's completion notes as Layer 1 evidence, since Layers
      2/3 do not exist yet for this ticket to cite as the acceptance
      discipline's "report row" — this ticket's own acceptance is its
      Layer 1 output being correct and evidenced, checked by the
      sprint-planner's own criteria for the harness issue.

## Completion Notes (2026-09-13)

**Implementation**: `scripts/bench/layer1/{types,exclusivity,dnsResolve,
lineReassembler,tcpLineSession,usbProbe,mbserialProbe,wifiProbe,
mbrelayProbe,mdnsBrowse,knownNames,registry,index}.ts`,
`scripts/bench/README.md`, `scripts/tsconfig.json`. `vitest.config.ts`
extended to include `scripts/**/*.{test,spec}.{ts,tsx}`; root
`package.json` gained `bench:layer1` script and `bonjour-service`/
`serialport` devDependencies (already transitively installed via
`@robot-console/host`, now declared explicitly for `scripts/`'s own
use). Root `typecheck` script extended with
`tsc --noEmit -p scripts/tsconfig.json`.

**Tests**: 75 passed across 11 files (`npx vitest run scripts/bench`),
covering every pure parser/classifier (banner/busy/DBG/radio-passthrough
classification, DNS-resolve timeout/error handling, the exclusivity
check against real captured `lsof` output, known-robots.json parsing,
CLI arg parsing) against captured byte sequences and fixtures — no live
hardware in the suite. `npm run typecheck` (extended with
`scripts/tsconfig.json`) is clean.

**Live bench evidence** (real bench, 2026-09-13, `--skip-held` run —
`/dev/cu.usbmodem2121102` (tovez) held by the stakeholder's `npm run dev`,
pid 82496, throughout):

| device | path | status | reason |
|---|---|---|---|
| vitut | usb | pass | relay banner + `?` status reply captured (`DEVICE:RADIOBRIDGE:relay:vitut:2198604104`) |
| (usb, unnamed board) | usb | fail | timeout waiting 3000ms for a HELLO banner |
| (tovez, usb) | usb | skipped | held by pid 82496 (node) |
| gopiv | mbserial | pass | banner + ID matched (`device NEZHA2 robot gopiv 2175407711` / `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`) |
| vevov | mbserial | pass | banner + ID matched (`device NEZHA2 robot vevov 1198504156` / `id diffdrive calibration-0.20260913.1 1.20260912.8 vevov`) |
| tigez | mbserial | fail | timeout waiting 3000ms for a HELLO reply (no banner, not ERR busy either) |
| gopiv | mbserial-contention | pass | second client correctly received ERR busy while first client's session was open |
| torture | radio-via-mbrelay:torture (pool status) | pass | pool answered `?` with `# channel: 0 group: 10 mode: RAW250 power: 7` |
| gopiv, vevov | radio-via-mbrelay:torture (sweep) | pass | radio pass-through HELLO answered |
| tigez, tovez, vitut | radio-via-mbrelay:torture (sweep) | fail | timeout: no radio reply (name likely unreachable via this pool) |
| gopiv | radio-via-mbrelay:torture (full data-plane) | pass | full data-plane handshake succeeded (`device NEZHA2 robot gopiv 2175407711` / `id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv`) |
| vevov | radio-via-mbrelay:torture (full data-plane) | pass | full data-plane handshake succeeded (`device NEZHA2 robot vevov 1198504156` / `id diffdrive calibration-0.20260913.1 1.20260912.8 vevov`) |

Full JSON:
`/private/tmp/claude-501/-Volumes-Proj-proj-league-projects-microbit-robot-console/2adee9e5-9c06-4d70-bfc8-e8df62ded3f1/scratchpad/bench-layer1.json`

Verbatim `vevov` torture data-plane transcript (the required byte-for-byte
demonstration):

```
+0ms    [tx]   !ECHO OFF
+518ms  [rx]   DEVICE:RADIOBRIDGE:relay:gozop:4267970133
+524ms  [rx]   # echo: OFF
+524ms  [tx]   !MODE RAW250
+530ms  [rx]   # mode: RAW250
+530ms  [tx]   !CG 37 43
+631ms  [rx]   # channel: 37 group: 43 mode: RAW250 power: 7
+631ms  [tx]   !P 7
+638ms  [rx]   # channel: 37 group: 43 mode: RAW250 power: 7
+638ms  [tx]   !GO
+644ms  [rx]   # entering data plane
+644ms  [info] entered data plane -- HELLO/ID answered unprefixed from here
+644ms  [tx]   HELLO
+674ms  [rx]   device NEZHA2 robot vevov 1198504156
+3646ms [tx]   ID
+3676ms [rx]   id diffdrive calibration-0.20260913.1 1.20260912.8 vevov
```

**Default refusal demonstration** (no `--skip-held`, same held resource):

```
[bench:layer1] REFUSING to run -- another process already holds a resource this run needs:
/dev/cu.usbmodem2121102 held by pid 82496 (node)
Pass --skip-held to probe everything else and mark these resources 'skipped' instead.
```
(exit code 1)

**Contradictions with the pre-supplied bench facts, found and fixed
during this ticket's own live evidence run — investigated, not papered
over**:

1. **Exclusivity check initially missed the held USB port entirely.**
   `serialport.list()` reports the darwin `tty.` (dial-in) path, but
   `npm run dev` (and this harness's own `usbProbe.ts`) opens the `cu.`
   (callout) path — two different device nodes for the same physical
   port. Checking `lsof` on the `tty.` path silently reported "free" for
   a port that then failed to open with `EBUSY`. Fixed: the exclusivity
   check now converts every USB path to its callout form before asking
   `lsof` about it (`index.ts`).
2. **`!CG 0 10` (the ticket's own "restore to defaults" instruction)
   cannot be built via `@robot-console/protocol`'s
   `buildSetChannelGroupLine`** — that builder validates a channel/group
   pair is a well-formed *derived* radio address (channel odd in
   [25, 73], group in [1, 126] excluding 10) and correctly throws for
   `(0, 10)`, which is the pool's own idle/default tuning, not a derived
   address. Fixed: the restore step now builds the raw `!CG 0 10` wire
   line directly, bypassing that (correct, for its own purpose)
   business validation — Layer 1 must be able to send exactly what the
   wire accepts, not only what the higher-level abstraction considers
   well-formed.
3. **The mbrelay data-plane handshake's `HELLO`/`ID` ordering is
   genuinely flaky over the real radio hop**, not just "the first HELLO
   sometimes gets no reply" as the pre-supplied facts described: across
   repeated live runs, either `HELLO` or `ID` (never predictably which)
   occasionally got no reply at all — consistent with ordinary radio
   packet loss, not a protocol defect. A strictly sequential
   wait-for-this-reply-before-sending-the-next implementation
   intermittently failed the acceptance criterion for this reason alone.
   Fixed: `probeMbrelayDataPlane` now alternates `HELLO`/`ID` up to 6
   times (stopping as soon as both a banner and an id reply have been
   seen), which is what produced the clean, single-attempt transcript
   above on the run recorded here.
4. **A crash, not a contradiction**: names that reach the radio sweep
   from other sources (a USB board's own serial number, used as a
   fallback device name when its banner never arrives; the mbrelay
   pool's own name, e.g. `torture`) are not well-formed five-letter
   micro:bit names, and `nameToRadioAddress`/`nameToValue` throw for
   those. Fixed by filtering the sweep's candidate-name list to the
   `^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$` shape before resolving any
   radio address.

No contradiction found in: the `.local` hostname resolve-by-IPv4
requirement (all four hosts resolved to IPv4 in single-digit
milliseconds in this run — no ~5s stall reproduced this session, though
the bound and reporting this ticket adds stays in place regardless);
the mbserial `ERR busy` distinction (reproduced cleanly via the
single-client contention demonstration); or the `torture`
vevov/gopiv-reachable, tovez/tigez/vitut-unreachable radio-address
pattern (matches the registry's own `/names/<name>` responses and the
sweep results exactly).

## Implementation Plan

**Approach**: pure Node/TypeScript scripts under `scripts/bench/layer1/`,
reusing the *shape* of existing protocol-layer helpers from
`packages/protocol` where possible (e.g. banner-line parsing) but not
importing host internals — Layer 1 must exercise the wire, not the
host's code paths, so a host bug is never masked by sharing its parser.

**Files to create**:
- `scripts/bench/layer1/usbProbe.ts`
- `scripts/bench/layer1/mbserialProbe.ts`
- `scripts/bench/layer1/mbrelayProbe.ts`
- `scripts/bench/layer1/exclusivity.ts` (the `lsof`-based check, shared
  by Layers 2/3 too)
- `scripts/bench/layer1/index.ts` (runs all three, writes JSON)
- `scripts/bench/README.md` (how to run the harness, its exclusivity
  requirement, and its three-layer shape)

**Files to modify**: none in `packages/*` — this ticket is additive.

**Testing plan**: a small `vitest` suite for the exclusivity check
(mock `lsof` output) and for each probe's parsing logic against
captured byte sequences (not live hardware, for CI); the live-hardware
run itself is this ticket's bench evidence, run by hand against the
real devices.

**Documentation updates**: `scripts/bench/README.md` documents the
exclusivity requirement and how to run Layer 1 alone.
