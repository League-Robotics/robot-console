/**
 * knownRobots.ts — the project's first persistence layer: a small,
 * on-disk roster of robots the console has identified over USB at least
 * once, keyed by five-letter name.
 *
 * Per `sprint.md`'s Architecture (Step 3, "knownRobots.ts") and Design
 * Rationale: this module owns exactly one thing -- durable storage of
 * {@link KnownRobotRecord}s -- and nothing about USB, banners, the wire
 * protocol, or *when* a sighting is durable-worthy (that write-gate
 * decision belongs to `deviceRegistry.ts`, a later ticket in this
 * sprint). Nothing calls this module yet; it is fully provable in
 * isolation against a temp directory and injected fakes.
 *
 * ## Keyed on the five-letter name, not the USB serial
 *
 * The name is the nRF `FICR.DEVICEID[1]`-derived *target* identity --
 * the same identity the relay dropdown (sprint 7), `radioAddress.ts`,
 * the mbrelay registry, and mDNS all key on. The USB serial comes from a
 * *different chip* (the KL27 interface chip, per `swdName.ts`'s own
 * module doc and spec §2.2) and is carried on each record purely as a
 * **non-authoritative display hint** ({@link KnownRobotRecord.lastUsbSerial}) --
 * the pair holds only until hardware is swapped or re-imaged. Nothing in
 * this module, or any caller, may use it to make an identity decision.
 *
 * ## An absent, corrupt, or unreadable file is never fatal
 *
 * Mirrors `config.ts`'s established "an absent or malformed value is
 * never fatal" discipline:
 *   - **Missing file**: the normal first run -- empty roster, no warning,
 *     writes allowed.
 *   - **Corrupt JSON, or a missing/non-numeric/unparseable `version`**:
 *     there is no known-good data at risk, so starting fresh *is* the
 *     recovery -- empty roster, one `console.warn`, writes still allowed.
 *   - **A valid, comparable `version` greater than
 *     {@link CURRENT_KNOWN_ROBOTS_VERSION}**: a newer install already
 *     wrote data this schema cannot safely round-trip. This is the one
 *     case where "start empty" and "never write again" must be paired --
 *     see {@link KnownRobotsStore.isReadOnly} -- so that an older `npx`
 *     invocation on a shared machine cannot clobber a newer install's
 *     roster.
 *   - **A valid `version` less than current**: loads normally through
 *     {@link migrateKnownRobotsFile}, today's identity-function seam for
 *     a future version bump to extend (no version below 1 has ever
 *     produced records, so this is a no-op path this sprint).
 *
 * ## Atomic, debounced writes
 *
 * Replugging a board tends to arrive in bursts (the device watcher
 * reports a modified device as remove+add), so every mutation
 * ({@link KnownRobotsStore.recordSighting}/{@link KnownRobotsStore.forget})
 * (re)starts a single debounce timer rather than writing immediately;
 * multiple mutations inside one debounce window collapse into one write
 * of the *current* in-memory state. Each write serializes to a temp file
 * in the same directory and renames it over the real path, so a reader
 * (or a crash mid-write) never observes a partially-written file. A
 * write failure (temp-file write, rename, or the directory `mkdir`) is
 * caught and logged via `console.warn` -- it never throws out of the
 * debounce callback and never affects the in-memory state a caller
 * already has via {@link KnownRobotsStore.list}/{@link KnownRobotsStore.get}.
 * {@link KnownRobotsStore.flush} exists purely for test determinism: it
 * cancels any pending debounce timer and awaits an immediate write of
 * the current state.
 *
 * ## Injectable filesystem seam
 *
 * Every filesystem touchpoint -- the synchronous boot-time read
 * (`existsSync`/`readFileSync`-shaped) and the async write path
 * (`mkdir`/`writeFile`/`rename`-shaped) -- is an injectable constructor
 * option, mirroring `flash.ts`'s `WriteFileFn`/`ReadTextFileFn` pattern
 * exactly. All default to the real `node:fs`/`node:fs/promises`
 * implementations, so the whole module is unit-testable against fakes
 * with no real filesystem I/O at all; a handful of tests additionally
 * exercise a real temp directory for the atomic-rename and permission
 * paths specifically.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir as fsMkdir, rename as fsRename, writeFile as fsWriteFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "./stateDir.js";

/** Schema version of the on-disk `known-robots.json` file. Bump this
 * (and extend {@link migrateKnownRobotsFile}) the next time the record
 * shape needs a backward-incompatible change. */
