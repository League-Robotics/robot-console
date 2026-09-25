---
id: '012'
title: Replay mbregistry integration onto merged main
status: done
use-cases:
- SUC-001
- SUC-002
- SUC-004
- SUC-005
- SUC-007
- SUC-008
depends-on:
- '011'
github-issue: ''
issue: use-mbregistry-for-boards-locks-and-flashing.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Replay mbregistry integration onto merged main

## Description

The mbregistry code from tickets 001-008, 010, and 011 was written on a
stale base (`old/robotprojects-sprint-018`). This branch (Lineage L =
`main` after sprint 023 close) has since diverged — new migrations,
`connector.ts` signature changes, `AppHeader.tsx` rewritten, etc. That
code must be replayed onto this branch rather than re-implemented from
scratch, reconciling each conflict against L's current state.

Follow
`clasi/sprints/024-connect-to-mbregistry-client-watcher-and-stream-transport/replay-guide.md`
sections 1-4 exactly. It documents, commit by commit, which side wins
each conflict and why.

Commits to replay from `old/robotprojects-sprint-018`, in order, with
`git cherry-pick --no-commit`:

```
58e2e10  client
c286cc5  watcher
3972612  stream
3777026  connector
4e326cb  flash
ffe550e  runtime/reconciler/mdns
ada147a  relayBridger
b8ab1d1  shareBoards
f68c160  gone/unrecognized, socket path
0198cd6  bench fixes 2
```

`58e2e10` and `c286cc5` are already staged in the working tree (per git
status at sprint start) — verify their content matches the guide's
section 1 notes for those two commits before moving on, rather than
re-picking them.

Skip all `.clasi/` and `clasi/` paths in every pick (keep this branch's
versions — the sprint dir is already re-homed as 024 here). Do not pick
the radio-map commits `66321fd`/`8dbc60c`; L already has its own.

After the ten commits are reconciled, complete the guide's remaining
required work:

- **Section 2** (edits no conflict will flag): `scripts/dev.mjs` missing
  `await` on `startRuntime()`; `mcp/tools/flash.ts` candidate-link filter
  needs `mbregistry` added/preferred; `deviceDisplay.ts`
  `NO_ANSWER_ADVICE` needs an `mbregistry` entry; UI spots that only know
  `usb`/`mbrelay` (`allocateRadioBridge`, `FrontPage.tsx`
  `RelayBridgeStatus` and `currentUsbLink`, `TransportIcon`) need
  `mbregistry` added; `startRuntime` needs a try/catch closing the store
  if the mbregistry `connect()` throws; `runtime.stop()`/`client.close()`
  must terminate a spawned child process.
- **Section 3** (port contention): age existing `usb` link rows stale in
  `startRuntime` after the mbregistry connect (since `usbWatcher` is off
  and nothing else ages them), and make `resolveFlashLinkTarget` prefer
  an mbregistry link over a stale usb one for the same device.
- **Section 4** (team-lead decisions, 2026-09-25): make the disabled
  mDNS types (`_mbserial`/`_mbflash`/`_mbrelay`) configurable via
  `ROBOT_CONSOLE_MDNS_LEGACY` (comma-separated list of types to
  re-enable), document it in README; keep L's device-kind classification
  as-is; add an mbregistry section to `docs/design/architecture.md`
  (owner process, link preference, disabled watchers, supervisor note
  about `MBREGISTRY_BIN` in `/etc/robot-console/robot-console.env`);
  keep L's `AppHeader.tsx` as the final form (drop the old
  `AppHeader.test.tsx` cases from the stale branch — the stakeholder
  rejected that wording).

Regenerate `package-lock.json` (`npm install`) once all picks are
resolved, keeping this branch's lockfile as the merge base.

## Acceptance Criteria

- [x] All ten commits' code is applied and reconciled against this
      branch's current state per the replay guide's per-commit notes
      (section 1), including the semantic merges (not just textual
      conflict resolution) called out for `3777026`, `4e326cb`,
      `ffe550e`, `ada147a`, `b8ab1d1`, `f68c160`, and `0198cd6`.
- [x] `58e2e10` and `c286cc5`'s already-staged content is verified
      against the guide's notes for those commits before proceeding.
- [x] Every item in replay-guide.md section 2 is done: `dev.mjs` awaits
      `startRuntime()`; `mcp/tools/flash.ts`'s flash-candidate filter
      includes and prefers `mbregistry`; `NO_ANSWER_ADVICE` covers
      `mbregistry`; `allocateRadioBridge`, `RelayBridgeStatus`,
      `currentUsbLink`, and `TransportIcon` all support `mbregistry`;
      `startRuntime` wraps the mbregistry connect in try/catch that
      closes the store on failure; stopping the runtime/closing the
      client terminates any spawned mbregistry child process.
- [x] Every item in replay-guide.md section 3 is done: stale `usb` links
      are aged out in `startRuntime` after the mbregistry connect, and
      `resolveFlashLinkTarget` prefers an mbregistry link over a stale
      usb link for the same device.
- [x] Every item in replay-guide.md section 4 is done:
      `ROBOT_CONSOLE_MDNS_LEGACY` env var re-enables listed legacy mDNS
      types and is documented in README; L's device-kind classification
      is unchanged; `docs/design/architecture.md` has an mbregistry
      section; L's `AppHeader.tsx` is kept and the stale branch's
      `AppHeader.test.tsx` additions are dropped.
- [x] `package-lock.json` is regenerated and committed.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] Full `npm test` passes.
- [x] UI `vite:build` passes.

## Implementation Plan

- **Approach**: `git cherry-pick --no-commit` each of the ten commits in
  order from `old/robotprojects-sprint-018`, resolving each conflict per
  the replay guide's per-commit notes rather than by generic
  `git mergetool` heuristics. Where the guide says a file's final form
  should be written directly (heavy host files: `server.ts`,
  `runtime.ts`, `connector.ts`, `relayBridger.ts`), do that at the first
  conflict and take "ours" (this branch's already-reconciled version) on
  later picks touching the same file. After all ten picks, work through
  guide sections 2-4 as a checklist.
- **Files to create/modify**: primarily
  `packages/host/src/{connect/connector.ts,projection.ts,store/**,
  watchers/mbregistryWatcher.ts,mbregistry/client.ts,
  reconciler.ts,runtime.ts,cli.ts}`,
  `scripts/dev.mjs`, `mcp/tools/flash.ts`,
  `packages/ui/src/{deviceDisplay.ts,FrontPage.tsx,AppHeader.tsx,
  TransportIcon.tsx}` and their test files, `docs/design/architecture.md`,
  `README.md`, `package-lock.json`. Exact file set follows the replay
  guide and the ten source commits' own diffs.
- **Testing plan**: run the full suite (`npm test`), `npm run typecheck`,
  `npm run build`, and the UI's `vite:build` after the replay is
  complete and before marking this ticket done. This is a replay/merge
  ticket, not new-feature work, so no new automated tests are expected
  beyond what the replayed commits already carried (e.g.
  `client.test.ts`, `mbregistryWatcher.test.ts`, `connector.test.ts`,
  `server.test.ts`, `runtime.test.ts`, `config.test.ts`,
  `deviceDisplay.test.ts`, `FrontPage.test.tsx` updates called out in the
  guide).
- **Documentation updates**: README (`ROBOT_CONSOLE_MDNS_LEGACY`),
  `docs/design/architecture.md` (mbregistry section per guide section 4).
