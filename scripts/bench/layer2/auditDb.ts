/**
 * auditDb.ts — 018-003 Step 0 hardening: a **database audit mode** so
 * Layer 2's truthfulness assertions can run against real, accumulated
 * state (the stakeholder's own `console.sqlite`, built up over many
 * sprints) rather than only a freshly-seeded scratch directory, which
 * can never reproduce a defect that only accumulates over time (a
 * duplicate device row from before sprints 016-017's merge-on-identify
 * fix; a radio link whose relay moved USB ports 14 hours ago and was
 * never re-resolved).
 *
 * ## Read-only, and never in place
 *
 * This module never opens the stakeholder's real state directory's
 * `console.sqlite` directly. {@link copyDatabaseForAudit} copies the
 * main file plus its `-wal`/`-shm` sidecars (if present — WAL mode
 * means recent writes can still live only in `-wal`; copying the main
 * file alone would silently lose them, not error) into a scratch
 * directory first; only that copy is ever opened, and always with
 * `node:sqlite`'s `{ readOnly: true }` (`store/db.ts`'s own
 * `openReadOnlyStoreDb`, which this module intentionally does **not**
 * import — see the module-boundary note below).
 *
 * ## Why raw SQL here, not `packages/host`'s `Store`/`dumpStore`
 *
 * `debug/dumpStore.ts` already wraps `openReadOnlyStoreDb` +
 * `Store.snapshotRows()` for exactly this "read the sqlite file
 * directly" need — but it is an explicitly-marked throwaway sprint-014
 * debugging affordance (its own `TODO(rearch-06)`), not a stable API,
 * and every other Layer 1/2 module in this harness deliberately talks
 * to the wire/wire-contract directly rather than importing host
 * internals (`layer1/lineReassembler.ts`'s own doc comment: "so a host
 * bug is never masked by sharing its parser"). The schema itself
 * (`store/migrations/0001-initial.ts`, mirrored in
 * `docs/design/architecture.md` §4) is the stable contract this module
 * reads against directly, via `node:sqlite`'s `DatabaseSync`, matching
 * that same boundary.
 *
 * ## What this checks
 *
 * 1. **One row per name** — same rule as {@link
 *    "./truthfulness.js".assertOneRowPerName}, run against real
 *    `devices` rows (which carry a real integer `id`, so a finding here
 *    can name the exact duplicate ids, e.g. "gopiv: ids 1461,
 *    2175407711").
 * 2. **Relay recorded as robot** — `kind = 'robot'` but `role` matches a
 *    relay banner token.
 * 3. **Would-be-hidden radio links** — a `radio`/`mbrelay` link whose
 *    `address` JSON names a `relayLinkId` that either doesn't exist
 *    among current `links` rows at all, or whose own `last_seen` is
 *    older than `ttlMs`; also flags the link itself when its *own*
 *    `last_seen`/`state_since` is older than `ttlMs` — a proper aging
 *    pass (ticket 005) would have hidden/retired it by now, so its
 *    continued presence on a card is exactly what "would be hidden"
 *    describes.
 * 4. **USB path mismatch** — a `radio`/`mbrelay` link whose
 *    `state_reason` text names a USB path/id that no longer matches its
 *    relay's *current* `address.path` — evidence the relay moved ports
 *    and this link's own failure text is now stale/misleading.
 */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Mirrors `mdnsWatcher.ts`'s own `DEFAULT_MBRELAY_TTL_MS` (180_000ms) —
 * duplicated, not imported (same host-internals boundary this module's
 * own doc comment explains throughout this harness). Radio/mbrelay
 * links are aged by the same watcher family, so this is the closest
 * existing precedent for "how old is too old to still trust," not an
 * invented number. */
export const DEFAULT_AUDIT_TTL_MS = 180_000;

/** Same relay-banner-role shape `layer1/index.ts`'s `classifyUsbDevice`
 * and `layer2/truthfulness.ts`'s `RELAY_ROLE_PATTERN` already use. */
const RELAY_ROLE_PATTERN = /^RADIO(BRIDGE|RELAY)$/i;

/** A USB device path or this project's own `usb-<serial>` link-id shape
 * (`connector.ts`'s `USB_LINK_ID_PREFIX`), as it can appear inside a raw
 * `state_reason` string. Global -- a single message can legitimately
 * mention both an opaque `usb-<serial>` link id and the actual `/dev/
 * cu....` path it dialed, so every mention is collected and checked
 * rather than only the first (positionally-first is not necessarily
 * "the" identifier the message is about). */
const USB_IDENTIFIER_PATTERN = /\/dev\/cu\.[A-Za-z0-9._-]+|usb-[0-9A-Za-z]+/g;

