/**
 * mcp/tools/drive.ts — `request_drive`: the MCP subsystem's motion-verb
 * category (sprint 019 ticket 007, SUC-006; `sprint.md`'s own module
 * table: "`mcp/tools/drive.ts` — *purpose*: validate a motion-verb
 * request against the allowlist and execute it immediately. *Boundary*:
 * the curated motion-verb allowlist ... lives here, not in
 * `connect/tools.ts`; on valid input it calls the extracted `sendCommand`
 * function directly — no queuing, no intermediate row — then calls
 * `agentActionLog.record()`.").
 *
 * ## No gate — read this before touching this file
 *
 * The sprint's own Revision records that Eric was shown the unattended-
 * harm framing for drive/flash twice and declined a confirmation gate
 * both times ("Let the agents do whatever they want ... It's not hard
 * [to reflash a board]"). `request_drive` therefore executes the moment
 * a valid call arrives — no pending row, no approval, no queue, no
 * "confirm" flag, nothing that could delay or veto a call. The
 * allowlist/field-shape validation below is a *correctness* check (a
 * malformed drive command must fail cleanly rather than reach the
 * firmware as garbage), never a permission check. Do not add anything
 * here that could hold a valid call back.
 *
 * ## One implementation, not two
 *
 * On valid input this file calls exactly `connect/sessionOps.ts`'s own
 * `sendCommand` — the same WS-independent function `server.ts`'s
 * `send-command` WS handler and `mcp/tools/connect.ts`'s `send_command`
 * tool both call. There is no second, drive-specific way of writing to
 * the wire; a `request_drive` call is mechanically just a `sendCommand`
 * call on an already-open session, once its verb/fields have been
 * proven well-formed.
 *
 * ## The allowlist, reused, not redefined
 *
 * {@link GATED_MOTION_VERBS} (`mcp/tools/connect.ts`, ticket 005) is the
 * single source of truth for "which verbs are motion-starting" — this
 * file imports it rather than re-typing the same seven names a second
 * place they could drift from each other. `send_command` rejects these
 * seven by name, pointing the caller here; this file is the tool that
 * actually knows how to validate and send them. `STOP`/`ESTOP` are
 * deliberately absent from the allowlist and never reach this file —
 * they remain always-available through `send_command` (`sprint.md`'s
 * Design Rationale, "`STOP`/`ESTOP` remain ordinary `send_command`
 * verbs").
 *
 * ## Per-verb field validation mirrors `wire_handler.cpp`'s decode
 * functions, not their exec-time merits checks
 *
 * `wire_handler.cpp`'s own `decodeWheelsX`/`decodeWheelsV`/`decodeMoveX`/
 * `decodeMoveV`/`decodeGoToR`/`decodeGoToW`/`decodeRun` each check only
 * field *count* and that every numeric field parses as an int32/uint32 —
 * none of them range-checks the values themselves (e.g. `WHEELS_X`'s
 * `timeout == 0` rejection is `clampMotionTimeout`, called from
 * `execWheelsX` *after* decode succeeds — an exec-time merits check, not
 * a decode failure). {@link validateFixedShape}/{@link validateRunShape}
 * below validate exactly the decode-time shape, on purpose: this file's
 * job (per the ticket's own acceptance criterion) is to fail fast on a
 * request the firmware could never even parse, not to duplicate the
 * firmware's own runtime merits logic.
 *
 * ## Audit write happens after the send, with its outcome (ticket 006)
 *
 * `mcp/agentActionLog.ts`'s `record()` is called exactly once per
 * successful-or-failed `sendCommand` call, after it resolves — never
 * before, and never for a call rejected by allowlist/field-shape/
 * open-session validation (nothing was sent, so there is nothing to
 * audit). This mirrors `agentActionLog.ts`'s own doc comment: "a `drive`
 * action resolves synchronously ... `mcp/tools/drive.ts` calls
 * `record()` immediately after."
 *
 * ## Empty-argument-safe schema (`.claude/rules/tool-call-empty-args.md`)
 *
 * `linkId`/`verb` are both required (`z.string().min(1)`, no optional
 * companion), so a `{}` collapse (the harness bug's worst case) fails
 * Zod validation before this file's handler ever runs — mirroring
 * `mcp/tools/connect.ts`'s `send_command` schema exactly. `fields` is
 * given a Zod `.default([])` rather than left bare-`.optional()`, so a
 * legitimate omission and the harness bug's silent drop both resolve to
 * the same unambiguous `[]`, never `undefined`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WireField } from "@robot-console/protocol";
import { requireSession, sendCommand, type SessionOpsSessions } from "../../connect/sessionOps.js";
import { GATED_MOTION_VERBS } from "./connect.js";
import { record, type AgentActionLogStore } from "../agentActionLog.js";

/** The narrow slice of the reconciler `request_drive` needs — just the
 * open-session lookup `requireSession` performs, mirroring
 * `mcp/tools/connect.ts`'s own `ConnectToolsReconciler.sessions` field
 * (a real `ConnectToolsReconciler` satisfies this structurally). */
