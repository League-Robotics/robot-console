# Bench harness

A committed, repeatable three-layer test harness that proves connections
work against the **real bench**, not fakes. Per sprint 018's own
Architecture (`clasi/sprints/018-.../sprint.md`) and the issue
`bench-layered-connection-test-harness.md`:

- **Layer 1** (`layer1/`, this ticket — 018-001): raw devices. Talks
  directly to every discovered device — USB serial, farm `mbserial` TCP
  bridges, the `mbrelay` radio pool — with **no host process involved at
  all**. This is ground truth: a path that fails here is an environment
  fact, not a host/UI bug.
- **Layer 2** (`layer2/`, ticket 002 — not built by this ticket): the host
  over WebSocket (`session-open` / `send-command` / `session-close`),
  plus card-truthfulness assertions.
- **Layer 3** (`layer3/`, ticket 003): headless Chrome (`playwright-core`)
  driving the real production-built UI (`packages/ui/dist`).
- **Report generator** (`report/generate.ts`, ticket 003): one Markdown
  file, one row per robot x path, joining all three layers' own JSON.

A path that passes Layer 1 but fails Layer 2 or 3 is a host/UI defect; a
path that fails Layer 1 is environment (see `sprint.md`'s own framing).
A path (at any layer) that was `skipped` due to exclusivity is neither —
it is simply inconclusive, and the report labels it `skipped`, not
`environment`/`defect`.

## Running the full harness (`run.sh`)

```sh
scripts/bench/run.sh [--skip-held] [--audit-db <path/to/console.sqlite>] --report /tmp/bench-report.md
```

The one committed entry point: builds the protocol/host packages and
the UI's actual production bundle (`npm run vite:build -w
@robot-console/ui` — the root `build` script only *typechecks* the UI,
it does not produce `packages/ui/dist`), then runs Layer 1 -> Layer 2 ->
Layer 3 in order, then the report generator, writing intermediate JSON
to a fresh `mktemp -d` work directory (printed at the end, kept — not
cleaned up — so a reader can inspect the raw JSON the report was built
from). Layer 3's screenshots go somewhere durable instead — 018-004: a
`mktemp -d` work directory is exactly the kind of thing OS temp cleanup
can reap at any time, which used to leave the report's own screenshot
links dead — under `<report-dir>/<report-basename>-screenshots/<run-
id>/`, next to `--report`'s own file, with the Markdown table's own
links rendered relative to the report so the whole directory stays
viewable if moved or committed elsewhere together. `--skip-held`/
`--audit-db` are forwarded to Layer 1/2 exactly as documented below.
Each layer's own script remains independently runnable (see each
section below) for targeted re-runs.

## Requires exclusive access to the bench

Every layer needs to be the only thing talking to the devices it probes.
Layer 1 enforces this itself, via `lsof`:

- Every USB serial device it is about to open.
- Every established TCP connection some **other** local process already
  holds to a farm `mbserial` bridge, the `mbrelay` pool, or a WiFi
  robot's `_robotlink` endpoint this run is about to dial.

**Default behavior: refuse to run**, naming every holder (`resource held
by pid <pid> (<command>)`) and exiting non-zero. This is deliberate — a
concurrent `npm run dev` (or a second harness run) silently stealing a
board's serial port or a bridge's single client slot is exactly the kind
of thing that produces a misleading "fail" elsewhere in the report.

Pass `--skip-held` to probe everything **not** held instead: the
harness never refuses in this mode, but every resource it found held is
marked `status: "skipped"` on its device/path row, with `reason: "held
by pid <pid> (<command>)"`.

This harness **never kills or signals** a holding process, no matter
which mode it runs in.

## Running Layer 1

```sh
# Default: refuses if anything relevant is already held.
npm run bench:layer1 -- --out /tmp/bench-layer1.json

# Skip whatever's held (e.g. a stakeholder's `npm run dev` mid-session),
# probe everything else, and mark held resources "skipped".
npm run bench:layer1 -- --skip-held --out /tmp/bench-layer1.json
```

Or directly: `npx tsx scripts/bench/layer1/index.ts [--skip-held] [--out <path>]`.
`--out` defaults to `./bench-layer1-report.json` in the current
directory.

Layer 1 never sends a motion/drive verb and never flashes firmware — it
only ever sends `HELLO`, `ID`, `?`, and (against the `mbrelay` pool only)
the documented command-plane preamble
(`!ECHO OFF`/`!MODE RAW250`/`!CG`/`!P 7`/`!GO`) plus a pass-through
`> HELLO`. It never writes to the user's real state directory — it only
ever *reads* `~/.local/state/robot-console/known-robots.json` (or
wherever `ROBOT_CONSOLE_STATE_DIR`/`XDG_STATE_HOME` points), to seed the
list of robot names to probe over radio.

**WiFi coverage (018-003)**: `_robotlink` is a periodic-*announcement*-
only mDNS service (see `mdnsBrowse.ts`'s own doc comment) — a robot
whose next announcement simply hadn't landed within one run's browse
window would otherwise go entirely missing from the report, even though
it's right there on the network. After the mDNS-announcement pass, Layer
1 also resolves every known robot name's own `<name>.local` directly
(bounded, `dnsResolve.ts`'s ~8s cap) and probes TCP 7654 — a `wifi` row
found this way is marked `"... (found by name lookup, not
announcement)"` in its `reason`, so the report stays honest about which
kind of evidence produced it.

**`--hid-reset-silent-relays`** (opt-in, off by default): if a USB
device produces no banner at all — even after `usbProbe.ts`'s own UART
break-reset retry — this attempts one DAPLink vendor-command HID reset
(`hidReset.ts`, importing the compiled `packages/host/dist/{devices,
flash}.js` — the one deliberate exception to this harness's "never
import host internals" rule, since a vendor HID reset protocol isn't
wire-level logic worth reimplementing a second time) and re-probes once.
Never runs unless this flag is passed — resetting a physical board is a
stronger action than anything else Layer 1 does unprompted.

## Output shape

One JSON file:

```jsonc
{
  "startedAt": "2026-09-13T...Z",
  "finishedAt": "2026-09-13T...Z",
  "host": { "os": "darwin 25.6.0", "node": "v22.13.0" },
  "holders": [{ "resource": "...", "pid": 123, "command": "node" }],
  "devices": [
    {
      "name": "vevov",
      "kind": "robot",
      "paths": [
        {
          "path": "mbserial",                 // or "usb" | "wifi" | "radio-via-mbrelay:<pool>"
          "endpoint": { "host": "hodr.local", "ip": "192.168.1.x", "port": 37317, "resolveMs": 4 },
          "status": "pass",                    // "fail" | "skipped"
          "reason": "banner + ID matched (...)",
          "transcript": [{ "t": 12, "dir": "tx", "line": "HELLO" }, "..."]
        }
      ]
    }
  ]
}
```

`transcript` lines are verbatim wire text (`dir: "tx"|"rx"`) or an
orchestration note this harness added itself (`dir: "info"` — never
confused with a real wire line).

## Module map

| File | Job |
| --- | --- |
| `layer1/exclusivity.ts` | The `lsof`-based holder check (shared by future layers too). |
| `layer1/dnsResolve.ts` | Resolve a `.local` host to IPv4 with a bound, recording how long it took — the harness's own regression guard for the `.local` hostname hang this sprint's other tickets fix in the host. |
| `layer1/mdnsBrowse.ts` | Browse `_mbserial._tcp`, `_mbrelay._tcp`, `_robotlink._tcp`/`_udp`. The first three settle within a few seconds; `_robotlink` gets up to 65s more (only if nothing has appeared yet) since these robots only ever answer with an unsolicited periodic announcement, not a live query reply — see that file's own doc comment for the live-verified root cause. |
| `layer1/usbProbe.ts` | Enumerate DAPLink boards directly (`serialport`), open, `HELLO`/`ID` (or `?` for a relay). No SWD naming — identity comes from the banner alone (see that file's own doc comment for why). A `HELLO` timeout triggers one UART break-reset + retry (a relay parked in its data plane after a host `!GO` forwards `HELLO` over radio instead of answering it) before the path is finally reported `fail`. |
| `layer1/mbserialProbe.ts` | Farm bridge `HELLO`/`ID`, distinguishing `ERR busy` from a timeout; also demonstrates single-client contention. |
| `layer1/wifiProbe.ts` | WiFi robot `HELLO`/`ID`, tolerating the doubled banner and interleaved `DBG:` lines. |
| `layer1/mbrelayProbe.ts` | The pool's command-plane sweep (every known name) plus the full data-plane handshake for whichever name(s) the sweep found reachable. |
| `layer1/knownNames.ts` | Read-only `known-robots.json` reader. |
| `layer1/registry.ts` | The one HTTP call this harness makes: `GET /names/<name>` on the pool's registry port. |
| `layer1/tcpLineSession.ts`, `layer1/lineReassembler.ts` | Shared line-oriented TCP client / byte reassembly (deliberately *not* imported from `packages/host` — see `lineReassembler.ts`'s doc comment for the host-internals boundary this harness keeps throughout). |
| `layer1/wifiNameLookup.ts` | 018-003: which known names still need a direct `<name>.local` lookup (not already found via mDNS announcement). |
| `layer1/hidReset.ts` | 018-003, opt-in only: one DAPLink vendor HID reset for a USB device that never banners at all — the harness's one deliberate exception to the "no host internals" rule (see its own doc comment). |
| `layer1/index.ts` | Orchestrates all of the above and writes the report. |

## Running Layer 2

Layer 2 (`layer2/`, ticket 018-002) starts a **real host** — the
compiled `packages/host/dist/` a student's `npx robot-console` actually
runs, not a `tsx`-from-source shortcut — against a fresh, seeded state
directory, waits for its watchers to settle, then for every path
Layer 1's report marked reachable: `session-open` → `send-command
{verb: "ID"}` (or, for a device whose own `kind` is `"relay"`, `{verb:
"?"}` — 018-004: a relay has no `ID` verb, `!HELP` lists `HELLO` and `?`
instead — matching its own `# channel: ...` status reply rather than an
`"id "` reply; `?`, not a second `HELLO`, because live verification
found a relay does not reliably repeat its full banner once the link is
already connected — see `layer2/pathChecks.ts`'s own doc comment) →
assert a matching `line` rx → `session-close` over the host's own
WebSocket contract (`docs/design/architecture.md` §9). It also runs
three card-truthfulness assertions directly against the live snapshot
(no UI needed): no link is `stale`/"Not seen since ..." while its mDNS
service is currently advertised (per Layer 1's own discovery); no
device is recorded `kind: "robot"` while its role says relay; exactly
one `devices` row per name.

```sh
npm run build   # Layer 2 tests the shipped host, not source -- required first

# Default: refuses if anything Layer 1 found reachable is already held.
npm run bench:layer2 -- --layer1 /tmp/bench-layer1.json --out /tmp/bench-layer2.json

# Skip whatever's held, same --skip-held contract as Layer 1.
npm run bench:layer2 -- --skip-held --layer1 /tmp/bench-layer1.json --out /tmp/bench-layer2.json --state-dir /tmp/bench-layer2-state --port 4799
```

`--layer1` defaults to `./bench-layer1-report.json`; `--state-dir`
defaults to a fresh directory under `os.tmpdir()` when omitted (never
the real state directory); `--port` defaults to `4799`. The host this
run starts is killed (`SIGTERM`) in a `finally` when this script exits,
whatever the outcome — no other process is ever touched, same
exclusivity discipline as Layer 1's own `lsof` check (reused directly,
against every resource a Layer-1-reachable path touches).

`known-robots.json` is copied — read-only, from its real location — into
the scratch state dir before the host starts, so devices already in the
roster come up `owned: true` rather than being gated off the WiFi/
mbserial projection (architecture.md §4's "`devices.owned` is the WiFi
gate" rule); the real file itself is never opened for writing. The host
is started with `--no-open` (added to `packages/host/src/cli.ts` by
this ticket) so it never tries to launch a desktop browser on a
headless bench run.

### Module map (Layer 2)

| File | Job |
| --- | --- |
| `layer2/wsClient.ts` | A thin `ws` client speaking the host's own wire contract directly (`session-open`/`send-command`/`session-close`, tracking the latest `snapshot`/`line`/`notice` stream); also `waitForSettle`, the "unchanged for 5s, bounded at 90s" settle detector. |
| `layer2/pathChecks.ts` | Per-path target resolution (which link id a `{deviceName, transport}` or `{deviceName, relayName}` target maps to in the current snapshot) and the actual `checkPath` round trip. |
| `layer2/truthfulness.ts` | The three card-truthfulness assertions, pure functions over a narrow `Snapshot` slice. 018-003 strengthened `assertNoRelayAsRobot`: it also fires from Layer 1's own banner-based `kind: "relay"` classification or a link's own reason/history mentioning a relay banner (not only the live snapshot's own, possibly-absent `role`), and flags a USB device with `kind: "robot"` and `role: null` as "unidentified, recorded as robot". |
| `layer2/auditDb.ts` | 018-003 `--audit-db` mode: copies a real `console.sqlite` (+ `-wal`/`-shm`) read-only into scratch and runs one-row-per-name, relay-as-robot, would-be-hidden radio link, and USB-path-mismatch checks directly against real accumulated state — see its own doc comment for why this is the one module that talks to the store schema directly instead of the wire. |
| `layer2/index.ts` | Orchestrates: exclusivity check, seed + start the host, settle, per-path checks, assertions, `--audit-db` (if passed), writes the report. |

### `--audit-db <path>` (018-003)

```sh
npm run bench:layer2 -- --skip-held --layer1 /tmp/bench-layer1.json --out /tmp/bench-layer2.json \
  --audit-db ~/.local/state/robot-console/console.sqlite
```

Copies `<path>` (plus `-wal`/`-shm` if present — WAL mode means recent
writes can live only in the sidecar files) into the run's own scratch
directory and opens **only that copy**, read-only — the real file
named by `<path>` is never opened directly. Adds a `auditDb` section to
the Layer 2 report (and the generated Markdown report) with the check
results: `one-row-per-name`, `relay-as-robot`, `would-be-hidden-radio-
link` (a relay link that's missing/stale, or a link whose own last
activity is older than a TTL), and `usb-path-mismatch` (a link's
`state_reason` naming a USB path its relay no longer dials). Independent
of the rest of Layer 2 — no live host round trip is needed for this
check, only the database file.

## Running Layer 3

Layer 3 (`layer3/`, ticket 018-003) starts its own instance of the same
shipped host Layer 2 uses (fresh seeded state dir, `--no-open`) and
drives it in headless Chrome (`playwright-core`'s bundled Chromium) for
every device x path Layer 2's own report marked as attempted (`layer2
!== "skipped"`) — Layer 2 already resolved which of Layer 1's reachable
paths are real "robot reached over this transport" rows, so Layer 3
reads that filtering rather than re-deriving it.

For each path: reach the robot's page (front page -> Connect, or a
relay card's own robot picker + Connect for `radio-via-mbrelay:<pool>`,
or the card's arrow directly if already Linked) -> assert the header
says `Linked` -> type `ID` into the console (`getByLabel("Line to
send")`) -- or, for a path whose own device `kind` is `"relay"`, `?`
instead (018-004: a relay has no `ID` verb; `?`, not `HELLO`, since live
verification found a relay does not reliably repeat its full banner
once already connected) -> assert an `id ...` reply (or, for a relay,
its own `# channel: ...` status reply) renders within 5s -> assert no
enabled drive/send control on a page that isn't Linked -> assert no raw
internal id (`connector:`, `relayBridger:`, `link "`, `candidate "`,
`usb-9906`) appears anywhere in the page's own text -> (relay paths
only) assert the relay card actually named the robot it was asked to
reach. Screenshots are saved at each step under `--screenshot-dir`.
Never clicks a drive button, never types a motion verb.

```sh
npm run build && npm run vite:build -w @robot-console/ui   # Layer 3 drives the real production build

npx tsx scripts/bench/layer3/index.ts --layer2 /tmp/bench-layer2.json --out /tmp/bench-layer3.json --screenshot-dir /tmp/bench-layer3-screenshots
```

`--layer2` defaults to `./bench-layer2-report.json`; `--port` defaults
to `4798` (Layer 2's own default is `4799`, so both can run against the
same bench without colliding if ever needed simultaneously); `--state-
dir`/`--screenshot-dir` default to fresh directories under
`os.tmpdir()`. The host this run starts is killed (`SIGTERM`) in a
`finally`, same discipline as Layer 2.

### Module map (Layer 3)

| File | Job |
| --- | --- |
| `layer3/uiDriver.ts` | Pure helpers (path-to-label matching, raw-id-leak detection, the `Linked`/reply-line text rules) plus the async Playwright orchestration (`checkPath`) that drives one device x path end to end. |
| `layer3/index.ts` | Starts its own host instance, reads Layer 2's report for the target list, drives Chromium, writes the report. |

## Report generator

`report/generate.ts` reads Layer 1's report (required) plus Layer 2/3's
own reports (either or both optional) and produces one Markdown file:
one row per robot x path with each layer's status, a `label` (`pass` /
`defect` / `environment` / `skipped` — see `generate.ts`'s own doc
comment for the exact rule), the first non-passing layer's own reason,
and links to that path's Layer 3 screenshots; a truthfulness-assertions
section (live snapshot); a database-audit section (only if Layer 2 ran
with `--audit-db`); an "Additional Layer 1 findings" section for
diagnostics that aren't a robot x path row (a relay pool's own status
check, the `mbserial-contention` demonstration); and a holders/skips
section.

```sh
npx tsx scripts/bench/report/generate.ts --layer1 /tmp/bench-layer1.json --layer2 /tmp/bench-layer2.json --layer3 /tmp/bench-layer3.json --out /tmp/bench-report.md
```

`--layer2`/`--layer3` are optional — omitting either simply reports
`n/a` for that layer's column and skips its report section, so the
generator also works from a Layer-1-only (or Layer-1+2-only) run.

## Testing

`npx vitest run scripts/bench` runs this harness's own unit suite: every
pure parser/classifier (banner/reply classification, the exclusivity
check, DNS resolution edge cases, Layer 2's target resolution and
truthfulness assertions, `waitForSettle` against a scripted fake driver,
Layer 3's path-label/raw-id-leak/`Linked`-text rules, the report
generator's environment-vs-defect labeling and row-joining) is tested
against captured byte sequences, mocked `lsof` output, and fixture
reports — **no live hardware or real browser in CI**. Live hardware
(and a real headless Chrome against the real production build) is
exercised only by actually running `scripts/bench/run.sh` (or each
layer by hand) against the real bench, which is each ticket's own
evidence (see their completion notes), not something CI re-runs.

`npm run typecheck` includes `scripts/tsconfig.json`, which covers this
directory. `packages/host/src/cli.test.ts` covers the `--no-open`/
`ROBOT_CONSOLE_NO_OPEN` flag Layer 2 relies on.
