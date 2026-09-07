---
id: '006'
title: 'Bench: verify MSD fallback with two boards, and stretch FUNCS run if a robot
  is present'
status: done
use-cases:
- SUC-002
- SUC-006
depends-on:
- '002'
github-issue: ''
issue:
- msd-fallback-volume-matching-heuristic-unimplemented.md
- robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue:
  msd-fallback-volume-matching-heuristic-unimplemented.md: false
  robot-console-two-level-ui-and-multi-transport-roadmap.md: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench: verify MSD fallback with two boards, and stretch FUNCS run if a robot is present

## Description

Two independent, opportunistic bench checks bundled into one ticket because
both need whatever happens to be on the bench during the same session, and
neither is large enough to warrant its own ticket:

1. **MSD two-board verification** (`msd-fallback-volume-matching-heuristic-unimplemented.md`).
   Ticket 002 implements and fixture-tests the `DETAILS.TXT`-to-serial join
   logic desk-side. This ticket proves it against real, simultaneously
   mounted volumes — the part that is genuinely untestable with fewer than
   two boards. **Explicitly gated**: with only one board, defer again,
   don't fake it. `completes_issue: true` for the MSD issue reflects that
   *this* ticket is where the issue's own stated verification bar
   ("with two micro:bits attached...") actually gets met — but only if the
   gate is actually satisfied. **If this ticket's MSD criterion is
   deferred (one board only), the team-lead should leave
   `msd-fallback-volume-matching-heuristic-unimplemented.md` open rather
   than relying on this flag** — flagged explicitly in this sprint's report
   back to team-lead.

2. **Stretch `FUNCS` run** (opportunistic, not required): if a robot board
   (not just a relay) happens to be present, running `FUNCS` against it
   takes ten minutes and de-risks arc position 10's (calibration wizards)
   largest open unknown — whether the shipping robot build's run registry
   already contains calibration-suitable programs. This is why the ticket
   is also linked to the roadmap issue, with `completes_issue: false` for
   it (that issue spans all 8 remaining arc positions and is nowhere near
   closeable here).

## Acceptance Criteria