export interface AuditDeviceRow {
  id: number;
  name: string;
  kind: string;
  role: string | null;
  last_seen: number;
}

export interface AuditLinkRow {
  id: string;
  device_id: number | null;
  transport: string;
  address: string;
  state: string;
  state_reason: string | null;
  state_since: number;
  last_seen: number | null;
}

export type AuditCheck = "one-row-per-name" | "relay-as-robot" | "would-be-hidden-radio-link" | "usb-path-mismatch";

export interface AuditFinding {
  check: AuditCheck;
  device: string;
  detail: string;
}

export interface AuditReport {
  dbPath: string;
  generatedAt: string;
  deviceCount: number;
  linkCount: number;
  findings: AuditFinding[];
}

/**
 * Copy `console.sqlite` (and its `-wal`/`-shm` sidecars, if present)
 * from `sourcePath` into `destDir`, returning the copied main file's
 * path. Never opens or modifies `sourcePath` itself. `destDir` is
 * created if needed.
 */
export function copyDatabaseForAudit(sourcePath: string, destDir: string): string {
  if (!existsSync(sourcePath)) {
    throw new Error(`audit-db: source database does not exist: ${sourcePath}`);
  }
  const destPath = path.join(destDir, path.basename(sourcePath));
  copyFileSync(sourcePath, destPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${sourcePath}${suffix}`;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, `${destPath}${suffix}`);
    }
  }
  return destPath;
}

function safeParseAddress(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "One `devices` row per name" against real rows, naming the actual
 * duplicate ids (real audit evidence needs the concrete ids, unlike the
 * live-snapshot assertion this mirrors -- `truthfulness.ts`'s
 * `assertOneRowPerName`). */
export function findDuplicateNameFindings(devices: readonly AuditDeviceRow[]): AuditFinding[] {
  const byName = new Map<string, AuditDeviceRow[]>();
  for (const device of devices) {
    const bucket = byName.get(device.name) ?? [];
    bucket.push(device);
    byName.set(device.name, bucket);
  }
  const findings: AuditFinding[] = [];
  for (const [name, rows] of byName) {
    if (rows.length > 1) {
      findings.push({
        check: "one-row-per-name",
        device: name,
        detail: `${rows.length} devices rows share the name "${name}": ids ${rows.map((r) => r.id).join(", ")}`,
      });
    }
  }
  return findings;
}

/** "Relay recorded as robot" against real rows -- same rule as
 * `truthfulness.ts`'s `assertNoRelayAsRobot`'s own-role check. */
export function findRelayAsRobotFindings(devices: readonly AuditDeviceRow[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const device of devices) {
    if (device.kind === "robot" && device.role !== null && RELAY_ROLE_PATTERN.test(device.role)) {
      findings.push({
        check: "relay-as-robot",
        device: device.name,
        detail: `device id ${device.id} ("${device.name}") is recorded kind:"robot" but role "${device.role}" is a relay banner role`,
      });
    }
  }
  return findings;
}

/**
 * Radio/mbrelay links whose relay is missing/stale, or whose own last
 * success/sighting is older than `ttlMs` -- reported as "would be
 * hidden" (a working aging pass would already have retired these).
 */
export function findWouldBeHiddenRadioLinkFindings(
  devices: readonly AuditDeviceRow[],
  links: readonly AuditLinkRow[],
  nowMs: number,
  ttlMs: number = DEFAULT_AUDIT_TTL_MS,
): AuditFinding[] {
  const linksById = new Map(links.map((l) => [l.id, l]));
  const deviceNameById = new Map(devices.map((d) => [d.id, d.name]));
  const findings: AuditFinding[] = [];

  for (const link of links) {
    if (link.transport !== "radio" && link.transport !== "mbrelay") {
      continue;
    }
    const deviceName = link.device_id !== null ? (deviceNameById.get(link.device_id) ?? `(device ${link.device_id})`) : `(link ${link.id}, no device)`;
    const address = safeParseAddress(link.address);
    const relayLinkId = typeof address.relayLinkId === "string" ? address.relayLinkId : undefined;

    if (relayLinkId !== undefined) {
      const relayLink = linksById.get(relayLinkId);
      if (relayLink === undefined) {
        findings.push({
          check: "would-be-hidden-radio-link",
          device: deviceName,
          detail: `link "${link.id}" names relay link "${relayLinkId}", which no longer exists`,
        });
        continue;
      }
      const relayLastActivity = relayLink.last_seen ?? relayLink.state_since;
      const relayAgeMs = nowMs - relayLastActivity;
      if (relayLink.state === "stale" || relayAgeMs > ttlMs) {
        findings.push({
          check: "would-be-hidden-radio-link",
          device: deviceName,
          detail: `link "${link.id}"'s relay link "${relayLinkId}" is ${relayLink.state === "stale" ? "stale" : `${Math.round(relayAgeMs / 1000)}s old (TTL ${Math.round(ttlMs / 1000)}s)`}`,
        });
        continue;
      }
    }

    const ownLastActivity = link.last_seen ?? link.state_since;
    const ownAgeMs = nowMs - ownLastActivity;
    if (ownAgeMs > ttlMs) {
      findings.push({
        check: "would-be-hidden-radio-link",
        device: deviceName,
        detail: `link "${link.id}" last success/sighting was ${Math.round(ownAgeMs / 1000)}s ago (TTL ${Math.round(ttlMs / 1000)}s) -- would be hidden by a working aging pass`,
      });
    }
  }
  return findings;
}