export const CURRENT_KNOWN_ROBOTS_VERSION = 1;

/** Default debounce window between a mutation and the write it
 * schedules. Configurable via {@link KnownRobotsStoreOptions.debounceMs}
 * purely for tests that want a different value; production code never
 * overrides it. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** Filename of the on-disk store, joined onto whichever directory
 * {@link resolveKnownRobotsFilePath} resolves. */
const KNOWN_ROBOTS_FILENAME = "known-robots.json";

/**
 * One record per known robot name. `lastSeenVia` and `lastType` are
 * both single-valued this sprint (`"usb"` and `"robot"` respectively,
 * since the write gate -- a later ticket -- only ever enrolls a USB
 * robot identify) but are carried now, unused-but-constant, so a later
 * sprint that legitimately needs a second value extends this schema
 * instead of adding the field under time pressure.
 */
export interface KnownRobotRecord {
  /** The five-letter target identity -- this record's key. */
  name: string;
  /** ISO 8601. Preserved across every subsequent sighting of the same
   * name. */
  firstSeenAt: string;
  /** ISO 8601. Refreshed on every sighting. */
  lastSeenAt: string;
  /** Single-valued this sprint -- carried for sprint 7's benefit. See
   * this module's doc comment. */
  lastSeenVia: "usb";
  /** Display hint only -- **never authoritative**. Comes from a
   * different chip than `name` and holds only until hardware is
   * swapped or re-imaged. See this module's doc comment. */
  lastUsbSerial: string;
  lastRole: string | null;
  /** Single-valued this sprint -- this store only ever records robots. */
  lastType: "robot";
}

/** The on-disk file shape: a schema `version` plus the flat record
 * list. */
export interface KnownRobotsFile {
  version: number;
  robots: KnownRobotRecord[];
}

/** Injectable constructor options. Every filesystem-touching field
 * defaults to the real `node:fs`/`node:fs/promises` implementation --
 * see this module's doc comment's "Injectable filesystem seam"
 * section. */
export interface KnownRobotsStoreOptions {
  /** Exact file path to use, overriding every other location option.
   * Tests point this directly at a file inside their own temp
   * directory. */
  filePath?: string;
  /** Directory to resolve `known-robots.json` inside of, overriding the
   * `ROBOT_CONSOLE_STATE_DIR`/`XDG_STATE_HOME` resolution below.
   * Ignored when `filePath` is given. */
  stateDir?: string;
  /** Environment to resolve `ROBOT_CONSOLE_STATE_DIR`/`XDG_STATE_HOME`
   * from when neither `filePath` nor `stateDir` is given. Defaults to
   * `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Debounce window in milliseconds. Defaults to
   * {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Returns the current time as an ISO 8601 string. Defaults to
   * `() => new Date().toISOString()`; injectable so tests assert exact
   * `firstSeenAt`/`lastSeenAt` values. */
  now?: () => string;
  /** Defaults to `node:fs`'s `existsSync`. */
  existsSync?: (filePath: string) => boolean;
  /** Defaults to `node:fs`'s `readFileSync` (utf8). May throw (e.g. a
   * permission error); a thrown error is treated the same as corrupt
   * JSON -- see this module's doc comment. */
  readFileSync?: (filePath: string) => string;
  /** Defaults to `node:fs/promises`'s `writeFile` (utf8). */
  writeFile?: (filePath: string, data: string) => Promise<void>;
  /** Defaults to `node:fs/promises`'s `rename`. */
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  /** Defaults to `node:fs/promises`'s `mkdir` (recursive). Called before
   * every write, never before a read -- a missing directory on read is
   * just "no file", same as a missing file. */
  mkdir?: (dirPath: string) => Promise<void>;
}

