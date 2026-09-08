---
id: '001'
title: 'KnownRobotsStore: schema, versioning, atomic debounced writes'
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-003
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# KnownRobotsStore: schema, versioning, atomic debounced writes

## Description

Add `packages/host/src/store/knownRobots.ts`: the project's first
persistence module. It owns nothing about USB, banners, or the wire
protocol — only the durable storage of a small roster of known-robot
records, keyed by five-letter name, in a plain JSON file. This ticket has
no dependency on any other ticket in this sprint and can be built and
fully tested in isolation against a temp directory.

Per `sprint.md`'s Architecture (Step 3, "knownRobots.ts") and Design
Rationale: hand-rolled JSON with atomic (temp-file + rename) and
debounced writes, no SQLite, no lowdb — mirroring `config.ts`'s own
"proportionate to the actual need" precedent for not adding `dotenv`.

**Location resolution** (mirrors `config.ts`'s `ROBOT_CONSOLE_*` env
convention): `${ROBOT_CONSOLE_STATE_DIR}/known-robots.json` if
`ROBOT_CONSOLE_STATE_DIR` is set, else
`${XDG_STATE_HOME:-~/.local/state}/robot-console/known-robots.json`.
Create the containing directory (recursive `mkdir`) before the first
write if it does not exist; never before a read (a missing directory on
read is just "no file", same as a missing file).

**File shape**: `{ version: number, robots: KnownRobotRecord[] }`, where
`KnownRobotRecord` is:

```ts
interface KnownRobotRecord {
  name: string;
  firstSeenAt: string;   // ISO 8601
  lastSeenAt: string;    // ISO 8601
  lastSeenVia: "usb";    // single-valued this sprint; carried for sprint 7's benefit -- see Design Rationale
  lastUsbSerial: string; // display hint only, never authoritative -- see sprint.md's Design Rationale
  lastRole: string | null;
  lastType: "robot";     // single-valued this sprint (the store only ever records robots)
}
```

`CURRENT_KNOWN_ROBOTS_VERSION = 1`.

