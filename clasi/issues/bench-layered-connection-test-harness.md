---
status: pending
---

# A repeatable three-layer bench test that every connection change must pass

## Why

Sprints 014–017 closed with ~1600 passing unit tests and several "bench passes", yet
the stakeholder found the UI unusable on 2026-09-12/13. Fakes and ad-hoc WebSocket
scripts hid real breaks. The stakeholder's instruction: test from the port up, then the
WebSocket, then Chrome, and try it.

## Proposed resolution

A committed, runnable harness (e.g. `scripts/bench/`), not scratch files:

1. **Layer 1 — raw devices:** for every discovered device, talk to it directly with no
   host: USB serial `HELLO`/`ID`; mbserial TCP `HELLO`/`ID` (report `ERR busy`); mbrelay
   pool `?`, command-plane `> HELLO` per known robot address, and the full
   `!ECHO OFF … !GO` data-plane `HELLO`/`ID`. Output: which robots are reachable over
   which paths right now. This is ground truth.
2. **Layer 2 — host over WebSocket:** start a host on a fresh state dir (optionally
   seeded from the real `known-robots.json`), wait for discovery, then for every path
   Layer 1 found reachable: `session-open`, `send-command ID`, expect the `line` rx
   reply, `session-close`. Also assert no card-visible link is stale while its service
   is advertised, no relay has `kind robot`, one device row per name.
3. **Layer 3 — Chrome (Playwright, headless):** load the UI; for each reachable path click
   Connect (or the card arrow), type `ID` in the console, expect the reply; assert
   enabled controls only on Linked pages; assert card text is plain and names the right
   robot; screenshot every page.
4. **Report:** one Markdown report with a row per robot × path: Layer 1 / 2 / 3
   pass-fail, the reason when failing, and screenshot links. A path that passes Layer 1
   but fails Layer 2 or 3 is a host/UI defect; a path that fails Layer 1 is environment.

Never sends motion verbs; never flashes. Requires exclusive access to the bench (no
other host or `npm run dev` holding ports/bridges) and says so up front, detecting
holders with `lsof`.
