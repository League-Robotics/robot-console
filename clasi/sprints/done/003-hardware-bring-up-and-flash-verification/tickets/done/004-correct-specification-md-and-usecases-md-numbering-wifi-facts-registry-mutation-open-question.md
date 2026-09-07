---
id: '004'
title: Correct specification.md and usecases.md (numbering, WiFi facts, registry mutation,
  open question)
status: done
use-cases:
- SUC-005
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Correct specification.md and usecases.md (numbering, WiFi facts, registry mutation, open question)

## Description

`docs/design/specification.md` has accumulated factual errors discovered
during roadmap planning that will mislead every future planning pass if
left uncorrected: stale sprint numbering in §7, wrong WiFi mDNS service
names/TXT format in §4.4/§7/UC-010, and an under-documented mutation in the
mbrelay registry's GET affecting §6/UC-004. This ticket makes exactly the
four corrections the roadmap issue's "Spec corrections" section specifies —
documentation only, no code or runtime behavior change.

This ticket does **not** close the roadmap issue — `completes_issue: false`
is deliberate; that issue spans all 8 remaining arc positions.

## Acceptance Criteria

- [x] `specification.md` §7 is renumbered to match the roadmap issue's
      8-sprint-arc table (`clasi/issues/robot-console-two-level-ui-and-multi-transport-roadmap.md`'s
      "Proposed fix" section): sprints 1-2 unchanged (merged history); new
      3 = Hardware bring-up (this sprint); new 4 = Device model + navigation;
      new 5 = Persistence; new 6 = Robot control over USB (the control half
      of today's Sprint 3); new 7 = Relay, radio, discovery (the transport
      half of today's Sprint 3); new 8 = Telemetry (today's Sprint 4); new
      9 = WiFi robots (today's Sprint 6); new 10 = Calibration wizards
      (today's Sprint 5).
- [x] `specification.md` §4.4 (line ~191) and the WiFi sprint subsection
      under §7 (lines ~292-293) are corrected: the robot advertises under
      **both** `_robotlink._tcp` and `_robotlink._udp`; the TXT record
      carries `link=v6`, not `link=v6-udp`. Source:
      `vendor/radio-robot-lib`'s upstream `src/DESIGN.md:1284` and
      `wifi_link.cpp:953`.
- [x] `docs/design/usecases.md`'s UC-010 (lines ~315-333) is corrected to
      match: both service types, `link=v6` in the TXT record example.
- [x] `specification.md` §6's registry bullet and `docs/design/usecases.md`'s
      UC-004 (main flow step 2, error flows) record that mbrelay's `GET
      /names/<name>` **mutates** the shared registry (`httpapi.py:146`
      calls the creating `resolve()`, not the non-mutating `get()`; the
      call writes into `_learned` and calls `save()`), and that a
      successful-looking HTTP reply can be a locally-derived guess rather
      than authoritative knowledge — "the call succeeded" is not the same
      as "the registry knew."
- [x] A new item is added under `specification.md` §9 Open Questions
      recording that no radio-enabled robot hex is currently obtainable
      (`pxt-nezha-diffdrive` publishes zero releases; `BOOT_RADIO_LINK =
      false` by default per `test/test.ts:48`), noting it gates arc
      positions 6, 7, 8, and 10.
- [x] §9 Q3(a) and Q3(d) are **not** closed. They are annotated (e.g., a
      parenthetical or a sub-note) as likely closable once the submodule
      bump (ticket 003) is confirmed, pending explicit stakeholder
      confirmation that `d4d8e4e` is the intended upstream direction — per
      the roadmap issue's own instruction not to close them unilaterally.
- [x] The two documents remain internally consistent after all edits: every
      cross-reference to a renumbered section, and every use-case citing a
      corrected fact, agrees with the correction.

## Implementation Plan

**Approach:** four targeted, mechanical edits plus one internal-consistency
pass. No code changes; nothing here touches test coverage.

1. **§7 renumbering** — rewrite the "## 7. Sprints" section's subsection
   structure and headings to the new 10-position numbering, preserving
   existing content for sprints 1-2 verbatim and re-slotting/re-titling the
   remaining content (today's Sprint 3 "Radio + control" splits across new
   6 and 7; today's Sprint 4 "Telemetry" becomes new 8; today's Sprint 5
   "Calibration wizards" becomes new 10; today's Sprint 6 "WiFi" becomes
   new 9) per the roadmap issue's table. New sprints 3, 4, 5 get brief
   summaries pointing at their own future detail-planning (this sprint is
   new 3's detail plan; 4 and 5 aren't detail-planned yet).
2. **WiFi facts** — edit `specification.md:191` (§4.4) and `:292-293` (§7's
   WiFi sprint, now renumbered to §7 new-9) to browse/advertise both
   `_robotlink._tcp` and `_robotlink._udp`, TXT `link=v6`. Edit
   `usecases.md:315-333` (UC-010) to match.
3. **Registry mutation** — edit `specification.md` §6's registry bullet and
   `usecases.md`'s UC-004 main flow step 2 / error flows to add the
   mutation and derived-guess notes.
4. **New §9 open question** — append the missing-hex item; annotate Q3(a)/(d)
   as noted above without closing them.
5. **Consistency pass** — re-read both documents end to end after the
   edits, checking every section-number cross-reference and every place a
   use case cites a spec section, to catch anything the mechanical edits
   missed.

**Files to modify:**
- `docs/design/specification.md`
- `docs/design/usecases.md`

**Testing plan:** none (documentation only); `npm run build`/`npm test`
are unaffected and don't need to be re-run for this ticket alone, though
they will run anyway as part of whichever other ticket lands adjacent to
it in the same session.

**Documentation updates:** this ticket *is* the documentation update.
