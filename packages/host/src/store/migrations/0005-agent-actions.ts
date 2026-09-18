/**
 * Migration 0005 — the `agent_actions` append-only audit table (sprint
 * 019 ticket 006; SUC-006/SUC-007; `sprint.md`'s Step 4 ERD and Design
 * Rationale, "`agent_actions` is one append-only audit table for both
 * `drive` and `flash` kinds, not two, and carries no lifecycle/status
 * column").
 *
 * ## Why this table exists, and what it deliberately does not have
 *
 * The stakeholder rejected an approval/confirmation gate for MCP-executed
 * `drive`/`flash` actions outright (`sprint.md`'s Revision: "Let the
 * agents do whatever they want ... It's not hard [to reflash a board]").
 * What survives is visibility, not permission: every row this table ever
 * gets is already an action that *executed* (`result = 'sent'`) or was
 * *attempted and failed* (`result = 'failed'`) — never one still waiting
 * on anything. There is deliberately no `status`/lifecycle column, no
 * `decided_at`/`decided_reason`, and no expiry sweep — the superseded
 * `pending_actions` design's own machinery, all of it, has no reason to
 * exist once nothing is ever held back. `mcp/agentActionLog.ts`'s own
 * `record()` is the only writer, called once per executed action by
 * `mcp/tools/drive.ts` (ticket 007) and `mcp/tools/flash.ts` (ticket
 * 008) — never updated in place afterward.
 *
 * ## Columns
 *
 * - `kind` — `'drive' | 'flash'`.
 * - `link_id` — the link a `drive` action targeted (an already-open
 *   session's own link); `NULL` for a `flash` row, which is targeted by
 *   device, not link.
 * - `device_id` — the device a `flash` action targeted; `NULL` for a
 *   `drive` row.
 * - `params` — JSON: the verb+fields for `drive`, a firmware reference
 *   for `flash` — free-form, validated by the tool that writes it
 *   (`drive.ts`/`flash.ts`), not by this table, mirroring `links.address`'s
 *   own already-established convention (`store/index.ts`'s module doc
 *   comment).
 * - `caller` — the MCP client's own declared `clientInfo.name`. Every row
 *   this table ever gets originates from an MCP-executed action, so this
 *   is always populated, never `NULL`.
 * - `executed_at` — wall-clock time the action's outcome became known
 *   (immediately, for a synchronous `drive` send; after `startFlash`'s
 *   terminal promise resolves, for `flash` — see `sprint.md`'s Design
 *   Rationale, "`request_flash` awaits `startFlash`'s own promise...").
 * - `result` — `'sent' | 'failed'`.
 * - `result_reason` — present only when `result = 'failed'`.
 *
 * `link_id`/`device_id` are deliberately plain columns, not
 * `REFERENCES links(id)`/`REFERENCES devices(id)` foreign keys — mirrors
 * `sightings.via_link_id`'s own already-established precedent
 * (`store/index.ts`'s `deleteLink` doc comment: "not a foreign key ... so
 * a leftover sighting row naming a since-deleted link is harmless and
 * left alone"). This audit trail must outlive the device/link it named
 * even if that device or link is later forgotten
 * (`Store.deleteDevice`/`deleteLink`) — an enforced FK would instead force
 * either a cascade delete of the audit history itself (defeating "survives
 * after the originating session closes," this ticket's own purpose) or a
 * failed forget-device/forget-link call.
 *
 * Indexed on `link_id`/`device_id` (not `caller`/`kind`) since every
 * read this ticket adds (`Store.recentAgentActions`) filters on exactly
 * one of those two columns.
 */
export const MIGRATION_0005_AGENT_ACTIONS = `
CREATE TABLE agent_actions (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,          -- 'drive' | 'flash'
  link_id       TEXT,                   -- set for 'drive'; not a FK (see doc comment)
  device_id     INTEGER,                -- set for 'flash'; not a FK (see doc comment)
  params        TEXT NOT NULL,          -- JSON: verb+fields, or firmware ref
  caller        TEXT NOT NULL,          -- MCP clientInfo.name -- always populated
  executed_at   INTEGER NOT NULL,
  result        TEXT NOT NULL,          -- 'sent' | 'failed'
  result_reason TEXT
);
CREATE INDEX agent_actions_link ON agent_actions(link_id);
CREATE INDEX agent_actions_device ON agent_actions(device_id);
`;
