---
status: in-progress
sprint: 019
tickets:
- 019-002
- 019-009
---

# WiFi robot discovery waits for the mDNS announcement interval instead of resolving on demand

## Evidence (team-lead, 2026-09-13, harness bench-report-008)

- The WiFi robots' mDNS responder (`gopiv` at 192.168.1.193, `vevov` at
  192.168.1.184, service `_robotlink._tcp` port 7654) only sends
  unsolicited periodic announcements and never answers queries.
- As a result, the host's `mdnsWatcher` may not create a `wifi` link
  for tens of seconds after host start — it is purely waiting on the
  next unsolicited announcement, not resolving on demand.
- Harness run bench-report-008: `gopiv wifi` failed Layer 3 with
  "no live-snapshot link of transport wifi found" because no `wifi`
  link existed yet at the time the harness probed it.
- The harness itself had to grow a name-lookup fallback in its own
  Layer 1 to work around this gap when probing WiFi robots directly.

## Expected

- For owned robots with no current `wifi` link, the host resolves
  `<name>.local` IPv4 with a bounded timeout, off the hot path, and
  creates/refreshes the `wifi` link when TCP port 7654 answers with a
  `HELLO`.
- This resolution does not block other host work — it runs
  opportunistically/off the hot path, not as a synchronous prerequisite
  to other operations.
- A robot whose mDNS announcement has not yet arrived still gets a
  `wifi` link within a bounded time, rather than waiting out however
  long the announcement interval happens to be.


## Reproduced on an exclusive bench (team-lead, 2026-09-17)

