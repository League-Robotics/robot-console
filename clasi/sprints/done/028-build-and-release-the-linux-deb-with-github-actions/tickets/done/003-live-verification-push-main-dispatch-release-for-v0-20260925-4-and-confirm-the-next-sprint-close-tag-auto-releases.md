---
id: '003'
title: 'Live verification: push main, dispatch release for v0.20260925.4, and confirm
  the next sprint-close tag auto-releases'
status: done
use-cases:
- SUC-001
- SUC-002
depends-on:
- '001'
- '002'
github-issue: ''
issue: release-linux-deb-via-github-actions.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Live verification: push main, dispatch release for v0.20260925.4, and confirm the next sprint-close tag auto-releases

## Scope Change (recorded by the executing programmer, authorized by team-lead)

`workflow_dispatch` only works once the workflow file is on the
default branch, and `-f tag=v0.20260925.4`/a real GitHub Release are
externally-visible actions this ticket was never authorized to take
directly — the team-lead's dispatch authorized pushing **this sprint
branch** only: no push to `main`, no tags, no `workflow_dispatch`, no
release creation from this ticket. Releasing `v0.20260925.4` by hand
and confirming the tag-triggered auto-release both happen right after
this sprint's own `close_sprint` (once ticket 001's workflow file has
actually reached `main`), and are recorded in the sprint's close notes
by the team-lead, not here.

What this ticket verifies instead: the workflow on a real GitHub
Actions runner, via its **build-only** trigger (`push` to
`sprint/**`, added in ticket 001) — the build/install-test job runs
for real, and the `publish` job is confirmed skipped since no tag is
in play. This is still the sprint's live, non-mocked verification of
the workflow mechanics (build, cache, install-test, artifact upload);
it just doesn't reach the `publish` job or touch `main`/tags/Releases.
See "Live Verification Results" below for what ran and its outcome.

## Description

Live, end-to-end verification of the release automation added in
ticket 001, against the real `League-Robotics/robot-console` GitHub
repo — per sprint.md's Test Strategy, this is explicitly **not**
mockable: the workflow, `gh` CLI, and Releases API must be exercised
for real. This ticket performs real, externally-visible actions (a
push to `origin/main`, a real workflow dispatch, a real GitHub
Release) and **must not proceed without the stakeholder's explicit
authorization**, obtained by the team-lead/programmer executing it —
this is not a decision the executing agent makes unilaterally.