/**
 * A radio/mbrelay link whose `state_reason` names a USB path/id that no
 * longer matches its relay's *current* `address.path` -- evidence the
 * relay moved ports since this link's failure text was last written.
 */
export function findUsbPathMismatchFindings(devices: readonly AuditDeviceRow[], links: readonly AuditLinkRow[]): AuditFinding[] {
  const linksById = new Map(links.map((l) => [l.id, l]));
  const deviceNameById = new Map(devices.map((d) => [d.id, d.name]));
  const findings: AuditFinding[] = [];

  for (const link of links) {
    if (link.transport !== "radio" && link.transport !== "mbrelay") {
      continue;
    }
    if (link.state_reason === null) {
      continue;
    }
    const mentions = [...link.state_reason.matchAll(USB_IDENTIFIER_PATTERN)].map((m) => m[0]);
    if (mentions.length === 0) {
      continue;
    }
    const address = safeParseAddress(link.address);
    const relayLinkId = typeof address.relayLinkId === "string" ? address.relayLinkId : undefined;
    const relayLink = relayLinkId !== undefined ? linksById.get(relayLinkId) : undefined;
    if (relayLink === undefined) {
      continue;
    }
    const relayAddress = safeParseAddress(relayLink.address);
    const currentPath = typeof relayAddress.path === "string" ? relayAddress.path : undefined;
    if (currentPath === undefined) {
      continue;
    }
    const anyMentionMatchesCurrent = mentions.some((m) => m === currentPath || currentPath.includes(m) || m.includes(currentPath));
    if (!anyMentionMatchesCurrent) {
      const deviceName = link.device_id !== null ? (deviceNameById.get(link.device_id) ?? `(device ${link.device_id})`) : `(link ${link.id}, no device)`;
      const mentioned = mentions.find((m) => m.startsWith("/dev/cu.")) ?? mentions[0]!;
      findings.push({
        check: "usb-path-mismatch",
        device: deviceName,
        detail: `link "${link.id}"'s state_reason names "${mentioned}", but its relay link "${relayLinkId}" currently reports "${currentPath}"`,
      });
    }
  }
  return findings;
}

/** Run every audit check against already-loaded rows and concatenate
 * their findings -- pure, so the whole check suite is testable against
 * fixture rows without any real database. */
export function runAuditChecks(
  devices: readonly AuditDeviceRow[],
  links: readonly AuditLinkRow[],
  options: { nowMs?: number; ttlMs?: number } = {},
): AuditFinding[] {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_AUDIT_TTL_MS;
  return [
    ...findDuplicateNameFindings(devices),
    ...findRelayAsRobotFindings(devices),
    ...findWouldBeHiddenRadioLinkFindings(devices, links, nowMs, ttlMs),
    ...findUsbPathMismatchFindings(devices, links),
  ];
}

/**
 * Open `dbPath` read-only (`node:sqlite`'s `DatabaseSync`, never
 * creating or migrating it), read every `devices`/`links` row, run
 * every audit check, and close the connection before returning --
 * whether or not reading/checking throws. Callers are responsible for
 * pointing `dbPath` at a copy (see {@link copyDatabaseForAudit}), never
 * the stakeholder's live state directory.
 */
export function auditDatabase(dbPath: string, options: { nowMs?: number; ttlMs?: number } = {}): AuditReport {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const devices = db.prepare("SELECT id, name, kind, role, last_seen FROM devices").all() as unknown as AuditDeviceRow[];
    const links = db
      .prepare("SELECT id, device_id, transport, address, state, state_reason, state_since, last_seen FROM links")
      .all() as unknown as AuditLinkRow[];
    return {
      dbPath,
      generatedAt: new Date().toISOString(),
      deviceCount: devices.length,
      linkCount: links.length,
      findings: runAuditChecks(devices, links, options),
    };
  } finally {
    db.close();
  }
}
