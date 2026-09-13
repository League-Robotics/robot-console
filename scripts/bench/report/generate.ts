#!/usr/bin/env -S npx tsx
/**
 * generate.ts — the report generator: reads Layer 1/2/3's own JSON
 * reports and produces one committed-format Markdown file, one row per
 * robot x path, with each layer's pass/fail, a failure reason, and
 * screenshot links — "the artifact every subsequent ticket in this
 * sprint (004-011) cites as its harness evidence" (this ticket's own
 * acceptance criterion).
 *
 * ## Labeling rule (sprint.md's own framing, restated precisely here)
 *
 * - **`environment`**: Layer 1 itself failed (or was skipped due to
 *   exclusivity) — the path is not reachable at the device level at
 *   all, so nothing above Layer 1 was even attempted. A `skipped`
 *   Layer 1 result (another process held the resource) is its own
 *   `skipped` label, distinct from a genuine `fail` — see
 *   {@link labelRow}'s own doc comment for why conflating the two would
 *   misrepresent an inconclusive run as a confirmed environment fact.
 * - **`defect`**: Layer 1 passed, but Layer 2 or Layer 3 did not
 *   (`fail`) — a host/UI bug, not an environment fact, per this
 *   sprint's own non-negotiable framing.
 * - **`skipped`**: some layer's own path row was itself `skipped`
 *   (held by another process at that layer's own run time) — distinct
 *   from `defect`/`environment`, since nothing was actually proven
 *   either way.
 * - **`pass`**: every layer that ran for this path passed.
 *
 * Only the four transports Layer 2/3 recognize (`usb`, `mbserial`,
 * `wifi`, `radio-via-mbrelay:<pool>`) appear in the main table — a
 * relay pool's own status-check row or the `mbserial-contention`
 * demonstration path are Layer-1-only diagnostics, listed in their own
 * "Additional Layer 1 findings" section instead (see {@link
 * isMainTablePath}).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Layer1Report, ProbeStatus } from "../layer1/types.js";
import type { Layer2Report, Layer2Status } from "../layer2/types.js";
import type { Layer3Report, Layer3Status } from "../layer3/types.js";

export type RowStatus = ProbeStatus | Layer2Status | Layer3Status | "n/a";
export type RowLabel = "pass" | "defect" | "environment" | "skipped";

export interface ReportRow {
  device: string;
  path: string;
  l1: RowStatus;
  l2: RowStatus;
  l3: RowStatus;
  reason: string;
  screenshots: string[];
}

/** The exact four transport path shapes Layer 2/3 recognize as "a
 * robot reached over this transport" (mirrors Layer 2's own
 * `targetForPath` filter) — everything else (a relay pool's own `?`
 * status-check row, the `mbserial-contention` demonstration) is a
 * Layer-1-only diagnostic, not a robot x path row. */
export function isMainTablePath(path: string): boolean {
  return path === "usb" || path === "mbserial" || path === "wifi" || /^radio-via-mbrelay:.+$/.test(path);
}

/**
 * Decide one row's label from its three layers' own statuses (`"n/a"`
 * when that layer never produced a row for this path at all — either
 * it wasn't run, or an earlier layer's failure meant a later layer
 * never got the chance to attempt it). Pure — this is the exact rule
 * the ticket's own acceptance criteria and `sprint.md`'s framing
 * describe, directly testable against every combination without any
 * report file.
 *
 * `skipped` at *any* layer that ran wins over `pass`/`fail` at a later
 * layer that also ran (an inconclusive result should never be reported
 * as a confirmed defect or a confirmed pass) — but never over an
 * *earlier* layer's own outcome (a Layer 1 `fail` is `environment`
 * regardless of what any later, never-attempted layer's field happens
 * to hold).
 */
export function labelRow(l1: RowStatus, l2: RowStatus, l3: RowStatus): RowLabel {
  if (l1 === "skipped") {
    return "skipped";
  }
  if (l1 === "fail") {
    return "environment";
  }
  // l1 === "pass" from here on.
  if (l2 === "skipped") {
    return "skipped";
  }
  if (l2 === "fail") {
    return "defect";
  }
  // l2 is "pass" or "n/a" (never attempted/reported) from here on.
  if (l3 === "skipped") {
    return "skipped";
  }
  if (l3 === "fail") {
    return "defect";
  }
  return "pass";
}

