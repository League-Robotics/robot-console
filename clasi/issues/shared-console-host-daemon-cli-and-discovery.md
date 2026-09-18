---
status: pending
sprint: '021'
---

# One shared console host on the bench LAN: a daemon CLI to start/stop it, and discovery so everyone else attaches

## What the stakeholder asked for (2026-09-18)

> "are agents able to start and stop the console host? Are they able to
> find it? What I'd like to have is that if the console host isn't
> running, somebody can run it, and then everybody else can connect to
> it."

Plus, on how it should be started: *"create a cli to start and stop the
host as a daemon, with additional function to open a browser to the web
interface."* And on reach: **anyone on the bench LAN**, not just agents
on the stakeholder's own Mac.

## What is true today (verified in the code, 2026-09-18)

- **Agents cannot start or stop the host.** The MCP server is mounted
  *inside* the host process (sprint 019's deliberate in-process
  decision), so with no host running there is no MCP endpoint to call at
  all. The tool surface has no lifecycle verb either: `list_devices`,
  `get_device_status`, `open_session`, `close_session`, `send_command`,
  `request_drive`, `request_flash`.
- **Agents can only find it by convention.** `server.ts` has
  `DEFAULT_PORT = 4795` and `DEFAULT_HOST = "127.0.0.1"`. The console
  does not advertise itself over mDNS, and writes no pidfile or
  portfile. A host started with `--port 9000` is undiscoverable.
- **It is localhost-only.** Bound to `127.0.0.1`, so nothing on another
  machine can reach it regardless of discovery.
- **The `EADDRINUSE` message points the wrong way.** Today it reads:
  _"port 4795 is already in use on 127.0.0.1. Pass a different port
  (e.g. `--port <port>`) rather than relying on an automatically-chosen
  one."_ For a shared singleton this is backwards: it tells a second
  caller to start **another host**, which is exactly how two processes
  end up contending for the same serial ports and relay leases. Sprint
  019 spent three tickets on that defect class, and ticket 006's
  programmer hit it live — an "isolated" second host on its own port and
  state dir still grabbed the real robot `vevov` over WiFi within a
  minute, because any host reaches for whatever hardware it can see.
  "Already in use" should mean **"a host is already running — attach to
  it."**

## What to build

**1. A daemon CLI.** `robot-console start` / `stop` / `status`, plus a
verb that opens a browser at the running host's web UI. `start` should be
idempotent in the way the stakeholder described — if a host is already
running, it should say so and succeed rather than starting a second one
or erroring.

**2. Discovery.** The console advertises itself (e.g.
`_robotconsole._tcp`) with its real port, so agents and browsers find the
live host wherever it is and whatever port it chose. This fits the
codebase's existing idiom exactly — it already browses `_mbserial._tcp`,
`_mbflash._tcp`, `_mbrelay._tcp`, `_robotlink._tcp` via `mdnsWatcher.ts`,
and `discovery/wifiOnDemand.ts` (019-002) already does bounded
resolution. Reuse, don't invent.

**3. LAN binding.** Bind beyond `127.0.0.1` so other machines attach.

**4. Invert the already-running semantics.** `EADDRINUSE` (or a
discovery hit) means attach, not "pick another port". This is the change
that makes the whole feature safe, given what a second host does to the
hardware.

## Accepted risk, recorded deliberately

Drive and flash are **ungated** — sprint 019 removed the approval
subsystem at the stakeholder's explicit direction (*"Let the agents do
whatever they want. We can always reflash a board that needs to be
reflashed. It's not hard."*). Putting the host on the bench LAN
therefore means **anyone on that network can drive robots and flash
firmware, unauthenticated.**

The stakeholder was shown this consequence in those words when choosing
LAN reach and chose it anyway. It is recorded here so the decision is
visible to whoever implements this, **not** as an invitation to
reintroduce a gate. If a future change makes the network less trusted
(guests, a school-wide VLAN), this is the line to revisit first.

## Open questions for planning

- **Daemonization mechanism**: a detached child process with a pidfile,
  or a launchd agent? The stakeholder asked for start/stop control,
  which argues against an always-running service — but launchd gives
  restart-on-crash for free. What happens when the host dies with agents
  attached?
- **How `stop` finds the daemon** — pidfile, discovery, or both — and
  what it does when the pidfile is stale (the same dead-process-state
  problem sprint 018's `clearDeadProcessState` solved inside the store).
- **Where daemon logs go**, since there is no terminal attached.
- **Do MCP clients reconnect** when the host restarts, or does every
  agent need to re-open its sessions?
- **Which interface to bind**, given the bench spans subnets — the Mac
  sits on 192.168.1.x while `naught` is on 192.168.4.x.
- **Does `open` launch a local browser only**, or print a URL others can
  use? On a LAN-reachable host the URL is useful to a person on another
  machine.

## Related

- [[mcp-server-for-robot-connections]] — the in-process decision that
  creates this chicken-and-egg.
- [[mcp-flash-outlives-client-timeout]] — another rough edge in the same
  MCP surface; worth fixing in the same sprint.
- [[bench-wifi-robot-discovery-waits-for-announcement]] — still open, and
  the same mDNS machinery this feature builds on.