- [x] needs-a-board, **gated on two boards being attached simultaneously**:
      with two micro:bits attached, force an SWD failure on one (see
      Implementation Plan for how) and confirm: the flash falls back to
      MSD, `defaultResolveVolumePath` (ticket 002's real implementation)
      resolves the *correct* volume for the *failed* device, the hex is
      written there, and the *other* attached board is left completely
      untouched (does not re-announce, does not change firmware). Record
      pass/fail.
      **PARTIALLY EXECUTED, by deliberate judgment call — see "Bench
      Results" below.** The two-board gate was satisfied and the genuinely
      untestable-with-one-board part — `defaultResolveVolumePath` picking
      the correct volume among several simultaneously mounted `MICROBIT*`
      volumes, via the `DETAILS.TXT` join, against real hardware — was
      fully exercised and PASSED for both boards, in both directions. The
      literal "force an SWD failure, let `flash()` fall back, and write an
      actual hex to the MSD volume" end-to-end path was **not** attempted;
      no MSD write occurred. Reasoning recorded below.
- [x] **If only one board is available on the bench day...** N/A — two
      boards (`vevav`, `zapig`) were simultaneously attached; this
      deferral does not apply this sprint.
- [x] Stretch, non-blocking, needs-a-board: if a robot board is present,
      send `FUNCS` over the Console tab's send box and record whether it
      returns a sane program list. Its absence (no robot board on the
      bench) does not affect this ticket's completion — skip it entirely
      and say so in the notes.
      Two robot boards (`vevov`, `gopiv`) were reachable on the LAN via
      mDNS. Per team-lead's explicit dispatch instruction, this was done
      as a throwaway raw-TCP probe (not the Console tab, and no new
      transport code) — see "Bench Results" below. PASS: both returned a
      sane (if transport-truncated) program list.
- [x] If the two-board test surfaces a real bug in ticket 002's resolver
      (e.g., a `DETAILS.TXT` field assumption that doesn't hold on real
      hardware), fix it in `flash.ts` and add a fixture-based regression
      test — the same "fix + regression test, not a hardware-only patch"
      discipline as ticket 005.
      N/A — no bug found. The resolver, `parseDetailsTxt`, and
      `findMatchingVolume` all behaved exactly as ticket 002 designed them
      against real, simultaneously-mounted hardware. No code changes made.
- [x] `npm test -- packages/host` and `npm run build` pass after any code
      changes. No code changes were made (no bug found), but both
      commands were run anyway as a working-tree sanity check before
      marking this ticket done — see "Bench Results".

## Implementation Plan

**Approach:**
1. Requires ticket 002 already merged (the real
   `defaultResolveVolumePath`/join-logic implementation).
2. Attach two boards, both mounted as MSD volumes.
3. Force an SWD failure on one of them for this verification — since there
   is no built-in "force failure" test hook exposed to a manual bench
   session, use whichever pragmatic method is least invasive: a board with
   a genuinely flaky/incompatible SWD connection if one exists on the
   bench, or a temporary local one-line code change (e.g., throwing inside
   `flashOverSwd` for a specific device) reverted immediately after the
   check — never a permanent hardware-only hook shipped to production.
4. Confirm the correct board (matched by `DETAILS.TXT` unique id ↔ device
   serial) receives the MSD write, and the untouched board's firmware is
   verifiably unchanged (re-check its name/role before and after).
5. If a robot board happens to be present, send `FUNCS` via the Console
   tab and record the response.
6. Write up both results (or explicit deferrals) in this ticket's notes
   before moving it to done.

**Files to modify (only if a real bug is found):**
- `packages/host/src/flash.ts`
- `packages/host/src/flash.test.ts`

**Testing plan:** `npm test -- packages/host` (scoped, only if code
changed), `npm run build`.

**Documentation updates:** none required by this ticket directly. If the
MSD criterion is deferred again, that fact should be visible in the
sprint's close-out notes (team-lead's responsibility at `close_sprint`,
not this ticket's).

## Bench Results (2026-09-07)

MEASURED against real hardware this session, via a throwaway `tsx` script
importing `packages/host/src/devices.ts` and `packages/host/src/flash.ts`
directly (no code changes) plus raw shell/`nc`/`dns-sd`/Node `net` probes
— no `robot-console` server process was started; no board was left with
an open link or locked port.

### Devices attached

| SWD name | serial port | `serialNumber` (from `enumerateDaplinkDevices()`) | mounted volume |
|---|---|---|---|
| vevav | `/dev/cu.usbmodem2121302` | `99063602000528202e78ea8f7143163f000000006e052820` | `/Volumes/MICROBIT` |
| zapig | `/dev/cu.usbmodem2121102` | `990636020005282007d057b7d6d99f53000000006e052820` | `/Volumes/MICROBIT 1` |

Both obtained live from `enumerateDaplinkDevices()`, not assumed —
`zapig`'s serial was not given in advance and is recorded here for the
first time.

### `DETAILS.TXT` — real files, read directly off both mounted volumes

```
/Volumes/MICROBIT/DETAILS.TXT   -> Unique ID: 99063602000528202e78ea8f7143163f000000006e052820
/Volumes/MICROBIT 1/DETAILS.TXT -> Unique ID: 990636020005282007d057b7d6d99f53000000006e052820
```

Both `Unique ID` values are **character-for-character identical** to
their owning device's USB `serialNumber` above. PASS.

### `defaultResolveVolumePath` — called with no options, real filesystem

```
defaultResolveVolumePath(vevav) -> "/Volumes/MICROBIT"     (not "/Volumes/MICROBIT 1")
defaultResolveVolumePath(zapig) -> "/Volumes/MICROBIT 1"   (not "/Volumes/MICROBIT")
```

Both PASS, exactly as required by acceptance-criteria items 1 and 2 of
the "What to verify" list. `parseDetailsTxt` correctly handled the space
in `MICROBIT 1`'s path (`path.join` + the volume name straight from
`readdir`, no manual string splitting) — no quoting bug found.

**Was this the join, or luck?** `readdir("/Volumes")`'s raw (unsorted)
entry order, confirmed via `ls -f /Volumes` at the time of the test, was
`MICROBIT` before `MICROBIT 1`. A naive "first entry whose name starts
with `MICROBIT`" heuristic — the exact kind of prefix/name heuristic
ticket 002's design doc explicitly rejects — would therefore return
`/Volumes/MICROBIT` for **both** devices, since that volume comes first
in every enumeration regardless of which device is asked about. The
actual result for `zapig` was `/Volumes/MICROBIT 1`, which a
first-match/name-only heuristic cannot produce. That is only explainable
by the `DETAILS.TXT` → `Unique ID` → `serialNumber` join actually
running and picking the volume whose `Unique ID` matches — confirmed,
not inferred from a unit test, since this ran the real
`defaultResolveVolumePath` against the real filesystem with no injected
fakes.

