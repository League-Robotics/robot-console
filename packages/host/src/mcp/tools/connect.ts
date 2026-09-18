/**
 * mcp/tools/connect.ts — `open_session`/`close_session`/`send_command`:
 * the MCP subsystem's connect-and-command category (sprint 019 ticket
 * 005, SUC-005; `sprint.md`'s own module table: "`mcp/tools/connect.ts`
 * -- *purpose*: open/close a session and send a non-motion command on
 * behalf of an MCP caller. *Boundary*: calls the same reconciler/
 * connector entry points a browser's `session-open`/`send-command`
 * already calls ... never opens a raw transport itself.").
 *
 * ## One implementation, not two
 *
 * All three tools below call `connect/sessionOps.ts`'s own
 * `openSession`/`closeSession`/`requireSession`/`sendCommand` --
 * exactly the same WS-independent functions `server.ts`'s
 * `session-open`/`session-close`/`send-command` WS handlers call. See
 * that module's own doc comment for the full extraction rationale; this
 * file adds nothing to "how a session is opened/closed/commanded" --
 * only the MCP-specific concerns a browser session never has: caller
 * identity, the gated-verb check, and Zod input shaping.
 *
 * ## Caller identity (SUC-005)
 *
 * `open_session` tags the session it opens with `origin: "mcp"` and
 * `caller: <clientInfo.name>` -- the MCP client's own declared name from
 * its `initialize` handshake. Reading that name back out at `tools/call`
 * time is not simply `server.server.getClientVersion()`: this project's
 * `mcp/server.ts` mounts a *stateless* Streamable HTTP endpoint (ticket
 * 004) where, absent session continuity, every POST gets a brand-new
 * `McpServer`, so a `tools/call` POST's own ephemeral server never
 * itself processed the `initialize` request and `getClientVersion()`
 * would read back `undefined` -- confirmed empirically against the real
 * SDK's `StreamableHTTPClientTransport`/`Client` before writing this
 * file (three separate POSTs for initialize / initialized / tools/call,
 * each a fresh ephemeral server under the ticket-004 architecture).
 * `mcp/server.ts`'s own doc comment anticipated exactly this ("ticket
 * 005's connect/command tools are the first to need any session
 * concept ... revisit this choice") -- this ticket revisits it by
 * having `startMcpServer` reuse one `McpServer`/transport pair for the
 * lifetime of an MCP session (keyed by the SDK's own `Mcp-Session-Id`),
 * so the same `Server` instance that processed `initialize` is still the
 * one `getClientVersion()` is read from on a later `tools/call`. See
 * `mcp/server.ts`'s own doc comment for that mechanism; this module only
 * consumes the result via {@link callerNameFrom}.
 *
 * ## Gated motion verbs (SUC-005's own acceptance criterion)
 *
 * `send_command` rejects the seven motion-*starting* verbs named in
 * `sprint.md`'s Architecture (verified there against
 * `vendor/pxt-nezha-diffdrive/src/comms/wire_handler.cpp`'s own
 * `kCommandTable`), pointing the caller at `request_drive` (ticket
 * 007) by that exact name -- load-bearing spelling ticket 007 must keep
 * in sync (`sprint.md`'s Description). This is a routing message, not an
 * approval gate: the stakeholder's own decision (`sprint.md`'s Revision
 * / Design Rationale, "no gate at all") is that drive executes
 * immediately once `request_drive` validates it -- the wording below
 * says exactly that, never implying a human must approve anything.
 * {@link GATED_MOTION_VERBS} is exported so ticket 007's
 * `mcp/tools/drive.ts` reuses this exact set as its own allowlist rather
 * than re-typing the same seven names a second place they could drift
 * from each other. `STOP`/`ESTOP` are deliberately absent from this set
 * -- they stop motion, never start it, and per `sprint.md`'s Design
 * Rationale ("a safety-decreasing action must never wait on a human
 * clicking Approve") must remain always-available through this tool.
 *
 * ## Empty-argument-safe schemas (`.claude/rules/tool-call-empty-args.md`)
 *
 * `close_session` follows `mcp/tools/inspect.ts`'s `get_device_status`
 * pattern exactly: one required field, no optional companion, so a `{}`
 * call (the harness bug's worst case) fails Zod validation cleanly.
 *
 * `send_command` has a genuinely optional field (`fields` -- most verbs,
 * e.g. `STATUS`/`ID`, take none) that cannot be made required without
 * lying about the wire protocol. `linkId`/`verb` stay required, so a
 * `{}` collapse still fails Zod validation on those before this file's
 * handler ever runs; `fields` itself is given a Zod `.default([])`
 * rather than left `.optional()` with no default, so *either* a
 * legitimate omission *or* the harness bug silently dropping it both
 * resolve to the same correct, unambiguous `[]` -- never `undefined`
 * reaching the handler, never a two-shape ambiguity to resolve at
 * runtime the way `open_session` (below) needs to.
 *
 * `open_session` genuinely accepts two mutually-exclusive shapes
 * (`{linkId}` or `{relayLinkId, name}`) that cannot both be expressed as
 * "required" in one flat Zod shape (`registerTool`'s `inputSchema` is a
 * shape, not a discriminated union, matching `mcp/server.ts`'s SDK
 * version). All three fields are declared `.optional()` so a
 * *legitimate* `{relayLinkId, name}` call and a *legitimate* `{linkId}`
 * call both validate -- which means a `{}` collapse (the harness bug's
 * worst case) also passes Zod cleanly. {@link parseOpenSessionParams} is
 * the runtime defense the schema cannot provide: it classifies the
 * input as exactly one of the two valid shapes or returns a plain-
 * language tool error naming both accepted shapes and warning about the
 * harness's own empty-argument-collapse behavior, rather than silently
 * misinterpreting a partial/empty input as some other request.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WireField } from "@robot-console/protocol";
import {
  openSession,
  closeSession,
  requireSession,
  sendCommand,
  findLinkStateReason,
  type OpenSessionParams,
  type SessionOpsReconciler,
  type SessionOpsSessions,
  type SessionOpsStore,
} from "../../connect/sessionOps.js";
import type { Store } from "../../store/index.js";

/** The narrow slice of {@link Store} the three tools below need --
 * `sessionOps.ts`'s own read/write needs, plus `reconcilerRows` for
 * `open_session`'s own post-open "did it actually connect" check (see
 * that tool's own doc comment). */