/** Every device x path row from Layer 1 that belongs in the main table
 * (per {@link isMainTablePath}), joined with Layer 2/3's own verdicts
 * for the same (device, path) pair when present. Pure given already-
 * parsed reports. */
export function buildRows(layer1: Layer1Report, layer2?: Layer2Report, layer3?: Layer3Report): ReportRow[] {
  const rows: ReportRow[] = [];

  for (const device of layer1.devices) {
    // A relay pool's own `?` status-check row shares the same
    // `radio-via-mbrelay:<pool>` path *label* as a real robot reached
    // through it, distinguished only by `kind: "pool"` -- mirrors
    // Layer 2's own `targetForPath`'s `deviceKind !== "pool"` guard, so
    // the pool's own diagnostic row never masquerades as a robot x path
    // result here either.
    if (device.kind === "pool") {
      continue;
    }
    for (const l1Path of device.paths) {
      if (!isMainTablePath(l1Path.path)) {
        continue;
      }
      const l2Device = layer2?.devices.find((d) => d.name === device.name);
      const l2Entry = l2Device?.paths.find((p) => p.path === l1Path.path);
      const l3Entry = layer3?.results.find((r) => r.device === device.name && r.path === l1Path.path);

      const l1: RowStatus = l1Path.status;
      const l2: RowStatus = l2Entry?.layer2.status ?? "n/a";
      const l3: RowStatus = l3Entry?.status ?? "n/a";

      const reason = l1 !== "pass" ? l1Path.reason : l2 !== "pass" && l2 !== "n/a" ? (l2Entry?.layer2.reason ?? "") : l3 !== "pass" && l3 !== "n/a" ? (l3Entry?.reason ?? "") : "-";

      rows.push({
        device: device.name,
        path: l1Path.path,
        l1,
        l2,
        l3,
        reason,
        screenshots: l3Entry?.screenshots ?? [],
      });
    }
  }

  return rows.sort((a, b) => a.device.localeCompare(b.device) || a.path.localeCompare(b.path));
}

function statusCell(status: RowStatus): string {
  return status === "n/a" ? "n/a" : status;
}

