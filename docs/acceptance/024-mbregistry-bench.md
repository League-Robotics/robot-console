# Sprint 024 mbregistry Bench Report

**Ticket**: [024-009](../../clasi/sprints/024-connect-to-mbregistry-client-watcher-and-stream-transport/tickets/009-bench-hardware-verification-spawn-case-system-instance-case-two-contending-clients.md)
**Date**: 2026-09-25
**Merged code**: `sprint/024-connect-to-mbregistry-client-watcher-and-stream-transport` @ `5dc99e5`
**mbregistry**: v0.20260924.7 (from the mbtools venv)
**Host**: macOS "gala"

This is the one manual/hardware verification pass for sprint 024's
mbregistry integration, per the sprint's Test Strategy ("tests must not
require a real mbregistry") and this ticket's own acceptance list. All
other sprint 024 tests run against a fake JSON-lines/binary server; this
report is the real-mbregistry, real-hardware counterpart. This is the
first entry in `docs/acceptance/`.

Where a case was also run before the final merge (against earlier,
pre-fix commits), that pre-merge run is noted for context, since it
often exposed the bug a later ticket in this sprint fixed.

## Case 1: Spawn case

**Result: PASS (merged).**

With no reachable registry (isolated `HOME`), the console spawned
`mbregistry run --instance gala-console … --no-peering --ready-json
--exit-with-parent` as its child. The child process exited ~5 s after
the console was stopped.

Found (not a regression, informational): running a second console on
the same machine at the same time logs "Service name is already in use
on the network" from `bonjour-service`, because of the spawned
instance's own LAN advertisement colliding with the first. The console
keeps running fine — this is bonjour-service log noise, not a
functional failure.

Pre-merge: an earlier run failed because the state-dir socket path was
too long for the platform socket-path limit; this was fixed by ticket
010 before the merge this report is against.

## Case 2: System-instance case

**Result: PASS (merged).**

With a running user registry already up at
`~/Library/Application Support/mbregistry/api.sock`, the console
attached to it directly and spawned nothing.

## Case 3: Two contending clients

**Result: PASS (merged and pre-merge).**

Forward direction (merged): a second client's `lock` call against a
board the console already held returned `locked`, with holder
`{label: "gala / robot-console", since}`. Running
`mbregistry unlock --force vevov` released the lock; the console saw
EOF on its own connection, did not crash, and re-acquired the board
within ~1 s (this is the console's normal auto-connect-to-owned-robot
behavior, not a bug — but it does mean force-unlock alone does not free
an owned board away from a running console; operators should know
that).

Reverse direction (pre-merge run, informational): with a board held by
a raw client labeled "bench-raw", the console's attempt to connect
showed "Couldn't connect: in use by bench-raw"; the holder then saw EOF
after a force-unlock.

## Case 4: Relay reset / bridging on real hardware

**Result: PASS (merged).**

Bridged robot `vitut` (on host `magni`) through relay `togov` (on host
`loki`), both discovered via mbregistry. Console reported "Connected to
vitut via togov on channel 41, group 30" and received live robot
status. Disconnect was clean.

Pre-merge, this case was blocked entirely by missing `relayBridger`
wiring; that was fixed in ticket 011 before this merge.

**Not separately verified**: BREAK-based physical reset of a *parked*
relay when the relay is owned by a Linux host vs. a macOS host — the
sync-first reset path succeeded in the run above, so the BREAK fallback
path itself was not separately exercised on both host OSes.

## Case 5: Minimum-version check

**Result: SKIPPED at stakeholder request.**

Not exercised this pass.

## Case 6: Flash a local board through mbregistry

**Result: console path PASS; hardware FAIL (bench/probe issue, not a
robot-console defect).**

The console flashed local relay `getez` via the local-socket `flash`
op: the flash lock was held for ~20 s and the result was reported in
the UI. However, mbregistry's underlying `pyocd` step failed during
erase with "Timeout reading from probe."

To isolate this, `pyocd flash -u <uid>` was run directly against the
same board on this Mac, outside of mbregistry/robot-console entirely,
and it also failed ("flash erase sector failure … 0x67"). This confirms
the failure is a pyocd/probe/USB-hub problem on this Mac's bench setup,
not a robot-console or mbregistry integration bug. A mass-storage-device
(MSD) drag-drop recovery attempt was made; `getez` may need a replug and
re-flash before it can be used to close out this case.

Pre-merge, local flash failed differently ("no remote TCP port known");
that was fixed in ticket 011 (local-socket flash path) before the merge
this report is against.

## Case 7: Flash a remote (peer-host) board through mbregistry

**Result: PASS (merged and pre-merge).**

Relay `togov` on host `loki` (192.168.2.149:7440) was re-flashed with
`microbit-radio-relay` v0.20260913.2 via `send_hex` + `flash`; the UI
returned to the front page on success, with no manual refresh needed to
re-identify the relay afterward.

Hosts `torture`/`braeburn`/`hodr` (192.168.1.x) were unreachable on port
7440 from this Mac for network reasons (different subnet/segment) — this
is a bench network condition, not a code defect, but it did expose that
robot-console had no connect timeout for this path; that gap was fixed
in ticket 011 (10 s timeout + a "connecting" UI phase) before the merge
this report is against.

## Other findings

An existing L daemon integration test
(`packages/host/src/daemon/cli.test.ts`, the `"real process"` test)
leaves a detached host process running on port 19572 when it fails.
During this bench session that orphaned process held local boards for
about an hour and caused peering to report host `loki` as "peer
unreachable" even though `loki`'s remote port was still answering
directly. This is a pre-existing test-hygiene issue, not sprint 024
code; worth a follow-up ticket to make that test clean up its child
process on failure.

## Summary

| Case | Result |
|---|---|
| 1. Spawn | PASS |
| 2. System instance | PASS |
| 3. Two contending clients | PASS |
| 4. Relay reset/bridging | PASS (BREAK-on-parked-relay cross-OS variant not separately verified) |
| 5. Minimum version | SKIPPED (stakeholder request) |
| 6. Local flash | Console path PASS; hardware FAIL (bench pyocd/probe issue, not robot-console) |
| 7. Remote flash | PASS |

Known gaps carried into ticket closure: case 5 skipped by stakeholder
request; case 6's hardware-level pyocd/probe failure on this Mac's bench
setup (root-caused to the probe/USB hub, not robot-console, via a direct
`pyocd` reproduction outside mbregistry); case 4's BREAK-based reset on a
Linux- vs. macOS-owned parked relay not separately exercised.
