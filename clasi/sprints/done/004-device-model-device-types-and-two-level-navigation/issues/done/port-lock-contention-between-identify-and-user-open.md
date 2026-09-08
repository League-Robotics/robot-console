---
status: done
sprint: '004'
tickets:
- 004-002
---

# Port lock contention between automatic identify and a user-initiated open

## Description

Opening a link from the Console tab shortly after the host's own
automatic identify attempt fails with `Resource temporarily unavailable,
Cannot lock port`. Observed repeatedly during ticket 011, including
after a fresh host restart and waits up to 15s.

## Cause

`DeviceRegistry` opens a link on its own to read the boot banner, then
releases the port. A user-initiated open racing that release hits the OS
lock while it is still held. The per-device `KeyedMutex` added in ticket
009 serializes access *within* the registry, but the failure suggests the
lock is not held across the full open/probe/close cycle, or that the OS
releases the device slightly after the fd is closed.

Note this is distinct from the board being silent — the identify attempt
times out on a silent board, which is expected and handled; the problem
is the port state afterwards.

## Proposed fix

Hold one link per device for its lifetime and multiplex readers over it,
rather than opening and closing per operation. Failing that, extend the
mutex to cover the port's actual release and retry the lock with backoff.

## Verification

Open a link from the Console tab immediately after the device appears,
repeatedly, with no `Cannot lock port` failure.

## Partial fix landed in sprint 003

Ticket 005 found and fixed one real contributor while flashing a board:
`deviceRegistry.ts#openLink`'s failure branch never closed a link whose
underlying `SerialPort` was already open at the OS level, leaking the handle for
the process's lifetime and producing `Cannot lock port` on every subsequent
attempt. That is one concrete source of the symptom described above.

It is **not** established that this was the only cause, so this issue stays
open. The broader contention design - one link per device held for its lifetime,
with readers multiplexed over it - is still the planned fix, and lands with the
device/endpoint/session model in arc position 4.