Sprint 018 closed without this fix; the issue returns to the pool for the
next sprint. The full harness ran on a genuinely exclusive bench that day
(the stakeholder stopped his own `npm run dev`, pid 38933; the report's
"Holders / skips" section reads "No resources held by another process at
Layer 1 run time" — 0 skipped, 0 contention), so the evidence below is
free of the contention that muddied every earlier attempt.

**`gopiv / wifi` → L1 pass, L2 pass, L3 fail**: _"no live-snapshot link of
transport 'wifi' found for 'gopiv'"_. The telling detail: gopiv's wifi chip
**is** present and green on a front-page screenshot taken later in the same
run (`01-front-torture-before.png`) — the link did arrive, just after Layer
3 had already given up waiting. That is this issue's exact shape: discovery
is waiting on the next unsolicited announcement rather than resolving on
demand. Layer 1 passed only because the harness itself grew a name-lookup
fallback to route around the gap (see the original evidence above).

Note the fleet has moved since this issue was written: on this run `tigez`
has a working WiFi path (it passed L1/L2/L3, header `WiFi ·
tigez.local:7654 Linked`), while `192.168.1.193` (gopiv) and
`192.168.1.184` (vevov) did not answer ICMP at all. Re-confirm the current
WiFi robot roster and addresses before implementing.


## Carried forward from sprint 018, ticket 012 (team-lead, 2026-09-17)

Sprint 018 planned this work as ticket 012 ("Relays and WiFi robots are
reachable without races"). **No implementation ever landed** — only the
planner's ticket-creation commit (`cc0e868`). At the stakeholder's
direction the sprint closed on what was actually done and this work moves
to the next sprint, where it will be re-ticketed from this issue. The
retired ticket's own analysis and implementation plan are preserved in git
history at that commit, and the design direction it settled on is worth
keeping:

- **Relay contention**: extend the `relayLeaseRevocation` takeover seam
  (016-004) so a *direct* console `session-open {linkId: <relay usb link>}`
  goes through the same lease-takeover path bridging already uses, instead
  of opening the raw port independently and racing the sweeper's ~30 s
  probe. Distinguish "our own sweeper holds it" (take over, no error) from
  "another *process* holds it" (a distinct plain-language reason — "another
  app has this relay open", never "Cannot lock port").
- **WiFi discovery**: give whichever module owns "an owned robot has no
  `wifi` link" a bounded, off-hot-path `dns.lookup(<name>.local, {family:
  4})` fallback, confirmed by dialing TCP 7654 and checking for `HELLO`
  before creating the link — the same IPv4-first approach 018-007 / SUC-004
  established for dialing an *existing* link, applied to creating one.

Both defects share a shape worth restating: something the host already does
correctly in one path needs to also happen in a second path that currently
has no such guarantee.

### `tigez` is in scope too (team-lead, 2026-09-17, second run)

Two full harness runs the same evening, ~15 minutes apart on the same
exclusive bench, disagreed about `tigez / wifi`:

- Run 1 (22:46Z): `tigez / wifi` **passed** all three layers — robot page
  header `WiFi · tigez.local:7654  Linked`, robot answered `id diffdrive
  tigez 1.20260914.1 tigez`.
- Run 2 (23:02Z): `tigez / wifi` **failed** L3 with the identical reason
  as gopiv — "no live-snapshot link of transport 'wifi' found for
  'tigez'".

No code affecting discovery changed between the runs (only
`scripts/bench/layer3/uiDriver.ts` and `scripts/bench/README.md`). That
intermittency is the clearest evidence yet that this is a race against
the announcement interval and not a per-robot configuration problem:
whether a WiFi link exists at probe time depends on where host start
falls relative to the next unsolicited announcement.

**Scope note**: the original report named only `gopiv`. Fix and test this
for **every owned robot with a WiFi path**, `tigez` included — and use
`tigez` as the regression fixture, since it demonstrably both succeeds
and fails under the current code.

## Not fixed by 019-002's on-demand-discovery fallback (programmer, 019-009, 2026-09-18)

019-002 shipped the bounded `dns.lookup` + TCP 7654 HELLO fallback and
closed `completes_issue: true`, but its own ten-consecutive-harness-runs
acceptance criterion against `tigez` was left unmet (no WiFi robot was
reachable at that ticket's verification time). This ticket (009) is the
sprint's own gate for exactly that kind of deferral, and ran the ten
runs now that `tigez` is back.

**Fixture chosen by property, not name**: at run time, `tigez` was the
only owned robot exhibiting a live WiFi banner match in Layer 1 (direct
`tigez.local:7654` HELLO). `gopiv` and `vevov` both failed WiFi-by-name
resolution (`getaddrinfo ENOTFOUND {gopiv,vevov}.local`) in every probe
this session ran — i.e. neither currently has a reachable onboard WiFi
path at all, independent of this discovery-timing question. `tigez` is
therefore the only valid fixture on the bench today, not a hardcoded
choice.

**Result: 2 pass / 8 fail across 10 valid, sequential
`scripts/bench/run.sh` runs** (2 further attempts were refused outright
by the harness's own exclusivity check, due to genuinely foreign
processes from *other, unrelated sessions* transiently holding a bench
resource — `gopiv`'s bridge port and `tovez`'s bridge port respectively;
neither was started by this session, neither was signaled, both cleared
on their own within seconds, and neither counts as one of the 10 —
recorded as bench-sharing events, not part of this ticket's own
evidence). Full stdout logs, per-run reports and screenshots are at
`clasi/sprints/.../tickets/` evidence path
`<scratchpad>/019-009/tigez-wifi-run-{1,2,4,5,6,7,8,9,10,12}.md` /
`.stdout.log`, summarized in `<scratchpad>/019-009/tigez-wifi-10run-summary.log`
(session scratchpad, not committed to the repo — cite by path in ticket
009's closing notes).

| run | L1 | L2 | L3 | reason |
| --- | -- | -- | -- | --- |
| 1  | pass | pass | fail | no live-snapshot link of transport "wifi" found for "tigez" |
| 2  | pass | pass | pass | - |
| 4  | pass | fail | pass | no link found in the snapshot for tigez via wifi |
| 5  | pass | pass | pass | - |
| 6  | pass | pass | fail | no live-snapshot link of transport "wifi" found for "tigez" |
| 7  | pass | fail | fail | no link found in the snapshot for tigez via wifi |
| 8  | pass | fail | fail | no link found in the snapshot for tigez via wifi |
| 9  | pass | fail | fail | no link found in the snapshot for tigez via wifi |
| 10 | pass | pass | fail | no live-snapshot link of transport "wifi" found for "tigez" |
| 12 | pass | fail | fail | no link found in the snapshot for tigez via wifi |

Notable: Layer 1's *raw* probe (a direct TCP dial + HELLO against
`tigez.local:7654`, the harness's own workaround for this exact gap)
passed all 10/10 — the robot's WiFi radio itself was reachable the
entire time. The failure is specifically that the **host's own live
link/snapshot** (Layer 2's WS-level session-open, Layer 3's browser-
visible link row) does not reliably reflect that reachability. This is
the same shape 019-002 was supposed to fix, and the failure mode has
gotten *more* consistent over the run (early runs split 2 pass/2 fail
in 4 attempts; the last 4 consecutive valid runs — 7, 8, 9, 12 — all
failed both L2 and L3), which argues against "just a race that
resolves eventually" and for the fallback path either not firing
reliably or regressing under repeated/rapid host restarts.

**This ticket (009) is not fixing this** — per its own scope rule
("if it is structural, stop and report rather than making a large
change here"), root-causing an intermittent async discovery race
inside `mdnsWatcher`'s on-demand fallback (or the reconciler policy
that triggers it) is exactly that kind of structural work, not a
one-line fix. Reopening/carrying this issue forward to the next sprint
that has bench access, with this ticket's 10-run evidence attached
rather than 019-002's single anecdotal 206ms success.