Two facts already confirmed during planning, so the executing agent
doesn't need to re-derive them:
- The workflow file (`.github/workflows/release-linux.yml`) does not
  exist at the commit tagged `v0.20260925.4` — it is only added by
  this sprint, on top of `main`. That's fine: a `workflow_dispatch` run
  executes the *workflow definition* from the ref it's dispatched from
  (`main`, once ticket 001's change reaches it), while the *build*
  step inside that run checks out and builds the tagged commit's
  source (see sprint.md's Architecture → Design Rationale, "checkout
  the tag's ref" decision).
- `scripts/package-linux.sh` and `packaging/linux/*` already exist at
  the `v0.20260925.4` commit (they were committed before that tag), so
  `package-linux.sh --test` can run successfully against that checkout.

## Acceptance Criteria

Rewritten per the Scope Change above — this ticket covers only the
build-only (`push` to `sprint/**`) trigger, on the real GitHub runner;
manual-dispatch release and the tag-push auto-release are the
team-lead's job right after `close_sprint`, not this ticket's.

- [x] Team-lead has explicitly authorized, for this ticket, pushing
      this sprint branch to `origin` against the live
      `League-Robotics/robot-console` repo, before any of the steps
      below run.
- [x] The sprint branch (carrying ticket 001's workflow file and
      ticket 002's docs update) is pushed to `origin`, so
      `release-linux.yml`'s `push`-to-`sprint/**` trigger fires for
      real on GitHub Actions.
- [x] The resulting run is watched (`gh run watch <run-id>
      --exit-status`) to a successful conclusion on the `build` job —
      not just "started" — iterating on any real failure until green.
- [x] The `publish` job is confirmed skipped on that run (build-only
      trigger, `needs.build.outputs.is_release == 'false'`), and the
      `.deb`+`.sha256` workflow artifact is confirmed to exist and its
      checksum verified.
- [ ] (Deferred to the team-lead, right after this sprint's
      `close_sprint`, not part of this ticket): manually release
      `v0.20260925.4` once ticket 001's workflow file has reached
      `main`, and confirm the tag this sprint's `close_sprint` pushes
      triggers `release-linux.yml` automatically and produces a
      matching Release. Recorded in the sprint's close notes, per the
      Scope Change above.

## Live Verification Results

**Run 1 (failed, real bug found)**: pushed
`sprint/028-build-and-release-the-linux-deb-with-github-actions` to
`origin` at `817d1c5`. Triggered
[run 36256865435](https://github.com/League-Robotics/robot-console/actions/runs/36256865435)
— `build` job **failed** in 8m51s: 15 of 114 install-test checks
failed (`A(b)`, `A(d)`, `A(c)`, `A(e)`, `B(f)` — every check that
needs the host actually running). Root cause (Phase 1/2 evidence):
the host refused to start —
`mbregistry ('mbregistry') not found on $MBREGISTRY_BIN/$PATH
(requires >= 0.20260924.7)`. `mbtools`/`mbregistry` is a
separately-installed prerequisite (see README) that
`packaging/linux/test-in-container.sh` never installed in its fresh
`ubuntu:24.04` container — a real, pre-existing packaging gap, not a
workflow-file issue, first exposed by running this on a truly clean
GitHub-hosted runner instead of a developer machine that already had
`mbtools` installed.

**Fix**: installed `mbtools`'s own published `.deb`
(`League-Microbit/mbtools`'s `packaging/deb/install-mbtools.sh`,
pinned via a new `MBTOOLS_VERSION=0.20260926.2` in
`packaging/linux/pins.env`) early in Phase A of
`packaging/linux/test-in-container.sh`, before the supervisor is ever
started, and threaded the pin through `test-install.sh`'s `docker run
-e`. `mbtools`'s postinst only touches `systemctl` when
`/run/systemd/system` exists, so this is safe pre-systemd (Phase A);
the host then spawns its own `mbregistry` instance on demand, matching
sprint 024's real-hardware "Spawn case". Commit
`0062b79` (`fix(028-003): install mbtools (mbregistry) in the .deb
install-test container`) on files:
`packaging/linux/pins.env`, `packaging/linux/test-in-container.sh`,
`packaging/linux/test-install.sh`. This is a packaging-script fix, not
ticket 001's workflow file, so it stayed in this ticket per its own
instructions.

**Run 2 (passed)**: pushed the fix at `0062b79`. Triggered
[run 36257915112](https://github.com/League-Robotics/robot-console/actions/runs/36257915112)
— `build` job **succeeded** in 1m42s (much faster than run 1's
failure time; the packaging cache was already warm). `publish` job
shows `skipped` (`-`) in `gh run view`, confirming the build-only
trigger never reaches the release step. Artifact
`robot-console-deb-36257915112` (52,292,767 bytes per the Actions
API / 52,493,722 bytes unzipped) contains
`robot-console_0.20260925.4-1_amd64.deb` and its `.sha256`; downloaded
via `gh run download` and `sha256sum -c` reported `OK`.

**Outcome**: build-only trigger on a real runner verified end to end,
including a real bug found and fixed. Manual release of
`v0.20260925.4` and the tag-push auto-release confirmation remain for
the team-lead right after `close_sprint`, per the Scope Change.

## Implementation Plan

**Approach**: This is an operational/verification ticket — no
application code changes. The executing agent:
1. Confirms stakeholder authorization is in hand (do not proceed on
   assumption; ask if it hasn't been given explicitly for this step).
2. Gets tickets 001 and 002's changes onto `origin/main`. Note for the
   executing agent: this repo's normal CLASI flow merges a sprint
   branch to `main` at `close_sprint`, not mid-sprint — getting the
   workflow onto `main` *before* this sprint closes (as the sprint's
   Solution section requires, so the manual-dispatch verification can
   run at all) may mean pushing/merging early, or dispatching with
   `gh workflow run release-linux.yml --ref <sprint-branch> ...`
   instead of relying on `main`. Decide the concrete mechanism at
   execution time based on how this sprint's branch actually gets
   pushed; either way, the workflow file must be reachable by the ref
   the dispatch uses.
3. Runs `gh workflow run release-linux.yml -f tag=v0.20260925.4` and
   watches it to completion.
4. Confirms the Release via `gh release view v0.20260925.4`.
5. At (or near) this sprint's own `close_sprint`, confirms the tag it
   pushes triggers `release-linux.yml` automatically and produces a
   matching Release, and records that confirmation here.

**Files to create/modify**: none (verification only). If step 2
surfaces a real gap in the workflow (e.g. a version mismatch, a
caching bug, a permissions error), fix it in ticket 001's file under
that ticket, not silently here.

**Testing plan**: The verification steps above are the test — real
GitHub Actions run, real `gh` CLI, real Releases API, no mocking, per
sprint.md's Test Strategy.

**Documentation updates**: none beyond recording the confirmation
required by the last acceptance criterion.
