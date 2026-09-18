/**
 * mcp/tools/inspect.ts — `list_devices` / `get_device_status`: the MCP
 * subsystem's read-only inspect category (sprint 019 ticket 004, SUC-004;
 * `sprint.md`'s own module table: "`mcp/tools/inspect.ts` — *purpose*:
 * answer read-only questions about devices, links, and status. *Boundary*:
 * calls the store's existing typed read operations and the same
 * projection shape `server.ts`'s snapshot uses; writes nothing.").
 *
 * Both tools read through {@link buildSnapshotFromRows} — the exact same
 * pure `(rows, seq, at) -> Snapshot` map `projection.ts` hands the
 * browser's own `server.ts` broadcast (that module's own doc comment) —
 * so no field either tool returns can ever disagree with what the
 * browser's own page shows for the same store state (this ticket's own
 * acceptance criterion). `seq`/`at` are meaningless for a point-in-time
 * MCP read (neither affects `devices`/`unassigned`, per `projection.ts`'s
 * own doc comment: they exist purely for the broadcast wire contract's
 * gap-detection counter and wall-clock stamp) — `0`/`Date.now()` here are
 * placeholders never surfaced to an MCP caller.
 *
 * ## No side effects, structurally enforced
 *
 * {@link InspectStore} is `Pick<Store, "projectionRows">` — mirroring
 * `connect/flasher.ts`'s own `FlasherStore` narrowing convention (that
 * module's own doc comment) — so this file could not call a write method
 * on `store` even by accident: the type simply does not expose one. This
 * is the acceptance criterion "no field disagrees with the store" and the
 * store's own architecture.md §3 rule ("nothing outside `store/` issues
 * SQL") applied one level up: nothing outside `store/` even *has* a write
 * seam unless a module's own dependency type grants it one, and this
 * module's grants none.
 *
 * ## Schema design against the harness's empty-argument bug
 *
 * `.claude/rules/tool-call-empty-args.md` documents a confirmed harness
 * bug in this project: a tool call carrying *any* empty (`""`) or null/
 * omitted argument causes the harness to silently drop *every* argument,
 * so the tool receives `{}` instead. Both tools here are designed so that
 * shape is either the only valid input or is caught cleanly, never
 * silently misinterpreted:
 *
 * - `list_devices` takes **no arguments at all** (no `inputSchema` key).
 *   There is no optional field for the bug to ever touch — a `{}` call is
 *   this tool's only valid input, not a degraded one.
 * - `get_device_status` takes exactly **one required** field (`name`,
 *   `z.string().min(1)`, no optional companion field). A call that
 *   arrives as `{}` (the bug's worst case) fails Zod validation before
 *   this file's own handler ever runs, surfacing a clear "Required" tool
 *   error instead of silently listing the wrong device or crashing —
 *   `inspect.test.ts` asserts this directly. There is deliberately no
 *   second, optional `id` field alongside `name` (the ticket's own
 *   "`{name}` (or `{id}`)" phrasing permits either, not both at once):
 *   a single required field is exactly what the ticket's own guidance
 *   prefers over "an optional field with no value."
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildSnapshotFromRows } from "../../projection.js";
import type { Store } from "../../store/index.js";
import type { SnapshotDevice, SnapshotLink } from "../../wsMessages.js";

/** The narrow slice of {@link Store} this module needs — see the module
 * doc comment's "No side effects, structurally enforced" section. A real
 * {@link Store} satisfies this structurally; `inspect.test.ts` uses a
 * plain fake object with only this one method. */
export type InspectStore = Pick<Store, "projectionRows">;

function currentFleet(store: InspectStore): { devices: readonly SnapshotDevice[]; unassigned: readonly SnapshotLink[] } {
  const snapshot = buildSnapshotFromRows(store.projectionRows(), 0, Date.now());
  return { devices: snapshot.devices, unassigned: snapshot.unassigned };
}

function jsonResult(value: unknown, isError = false): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** Registers `list_devices`/`get_device_status` on `server`. Both are
 * read-only over `store` — see the module doc comment. */
export function registerInspectTools(server: McpServer, store: InspectStore): void {
  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description:
        "Lists every known device (robot or relay) with its current links, plus " +
        "any unassigned (not-yet-identified) USB boards -- the same rows the " +
        "robot console's own browser page shows for the fleet right now. " +
        "Read-only: never opens a session, takes a relay lease, or writes " +
        "anything. Takes no arguments.",
    },
    async () => jsonResult(currentFleet(store)),
  );

  server.registerTool(
    "get_device_status",
    {
      title: "Get device status",
      description:
        "Single-device detail by name -- current link states and, for any link " +
        "with an open session, its robotStatus/functions -- the same rows the " +
        "device's own console card shows. Read-only: never opens a session, " +
        "takes a relay lease, or writes anything.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('The device\'s five-letter name as shown on the console, e.g. "vevov". Required -- do not omit or send an empty string.'),
      },
    },
    async ({ name }) => {
      const { devices } = currentFleet(store);
      const device = devices.find((candidate) => candidate.name === name);
      if (device === undefined) {
        return jsonResult({ error: `no device named "${name}" is currently known to this console` }, true);
      }
      return jsonResult(device);
    },
  );
}
