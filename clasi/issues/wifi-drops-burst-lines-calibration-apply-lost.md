---
status: pending
---

# Firmware: the WiFi link drops lines emitted in a burst; calibration apply lines are lost

## Description

Captured 2026-09-10 on `gopiv` (template `calibration-0.20260910.3`,
extension `1.20260909.2`) over WiFi, host side, during `RUN cala`:

```
29.1 CALA:slope cw=0.7693 ccw=0.6945 gap=26.9deg/turn
29.1 CALA:measured b=8.84cm  (anchor was 12.08)
29.2 CALA:derived slip=1.301 = track 11.5 / b 8.84
29.3 CALA:armed at 4deg
```

`calibratea.ts` emits five lines back to back at that point: slope,
measured, derived, `CALA:apply ...`, `CALA:check clockwise`. Only the
first three reached the host; the apply line and the check marker were
dropped. The robot's `DBG:wifi` line on the same board showed
`drop=75` earlier in the day, and `FUNCS` over WiFi is already known to
truncate at seven lines (the 8-slot emit ring). USB and radio are not
affected.

Stakeholder-visible effect: the rotation wizard showed every progress
detail and then never produced the code to paste. The console now
reconstructs the result from `CALA:derived slip=` / `CALX:calib=` +
`CALX:diameter=` when the apply line is missing (commit on 2026-09-10),
but that is a workaround for the transport, not a fix.

## Proposed resolution (pxt-nezha-diffdrive)

Make the WiFi sink drain the emit ring without dropping when the
module's send is slow: block the emitting fiber briefly (bounded) when
the ring is full instead of refusing the line, or grow the ring for the
WiFi sink, or coalesce a burst into one TCP send. Count and report
drops on `STATUS` so the host can show them.
