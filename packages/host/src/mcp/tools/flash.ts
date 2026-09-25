/**
 * mcp/tools/flash.ts — `request_flash`: the MCP subsystem's flash
 * category (sprint 019 ticket 008; SUC-007; `sprint.md`'s own module
 * table: "`mcp/tools/flash.ts` — *purpose*: validate a flash target and
 * execute the flash immediately. *Boundary*: on valid input, calls the
 * extracted `startFlash` function directly — no queuing, no
 * intermediate row — awaits its terminal outcome ..., calls
 * `agentActionLog.record()` with that outcome, and returns it to the
 * caller; never calls `connect/flasher.ts` a second, divergent way.").
 *
 * ## No gate — read this before touching this file
 *
 * This ticket's own filename is stale ("gated through the same
 * confirmation subsystem"); its contents were rewritten once Eric
 * overrode the approval design entirely (`sprint.md`'s Revision: "Let
 * the agents do whatever they want ... It's not hard [to reflash a
 * board]"). `request_flash` executes the moment a valid call arrives —
 * no pending row, no approval, no queue, no "confirm" flag, no
 * "dry run unless confirmed" mode. The precondition check below (is this
 * device flashable right now) is a *correctness* check — flashing needs
 * a real, currently-reachable target — never a permission check. Do not
 * add anything here that could hold a valid call back.
 *
 * ## One implementation, not two
 *
 * On valid input this file calls exactly `server.ts`'s own extracted
 * `startFlash` (handed down through `mcp/server.ts`'s own `McpDeps`,
 * which in turn gets it from `cli.ts`'s `mountRoutes` wiring — see
 * `server.ts`'s `MountRoutesExtra`/`StartFlashFn` doc comments) — the
 * same function `server.ts`'s own `flash-start` WS handler calls. There
 * is no second, MCP-specific way of starting a flash.
 *
 * ## The precondition check reuses `runFlashTask`'s own resolution, not
 * a second copy of it
 *
 * `sprint.md`'s SUC-007: "the same precondition `flash-start`'s existing
 * handler already checks — do not invent a new precondition set."
 * `deviceId` is translated to whichever of that device's own links is
 * currently a candidate to flash (`mbregistry` preferred, else `usb`, or
 * `mbserial`/`wifi`), then handed to `server.ts`'s own {@link resolveFlashLinkTarget} — the exact
 * function `runFlashTask` itself calls before ever touching
 * `board_owner`/`flasher.flash()`. A rejection here (no such device, no
 * candidate link, or `resolveFlashLinkTarget` itself refusing the link)
 * never calls `startFlash` at all — nothing is started, no
 * `agent_actions` row is written. This is deliberately a *second* call
 * to the same resolution `startFlash`'s own `runFlashTask` will make
 * again internally once actually invoked (a small, accepted TOCTOU gap,
 * not a correctness bug this ticket needs to close) — the alternative
 * would require `runFlashTask` to accept a pre-resolved target, a larger
 * restructuring than this ticket's own scope calls for.
 *
 * ## Awaiting `startFlash`'s own terminal promise (the ticket's own
 * distinctive design point)
 *
 * Unlike `mcp/tools/drive.ts`'s `sendCommand` (synchronous success-or-
 * throw), `startFlash`'s own promise is long-running — this function
 * `await`s it through to `{status: "ok"} | {status: "error", error}`
 * before responding, per `sprint.md`'s Design Rationale ("`request_flash`
 * awaits its own completion"): the `flash` snapshot overlay this
 * operation sets is deleted the instant it settles
 * (`finishFlash`/`failFlash`, `server.ts`), so a purely poll-based design
 * could poll a moment too late and see nothing at all. This is not a
 * reintroduction of the approval gate — nothing stands between the
 * precondition check passing and `startFlash` being invoked; only the
 * *response* waits for work that is already unconditionally under way.
 *
 * ## Audit write happens once, after the outcome is known (ticket 006)
 *
 * `mcp/agentActionLog.ts`'s `record()` is called exactly once per call
 * that reaches `startFlash`, after its promise settles — never before,
 * and never for a call rejected by the precondition check (nothing was
 * started, so there is nothing to audit). `params` carries `firmwareRef`
 * (the same free-form-JSON convention `mcp/tools/drive.ts` uses for its
 * own verb+fields).
 *
 * ## Empty-argument-safe schema (`.claude/rules/tool-call-empty-args.md`)
 *
 * `deviceId`/`firmwareRef` are both required with no optional companion
 * (`z.coerce.number().int()` / `z.enum([...])`), so a `{}` collapse (the
 * harness bug's worst case) fails Zod validation before this file's
 * handler ever runs — mirroring `mcp/tools/drive.ts`'s own
 * `linkId`/`verb` pattern exactly.
 *
 * ## Outliving a client timeout, and surviving a dropped connection
 * (ticket 021-004)
 *
 * A real flash can outlast a calling MCP client's own default timeout
 * (confirmed live in ticket 019-008: `tigez` flashed successfully but the
 * caller's own request timed out first). This function's own execution
 * is unconditional once `startFlash` is called — a timed-out or
 * disconnected caller changes nothing about what happens above; `record()`
 * still writes exactly one row with the real outcome. The durable
 * recovery path is already the "Audit write happens once" section
 * above: `get_device_status`'s own `recentAgentActions[0]`
 * (`mcp/tools/inspect.ts`, `projection.ts`'s `buildAgentActionActivity`).
 * This is the issue's own "Option 3: both" — inline outcome when the
 * client is still listening, durable audit row otherwise — and it
 * required no new plumbing; only this doc comment and the tool
 * `description` below (which used to point at the `flash` overlay, wrong
 * once it settles) needed correcting.
 *
 * Separately, `flash.test.ts`'s own disconnect-mid-flash test proves
 * (not just by reasoning) that when the caller's own connection is gone
 * by the time `startFlash`'s promise resolves, the SDK's own
 * `Protocol._onrequest` (`@modelcontextprotocol/sdk`'s
 * `shared/protocol.js`) already wraps the resulting undeliverable-
 * response failure in `.catch(error => this._onerror(...))` — it never
 * escapes as an uncaught exception or an unhandled rejection that could
 * crash this host process (which serves other agents' sessions
 * concurrently). That test exercises the exact failure the real
 * `StreamableHTTPServerTransport`'s `send()` throws in this situation
 * (`"No connection established for request ID"`), so no change was
 * needed here or in `server.ts` to harden this path — the SDK already
 * degrades safely.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveFlashLinkTarget, type FlashIdentity, type FlashResultLike, type StartFlashFn } from "../../server.js";
import type { DaplinkDeviceLister } from "../../devices.js";
import type { FirmwareKind, FirmwareSourceRef } from "../../wsMessages.js";
import type { Store } from "../../store/index.js";
import { record, type AgentActionLogStore } from "../agentActionLog.js";

/** The narrow slice of {@link Store} `request_flash` needs -- the
 * precondition check's own device/link read, plus
 * `mcp/agentActionLog.ts`'s own {@link AgentActionLogStore} need. */
