---
status: in-progress
sprint: '027'
tickets:
- 027-001
- 027-005
---

# A robot's own mbregistry link never identifies ("no banner within the identify budget") although the board answers `ID` at once

## Symptom

Tigez's own board link
`mbregistry-99063602000528203b43773cab0210ea000000006e052820` (hodr,
`/dev/ttyACM1`) sits in `failed` with:

> connector: link "…3b43773c…" produced no banner within the identify budget

It shows as an orange mbregistry icon on the card. `open_session` on it
fails the same way. That was still true after the stale zugit session
occupying the port was closed (see
`gone-mbregistry-board-link-is-reattributed-to-the-next-board-on-its-port.md`).

Also: after the failure its `nextRetryAt` passed without a retry being
attempted. The link stayed `failed` for 10+ minutes.

## Evidence the board is fine

With nothing holding the port (`lsof /dev/ttyACM1` empty on hodr), opening
it directly on hodr with pyserial at 115200 and sending `ID\n` returns
immediately:

```
id diffdrive calibration-0.20260919.6 1.20260914.1 tigez
DBG:wifi state=1 ...
```

The registry itself also identified the board from its own probe
(`raw_announcement: "device NEZHA2 robot tigez 3527777815"`).

So the failure is somewhere between the console's connector, the
mbregistry stream (local socket → peer hodr:7440), and the identify
handshake. Candidates to check:
- the stream for this UID is routed to a stale/other session on hodr;
- the identify probe is not sent (or sent before the stream is ready) and
  the robot only prints a banner in reply to `ID`, never unsolicited;
- DTR/reset handling on stream open.

Pointers from the sprint 024 author: the identify path for mbregistry
links is `connector.ts` `buildStreamPlan` → `mbregistryStream` (lock +
stream; local socket first, then the remote port). Suspects: relay-vs-serial
lock kind, the stream ack / first-frame leftover handling in `client.ts`
`performStreamHandshake`, or a reset/BREAK disturbing the port. See
`clasi/sprints/done/024-*/replay-guide.md` and
`docs/acceptance/024-mbregistry-bench.md`.

From mbtools: the stream opens the port with DTR/RTS held low (no reboot),
so the board never re-announces on open. The console must send `ID` and
read the reply. First step: confirm the connector actually sends `ID` (log
the exact bytes) on an mbregistry stream and not only on direct serial.

Related: before robot-console-e6's uncommitted fix, `client.watch()` shared
the control connection, and any later `list()`/`find()`/`lock()` on it hung.
Re-test this issue after that fix lands; it may change the picture.

## Expected

Opening a robot's current mbregistry link identifies it as reliably as a
direct serial `ID` does. A failed link is retried at `nextRetryAt`.
