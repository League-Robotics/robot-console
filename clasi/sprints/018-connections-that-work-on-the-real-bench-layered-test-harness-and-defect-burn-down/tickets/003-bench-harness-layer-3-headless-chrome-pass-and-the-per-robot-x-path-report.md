---
id: '003'
title: 'Bench harness Layer 3: headless Chrome pass and the per-robot x path report'
status: open
use-cases:
- SUC-001
depends-on:
- '002'
github-issue: ''
issue: bench-layered-connection-test-harness.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Bench harness Layer 3: headless Chrome pass and the per-robot x path report

## Description

Third and final layer of the harness (SUC-001), completing the harness
issue. Build `scripts/bench/layer3/` (Playwright, headless Chrome
against the real built UI, `packages/ui/dist`, served by the same host
Layer 2 started) and the report generator that ties all three layers
together into the one Markdown report every other ticket in this sprint
cites as evidence.

- For each path Layer 1 found reachable and Layer 2 attempted: load the
  UI, click Connect (or the card's arrow), type `ID` in the console,
  expect the reply to appear; assert enabled controls only on a
  genuinely `Linked` page; assert card text is plain language and names
  the right robot (no raw internal ids); screenshot every page checked.
- **Report generator**: one Markdown file, one row per robot × path,
  columns for Layer 1/2/3 pass-fail, the failure reason when failing,
  and links to screenshots. A path failing only Layer 1 is labeled
  "environment"; a path passing Layer 1 but failing Layer 2 or 3 is
  labeled a defect, per the issue's own framing.
- Reuses tickets 001/002's exclusivity check and Layer 1/2 outputs as
  input.

## Acceptance Criteria

- [ ] `scripts/bench/layer3` drives the real built UI in headless
      Chrome for every Layer-2-attempted path: Connect, type `ID`,
      assert the reply appears in the console.
- [ ] Asserts enabled controls only on a page the snapshot says is
      actually `Linked` (not merely `connecting` or TCP-connected).
- [ ] Screenshots every page checked, saved under a path the report can
      link to.
- [ ] The report generator produces one committed-format Markdown file
      with one row per robot × path and Layer 1/2/3 pass-fail, failure
      reasons, and screenshot links — this is the artifact every
      subsequent ticket in this sprint (004-011) cites as its harness
      evidence.
- [ ] **Harness command and evidence**: `scripts/bench/run.sh
      --report /tmp/bench-report.md` (the full three-layer run) against
      the real bench; the generated report is attached to this ticket's
      completion notes, showing at least one full robot × path row
      passing all three layers end to end (e.g. USB to a relay-flashed
      board on the hub).

## Implementation Plan

**Approach**: Playwright (already installed per sprint 015 ticket 011's
own bench evidence — `~/Library/Caches/ms-playwright` has Chromium)
driving the production build, not a dev server; the report generator is
a small Markdown templater reading Layer 1/2's JSON plus its own Layer 3
results.

**Files to create**:
- `scripts/bench/layer3/uiDriver.ts` (Playwright: load, Connect, type,
  assert, screenshot)
- `scripts/bench/layer3/index.ts`
- `scripts/bench/report/generate.ts` (Layer 1+2+3 JSON → Markdown report)
- `scripts/bench/run.sh` (the one committed entry point: exclusivity
  check, build the UI if needed, run Layer 1 → 2 → 3, generate report)

**Files to modify**: none in `packages/*`.

**Testing plan**: `vitest` coverage for the report generator (fixture
Layer 1/2/3 JSON → expected Markdown, including the
environment-vs-defect labeling rule); the live Playwright run against
real hardware is this ticket's bench evidence and cannot be meaningfully
faked in CI.

**Documentation updates**: `scripts/bench/README.md` gets the full
three-layer usage, the exclusivity requirement, and the report format,
since this becomes the standing reference every future ticket in this
sprint (and beyond) points back to.