function screenshotLinks(row: ReportRow, layer3?: Layer3Report): string {
  if (row.screenshots.length === 0 || layer3 === undefined) {
    return "";
  }
  return row.screenshots.map((file, i) => `[${i + 1}](${path.join(layer3.screenshotDir, file)})`).join(" ");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Render the full Markdown report: the main per-robot-x-path table,
 * then a truthfulness-assertions section (live snapshot, plus
 * `--audit-db` findings when Layer 2 ran with that flag), then
 * "Additional Layer 1 findings" (pool status rows, mbserial-contention)
 * and holders/skips. Pure given already-parsed reports.
 */
export function generateMarkdown(layer1: Layer1Report, layer2?: Layer2Report, layer3?: Layer3Report): string {
  const rows = buildRows(layer1, layer2, layer3);
  const lines: string[] = [];

  lines.push("# Bench harness report");
  lines.push("");
  lines.push(`Generated from Layer 1 run ${layer1.startedAt} - ${layer1.finishedAt}${layer2 ? `, Layer 2 run ${layer2.startedAt} - ${layer2.finishedAt}` : ""}${layer3 ? `, Layer 3 run ${layer3.startedAt} - ${layer3.finishedAt}` : ""}.`);
  lines.push("");

  lines.push("## Robot x path results");
  lines.push("");
  lines.push("| device | path | L1 | L2 | L3 | label | reason | screenshots |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const label = labelRow(row.l1, row.l2, row.l3);
    lines.push(
      `| ${row.device} | ${row.path} | ${statusCell(row.l1)} | ${statusCell(row.l2)} | ${statusCell(row.l3)} | ${label} | ${escapeCell(row.reason)} | ${screenshotLinks(row, layer3)} |`,
    );
  }
  lines.push("");

  const passCount = rows.filter((r) => labelRow(r.l1, r.l2, r.l3) === "pass").length;
  const defectCount = rows.filter((r) => labelRow(r.l1, r.l2, r.l3) === "defect").length;
  const environmentCount = rows.filter((r) => labelRow(r.l1, r.l2, r.l3) === "environment").length;
  const skippedCount = rows.filter((r) => labelRow(r.l1, r.l2, r.l3) === "skipped").length;
  lines.push(`${rows.length} row(s): ${passCount} pass, ${defectCount} defect, ${environmentCount} environment, ${skippedCount} skipped.`);
  lines.push("");

  lines.push("## Truthfulness assertions (live snapshot)");
  lines.push("");
  if (layer2 === undefined) {
    lines.push("_Layer 2 did not run._");
  } else if (layer2.assertions.length === 0) {
    lines.push("_No assertions recorded._");
  } else {
    lines.push("| assertion | device | pass | reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const a of layer2.assertions) {
      lines.push(`| ${a.assertion} | ${a.device} | ${a.pass ? "pass" : "FAIL"} | ${escapeCell(a.reason)} |`);
    }
  }
  lines.push("");

  lines.push("## Database audit (--audit-db)");
  lines.push("");
  if (layer2?.auditDb === undefined) {
    lines.push("_Not run (pass --audit-db <path> to Layer 2 / run.sh to enable)._");
  } else {
    const audit = layer2.auditDb;
    lines.push(`Audited a read-only copy of \`${audit.sourcePath}\` (${audit.deviceCount} device row(s), ${audit.linkCount} link row(s)).`);
    lines.push("");
    if (audit.findings.length === 0) {
      lines.push("_No findings._");
    } else {
      lines.push("| check | device | detail |");
      lines.push("| --- | --- | --- |");
      for (const f of audit.findings) {
        lines.push(`| ${f.check} | ${f.device} | ${escapeCell(f.detail)} |`);
      }
    }
  }
  lines.push("");

  lines.push("## Additional Layer 1 findings");
  lines.push("");
  const otherPaths = layer1.devices.flatMap((d) =>
    d.paths.filter((p) => d.kind === "pool" || !isMainTablePath(p.path)).map((p) => ({ device: d.name, kind: d.kind, ...p })),
  );
  if (otherPaths.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| device | kind | path | status | reason |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const p of otherPaths) {
      lines.push(`| ${p.device} | ${p.kind} | ${p.path} | ${p.status} | ${escapeCell(p.reason)} |`);
    }
  }
  lines.push("");

  lines.push("## Holders / skips");
  lines.push("");
  if (layer1.holders.length === 0) {
    lines.push("_No resources held by another process at Layer 1 run time._");
  } else {
    lines.push("| resource | pid | command |");
    lines.push("| --- | --- | --- |");
    for (const h of layer1.holders) {
      lines.push(`| ${h.resource} | ${h.pid} | ${h.command} |`);
    }
  }
  if (layer2 !== undefined && layer2.settle.neverAppeared.length > 0) {
    lines.push("");
    lines.push(`Layer 2: link(s) that never appeared in any snapshot within the settle bound: ${layer2.settle.neverAppeared.join(", ")}.`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---- CLI entry point ----------------------------------------------------

interface CliOptions {
  layer1Path: string;
  layer2Path: string | undefined;
  layer3Path: string | undefined;
  outPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let layer1Path = path.join(process.cwd(), "bench-layer1-report.json");
  let layer2Path: string | undefined;
  let layer3Path: string | undefined;
  let outPath = path.join(process.cwd(), "bench-report.md");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--layer1") {
      layer1Path = argv[++i] ?? layer1Path;
    } else if (arg === "--layer2") {
      layer2Path = argv[++i];
    } else if (arg === "--layer3") {
      layer3Path = argv[++i];
    } else if (arg === "--out") {
      outPath = argv[++i] ?? outPath;
    }
  }
  return { layer1Path, layer2Path, layer3Path, outPath };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const layer1: Layer1Report = JSON.parse(readFileSync(options.layer1Path, "utf8"));
  const layer2: Layer2Report | undefined = options.layer2Path && existsSync(options.layer2Path) ? JSON.parse(readFileSync(options.layer2Path, "utf8")) : undefined;
  const layer3: Layer3Report | undefined = options.layer3Path && existsSync(options.layer3Path) ? JSON.parse(readFileSync(options.layer3Path, "utf8")) : undefined;

  const markdown = generateMarkdown(layer1, layer2, layer3);
  mkdirSync(path.dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, markdown, "utf8");
  console.log(`[bench:report] wrote report to ${options.outPath}`);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}

export { main, parseArgs };