**Read (boot load)**: synchronous, in the constructor (mirrors
`config.ts`'s own sync `readFileSync`-based `.env` parsing) — a small
JSON file needs no async read, and a synchronous constructor means the
store never has "not loaded yet" as an observable state. Behavior by
file condition:

- **Missing file**: start with an empty in-memory roster, no warning
  (this is the normal first run) — writes are allowed.
- **Corrupt / unparseable JSON, or a `version` field that is missing,
  non-numeric, or otherwise not a comparable integer**: start empty, log
  one `console.warn`, never throw — writes are allowed (there is no
  known-good data at risk of being clobbered; starting fresh *is* the
  recovery).
- **Valid JSON, numeric `version` greater than
  `CURRENT_KNOWN_ROBOTS_VERSION`**: start empty, log one `console.warn`,
  and set the store **read-only** — every subsequent `recordSighting`/
  `forget` call becomes a silent no-op (in-memory *and* on disk). This is
  the one case where "start empty" and "never write" must be paired — see
  `sprint.md`'s Design Rationale for why.
- **Valid JSON, numeric `version` less than `CURRENT_KNOWN_ROBOTS_VERSION`**:
  load normally (no records exist below version 1 yet, so this is a
  no-op path this sprint, but the constructor should have an obvious,
  documented place — e.g. a `migrate(data, fromVersion)` seam, even if
  it is the identity function today — for a future version bump to hook
  into, rather than requiring a reader to invent that seam from scratch).

**Write path**: `recordSighting(input: { name: string; usbSerial: string;
role: string | null })` upserts a record — updates `lastSeenAt` (now),
`lastUsbSerial`, `lastRole`, sets `lastSeenVia: "usb"` and
`lastType: "robot"` always, and preserves `firstSeenAt` from the existing
record if one exists, else sets it to now. `forget(name: string): boolean`
removes a record if present, returns whether it existed. Both mutate the
in-memory map synchronously and unconditionally return (never throw); if
the store is read-only (newer-version file), both are no-ops. Both
schedule a debounced write (see below) unless read-only.

**Debounced, atomic write**: on any mutation, (re)start a timer
(`debounceMs`, default ~300ms — configurable via constructor option).
When it fires: serialize the *current* in-memory state to JSON, write it
to a temp file in the same directory (e.g. `known-robots.json.tmp-<random>`),
then rename it over the real path. A write failure (temp-file write
failure, rename failure) is caught and logged via `console.warn` — it
must never throw out of the debounce callback, and it must never affect
the in-memory state a caller already has (a failed persist is invisible
to `list()`/`get()`, per `sprint.md`'s "a write failure never fails the
underlying USB sighting" requirement). Multiple mutations within one
debounce window collapse into a single write of the latest state.

**Injectable seams** (constructor options, all defaulting to the real
`node:fs`/`node:fs/promises` implementations, mirroring `flash.ts`'s
`WriteFileFn`/`ReadTextFileFn` pattern exactly):
- `readFileSync`-shaped sync read (for the boot load)
- `writeFile`/`rename`/`mkdir`-shaped async functions (for the debounced
  write)
- `now: () => string` (ISO timestamp) — injectable so tests assert exact
  `firstSeenAt`/`lastSeenAt` values instead of "some recent-looking
  string"
- `filePath` or `stateDir` override — tests point directly at a file
  inside their own temp directory rather than touching
  `~/.local/state`

**Public API**:
```ts
class KnownRobotsStore {
  constructor(options?: KnownRobotsStoreOptions);
  list(): KnownRobotRecord[];               // sorted by name, for deterministic tests/rendering
  get(name: string): KnownRobotRecord | undefined;
  recordSighting(input: { name: string; usbSerial: string; role: string | null }): void;
  forget(name: string): boolean;
  flush(): Promise<void>;                   // await any pending debounced write -- test determinism only
  readonly isReadOnly: boolean;
}
```

## Acceptance Criteria

All of the following are provable without hardware, against a temp
directory / injected fakes — this ticket has no hardware-deferred
criteria at all.

- [x] A `recordSighting` call followed by `list()` returns a record with
      the correct `name`, `lastUsbSerial`, `lastRole`, `lastSeenVia:
      "usb"`, `lastType: "robot"`, and `lastSeenAt` set from the
      injected `now()`.
- [x] A second `recordSighting` for the same name updates `lastSeenAt`/
      `lastUsbSerial`/`lastRole` but preserves the original `firstSeenAt`.
- [x] After `flush()`, a *fresh* `KnownRobotsStore` instance pointed at
      the same file path reads back the same record(s) — the round-trip
      test.
- [x] A missing file produces an empty `list()` with no warning logged.
- [x] A file containing invalid JSON produces an empty `list()`, one
      warning logged, and does **not** set `isReadOnly` — a subsequent
      `recordSighting` + `flush()` succeeds in writing a fresh file.
- [x] A file with `version: 999` (greater than
      `CURRENT_KNOWN_ROBOTS_VERSION`) produces an empty `list()`, one
      warning logged, `isReadOnly === true`, and a subsequent
      `recordSighting` call is a silent no-op — `list()` still empty
      after it, and no write is attempted (assert the injected
      `writeFile`/`rename` fakes are never called).
- [x] `forget` on an existing name removes it from `list()` and, after
      `flush()`, from a freshly-constructed store reading the same file.
- [x] `forget` on a name not present returns `false` and does not throw
      or schedule a write.
- [x] Several `recordSighting`/`forget` calls within one debounce window
      result in exactly one `writeFile` call (assert on the injected
      fake's call count) once `flush()` resolves — the debounce-coalescing
      behavior.
- [x] A failing injected `writeFile` (rejects) does not throw out of
      `recordSighting` or `flush()`, and does not change what `list()`
      returns.
- [x] The write uses the temp-file-then-rename pattern — assert the
      injected `writeFile` is called with a path different from the
      final `rename` target, and `rename`'s second argument is the real
      file path.

## Testing

- **Existing tests to run**: `npm test -w @robot-console/host` (no
  existing suite touches this new module; run to confirm no accidental
  breakage from adding a new file/directory under `src/`).
- **New tests to write**: `packages/host/src/store/knownRobots.test.ts`,
  covering every acceptance criterion above against injected fs fakes
  and a fixed `now()` — no real filesystem I/O, no real timers (use
  `vi.useFakeTimers()` or an injectable timer function so the debounce
  window is deterministic in test time).
- **Verification command**: `npm test -w @robot-console/host` and
  `npm run build` (typecheck across workspaces).
