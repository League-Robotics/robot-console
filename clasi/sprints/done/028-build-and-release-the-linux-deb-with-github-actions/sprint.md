---
id: 028
title: Build and release the Linux .deb with GitHub Actions
status: done
branch: sprint/028-build-and-release-the-linux-deb-with-github-actions
use-cases: []
issues:
- release-linux-deb-via-github-actions.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 028: Build and release the Linux .deb with GitHub Actions

## Goals

Get the Linux `.deb` package built and released automatically through
GitHub Actions on every version tag, and get the current version
(`v0.20260925.4`) actually published as a GitHub Release with the
`.deb` attached, since none has ever been published.

## Problem

`scripts/package-linux.sh` already builds and install-tests a working
`.deb` (`packaging/linux/build-in-container.sh`, nfpm, pinned/
checksummed inputs in `packaging/linux/pins.env`), and `close_sprint`
already pushes a `vX.Y.Z` tag at every sprint close (latest
`v0.20260925.4`, matching `package.json`). But there is no `.github/`
directory at all — no CI, no workflow, no GitHub Release has ever been
created — so tags accumulate with no built artifact behind them, and
`docs/linux-install.md` tells admins to `apt install` a file it never
says how to obtain.

## Solution

Add a GitHub Actions workflow, `.github/workflows/release-linux.yml`,
that builds and install-tests the `.deb` via the existing
`scripts/package-linux.sh --test` and publishes a GitHub Release for
the tag with the `.deb` and a `.sha256` checksum attached:

- Triggers: push of tags `v*`, plus `workflow_dispatch` with a `tag`
  input so an already-existing tag (`v0.20260925.4`) can be released
  retroactively.
