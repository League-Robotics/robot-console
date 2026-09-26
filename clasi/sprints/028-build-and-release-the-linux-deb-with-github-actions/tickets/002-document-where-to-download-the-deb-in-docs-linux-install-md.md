---
id: '002'
title: Document where to download the .deb in docs/linux-install.md
status: open
use-cases: [SUC-003]
depends-on: []
github-issue: ''
issue: release-linux-deb-via-github-actions.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Document where to download the .deb in docs/linux-install.md

## Description

`docs/linux-install.md` tells admins to run
`sudo apt install ./robot-console_<version>_amd64.deb` but never says
where to obtain that file. Add a short, additive section pointing at
the GitHub Releases page (now populated by ticket 001's workflow) and
the `gh` CLI download command, ahead of the existing `## Install`
step.

## Acceptance Criteria

- [ ] `docs/linux-install.md` states where to get the `.deb`: the
      Releases page for `League-Robotics/robot-console`
      (`https://github.com/League-Robotics/robot-console/releases`),
      placed before the existing `sudo apt install ./robot-console_...`
      step so the download step isn't left unstated.
- [ ] Includes the `gh` CLI one-liner:
      `gh release download --repo League-Robotics/robot-console --pattern '*.deb'`.
- [ ] Mentions the published `.sha256` file and gives a one-line
      verification example (e.g. `sha256sum -c robot-console_<version>_amd64.deb.sha256`),
      since the release now always publishes one alongside the `.deb`.
- [ ] The edit is additive and minimal — no unrelated section is
      restructured or removed; the rest of the document (Prerequisites,
      First launch, Firmware sources, Troubleshooting, etc.) is
      untouched.
- [ ] Markdown renders correctly (fenced code blocks, no broken links).

## Implementation Plan

**Approach**: Insert a new `## Download` section (or a short leading
paragraph inside the existing `## Install` section — whichever reads
more naturally) between the document's intro and the current
`## Install` heading, giving the Releases URL, the `gh release
download` command, and the `.sha256` verification example.

**Files to modify**:
- `docs/linux-install.md`

**Testing plan**: Documentation-only change; no automated tests.
Manually re-read the edited file for correct Markdown rendering and
confirm the repository name/URL matches the actual GitHub org/repo
(`League-Robotics/robot-console`, consistent with the firmware-source
URLs already referenced elsewhere in this same document).

**Documentation updates**: this ticket *is* the documentation update.