function defaultReadFileSync(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

async function defaultWriteFile(filePath: string, data: string): Promise<void> {
  await fsWriteFile(filePath, data, "utf8");
}

async function defaultRename(oldPath: string, newPath: string): Promise<void> {
  await fsRename(oldPath, newPath);
}

async function defaultMkdir(dirPath: string): Promise<void> {
  await fsMkdir(dirPath, { recursive: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the on-disk path for `known-robots.json`, following (in
 * priority order): an explicit `filePath`, else {@link resolveStateDir}'s
 * directory (an explicit `stateDir`, the `ROBOT_CONSOLE_STATE_DIR`
 * environment variable — mirroring `config.ts`'s own `ROBOT_CONSOLE_*`
 * convention — or the `XDG_STATE_HOME`/home-directory fallback) joined
 * with this file's name.
 *
 * Exported for direct unit testing of the resolution logic itself,
 * independent of the store's other behavior.
 */
export function resolveKnownRobotsFilePath(
  options: { filePath?: string; stateDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (options.filePath !== undefined) {
    return options.filePath;
  }
  return path.join(resolveStateDir(options, env), KNOWN_ROBOTS_FILENAME);
}

interface ParsedKnownRobotsFile {
  version: number;
  robots: KnownRobotRecord[];
}

/**
 * Validate that `parsed` (already-`JSON.parse`d, otherwise-untyped)
 * data is at least shaped like a {@link KnownRobotsFile}: an object with
 * a finite numeric `version`. A missing/non-numeric/non-finite `version`
 * -- the "not a comparable integer" case `KnownRobotsStore.load` treats
 * as corrupt -- returns `undefined`. `robots` defaults to an empty array
 * when absent or not an array, rather than failing the whole file over
 * a malformed record list.
 */
function parseKnownRobotsFile(parsed: unknown): ParsedKnownRobotsFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return undefined;
  }
  const robots = Array.isArray(obj.robots) ? (obj.robots as KnownRobotRecord[]) : [];
  return { version, robots };
}

/**
 * Migration seam: turn a {@link ParsedKnownRobotsFile} at some
 * already-validated `version <= CURRENT_KNOWN_ROBOTS_VERSION` into
 * today's {@link KnownRobotRecord} shape. Identity function today --
 * {@link CURRENT_KNOWN_ROBOTS_VERSION} is 1, and no version below it has
 * ever produced records -- but is the documented, obvious place a future
 * version bump hooks a real migration into, rather than requiring a
 * reader to invent this seam from {@link KnownRobotsStore}'s constructor
 * from scratch.
 */
function migrateKnownRobotsFile(file: ParsedKnownRobotsFile): KnownRobotRecord[] {
  return file.robots;
}

/**
 * A durable, versioned, atomically-and-debounced-written roster of
 * known-robot records, keyed by five-letter name. See this module's
 * doc comment for the full design rationale.
 */
export class KnownRobotsStore {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly nowFn: () => string;
  private readonly existsSyncFn: (filePath: string) => boolean;
  private readonly readFileSyncFn: (filePath: string) => string;
  private readonly writeFileFn: (filePath: string, data: string) => Promise<void>;
  private readonly renameFn: (oldPath: string, newPath: string) => Promise<void>;
  private readonly mkdirFn: (dirPath: string) => Promise<void>;

  private readonly records = new Map<string, KnownRobotRecord>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: Promise<void> | null = null;
  private _isReadOnly = false;

  constructor(options: KnownRobotsStoreOptions = {}) {
    this.filePath = resolveKnownRobotsFilePath(options, options.env ?? process.env);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.existsSyncFn = options.existsSync ?? existsSync;
    this.readFileSyncFn = options.readFileSync ?? defaultReadFileSync;
    this.writeFileFn = options.writeFile ?? defaultWriteFile;
    this.renameFn = options.rename ?? defaultRename;
    this.mkdirFn = options.mkdir ?? defaultMkdir;

    // Synchronous, in the constructor -- mirrors config.ts's own sync
    // readFileSync-based .env parsing. A small JSON file needs no async
    // read, and a synchronous constructor means the store never has
    // "not loaded yet" as an observable state.
    this.load();
  }

  /** `true` once a file with a newer-than-supported `version` has been
   * loaded (as empty) -- see this module's doc comment. Every subsequent
   * {@link recordSighting}/{@link forget} call becomes a silent no-op,
   * in-memory and on disk, once this is `true`. */
  get isReadOnly(): boolean {
    return this._isReadOnly;
  }

  private load(): void {
    if (!this.existsSyncFn(this.filePath)) {
      // Missing file -- the normal first run. Empty roster, no warning.
      return;
    }

    let raw: string;
    try {
      raw = this.readFileSyncFn(this.filePath);
    } catch {
      console.warn(
        `KnownRobotsStore: could not read "${this.filePath}" -- starting with an empty roster`,
      );
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      console.warn(
        `KnownRobotsStore: "${this.filePath}" contains invalid JSON -- starting with an empty roster`,
      );
      return;
    }

    const parsed = parseKnownRobotsFile(parsedJson);
    if (parsed === undefined) {
      console.warn(
        `KnownRobotsStore: "${this.filePath}" has a missing or unrecognizable "version" field -- starting with an empty roster`,
      );
      return;
    }

    if (parsed.version > CURRENT_KNOWN_ROBOTS_VERSION) {
      console.warn(
        `KnownRobotsStore: "${this.filePath}" was written by a newer version of this store ` +
          `(file version ${parsed.version} > ${CURRENT_KNOWN_ROBOTS_VERSION}) -- starting empty and refusing to write`,
      );
      this._isReadOnly = true;
      return;
    }

    for (const record of migrateKnownRobotsFile(parsed)) {
      this.records.set(record.name, record);
    }
  }

  /** Every known record, sorted by name for deterministic tests and
   * rendering. Returns shallow copies -- mutating the result never
   * affects the store's own state. */
  list(): KnownRobotRecord[] {
    return Array.from(this.records.values())
      .map((record) => ({ ...record }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The record for `name`, or `undefined` if it is not known. Returns a
   * shallow copy -- see {@link list}. */
  get(name: string): KnownRobotRecord | undefined {
    const record = this.records.get(name);
    return record === undefined ? undefined : { ...record };
  }

  /**
   * Upsert a record for `input.name`: refreshes `lastSeenAt`,
   * `lastUsbSerial`, `lastRole`, and sets `lastSeenVia: "usb"`/
   * `lastType: "robot"` always. Preserves `firstSeenAt` from the
   * existing record if one exists, else sets it to now. A silent no-op
   * when {@link isReadOnly}. Never throws. Schedules a debounced write
   * unless read-only.
   */
  recordSighting(input: { name: string; usbSerial: string; role: string | null }): void {
    if (this._isReadOnly) {
      return;
    }
    const existing = this.records.get(input.name);
    const timestamp = this.nowFn();
    const record: KnownRobotRecord = {
      name: input.name,
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      lastSeenVia: "usb",
      lastUsbSerial: input.usbSerial,
      lastRole: input.role,
      lastType: "robot",
    };
    this.records.set(input.name, record);
    this.scheduleWrite();
  }

  /**
   * Remove the record for `name` if present. Returns whether it existed.
   * A silent no-op (returns `false`, schedules no write) when `name` was
   * not present, or when {@link isReadOnly}. Never throws. Schedules a
   * debounced write when a record was actually removed.
   */
  forget(name: string): boolean {
    if (this._isReadOnly) {
      return false;
    }
    const existed = this.records.delete(name);
    if (existed) {
      this.scheduleWrite();
    }
    return existed;
  }

  /**
   * Await any pending debounced write, forcing it to happen immediately
   * rather than waiting out the debounce window. Test determinism only
   * -- production callers never need to await persistence, since a
   * write failure never affects {@link list}/{@link get} (see this
   * module's doc comment).
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pendingWrite = this.performWrite();
    }
    if (this.pendingWrite !== null) {
      await this.pendingWrite;
    }
  }

  private scheduleWrite(): void {
    if (this._isReadOnly) {
      return;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pendingWrite = this.performWrite();
    }, this.debounceMs);
  }

  /**
   * Serialize the *current* in-memory roster to a temp file in the same
   * directory as {@link filePath} and rename it into place -- the
   * atomic-write pattern this module's doc comment describes. Never
   * throws: any failure (creating the directory, writing the temp file,
   * or renaming it) is caught and logged via `console.warn`, leaving the
   * in-memory state -- and the previously-written file, if any --
   * untouched.
   */
  private async performWrite(): Promise<void> {
    if (this._isReadOnly) {
      return;
    }
    const payload: KnownRobotsFile = {
      version: CURRENT_KNOWN_ROBOTS_VERSION,
      robots: this.list(),
    };
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await this.mkdirFn(dir);
      await this.writeFileFn(tmpPath, JSON.stringify(payload, null, 2));
      await this.renameFn(tmpPath, this.filePath);
    } catch (error) {
      console.warn(
        `KnownRobotsStore: failed to persist "${this.filePath}" -- ${errorMessage(error)}`,
      );
    }
  }
}