- `runs-on: ubuntu-24.04`, `permissions: contents: write`.
- Checks out the tag with full history; caches `build/linux/cache`
  (the packaging script's download cache) across runs.
- Runs `scripts/package-linux.sh --test`, which builds the `.deb` in
  an `ubuntu:24.04` linux/amd64 container with pinned, checksum-verified
  inputs and then install-tests it in a fresh container.
- Asserts the `package.json` version checked out at the tag equals the
  tag name minus its leading `v`, so a mistagged release fails loudly
  instead of shipping a mismatched artifact.
- Publishes (or updates, with `--clobber`) a GitHub Release for the
  tag, attaching the `.deb` and its `.sha256`, using generated release
  notes. The publish step is idempotent — safe to re-run on the same
  tag. Concurrency is keyed per tag so overlapping runs for the same
  tag don't race.

Also update `docs/linux-install.md` to point admins at the GitHub
Releases page (and `gh release download`) for the `.deb`, instead of
leaving the download step unstated.

Verification is done live during this sprint, not just by code review:
push `main` so the workflow exists on the default branch, dispatch it
manually for `v0.20260925.4`, and confirm a Release now exists with
the `.deb` asset attached. This sprint's own `close_sprint` will push
a new tag; confirm the tag-push trigger fires and produces a Release
for that tag too, proving the end-to-end automation (not just the
manual dispatch path) works.

## Success Criteria

- `.github/workflows/release-linux.yml` exists on `main`, triggered by
  `v*` tag pushes and by manual `workflow_dispatch` with a `tag` input.
- Running the workflow (via dispatch) for `v0.20260925.4` produces a
  GitHub Release for that tag containing the `.deb` and a `.sha256`
  file.
- The tag this sprint's own close pushes automatically produces a
  matching GitHub Release via the tag-push trigger, with no manual
  step.
- The workflow fails (rather than silently publishing) if the tagged
  commit's `package.json` version doesn't match the tag.
- `docs/linux-install.md` tells admins where to download the `.deb`.

## Scope

### In Scope

- `.github/workflows/release-linux.yml`: build, install-test, version
  assertion, idempotent GitHub Release publish with `.deb` + `.sha256`.
- Caching of `build/linux/cache` in the workflow.
- `docs/linux-install.md` update: download location.
- Live verification: push to `main`, manual dispatch for
  `v0.20260925.4`, and confirming the next sprint-close tag
  auto-releases.

### Out of Scope

- apt repository hosting (a real `apt` repo/PPA for `apt update` to see
  the package).
- arm64 builds.
- Package/artifact signing.

## Test Strategy

Primarily CI-level, not unit tests: the workflow's own `--test` flag
already install-tests the `.deb` in a fresh container as part of
`scripts/package-linux.sh`, so the ticket work is to wire that
existing check into CI correctly rather than to add new test code.
Correctness of the workflow itself is verified live against the real
GitHub Actions and Releases API for this repo (League-Robotics/robot-console):
a manual `workflow_dispatch` run against the existing
`v0.20260925.4` tag, and a real tag push (this sprint's own
`close_sprint`) exercising the tag-trigger path end to end. No mocking
of GitHub Actions or the `gh` CLI — the verification step must observe
an actual Release with an actual `.deb` asset.

## Architecture

**Sizing: Compact** — adds one new component, a GitHub Actions
workflow (`.github/workflows/release-linux.yml`), that orchestrates
the existing `scripts/package-linux.sh` build/test pipeline and
publishes a GitHub Release. No new cross-module dependency inside the
application (the workflow calls the existing packaging scripts as an
unmodified black box), no dependency-direction change, and no
data-model change — so the compact variant applies: no diagrams, and
the write-up below stays at the size one new module warrants.

### Architecture Overview

**What Changed**: One new module — a GitHub Actions workflow,
`.github/workflows/release-linux.yml`. It triggers on push of tags
matching `v*` and on `workflow_dispatch` with a required `tag` input
(so an already-existing tag, `v0.20260925.4`, can be released
retroactively). It runs on `ubuntu-24.04` with `permissions:
contents: write` and a concurrency group keyed per tag. It checks out
the given tag (`fetch-depth: 0`, full history — the version-assertion
and packaging steps need the exact commit the tag points at, not
whatever `main` happens to be at run time), restores/saves an
`actions/cache` for `build/linux/cache` keyed on
`packaging/linux/pins.env`'s hash, then runs the existing
`scripts/package-linux.sh --test` unmodified — this builds the `.deb`
in a pinned `ubuntu:24.04` container and install-tests it via
`packaging/linux/test-install.sh`. It asserts the `package.json`
version at that checkout equals the tag name minus its leading `v`,
failing the run otherwise. It then publishes (or idempotently updates,
via `--clobber`) a GitHub Release for the tag, attaching the `.deb`
and a generated `.sha256` file. `docs/linux-install.md` gets a short,
additive paragraph pointing admins at the Releases page and
`gh release download` for the file the install instructions already
reference.

**Why**: `scripts/package-linux.sh` already builds and install-tests a
working `.deb`, but nothing in the repo runs it automatically or
publishes anything — there is no `.github/` directory at all — so
every tag `close_sprint` pushes (latest `v0.20260925.4`) accumulates
with no artifact behind it, and `docs/linux-install.md` never says
where to get the file it tells admins to `apt install`.

**Impact on Existing Components**: None — additive. The workflow
treats `scripts/package-linux.sh`, `packaging/linux/*`, and
`packaging/linux/pins.env` as an existing, unmodified interface; it
introduces no new dependency between existing application modules and
touches no application source. The `docs/linux-install.md` edit is
additive prose with no structural change.

### Design Rationale

- **Decision**: idempotent release publish (create-if-missing,
  otherwise upload with `--clobber`) rather than a plain
  `gh release create` that fails if the release already exists.
  **Context**: `workflow_dispatch` must be re-runnable against
  `v0.20260925.4` (a tag that predates this workflow) without manual
  cleanup, and a retry after a flaky run must not error out on a
  release that already exists.
  **Alternatives considered**: always `gh release create` (fails on a
  pre-existing release); delete-then-recreate (loses release notes
  and history unnecessarily).
  **Why this choice**: check-then-create-or-upload with `--clobber` is
  the standard idempotent pattern for `gh release` and matches this
  repo's existing convention of re-runnable automation (`close_sprint`
  already pushes tags idempotently).
  **Consequences**: re-running the workflow for the same tag silently
  overwrites that tag's `.deb`/`.sha256` assets — intended, since the
  content for a given tag is deterministic from the same commit.

- **Decision**: check out the dispatched/pushed **tag's ref**
  (`fetch-depth: 0` at that ref) rather than always building whatever
  is currently on `main`.
  **Context**: a `workflow_dispatch` run for `v0.20260925.4` executes
  the workflow *file* from `main` (GitHub always runs the workflow
  definition from the triggering ref — the default branch, for
  `workflow_dispatch`), but must still *build* the source tree as it
  existed at that tag, whose commit predates the workflow file itself.
  **Alternatives considered**: build `main`'s HEAD and label the
  resulting artifact with the dispatched tag name.
  **Why this choice**: correctness — the `.deb` must match the code at
  the tag, and the version-assertion step depends on reading
  `package.json` at that exact commit. The packaging scripts
  (`scripts/package-linux.sh`, `packaging/linux/*`) only need to
  already exist at the tagged commit, which they do — they were
  committed well before `v0.20260925.4`.
  **Consequences**: the workflow YAML itself never needs to be
  present at the tag being released, only at `main`; only the
  packaging scripts it invokes need to predate the tag.

