/**
 * Migration 0004 — `sessions.origin`/`sessions.caller` (sprint 019
 * ticket 005; SUC-005, MCP caller identity).
 *
 * The stakeholder's own original ask for the whole MCP feature was that
 * an agent's connection "shows up in the robot console" -- the
 * console's existing "who holds this board" accounting (`sessions`,
 * architecture.md §4) must not go blind to *who* opened a session just
 * because it was an agent rather than a human at the browser. These two
 * columns are that missing attribution: `origin` distinguishes a
 * browser-opened session (`'ui'`) from an MCP-opened one (`'mcp'`);
 * `caller` carries the MCP client's own declared name (`clientInfo.name`
 * from its `initialize` handshake) when `origin = 'mcp'`, `NULL`
 * otherwise.
 *
 * `origin` defaults to `'ui'` and `caller` to `NULL` on every existing
 * and future plain `INSERT`/`ON CONFLICT` from `Store.openSession` (see
 * that method's own doc comment) -- a pre-migration row and a fresh
 * browser-opened row are indistinguishable, both correctly "not an
 * agent" under this column's own meaning. `Store.setSessionIdentity`
 * (this ticket) is the only thing that ever writes `'mcp'`/a caller
 * name, called by `connect/sessionOps.ts`'s `openSession` only after a
 * session it just opened is confirmed live -- never touching a session
 * some other caller already holds.
 */
export const MIGRATION_0004_SESSION_ORIGIN_CALLER = `
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'ui';
ALTER TABLE sessions ADD COLUMN caller TEXT;
`;
