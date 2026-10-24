---
status: pending
---

# Relay "Switch" fails with "in use" on an mbregistry relay

## Found (2026-10-24, sprint 029 hardware test)

On ferranti, through guvov (an mbregistry relay on `/dev/ttyACM0`), the
relay page's Switch button fails every time, whatever the shapes:

- raw ch76/g30 → raw ch12/g30
- raw ch76/g30 → named gopiv
- named gopiv → named tigez

The old link closes with `closed_by_user relay-switch` and the new one
goes straight to `failed` with `in use by ferranti / robot-console`, in
the same second. Disconnect, then Connect, works every time. So the
new bridge asks mbregistry for guvov's lease before the old bridge's
release has landed, and mbregistry reports the console's own lease
back to it as "in use".

Not caused by sprint 029: named → named fails the same way.

## What to do

Make Switch wait for the old bridge's relay lease to be released (or
reuse it) before the new bridge acquires it. Check the same ordering in
the MCP path, where a caller closing and immediately reopening on the
same relay would race too. Related:
`mbregistry-flash-races-the-consoles-own-session-close.md`.