export type FlashToolsStore = AgentActionLogStore & Pick<Store, "projectionRows">;

export interface FlashToolsDeps {
  readonly store: FlashToolsStore;
  /** See `server.ts`'s `MountRoutesExtra`/`StartFlashFn` doc comments. */
  readonly startFlash: StartFlashFn;
  /** The exact USB enumerator `startFlash` itself was built with -- see
   * this module's own doc comment, "The precondition check reuses
   * `runFlashTask`'s own resolution." */
  readonly enumerateDaplinkDevices: DaplinkDeviceLister;
}

/** Recorded in `agent_actions.caller` when this MCP session never
 * negotiated a `clientInfo.name` -- see `mcp/tools/drive.ts`'s own
 * identical constant/doc comment; `agent_actions.caller` is `NOT NULL`
 * (`migrations/0005-agent-actions.ts`). Not a gate of any kind: the
 * action already executed by the time this value is chosen. */
const UNKNOWN_CALLER = "unknown";

/** The three {@link FirmwareKind} values `request_flash` accepts --
 * kept as a literal tuple (not re-derived from the type) so `z.enum`
 * has a concrete value to validate against; `flash.test.ts` asserts
 * this stays exactly `FirmwareKind`'s own three members. Deliberately a
 * separate constant from `wsMessages.ts`'s own union (this file's
 * narrow-surface convention -- see this module's own doc comment): the
 * MCP tool surface names its own accepted values rather than importing
 * a type-derived list, so a future widening of `FirmwareKind` cannot
 * silently change what an agent can request without a corresponding
 * edit here. "joystick" (sprint 023, 2026-09-21) is included with no
 * context-based restriction -- an MCP-connected agent is not "on a
 * robot's device page", so it can already flash relay or robot firmware
 * onto any device today with no such restriction; joystick joins on the
 * same unrestricted footing. */
const FIRMWARE_KINDS = ["relay", "robot", "joystick"] as const;

function jsonResult(value: unknown, isError = false): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** See `mcp/tools/drive.ts`'s own `callerNameFrom` doc comment for why
 * this cannot simply be a shared import from `mcp/tools/connect.ts` --
 * that module's own version returns `string | null` (fine for a
 * `sessions.caller` column that allows `NULL`); `agent_actions.caller`
 * does not, so this file keeps its own null-collapsing copy, exactly as
 * `mcp/tools/drive.ts` does. */