export type ConnectToolsStore = SessionOpsStore & Pick<Store, "reconcilerRows">;

/** The narrow slice of the reconciler the three tools below need --
 * `sessionOps.ts`'s own `requestOpen`/`requestClose`, plus `sessions`
 * for `send_command`'s own `requireSession` lookup. */
export interface ConnectToolsReconciler extends SessionOpsReconciler {
  readonly sessions: SessionOpsSessions;
}

export interface ConnectToolsDeps {
  readonly store: ConnectToolsStore;
  readonly reconciler: ConnectToolsReconciler;
}

/** See the module doc comment's "Gated motion verbs" section. */
export const GATED_MOTION_VERBS: ReadonlySet<string> = new Set(["WHEELS_X", "WHEELS_V", "MOVE_X", "MOVE_V", "GO_TO_R", "GO_TO_W", "RUN"]);

function jsonResult(value: unknown, isError = false): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The MCP client's own declared `clientInfo.name`, or `null` if this
 * server/transport pair never saw an `initialize` handshake carry one
 * (a client that omits `clientInfo.name`, or -- the case this module's
 * doc comment describes at length -- a fully one-shot stateless call
 * that never negotiated a session at all). Never throws. */
function callerNameFrom(server: McpServer): string | null {
  return server.server.getClientVersion()?.name ?? null;
}

/** See the module doc comment's "Empty-argument-safe schemas" section.
 * Classifies a raw `{linkId?, relayLinkId?, name?}` call into exactly
 * one of `open_session`'s two valid shapes, or reports a plain-language
 * error naming both. Empty strings are treated as absent (the Zod
 * schema's own `.min(1)` on each field already rejects a call that
 * *keeps* an empty-string field intact, but this function is the last
 * line of defense against the harness bug's `{}` collapse and any
 * partial survivor of it). */
function parseOpenSessionParams(input: {
  linkId?: string | undefined;
  relayLinkId?: string | undefined;
  name?: string | undefined;
}): { ok: true; params: OpenSessionParams } | { ok: false; message: string } {
  const linkId = input.linkId !== undefined && input.linkId.length > 0 ? input.linkId : undefined;
  const relayLinkId = input.relayLinkId !== undefined && input.relayLinkId.length > 0 ? input.relayLinkId : undefined;
  const name = input.name !== undefined && input.name.length > 0 ? input.name : undefined;

  if (linkId !== undefined && relayLinkId === undefined && name === undefined) {
    return { ok: true, params: { linkId } };
  }
  if (linkId === undefined && relayLinkId !== undefined && name !== undefined) {
    return { ok: true, params: { relayLinkId, name } };
  }
  return {
    ok: false,
    message:
      `open_session needs either {linkId} or {relayLinkId, name}, never a mix and never neither -- got ${JSON.stringify(input)}. ` +
      "Note: this MCP client's own tool-calling harness silently drops every argument in a call if any one of them arrives empty or " +
      "omitted, so a call meant to send {relayLinkId, name} with one of those two fields blank can arrive here missing that field " +
      "entirely (or as {} with nothing at all). Resend with concrete, non-empty values for every field the shape you want needs.",
  };
}

/** Registers `open_session`/`close_session`/`send_command` on `server`.
 * See the module doc comment. */