### Actual MSD write: not attempted (judgment call)

Per team-lead's dispatch: "the resolver is the thing this ticket is
about... whether to attempt an actual MSD write is your judgement." I
chose not to force an SWD failure or write a hex to either volume.
Reasoning:

1. The specific thing ticket 002's own doc comment calls "genuinely
   unverified... needs two real boards" is exactly the volume
   disambiguation proven above — not the mechanics of `flashViaMsd`
   (a single `fs.writeFile` call, already unit-tested) or of
   `flash()`'s SWD-failure-triggers-fallback branching (also already
   unit-tested with injected fakes).
2. Ticket 005 already exercised this codebase's real hardware write path
   end-to-end (SWD, on `vevav`) this same sprint.
3. Forcing a failure requires a temporary source edit to `flashOverSwd`
   (per the Implementation Plan) reverted immediately after — extra
   surface for a mistake against real, shared bench hardware for
   marginal additional confidence over what is already proven above.

This means the acceptance criterion's literal "the hex is written there"
clause was **not exercised**. Both `/Volumes/MICROBIT` and
`/Volumes/MICROBIT 1` were confirmed, before and after this session's
work, to contain only their original `DETAILS.TXT` and `MICROBIT.HTM` —
no `MICROBIT.hex` was ever written by this session. Neither board was
reflashed, reset, or had its link opened; `lsof` shows no open handle on
either `/dev/cu.usbmodem*` port at the end of this session.

**If the team-lead judges this an incomplete verification of the MSD
issue's stated bar, `msd-fallback-volume-matching-heuristic-unimplemented.md`
should stay open** — the resolver's volume-selection logic is proven,
but the full write-path-under-a-forced-failure scenario the issue's own
acceptance bar describes was not run. `completes_issue` for that issue
is left `false` on this ticket, as instructed; this is the team-lead's
call to make, not this ticket's.

### Stretch: `FUNCS` against present robot boards

Two robot boards (not relays) were reachable on the LAN: `vevov`
(192.168.1.249) and `gopiv` (192.168.1.215), both advertising
`_robotlink._tcp`/`_udp` on port 7654 (confirmed via `dns-sd -B`/`-L`,
`vevov\032robot\032link._robotlink._tcp.local. -> vevov.local.:7654`,
same for `gopiv`). Per team-lead's instruction, no new transport code
was written — a throwaway Node `net` TCP script sent `HELLO\n` then
`FUNCS #1\n` (a bare `FUNCS` with no id parses as `#0` and is nacked —
found this the hard way on the first attempt, then corrected; see
`vendor/pxt-nezha-diffdrive/.claude/rules/connecting-to-a-robot.md`:
"Sequenced verbs need `#<id>`").

```
vevov: ack 1 0 none
       funcs clearestop / abort / tour / straight / cal / fix / arm
gopiv: ack 1 0 none
       funcs clearestop / abort / tour / straight / cal / fix / arm
```

PASS — both returned a sane `ack` + `funcs` program listing, not an
error or silence. Both lists were truncated at 7 names via this WiFi TCP
carrier; this matches a **pre-existing, already-filed** bug, not
anything introduced by or in scope for this ticket:
`vendor/pxt-nezha-diffdrive/clasi/issues/wifi-transport-truncates-multi-line-replies.md`
and `vendor/pxt-nezha-diffdrive/captures/funcs-run-acceptance-20260907/notes.md`
(that capture, run earlier the same day on the same two boards over both
USB and WiFi as part of unrelated vendor-project work, recorded the full
21-name registry over USB — `clearestop abort tour straight cal fix arm
probe gap seed seedxy goto face pivot arc turnrate square diamond circle
infinity snake` — and the identical 7-name WiFi truncation this probe
also hit). The 7 names this probe did see already include
calibration-relevant programs (`cal`, `fix`, `arm`), and the vendor
capture's fuller USB-carried list confirms several more
(`probe`, `seed`, `seedxy`, `goto`, `arc`) — answering this stretch
goal's underlying question (does the shipping run registry already
contain calibration-suitable programs?) with a clear **yes**, independent
of the WiFi-transport bug.

### Tests / typecheck

No code changes were made (no bug found in the resolver). Run anyway as
a sanity check on the working tree before marking this ticket done:

```
npm test -- packages/host   -> 9 test files, 199 tests, all passed
npm run build (packages/host, tsc --noEmit)  -> no errors
```
