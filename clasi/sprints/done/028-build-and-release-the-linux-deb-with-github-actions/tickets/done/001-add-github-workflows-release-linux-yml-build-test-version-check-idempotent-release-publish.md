---
id: '001'
title: Add .github/workflows/release-linux.yml (build, test, version-check, idempotent
  release publish)
status: done
use-cases:
- SUC-001
- SUC-002
depends-on: []
github-issue: ''
issue: release-linux-deb-via-github-actions.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Add .github/workflows/release-linux.yml (build, test, version-check, idempotent release publish)

## Description

Add `.github/workflows/release-linux.yml`, the first GitHub Actions
workflow in this repo (no `.github/` directory currently exists). It
builds, install-tests, and publishes a GitHub Release for the Linux
`.deb`, by orchestrating the existing `scripts/package-linux.sh --test`
unmodified — see sprint.md's Architecture section for the full
rationale (idempotent `--clobber` publish; checkout the tag's own ref,
not `main`'s HEAD).

## Team-Lead Scope Addition

Besides the release triggers (tag push `v*`, and `workflow_dispatch`
with a `tag` input), the team-lead directed adding **build-only**
triggers: push to `main` and `sprint/**` branches, and `pull_request`
to `main`. Those runs build and install-test the `.deb`
(`scripts/package-linux.sh --test`), upload it as a workflow artifact,
and never create a release — only tag pushes and dispatches publish.
Implemented as two jobs (`build`, `publish`) with a job-level `if:` on
`publish` and least-privilege permissions per job (`contents: write`
only on `publish`).

## Acceptance Criteria

- [x] Workflow triggers on push of tags matching `v*`.
- [x] Workflow also has `workflow_dispatch` with a required `tag`
      string input, so an already-existing tag (`v0.20260925.4`) can be
      released retroactively without a new push.
- [x] `runs-on: ubuntu-24.04`; `permissions: contents: write`;
      `concurrency` keyed per tag (e.g. group name derived from the
      resolved tag) so two runs for the same tag can't race each other's
      release publish. (Scoped to the `publish` job only, per the
      team-lead's least-privilege addition above; the top-level default
      is `contents: read`.)
- [x] Checks out the resolved tag's ref (the `workflow_dispatch` `tag`
      input, or the pushed tag ref) with `fetch-depth: 0` (full history —
      needed for a correct version read and for `package-linux.sh`'s own
      `git log`/`git rev-parse` calls).
- [x] `actions/cache` for `build/linux/cache`, keyed on a hash of
      `packaging/linux/pins.env` (with a restore-key fallback), so
      re-runs don't re-download the pinned Node/nfpm tarballs.
- [x] Runs `scripts/package-linux.sh --test` and fails the job if it
      fails.
- [x] Asserts that `package.json`'s `version` at the checked-out ref
      equals the resolved tag name with its leading `v` stripped; fails
      the run with a clear message otherwise (this must fail loudly, not
      silently publish a mismatched artifact).
- [x] Publishes a GitHub Release for the tag: create it if it doesn't
      exist, otherwise update it; upload the built `.deb` and a
      generated `<deb-filename>.sha256` file with `--clobber` so re-runs
      are idempotent. Use generated release notes.
- [x] `actionlint` (if available in the dev environment) reports no
      errors against the new workflow file; every inline `run:` shell
      block passes `bash -n`.
- [x] The workflow's own shell steps work correctly on a Linux
      (ubuntu-24.04) GitHub runner: prefer reusing
      `scripts/package-linux.sh`'s existing `sha256()` pattern
      (`sha256sum` when present, else `shasum -a 256`) for the released
      `.sha256` file rather than a macOS-only tool, and rely on
      `docker run --platform linux/amd64` exactly as `package-linux.sh`
      already does (this runs natively, without emulation, on an
      ubuntu-24.04 amd64 runner).
- [x] No new secrets are introduced; the `gh` CLI and its ambient
      `GITHUB_TOKEN` (already available on GitHub-hosted runners) are
      used for the release publish, not a hand-rolled REST call.

## Implementation Plan

**Approach**: A single-job workflow. Resolve the tag once near the top
(`inputs.tag` for `workflow_dispatch`, else `github.ref_name` for a tag
push) into a step output so later steps and the concurrency group can
reference one value. Use the `gh` CLI (`gh release view` /
`gh release create` / `gh release upload --clobber`) for the idempotent
publish step, per sprint.md's Design Rationale — no third-party
release-publishing Action needed.

**Files to create**:
- `.github/workflows/release-linux.yml`

**Files to modify**: none. `scripts/package-linux.sh`,
`packaging/linux/*`, and `packaging/linux/pins.env` are invoked
unmodified, as designed. If, during implementation, something in
those scripts turns out not to be portable to a real Linux runner
(distinct from this ticket's own workflow-file portability items
above), note it as a follow-up rather than silently patching
out-of-scope files — check with the team-lead first, since editing
those scripts is not this ticket's stated acceptance criteria.

**Testing plan**: Validate locally as far as possible without a live
GitHub Actions run (the live run itself is ticket 003, which needs
explicit stakeholder authorization to push/dispatch against the real
repo):
- Run `actionlint .github/workflows/release-linux.yml` if `actionlint`
  is installed; otherwise note its absence.
- Extract each inline `run: |` block and check it with `bash -n`.
- Read through the YAML once more for the version-assertion and
  idempotent-publish logic against the acceptance criteria above.

**Documentation updates**: none in this ticket (see ticket 002 for the
`docs/linux-install.md` update).