function callerNameFrom(server: McpServer): string {
  return server.server.getClientVersion()?.name ?? UNKNOWN_CALLER;
}

/** Registers `request_flash` on `server`. See the module doc comment. */
export function registerFlashTools(server: McpServer, deps: FlashToolsDeps): void {
  server.registerTool(
    "request_flash",
    {
      title: "Request flash",
      description:
        "Flashes a device's firmware immediately: resolves `deviceId` to its currently flashable link (a directly " +
        "attached USB board, or a mbserial/wifi robot currently advertising _mbflash._tcp), rejects a device with no " +
        "such link right now with a plain-language reason and starts nothing, then -- on a valid target -- calls the " +
        "exact same startFlash path the console's own Flash button uses (session close-first, board_owner='flash' " +
        "acquire, flash, release in finally) immediately and unconditionally (there is no approval step anywhere in " +
        "this system). Awaits the flash through to its terminal outcome and returns it directly -- ok or error -- so " +
        "the calling agent needs no polling to learn the result; get_device_status's `flash` overlay shows interim " +
        "phase progress while the flash is under way, but is deleted the instant it settles -- it is not a fallback " +
        "for a dropped connection. A flash can outlast this call's own timeout (server-side execution is " +
        "unconditional and keeps going regardless): if this call's own connection drops or times out before the " +
        "response arrives, the flash still completed (or failed) and is durably recorded -- recover the real outcome " +
        "with a fresh get_device_status {deviceId} call afterward and read recentAgentActions[0] there (kind/caller/ " +
        "result/resultReason), rather than assuming a timeout means failure and retrying. This is the " +
        "highest-blast-radius tool in this surface: a bad flash can leave a board silent until reflashed (always " +
        "recoverable, but not free) -- use a device id you have just confirmed via list_devices/get_device_status.",
      inputSchema: {
        deviceId: z.coerce
          .number()
          .int()
          .describe("The target device's numeric id (devices.id), e.g. from list_devices/get_device_status's own `id` field."),
        firmwareRef: z.enum(FIRMWARE_KINDS).describe('Which firmware to flash -- "relay", "robot", or "joystick" (the fleet\'s own configured release for each).'),
      },
    },
    async ({ deviceId, firmwareRef }) => {
      const rows = deps.store.projectionRows();
      const device = rows.devices.find((candidate) => candidate.id === deviceId);
      if (device === undefined) {
        return jsonResult({ error: `no device with id ${deviceId} is currently known to this console` }, true);
      }
      // Sprint 018: `mbregistry` is preferred over every other
      // flashable transport for the same device -- a device with both a
      // live `mbregistry` link and a stale `usb`/`mbserial`/`wifi` one
      // (the common case once mbregistryWatcher replaces usbWatcher,
      // per `resolveFlashLinkTarget`'s own preference over a stale usb
      // link) should flash over the transport that's actually live.
      const candidateLinks = rows.links.filter(
        (candidate) =>
          candidate.deviceId === deviceId &&
          (candidate.transport === "mbregistry" ||
            candidate.transport === "usb" ||
            candidate.transport === "mbserial" ||
            candidate.transport === "wifi"),
      );
      const candidateLink =
        candidateLinks.find((candidate) => candidate.transport === "mbregistry") ?? candidateLinks[0];
      if (candidateLink === undefined) {
        return jsonResult({ error: `device ${deviceId} ("${device.name}") has no USB or network-flashable link right now` }, true);
      }
      const resolution = await resolveFlashLinkTarget(rows, candidateLink.id, { enumerateDaplinkDevices: deps.enumerateDaplinkDevices });
      if (!resolution.ok) {
        return jsonResult({ error: resolution.reason }, true);
      }

      const caller = callerNameFrom(server);
      const source: FirmwareSourceRef = { kind: "release", firmware: firmwareRef as FirmwareKind };
      const identity: FlashIdentity = { origin: "mcp", caller };
      const params = { firmwareRef };

      const outcome: FlashResultLike = await deps.startFlash(candidateLink.id, source, identity);
      const executedAt = Date.now();
      if (outcome.status === "ok") {
        record(deps.store, { kind: "flash", deviceId, params, caller, executedAt, result: "sent" });
        return jsonResult({ ok: true, deviceId, firmwareRef, linkId: candidateLink.id });
      }
      record(deps.store, { kind: "flash", deviceId, params, caller, executedAt, result: "failed", resultReason: outcome.error });
      return jsonResult({ error: outcome.error }, true);
    },
  );
}
