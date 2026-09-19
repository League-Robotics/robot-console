---
status: pending
---

# The supervisor's host child advertises its internal port, so a LAN client can bypass idle-release

## The gap

Found while merging `linux-packaging` into `main` (2026-09-19, commit
`3ebf17c`), flagged rather than patched because fixing it is design work,
not conflict resolution.

The packaged `.deb` runs a **supervisor** (`packages/host/src/supervisor/`)
on the public port (4795 by default). Its whole purpose is that an
installed desktop app should **release USB, serial and WiFi hardware when
no window is open**: it starts the real host child on demand, on an
internal port (4796 by default), and idle-stops it when the last
connection goes away.

But the host child still runs `startConsoleAdvertiser` itself, so it
advertises `_robotconsole._tcp` **on its own internal port**, not the
supervisor's public one. And that internal port is bound `0.0.0.0`
(sprint 021's LAN-reach decision), so it is **directly reachable from the
LAN**.

Two consequences:

1. **The idle-release model can be bypassed.** A client that connects
   straight to 4796 holds the hardware open without the supervisor ever
   seeing a proxied connection — so the supervisor believes it is idle
   and the robot stays claimed. That is exactly the "stopped does not
   mean released" class of bug that
   [[reconciler-stop-leaks-open-sessions]] was about, arriving by a
   different route.
2. **Discovery points at the wrong door.** Anything finding the console
   over mDNS gets the internal port, so it connects past the component
   that manages the host's lifecycle rather than through it.

## Why it was not fixed in the merge

Reconciling it means deciding *who owns the advertisement*:

- make mDNS advertisement supervisor-owned (the supervisor advertises
  its public port; the child never advertises), or
- suppress advertisement in a supervised child and leave it on for a
  standalone host, or
- bind the child to loopback only, so the LAN cannot reach it at all —
  but check this against sprint 021's LAN-reach decision before
  assuming it is safe.

Any of those is a design choice with consequences for
`rconsole`/`daemon/cli.ts`, which probes and attaches on the public port.
Picking one inside a merge resolution would have been the wrong place.

## Related, and already handled

The same merge found a **second** collision at the same seam and did fix
it: the supervisor's HTTP surface only proxied WebSocket upgrades, so a
plain `GET /api/host-info` fell through to the SPA catch-all and returned
`index.html`. That would have broken `daemon/cli.ts`'s attach probe — it
would have seen an unparseable 200, tried to spawn a second host, and
hard-failed on the bound port instead of attaching — and also the new
header version fetch. The supervisor now answers `/api/host-info` itself
(`{ok, service, port, version}`) rather than proxying, since the point of
an idle-stopped host is that there is no child to proxy to.

## Not observed, only reasoned

No LAN test of the bypass was run — there was no second machine
available. This is a reasoned-through risk from reading the merged code,
not an observed failure. **Confirm it before designing the fix**: stand a
supervised install up, connect a second machine straight to the internal
port, and check whether the supervisor still reports itself idle and
whether it stops the host out from under that client.
