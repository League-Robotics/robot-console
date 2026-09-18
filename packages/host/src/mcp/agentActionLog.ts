/**
 * mcp/agentActionLog.ts — durably records every MCP-executed `drive`/
 * `flash` action so it is attributable to its caller live and after the
 * fact (sprint 019 ticket 006; SUC-006/SUC-007; `sprint.md`'s own module
 * table: "`mcp/agentActionLog.ts` — *purpose*: durably record every
 * MCP-executed drive or flash action so it is attributable to its caller
 * live and after the fact").
 *
 * ## Visibility, not permission
 *
 * This ticket is the one piece of the sprint's original (and rejected)
 * authorization/confirmation design that survives: Eric's own original
 * ask for the whole MCP feature was that an agent's connection "shows up
 * in the robot console," not that it be gated. He was shown the
 * unattended-harm framing twice and declined a gate both times ("Let the
 * agents do whatever they want ... It's not hard [to reflash a board]"
 * — `sprint.md`'s Revision). Every row this module ever writes already
 * happened (or was attempted and failed, `result: "failed"`) — there is
 * nothing here that blocks, delays, queues, or requires approval, and
 * nothing should ever be added to this module that does. `record()` is
 * called only *after* `mcp/tools/drive.ts`/`mcp/tools/flash.ts` (tickets
 * 007/008) have already executed the action through the same extracted,
 * WS-independent functions the browser path calls (`sendCommand`,
 * `startFlash`) — this module never calls `connect/connector.ts`/
 * `connect/flasher.ts` itself, and it never sits between a call arriving
 * and the action executing.
 *
 * ## One write shape serves both an instant send and an awaited flash
 *
 * `record()` takes a single, already-complete {@link RecordAgentActionInput}
 * and writes exactly one row, once. This is deliberately timing-agnostic:
 * a `drive` action resolves synchronously (`sendCommand` either sends or
 * throws), so `mcp/tools/drive.ts` calls `record()` immediately after;
 * a `flash` action is long-running (`sprint.md`'s Design Rationale:
 * `request_flash` awaits `startFlash`'s own terminal promise rather than
 * returning an immediate acknowledgement), so `mcp/tools/flash.ts` calls
 * `record()` only once that promise resolves, with the now-known
 * `result`/`resultReason`. Neither caller writes a row before the
 * outcome is known, and neither ever updates a row afterward — there is
 * no two-phase write (a "start" row later patched to "done") anywhere in
 * this module, which is exactly what would smuggle a lifecycle/status
 * concept back in under another name. See `migrations/0005-agent-actions
 * .ts`'s own doc comment for the schema this rests on.
 *
 * ## No SQL here
 *
 * Every read/write below delegates to {@link Store} (`recordAgentAction`/
 * `recentAgentActions`) — this file issues no raw SQLite statement of its
 * own, per architecture.md §3's "nothing outside `store/` issues SQL"
 * rule (`store/noRawSqlOutsideStore.test.ts` enforces this across the
 * whole of `packages/host/src`, not just this file).
 */
import type { AgentActionKind, AgentActionResult, AgentActionRow, RecordAgentActionInput, Store } from "../store/index.js";

export type { AgentActionKind, AgentActionResult, AgentActionRow, RecordAgentActionInput };

/** The narrow slice of {@link Store} this module needs — mirrors
 * `connect/sessionOps.ts`'s own `SessionOpsStore` narrowing convention. */
export type AgentActionLogStore = Pick<Store, "recordAgentAction" | "recentAgentActions">;

/** One already-complete action to record — see this module's doc
 * comment ("One write shape serves both..."). An alias of
 * {@link RecordAgentActionInput} under this module's own name, since
 * `mcp/tools/drive.ts`/`mcp/tools/flash.ts` reach this module, not
 * `store/index.ts`, to record an action. */
export type AgentActionEntry = RecordAgentActionInput;

/** Which link or device {@link recentFor} reads for — exactly one of the
 * two, never both (a caller that wants "everything touching this device,
 * including its links' own `drive` rows" — as `store/index.ts`'s
 * `projectionRows` does for the console's own "Recent agent activity"
 * list — calls this once per target and merges the results itself). */
export type AgentActionTarget = { readonly linkId: string } | { readonly deviceId: number };

/**
 * Writes exactly one `agent_actions` row for `entry` and returns its
 * `id`. Never writes to `links`, `sessions`, `board_owner`, or
 * `relay_leases` — a pure audit write, nothing else. Called by
 * `mcp/tools/drive.ts` immediately after a `sendCommand` call resolves
 * (success or throw), and by `mcp/tools/flash.ts` once `startFlash`'s
 * own terminal promise resolves — both callers already know `result`/
 * `resultReason` by the time they call this; `record()` itself makes no
 * decision about either.
 */
export function record(store: AgentActionLogStore, entry: AgentActionEntry): number {
  return store.recordAgentAction(entry);
}

/**
 * The most recent `limit` `agent_actions` rows for a single link or
 * device, newest first — the read the console's "Recent agent activity"
 * list is ultimately backed by (via `store/index.ts`'s own
 * `projectionRows`, which calls the same underlying {@link
 * Store.recentAgentActions} directly rather than through this module, to
 * keep `projection.ts` free of any dependency on `mcp/*` — see
 * `sprint.md`'s own "mcp/* → existing store/connect/*, never the
 * reverse" dependency-direction note). Exposed here as the MCP-facing
 * primitive future tooling (or a test exercising this module in
 * isolation) reaches for, rather than going around this module straight
 * to the store.
 */
export function recentFor(store: AgentActionLogStore, target: AgentActionTarget, limit: number): readonly AgentActionRow[] {
  return store.recentAgentActions(target, limit);
}
