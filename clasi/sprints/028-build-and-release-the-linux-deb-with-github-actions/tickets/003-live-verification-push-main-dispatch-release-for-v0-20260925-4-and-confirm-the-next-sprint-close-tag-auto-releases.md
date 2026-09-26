---
id: '003'
title: 'Live verification: push main, dispatch release for v0.20260925.4, and confirm
  the next sprint-close tag auto-releases'
status: open
use-cases: [SUC-001, SUC-002]
depends-on: ['001', '002']
github-issue: ''
issue: release-linux-deb-via-github-actions.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Live verification: push main, dispatch release for v0.20260925.4, and confirm the next sprint-close tag auto-releases

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

- [ ] Stakeholder has explicitly authorized, for this ticket, pushing
      to `origin/main` and dispatching a real release workflow against
      the live `League-Robotics/robot-console` repo, before any of the
      steps below run.
- [ ] Ticket 001's workflow file and ticket 002's docs update have
      reached `main` (via whatever merge/push mechanism this sprint's
      execution flow uses) and are pushed to `origin`, so
      `release-linux.yml` exists on the default branch.
- [ ] `gh workflow run release-linux.yml -f tag=v0.20260925.4` is
      dispatched successfully.
- [ ] The dispatched run is watched (e.g. `gh run watch <run-id>`) to a
      successful conclusion — not just "started".
- [ ] `gh release view v0.20260925.4` afterward lists both the `.deb`
      asset and a `.sha256` asset.
- [ ] The automatic tag-push path is confirmed too, not just the
      manual-dispatch path: when this sprint's own `close_sprint`
      pushes its new version tag, the tag-push trigger fires on its own
      (no manual `gh workflow run`) and produces a matching Release for
      that tag. Record the resulting tag and a link/confirmation of its
      Release in this ticket's notes before it is moved to done — this
      is the sprint's proof that the end-to-end automation, not just
      the retroactive backfill, actually works.

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