export interface DriveToolsReconciler {
  readonly sessions: SessionOpsSessions;
}

export interface DriveToolsDeps {
  readonly store: AgentActionLogStore;
  readonly reconciler: DriveToolsReconciler;
}

/** Recorded in `agent_actions.caller` when this MCP session never
 * negotiated a `clientInfo.name` (see `mcp/tools/connect.ts`'s own
 * `callerNameFrom` doc comment for when that happens — a client that
 * omits `clientInfo.name`, or a fully one-shot stateless call). The
 * `agent_actions.caller` column is `NOT NULL` (`migrations/0005-agent-
 * actions.ts`) — this is the audit trail's own honest placeholder for
 * "an MCP action executed, but no caller name was ever declared," not a
 * gate of any kind: the action already executed by the time this value
 * is chosen. */
const UNKNOWN_CALLER = "unknown";

function jsonResult(value: unknown, isError = false): { content: [{ type: "text"; text: string }]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** See `mcp/tools/connect.ts`'s own `callerNameFrom` doc comment for why
 * this cannot simply be `server.server.getClientVersion()` cached
 * elsewhere — it must be read fresh, from the same `Server` instance
 * that processed this session's `initialize` handshake. Never throws;
 * falls back to {@link UNKNOWN_CALLER} rather than writing a `null`/
 * empty `caller` into a `NOT NULL` column. */
function callerNameFrom(server: McpServer): string {
  return server.server.getClientVersion()?.name ?? UNKNOWN_CALLER;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;

/** Parses one wire field the way `wire_handler.cpp`'s `parseInt32`/
 * `parseUint32` would from the field's own wire text: a JS integer as-
 * is, or a string of an optional leading `-` followed by digits, fully
 * consumed (no partial parse, no exponent/hex notation — mirroring those
 * functions' own strictness). Returns `undefined` for anything else. */
function parseWireInteger(value: WireField): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isInt32(value: WireField): boolean {
  const parsed = parseWireInteger(value);
  return parsed !== undefined && parsed >= INT32_MIN && parsed <= INT32_MAX;
}

function isUint32(value: WireField): boolean {
  const parsed = parseWireInteger(value);
  return parsed !== undefined && parsed >= 0 && parsed <= UINT32_MAX;
}

type WireFieldKind = "int32" | "uint32";

/** Validates `fields` against a fixed-arity, fixed-kind shape — what
 * `WHEELS_X`/`WHEELS_V`/`MOVE_X`/`MOVE_V`/`GO_TO_R`/`GO_TO_W`'s own
 * decode functions all reduce to (see the module doc comment's "Per-verb
 * field validation" section). Returns a plain-language error, or
 * `undefined` when `fields` is valid. */
function validateFixedShape(fields: readonly WireField[], kinds: readonly WireFieldKind[]): string | undefined {
  if (fields.length !== kinds.length) {
    return `expects exactly ${kinds.length} field(s) (${kinds.join(", ")}), got ${fields.length}`;
  }
  for (let i = 0; i < kinds.length; i += 1) {
    const field = fields[i] as WireField;
    const ok = kinds[i] === "int32" ? isInt32(field) : isUint32(field);
    if (!ok) {
      return `field ${i} must be a ${kinds[i]} integer, got ${JSON.stringify(field)}`;
    }
  }
  return undefined;
}

/** `RUN`'s own decode shape (`wire_handler.cpp`'s `decodeRun`): a
 * function-name token plus 0-`kMaxRunArgs` (16) argument tokens, and no
 * more than `kMaxFieldTokens - 1` (19) tokens in total — the tighter of
 * the two bounds is 17, so a valid call has 1-17 fields. `decodeRun`
 * itself does not type-check the tokens (its own comment: "no function
 * name resolution, no type conversion" — an unknown function name or
 * wrong arity is the *adapter's* own merits rejection, not a decode
 * failure), so this validates field count only. */
function validateRunShape(fields: readonly WireField[]): string | undefined {
  if (fields.length < 1) {
    return "RUN needs at least a function-name field";
  }
  if (fields.length > 17) {
    return `RUN accepts at most 17 fields (1 function name + up to 16 arguments), got ${fields.length}`;
  }
  return undefined;
}

/** One validator per allowlisted verb. Keys must be exactly
 * {@link GATED_MOTION_VERBS}'s own members — `drive.test.ts` asserts
 * this directly so the two sets can never silently drift apart. */
const VERB_FIELD_VALIDATORS: Readonly<Record<string, (fields: readonly WireField[]) => string | undefined>> = {
  WHEELS_X: (fields) => validateFixedShape(fields, ["int32", "int32", "int32", "uint32"]),
  WHEELS_V: (fields) => validateFixedShape(fields, ["int32", "int32", "uint32"]),
  MOVE_X: (fields) => validateFixedShape(fields, ["int32", "int32", "int32", "uint32"]),
  MOVE_V: (fields) => validateFixedShape(fields, ["int32", "int32", "uint32"]),
  GO_TO_R: (fields) => validateFixedShape(fields, ["int32", "int32", "int32", "int32", "uint32"]),
  GO_TO_W: (fields) => validateFixedShape(fields, ["int32", "int32", "int32", "int32", "uint32"]),
  RUN: (fields) => validateRunShape(fields),
};

/** Exported for `drive.test.ts`'s own "keys match the allowlist"
 * negative-space check — this file's own validators, not a second
 * allowlist. */
export const DRIVE_VERB_VALIDATOR_KEYS: ReadonlySet<string> = new Set(Object.keys(VERB_FIELD_VALIDATORS));

/** Registers `request_drive` on `server`. See the module doc comment. */
export function registerDriveTools(server: McpServer, deps: DriveToolsDeps): void {
  server.registerTool(
    "request_drive",
    {
      title: "Request drive",
      description:
        "Starts motion immediately: validates `verb` against the seven allowlisted motion-starting verbs (WHEELS_X, " +
        "WHEELS_V, MOVE_X, MOVE_V, GO_TO_R, GO_TO_W, RUN) and `fields` against that verb's own wire shape, then sends " +
        "it through the exact same sendCommand path send_command and the console's own UI use -- immediately and " +
        "unconditionally, the instant this call validates (there is no approval step anywhere in this system; this " +
        "tool is simply the correct, validating entry point for these seven verbs). Requires an already-open session " +
        "on `linkId` -- a correctness precondition, since sending needs a link to send on -- call open_session first " +
        "if none exists. STOP, ESTOP, and every other verb are rejected here and must go through send_command instead. " +
        "Returns the same reply send_command would return for the same verb.",
      inputSchema: {
        linkId: z.string().min(1).describe("The link id an open_session call already opened."),
        verb: z
          .string()
          .min(1)
          .describe("One of the seven allowlisted motion-starting verbs: WHEELS_X, WHEELS_V, MOVE_X, MOVE_V, GO_TO_R, GO_TO_W, RUN. Any other verb is rejected."),
        fields: z
          .array(z.union([z.string(), z.number()]))
          .default([])
          .describe(
            "Positional wire fields for `verb`, validated against that verb's own shape before anything is sent -- " +
              "e.g. WHEELS_X needs [left, right, cruise, timeout] (int32, int32, int32, uint32); RUN needs [functionName, ...args] " +
              "(1-17 fields total). A rejected call's error message names the exact shape expected.",
          ),
      },
    },
    async ({ linkId, verb, fields }) => {
      const upperVerb = verb.toUpperCase();
      const validator = VERB_FIELD_VALIDATORS[upperVerb];
      if (validator === undefined) {
        return jsonResult(
          {
            error:
              `"${verb}" is not one of the seven allowlisted motion-starting verbs (WHEELS_X, WHEELS_V, MOVE_X, MOVE_V, ` +
              "GO_TO_R, GO_TO_W, RUN) -- send it via send_command instead (STOP/ESTOP and every non-motion verb always go " +
              "through that tool).",
          },
          true,
        );
      }
      const typedFields = fields as readonly WireField[];
      const fieldError = validator(typedFields);
      if (fieldError !== undefined) {
        return jsonResult({ error: `invalid fields for "${upperVerb}": ${fieldError}` }, true);
      }
      let session;
      try {
        session = requireSession(deps.reconciler.sessions, linkId);
      } catch (error) {
        return jsonResult({ error: `${errorMessage(error)} -- call open_session first.` }, true);
      }
      const caller = callerNameFrom(server);
      const params = { verb, fields: typedFields };
      try {
        const sent = sendCommand(session, verb, typedFields);
        record(deps.store, { kind: "drive", linkId, params, caller, executedAt: Date.now(), result: "sent" });
        return jsonResult({ ok: true, sent: sent.replace(/\n$/, "") });
      } catch (error) {
        const resultReason = errorMessage(error);
        record(deps.store, { kind: "drive", linkId, params, caller, executedAt: Date.now(), result: "failed", resultReason });
        return jsonResult({ error: resultReason }, true);
      }
    },
  );
}
