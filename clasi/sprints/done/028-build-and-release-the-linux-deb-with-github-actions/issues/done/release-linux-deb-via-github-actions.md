---
status: done
sprint: 028
tickets:
- 028-001
- 028-002
- 028-003
---

# Build and release the Linux .deb with GitHub Actions

## Stakeholder request (2026-09-26)

Eric: "We've got a packaged version of this that we're installing on
Linux machines. Make sure that package is getting built and released
through GitHub Actions, and make sure our current version has been
released."

## Current state

- No `.github/` directory exists: no workflows, no GitHub Releases.
  Tags exist, and `close_sprint` already pushes a `vX.Y.Z` tag at each
  sprint close (latest `v0.20260925.4`, matching `package.json`).
- `scripts/package-linux.sh` builds
  `dist/robot-console_<version>-<release>_amd64.deb`. It runs
  `git archive HEAD` into an `ubuntu:24.04` `linux/amd64` docker
  container (`packaging/linux/build-in-container.sh`, `nfpm`, bundled
  Node), with inputs pinned and checksum-verified in
  `packaging/linux/pins.env`. `--test` also runs
  `packaging/linux/test-install.sh`, which install-tests the `.deb` in
  a fresh container. The version is read from HEAD's `package.json`.
  Git submodules are not needed for the build. The download cache is
  `build/linux/cache`.
- `docs/linux-install.md` tells admins to
  `sudo apt install ./robot-console_<version>_amd64.deb` but doesn't
  say where to get the file.

## Intended solution

- Add `.github/workflows/release-linux.yml`:
  - Triggers: push of tags `v*`, plus `workflow_dispatch` with a `tag`
    input so an existing tag (`v0.20260925.4`) can be released.
  - `runs-on: ubuntu-24.04`, `permissions: contents: write`.
  - Check out the tag with full history. Cache `build/linux/cache`.
  - Run `scripts/package-linux.sh --test`.
  - Assert that the `package.json` version at the tag equals the tag
    minus its leading `v`.
  - Publish a GitHub Release for the tag with the `.deb` and a
    `.sha256` file attached. Idempotent: create the release if
    missing, otherwise upload with `--clobber`. Use generated notes.
  - Concurrency keyed per tag.
- Update `docs/linux-install.md`: where to download the `.deb` (the
  Releases page / `gh release download`).
- Verification is live: push `main` so the workflow is on the default
  branch, dispatch it for `v0.20260925.4`, and confirm the release
  exists with the `.deb` asset. This sprint's own close will push a
  new tag, which must auto-release through the tag trigger; confirm
  that too.

## Out of scope

- apt repository hosting
- arm64 builds
- signing
