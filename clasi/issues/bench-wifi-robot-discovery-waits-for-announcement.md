---
status: pending
sprint: 018
tickets:
- 018-012
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
