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
- **Layer 3** (`layer3/`, ticket 003 — not built by this ticket): headless
  Chrome (Playwright) driving the built UI.

A path that passes Layer 1 but fails Layer 2 or 3 is a host/UI defect; a
path that fails Layer 1 is environment (see `sprint.md`'s own framing).

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
| `layer1/index.ts` | Orchestrates all of the above and writes the report. |

## Testing

`npx vitest run scripts/bench` runs this harness's own unit suite: every
pure parser/classifier (banner/reply classification, the exclusivity
check, DNS resolution edge cases) is tested against captured byte
sequences and mocked `lsof` output — **no live hardware in CI**. Live
hardware is exercised only by actually running `npm run bench:layer1`
by hand against the real bench, which is this ticket's own evidence
(see its completion notes), not something CI re-runs.

`npm run typecheck` includes `scripts/tsconfig.json`, which covers this
directory.
