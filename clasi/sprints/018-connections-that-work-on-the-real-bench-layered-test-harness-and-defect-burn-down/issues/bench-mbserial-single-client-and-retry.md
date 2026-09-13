---
status: in-progress
sprint: 018
tickets:
- 018-008
---

# mbserial bridges are single-client, and a failed mbserial link is not retried

## Evidence (team-lead, 2026-09-13)

- The farm bridges (`loki` for gopiv, `magni` for tigez, `hodr` for vevov) accept one TCP
  client. A second client gets `ERR busy` then the connection resets (observed on loki
  while a host held it), or silence.
- Raw `HELLO`/`ID` to loki and magni with no other client connected: both answer
  immediately (`device NEZHA2 robot gopiv 2175407711`, `id diffdrive … gopiv`;
  `device NEZHA2 robot tigez 3527777815`, `id diffdrive unbaked … tigez`).
- The stakeholder's host has `mbserial-gopiv` `failed` "produced no banner", fail_count 1,
  and does not retry, while the bridge answers raw a minute later. The failure coincided
  with another host process (the team-lead's bench host) still connected.
- `mbserial-tigez` `failed` "transport closed", fail_count 4.

## Expected

- `ERR busy` is recognised and reported as "another app is connected to this bridge"
  (not "no banner"), with a retry after backoff.
- A failed mbserial link on an owned robot is retried on backoff until it connects,
  including when the device has no other connected link.
- Two host processes never silently fight over one bridge; the loser says so.
