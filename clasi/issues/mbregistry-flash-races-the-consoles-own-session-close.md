---
status: pending
---

# An mbregistry flash is refused as "in use by <this console>" because the flash lock request races the console's own session close

## Measured: denning, tigez, 2026-10-16

Pressing the robot-firmware flash button while the console had the board's
session open gave "in use by denning/robot-console". The registry log shows
the console refused by its own serial lock, with the release landing in the
same second:

```
12:32:27 flash lock refused for pid 305033 (denning / robot-console) -- held (serial) by pid 305033 (denning / robot-console)
12:32:27 serial lock released, was held by pid 305033 (denning / robot-console)
```

It happened again at 12:33:42. A second press, with no session open, went
through.

## Cause

`connect/flasher.ts` `flashMbregistry()` awaits `reconciler.requestClose()`
and then `mbregistry/remoteFlash.ts` opens a new connection and sends
`lock(flash)`. The close is observed by the registry through the old
socket closing, which can arrive after the new connection's lock request.
The USB path (`flash()`) retries `acquireBoardOwner` for `acquireTimeoutMs`
for exactly this residual race; the mbregistry path maps `locked` straight
to `owner-unavailable` with no retry.

## Fix options

- Retry `lock(flash)` for a bounded window when `holder` is this console's
  own label, mirroring `acquireWithRetry`.
- Or have `requestClose` resolve only once the registry has acknowledged the
  session's `unlock`, so the serial lock is gone before the flash lock is
  asked for.