export function registerConnectTools(server: McpServer, deps: ConnectToolsDeps): void {
  server.registerTool(
    "open_session",
    {
      title: "Open session",
      description:
        "Opens a session on a link -- the same open a browser's own Connect button performs, through the same " +
        "reconciler/connector path, visible on the console exactly like a browser-opened session (with this call's " +
        "own name shown as its caller). Two mutually exclusive input shapes: {linkId} opens a direct usb/wifi/mbserial/" +
        "radio link by id (from list_devices/get_device_status); {relayLinkId, name} bridges to a named robot over a " +
        "relay's own link id, deriving (and returning) that robot's own radio child link id. A board a human already " +
        "holds, or a farm robot's single TCP slot already taken by someone else, is reported back as a plain-language " +
        "error, not a crash or silence.",
      inputSchema: {
        linkId: z
          .string()
          .min(1)
          .optional()
          .describe('Open a direct link by id, e.g. from list_devices/get_device_status\' link.id. Mutually exclusive with relayLinkId+name.'),
        relayLinkId: z
          .string()
          .min(1)
          .optional()
          .describe("Bridge to a robot over this relay's own link id. Must be paired with `name` below; never combined with `linkId`."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("The five-letter robot name to bridge to over `relayLinkId`. Must be paired with `relayLinkId` above."),
      },
    },
    async ({ linkId, relayLinkId, name }) => {
      const parsed = parseOpenSessionParams({ linkId, relayLinkId, name });
      if (!parsed.ok) {
        return jsonResult({ error: parsed.message }, true);
      }
      const caller = callerNameFrom(server);
      const result = await openSession({ store: deps.store, reconciler: deps.reconciler }, parsed.params, { origin: "mcp", caller });
      if (result.refusedReason !== undefined) {
        return jsonResult({ error: `could not open a session on "${result.linkId}": ${result.refusedReason}` }, true);
      }
      // A dispatched job can still fail to connect (contention: a farm
      // robot's one TCP slot already taken, a relay busy sweeping, ...)
      // with no refusedReason -- `connect/sessionOps.ts`'s own doc
      // comment. `openSession` itself stays byte-for-byte the same
      // contract the WS path always had (no notion of "did it actually
      // connect" in its own return value); this tool, which has no later
      // snapshot to read and needs a synchronous, plain-language answer,
      // checks that here instead.
      const opened = deps.store.reconcilerRows().sessions.some((session) => session.linkId === result.linkId);
      if (!opened) {
        const reason = findLinkStateReason(deps.store, result.linkId) ?? "the connection attempt did not succeed";
        return jsonResult({ error: `could not open a session on "${result.linkId}": ${reason}` }, true);
      }
      return jsonResult({ ok: true, linkId: result.linkId, caller });
    },
  );

  server.registerTool(
    "close_session",
    {
      title: "Close session",
      description:
        "Closes the session on a link -- the same close a browser's own Disconnect button performs. Works on a " +
        "session this same MCP caller opened, or one a human opened from the browser (sessions are not owned by " +
        "whoever opened them -- see open_session's own caller-identity note). A link with no open session is simply " +
        "a no-op, not an error.",
      inputSchema: {
        linkId: z.string().min(1).describe("The link id to close, as returned by open_session or shown by list_devices/get_device_status."),
      },
    },
    async ({ linkId }) => {
      await closeSession({ reconciler: deps.reconciler }, linkId);
      return jsonResult({ ok: true, linkId });
    },
  );

  server.registerTool(
    "send_command",
    {
      title: "Send command",
      description:
        "Sends a wire verb on a link's already-open session -- the same send a browser's own console input performs. " +
        "Any verb except the seven motion-starting ones (WHEELS_X, WHEELS_V, MOVE_X, MOVE_V, GO_TO_R, GO_TO_W, RUN) is " +
        "sent as-is; those seven are rejected here and routed to request_drive instead, which validates motion " +
        "arguments properly before executing immediately (this is a routing message, not an approval step -- there is " +
        "no human-approval gate in this system). STOP and ESTOP always go through this tool, unconditionally, since " +
        "they reduce risk rather than increase it. Requires an already-open session on `linkId` (call open_session " +
        "first).",
      inputSchema: {
        linkId: z.string().min(1).describe("The link id an open_session call already opened."),
        verb: z
          .string()
          .min(1)
          .describe(
            'The wire verb to send, e.g. "STATUS", "ID", "FUNCS", "STOP", "ESTOP". The seven gated motion verbs are ' +
              "rejected -- use request_drive for those.",
          ),
        fields: z
          .array(z.union([z.string(), z.number()]))
          .default([])
          .describe("Positional wire fields for `verb`, if any. Omit (or pass []) for a verb that takes none, e.g. STATUS/ID."),
      },
    },
    async ({ linkId, verb, fields }) => {
      if (GATED_MOTION_VERBS.has(verb.toUpperCase())) {
        return jsonResult(
          {
            error:
              `"${verb}" is a motion-starting command -- send it via request_drive instead, which validates motion ` +
              "arguments properly and executes immediately (no approval step exists in this system; request_drive is " +
              "simply the correct, more specific tool for this verb).",
          },
          true,
        );
      }
      let session;
      try {
        session = requireSession(deps.reconciler.sessions, linkId);
      } catch (error) {
        return jsonResult({ error: errorMessage(error) }, true);
      }
      try {
        const sent = sendCommand(session, verb, fields as readonly WireField[]);
        return jsonResult({ ok: true, sent: sent.replace(/\n$/, "") });
      } catch (error) {
        return jsonResult({ error: errorMessage(error) }, true);
      }
    },
  );
}
