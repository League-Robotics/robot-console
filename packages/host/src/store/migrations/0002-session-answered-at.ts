/**
 * Migration 0002 — `sessions.answered_at` (sprint 018 ticket 010;
 * SUC-007, "UI truthfulness").
 *
 * The front page's "Linked" pill (and every equivalent green-pill
 * indicator, e.g. the relay card's "Connected to `<name>`" line) used
 * to read only `links.state === 'connected'` — true the instant a
 * session opens, even if the device on the other end never actually
 * answers anything (bench evidence: `vevov`'s mbserial bridge accepted
 * a TCP connection and flipped its link to `connected` while never once
 * replying to `HELLO`, and the front page still showed a green
 * "Linked" pill). `state === 'connected'` alone cannot distinguish "the
 * transport is open" from "the robot is actually there and answering" —
 * this column is that distinguishing fact: the wall-clock time
 * `connect/harvester.ts` last received *any* reply on this session's
 * link (see that module's own `syncSession`), independent of
 * `last_done`/`last_done_reason` (which only ever track a *sequenced*
 * command's own completion, never a bare poll reply).
 *
 * `NULL` by default and on every `openSession()` (a fresh session has
 * not answered anything yet) — a session that has never answered reads
 * identically to a pre-migration row, both correctly "not yet Linked"
 * under `packages/ui/src/deviceDisplay.ts`'s new `isLinkAnswering`.
 */
export const MIGRATION_0002_SESSION_ANSWERED_AT = `
ALTER TABLE sessions ADD COLUMN answered_at INTEGER;
`;