### Migration Concerns

None. This adds automation over existing, already-tested build/test
scripts; it changes no data format, no installed-package behavior,
and no backward compatibility. The workflow's first real exercise (a
manual dispatch for the pre-existing `v0.20260925.4` tag) is a
one-time backfill, not a data migration.

## Use Cases

Use cases sized to the Compact tier — brief, since this sprint adds
one operational component with no new user-facing product behavior.

### SUC-001: Automatic release on tag push
Parent: N/A (operational/CI capability; no existing product-level UC)

- **Actor**: GitHub Actions (triggered by `close_sprint`'s tag push, or
  any future tag push matching `v*`)
- **Preconditions**: `.github/workflows/release-linux.yml` exists on
  `main`; a commit tagged `vX.Y.Z` is pushed to the repo.
- **Main Flow**:
  1. The tag push triggers the workflow.
  2. The workflow checks out the tagged commit and restores the
     `build/linux/cache`.
  3. It runs `scripts/package-linux.sh --test`, building and
     install-testing the `.deb`.
  4. It asserts the tag matches the checked-out `package.json` version.
  5. It publishes a GitHub Release for the tag with the `.deb` and a
     `.sha256` file attached.
- **Postconditions**: A GitHub Release for the tag exists, containing
  the `.deb` and its checksum, with no manual step.
- **Acceptance Criteria**:
  - [ ] Pushing a `vX.Y.Z` tag produces a matching GitHub Release
        automatically.
  - [ ] The release contains the `.deb` and a `.sha256` file.
  - [ ] A version mismatch between the tag and `package.json` fails
        the run instead of publishing.

### SUC-002: Manual release of an already-existing tag
Parent: N/A (operational/CI capability; no existing product-level UC)

- **Actor**: Release maintainer (team-lead/programmer, with
  stakeholder authorization), via `gh workflow run`
- **Preconditions**: `.github/workflows/release-linux.yml` exists on
  `main`; a tag exists (e.g. `v0.20260925.4`) with no GitHub Release
  behind it, and no workflow existed when it was pushed.
- **Main Flow**:
  1. The maintainer runs
     `gh workflow run release-linux.yml -f tag=v0.20260925.4`.
  2. The workflow (running from `main`) checks out that tag's commit,
     builds and install-tests the `.deb` from it, and asserts the
     version match.
  3. It publishes a GitHub Release for that tag with the `.deb` and
     `.sha256` attached.
- **Postconditions**: The previously-unreleased tag now has a GitHub
  Release with the built artifact.
- **Acceptance Criteria**:
  - [ ] `workflow_dispatch` with `tag=v0.20260925.4` succeeds and
        builds from that tag's commit, not from `main`'s HEAD.
  - [ ] `gh release view v0.20260925.4` afterward lists the `.deb` and
        `.sha256`.
  - [ ] Re-running the same dispatch is safe (idempotent update, not a
        failure).

### SUC-003: Admin finds and downloads the released .deb
Parent: N/A (operational/CI capability; no existing product-level UC)

- **Actor**: Lab admin installing/upgrading Robot Console on a Linux
  machine.
- **Preconditions**: A GitHub Release exists for the version to
  install (per SUC-001/SUC-002).
- **Main Flow**:
  1. The admin opens the Releases page for
     `League-Robotics/robot-console`, or runs
     `gh release download --repo League-Robotics/robot-console --pattern '*.deb'`.
  2. The admin optionally verifies the download against the published
     `.sha256`.
  3. The admin follows `docs/linux-install.md`'s existing
     `sudo apt install ./robot-console_<version>_amd64.deb` step.
- **Postconditions**: The admin has the correct `.deb` on disk, with a
  documented way to have found it.
- **Acceptance Criteria**:
  - [ ] `docs/linux-install.md` states the download location and the
        `gh release download` command before the install step.

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|
| 001 | Add .github/workflows/release-linux.yml (build, test, version-check, idempotent release publish) | — |
| 002 | Document where to download the .deb in docs/linux-install.md | — |
| 003 | Live verification: push main, dispatch release for v0.20260925.4, and confirm the next sprint-close tag auto-releases (requires stakeholder authorization) | 001, 002 |

Tickets execute serially in the order listed.
