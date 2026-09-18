/**
 * agentActionLog.test.ts — sprint 019 ticket 006's own suite for
 * `record()`/`recentFor()` (SUC-006/SUC-007). A real {@link Store} backed
 * by an in-memory `node:sqlite` connection is used throughout
 * (`connect/sessionOps.test.ts`'s own `freshStore()` pattern) -- this
 * module's own write/read discipline is store-schema behavior, not
 * something a hand-rolled fake should reimplement. `caller` values below
 * are fakes ("agent-smith"), exactly as the ticket's own acceptance
 * criterion describes ("exercised here with a fake caller") -- there is
 * no `mcp/tools/drive.ts`/`mcp/tools/flash.ts` yet (tickets 007/008) to
 * exercise this module through.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import { record, recentFor } from "./agentActionLog.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

/** Strips block comments and line comments before a source-text scan --
 * the negative-space test below must catch approval/lifecycle *code* (an
 * identifier, a string literal, a real SQL column), never trip over a
 * doc comment discussing, in prose, the rejected design it does not
 * implement (e.g. this module's own "no code path here blocks, delays,
 * queues, or requires approval" sentence, which legitimately uses that
 * vocabulary to say the opposite). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("agentActionLog: record", () => {
  it("writes exactly one agent_actions row and makes no write to links, sessions, board_owner, or relay_leases", () => {
    const store = freshStore();
    try {
      // The four tables this ticket's own acceptance criterion names --
      // spied on the real Store (not a fake), mirroring
      // `mcp/tools/inspect.test.ts`'s own "never writes" discipline.
      const upsertLink = vi.spyOn(store, "upsertLink");
      const openSession = vi.spyOn(store, "openSession");
      const closeSession = vi.spyOn(store, "closeSession");
      const setSessionIdentity = vi.spyOn(store, "setSessionIdentity");
      const updateSession = vi.spyOn(store, "updateSession");
      const acquireBoardOwner = vi.spyOn(store, "acquireBoardOwner");
      const releaseBoardOwner = vi.spyOn(store, "releaseBoardOwner");
      const acquireRelayLease = vi.spyOn(store, "acquireRelayLease");
      const releaseRelayLease = vi.spyOn(store, "releaseRelayLease");

      const id = record(store, {
        kind: "drive",
        linkId: "link-1",
        params: { verb: "WHEELS_V", fields: [40, 40] },
        caller: "agent-smith",
        executedAt: 100,
        result: "sent",
      });

      expect(typeof id).toBe("number");
      const rows = store.snapshotRows(); // does not expose agent_actions -- see its own doc comment
      expect(rows.links).toHaveLength(0);
      expect(rows.sessions).toHaveLength(0);
      for (const spy of [
        upsertLink,
        openSession,
        closeSession,
        setSessionIdentity,
        updateSession,
        acquireBoardOwner,
        releaseBoardOwner,
        acquireRelayLease,
        releaseRelayLease,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }

      const written = store.recentAgentActions({ linkId: "link-1" }, 10);
      expect(written).toEqual([
        {
          id,
          kind: "drive",
          linkId: "link-1",
          deviceId: null,
          params: { verb: "WHEELS_V", fields: [40, 40] },
          caller: "agent-smith",
          executedAt: 100,
          result: "sent",
          resultReason: null,
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("records a failed flash outcome with its resultReason, keyed by deviceId not linkId", () => {
    const store = freshStore();
    try {
      record(store, {
        kind: "flash",
        deviceId: 1198504156,
        params: { firmware: "robot" },
        caller: "agent-smith",
        executedAt: 200,
        result: "failed",
        resultReason: "no USB device is currently enumerated",
      });
      const rows = recentFor(store, { deviceId: 1198504156 }, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "flash", linkId: null, deviceId: 1198504156, result: "failed", resultReason: "no USB device is currently enumerated" });
    } finally {
      store.close();
    }
  });
});

describe("agentActionLog: recentFor", () => {
  it("returns rows newest-first, bounded by limit, for a given link", () => {
    const store = freshStore();
    try {
      record(store, { kind: "drive", linkId: "link-1", params: { verb: "STOP" }, caller: "a", executedAt: 1, result: "sent" });
      record(store, { kind: "drive", linkId: "link-1", params: { verb: "MOVE_X" }, caller: "a", executedAt: 2, result: "sent" });
      record(store, { kind: "drive", linkId: "link-1", params: { verb: "WHEELS_V" }, caller: "a", executedAt: 3, result: "sent" });

      const rows = recentFor(store, { linkId: "link-1" }, 2);
      expect(rows.map((r) => (r.params as { verb: string }).verb)).toEqual(["WHEELS_V", "MOVE_X"]);
    } finally {
      store.close();
    }
  });

  it("returns rows newest-first, bounded by limit, for a given device", () => {
    const store = freshStore();
    try {
      record(store, { kind: "flash", deviceId: 7, params: { firmware: "robot" }, caller: "a", executedAt: 1, result: "sent" });
      record(store, { kind: "flash", deviceId: 7, params: { firmware: "robot" }, caller: "a", executedAt: 2, result: "failed", resultReason: "timeout" });

      const rows = recentFor(store, { deviceId: 7 }, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ executedAt: 2, result: "failed" });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Negative-space test (this ticket's own testing plan): protects the
// Design Rationale's "no gate under another name" constraint. Scoped
// narrowly to this module's own source text and the migration's own SQL
// -- NOT the whole of `store/index.ts`, which legitimately uses several
// of these words elsewhere for unrelated columns (e.g. `sessions.pending`,
// the sequencing-pending-count column ticket 003 already added -- a
// whole-file scan would false-positive on that real, unrelated column).
// ---------------------------------------------------------------------

describe("agentActionLog: no approval/lifecycle vocabulary (negative-space test)", () => {
  const FORBIDDEN = [/\bapprove/i, /\bdeny\b/i, /\bdenied\b/i, /\bpending\b/i, /\bdecided_at\b/i, /\bdecided_reason\b/i, /\bexpiry\b/i, /\bTTL\b/, /\bqueue/i];

  it("agentActionLog.ts's own code (comments stripped) contains none of the superseded pending_actions design's vocabulary", () => {
    const code = stripComments(readFileSync(path.join(THIS_DIR, "agentActionLog.ts"), "utf8"));
    for (const pattern of FORBIDDEN) {
      expect(code).not.toMatch(pattern);
    }
  });

  it("the agent_actions migration's own SQL declares no status/lifecycle column", () => {
    const text = readFileSync(path.join(THIS_DIR, "..", "store", "migrations", "0005-agent-actions.ts"), "utf8");
    // Only the SQL template literal, not the doc comment above it (which
    // legitimately discusses the superseded design in prose) -- everything
    // from the `export const` line onward.
    const sqlOnly = text.slice(text.indexOf("export const MIGRATION_0005_AGENT_ACTIONS"));
    for (const pattern of FORBIDDEN) {
      expect(sqlOnly).not.toMatch(pattern);
    }
    expect(sqlOnly).toContain("CREATE TABLE agent_actions");
  });
});
