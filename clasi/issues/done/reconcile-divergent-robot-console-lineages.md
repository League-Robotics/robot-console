---
status: done
priority: urgent
tickets:
- 024-012
---

# Reconcile two divergent robot-console lineages (UI regressed to Sep 12)

Found 2026-09-25 when the stakeholder noticed the UI served from this
checkout is weeks old. **No work is lost**, but this checkout
(`proj/robot-projects/robot-console`) is built on an old base, and a week of
newer work — including all recent UI work — lives only in a different
checkout. The two must be merged before sprint 018 (mbregistry) can land on
`main`.

## What happened

There are two independent checkouts of League-Robotics/robot-console that
diverged at `ea96f46` (2026-09-13, sweep after sprint 017 close):

| | **Lineage L** (newer) | **Lineage R** (this checkout) |
|---|---|---|
| Path | `/Volumes/Proj/proj/league-projects/microbit/robot-console` | `/Volumes/Proj/proj/robot-projects/robot-console` |
| Branch | `sprint/023-joystick-firmware-and-per-context-flash-choices` | `sprint/018-connect-to-mbregistry-client-watcher-and-stream-transport` |
| Last commit | 2026-09-22 (`9f536e7`) | 2026-09-25 |
| Work since divergence | ~217 commits, sprints 018–023 (64 touch `packages/ui`) | 15 commits: 2 radio-map + 13 mbregistry (sprint 018) |

- Lineage R started from `origin/main` as of 2026-09-14 (`8dbc60c`), which is
  the last time anything was pushed. Lineage L's `main` was 204 commits ahead
  of `origin/main` and **never pushed**.
- The whole tree was copied into `robot-projects/` on 2026-09-23 10:01 (all
  file mtimes), apparently from the wrong / stale copy.
- The console server running on port 4799 (`node bin/robot-console.js`) runs
  from Lineage R, so it serves the Sep 12-era UI plus the mbregistry changes.
- Other copies on disk: `/Volumes/Cache-1/proj-gala/...` mirrors both
  lineages; `/Volumes/Proj/proj-archive-202609/league-projects/microbit/robot-console`
  is an archive of Lineage L.

Lineage L's sprints 018–023 include: connections that work on the real bench
(018), MCP server for robot connections (019), WiFi discovery reliability
(020), shared console host daemon / CLI / LAN discovery (021), global debug
console dock (022), joystick firmware and per-context flash choices (023),
plus linux-packaging (.deb), calibration and relay-flash fixes. Its
`linux-packaging` and `write-calibration-to-robot` branches are already
contained in sprint/023.

## Backups (done 2026-09-25)

Pushed to origin as new branches; nothing existing was overwritten:

- `backup/league-main-20260925` — Lineage L `main` (`5571ba1`)
- `backup/league-sprint-023-20260925` — Lineage L `sprint/023-…` (`9f536e7`)
- `backup/robotprojects-sprint-018-mbregistry-20260925` — Lineage R sprint 018 at `f68c160`

Commits made in Lineage R after `f68c160` (tickets 009 / 011 in progress)
are **not** in the backup; push them before rewriting anything.

## Trial merge findings

A trial replay in a throwaway worktree (since deleted) showed:

1. **Drop Lineage R's radio-map commits** `66321fd` (feat: 73-channel name
   map) and `8dbc60c` (docs). Lineage L implemented the same feature
   independently (`b8ce4f4`, `3b8ce54`, `8060f18`). Take L's version — this
   eliminates every conflict in `packages/protocol` and `tools/`.
2. **Cherry-pick the 13 mbregistry commits** onto Lineage L
   (`fc73989 58e2e10 8bb80fd c286cc5 3972612 3777026 4e326cb ffe550e ada147a
   b8ab1d1 68b2ccc bbc8862 f68c160`, plus anything newer). Result:
   - 7 apply clean (apart from the binary `.clasi/.clasi.db` and
     `package-lock.json`, which should be regenerated, not merged).
   - 6 conflict, ~34 hunks, almost all in `packages/host`:

     | Commit | File | Hunks |
     |---|---|---|
     | 3777026 (018-004) | host/src/connect/connector.ts | 4 |
     |  | host/src/connect/connector.test.ts | 4 |
     | 4e326cb (018-005) | host/src/server.ts | 5 |
     |  | host/src/projection.ts / projection.test.ts | 1 / 1 |
     | ffe550e (018-006) | host/src/runtime.ts / runtime.test.ts | 4 / 5 |
     |  | host/src/cli.ts | 2 |
     |  | host/src/watchers/mdnsWatcher.ts | 2 |
     |  | host/src/server.test.ts | 1 |
     | ada147a (018-007) | host/src/connect/relayBridger.ts | 3 |
     | b8ab1d1 (018-008) | host/src/config.test.ts | 1 |
     |  | ui/src/deviceDisplay.test.ts | 1 |

3. **The UI survives intact** — only one UI test file conflicts.
4. **Semantic risk is larger than textual risk.** The mbregistry design was
   written against the Sep 13 host. Lineage L's sprints 019–021 added an MCP
   server, a shared console host daemon, and connection rework. Before
   resolving hunks, check the mbregistry architecture (sprint 018
   `architecture-update.md`, mbtools `docs/design/robot-console-integration.md`)
   against L's current `docs/design/architecture.md`, especially runtime
   assembly, the connector/reconciler, and the daemon's ownership of boards.

## CLASI numbering collision

Both lineages have a sprint 018 and a sprint 019, and they are different
sprints. Lineage L's CLASI state (sprints through 023, its `.clasi.db`) is
authoritative. Re-register this checkout's mbregistry sprint as **024** and
the planned follow-up (currently 019, with issues
`retire-direct-usb-flash-and-names-via-mbregistry.md` and
`spawn-mbregistry-via-service-run.md`) as **025**. Ticket references like
`018-005` in those issues must be updated to match.

## Proposed plan

1. Pause sprint 018 work at a clean commit; push it to the backup branch.
2. Keep `robot-projects/robot-console` as the home checkout. Fetch Lineage L
   from the backup branches; point local `main` at L's `main`, merge L's
   sprint/023 into it (its CLASI close-out may need doing first).
3. Bring over Lineage L's uncommitted edits to `config/prod/public.env` and
   `config/prod/secrets.env` (and check the `vendor/radio-robot-lib`
   submodule pointer).
4. Branch a new sprint 024 from `main`; cherry-pick the mbregistry commits
   (skipping `66321fd`, `8dbc60c`), resolving conflicts per commit with the
   semantic check above. Regenerate `package-lock.json`.
5. Re-home the CLASI artifacts as sprint 024 / 025 (likely needs the OOP
   bypass, since this is a repository operation, not ticket work).
6. `npm run build`, full `npm test`, restart the 4799 server, and confirm in
   the browser that the new UI (debug console dock, joystick section, etc.)
   is present and mbregistry connections still work.
7. Push `main` to origin (it has been unpushed since 2026-09-14), then retire
   the `league-projects/microbit` checkout.

## Acceptance

- One checkout, one `main`, containing all of Lineage L plus the mbregistry
  work; pushed to origin.
- The served UI matches Lineage L's latest UI.
- Full test suite and build pass; mbregistry bench behavior (ticket 009) is
  re-verified on the merged code.
- CLASI sprint numbering has no duplicates.
