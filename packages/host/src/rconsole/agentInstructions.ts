/**
 * rconsole/agentInstructions.ts — the text `rconsole agent` prints.
 *
 * Purpose (stakeholder, 2026-09-18): "an agent command that produces
 * agent instructions that agents can use to figure things out."
 *
 * This is written for an AI agent that has just arrived, has shell
 * access to this machine, and knows nothing about the bench. It favours
 * the things that are expensive to learn by experiment — the ones this
 * project learned by breaking real hardware — over things an agent can
 * discover cheaply by reading `--help`.
 */
export const AGENT_INSTRUCTIONS = `# robot-console — instructions for an agent

You are talking to a robot bench: micro:bit-based robots reachable over
USB serial, WiFi, farm serial bridges (mbserial), and radio through a
relay. The console is a single host process that owns those connections.
You drive it through MCP.

## Connecting

The MCP server lives **inside the host process**, so start a host first
(below) — no host means no endpoint to connect to. It speaks Streamable
HTTP, not stdio: there is no command to spawn.

Endpoint: \`http://127.0.0.1:4795/mcp\`

Claude Code, on this machine:

    claude mcp add --transport http robot-console http://127.0.0.1:4795/mcp

or in \`.mcp.json\`:

    {
      "mcpServers": {
        "robot-console": {
          "type": "http",
          "url": "http://127.0.0.1:4795/mcp"
        }
      }
    }

From another machine on the bench, swap the host for this machine's
name — \`http://<hostname>.local:4795/mcp\`. The host binds to every
interface and accepts that name; it is the same URL \`rconsole ui\`
prints for sharing.

Identify yourself: your MCP client name is recorded as the \`caller\` on
every session and every action you take, and it is what a human sees in
the console UI. Use something a person can recognize.

## Getting a host

    rconsole status     # is one running, and where?
    rconsole start      # start one if there isn't (no browser)
    rconsole            # start if needed, then open the UI

**There is only ever one host.** \`start\` probes before it spawns
anything, so running it again attaches to the host already running. Do
not start a host any other way. Two hosts on one bench fight over the
same serial ports and relay leases; this has put a robot into a wall.

    rconsole stop       # stops the host AND releases its robots

\`stop\` waits for the process to actually exit before reporting success.
If it reports \`timed-out\`, the robots may still be held — believe that
over any assumption that stopping worked.

## Tools

| tool | what it does |
| --- | --- |
| \`list_devices\` | every known device and its links. No side effects. |
| \`get_device_status\` | one device in detail, incl. \`recentAgentActions\`. |
| \`open_session\` | open a session on a link. |
| \`close_session\` | close one. |
| \`send_command\` | send the text protocol (ID, STATUS, VER, FUNCS, GET/SET, cal*). |
| \`request_drive\` | motion verbs. Executes immediately. |
| \`request_flash\` | flash firmware. Executes immediately. |

\`send_command\` refuses motion-starting verbs and points you at
\`request_drive\`, which validates their arguments properly. That is
routing, not permission — there is no approval step anywhere.
\`STOP\` and \`ESTOP\` stay in \`send_command\` and are always available; a
safety stop must never queue behind anything.

## What you are allowed to do, and what that means

**Drive and flash are ungated by deliberate decision of the bench's
owner.** You can move robots and overwrite firmware with no human
confirmation. Act accordingly:

- A robot that moves can drive off a table or into a wall. Know where it
  is before you start it.
- **Read a board's \`ID\` before flashing it.** A board may be carrying
  someone's hand-built or measured firmware that exists nowhere else.
  If the profile is not the fleet's calibration build, assume it is
  deliberate and ask before overwriting it. This has been got wrong.
- Everything you do is recorded in \`agent_actions\` and shown in the
  console UI, attributed to your MCP client name. That is visibility, not
  a gate — but a human will see what you did.

## Flashing takes longer than your client's timeout

\`request_flash\` waits for the flash to finish and returns the outcome.
A flash can exceed a default 60s MCP client timeout. **A timeout is not a
failure** — the flash is still running server-side and will complete.

Do **not** retry: you would reflash a board that succeeded. Recover the
result instead:

    get_device_status { deviceId }  ->  recentAgentActions[0]

## Identity: trust the chip, not the label

One board can advertise different names on different services — this has
been observed live:

    _mbserial._tcp    ->  tovez-2
    _robotlink._tcp   ->  tovez robot link
    HELLO on the wire ->  device NEZHA2 robot tovez

Only \`HELLO\` comes from the chip. The advertised names are whatever the
advertising daemon was told. **When they disagree, \`HELLO\` wins.** Two
sessions once read the same bench as contradictory because they browsed
different service types.

Related: resolve a robot by *property* ("a robot with a live WiFi path")
at the moment you use it, never by a name or address you were told
earlier. Fixtures on this bench changed identity four times in two
sprints — hosts moved, addresses died, names gained suffixes.

## You are not alone on this bench

Other agents and humans use these robots at the same time.

- Before taking a robot, check whether anything holds it:
  \`lsof -nP -iTCP@<bridge-address>\`.
- **Never kill or signal a process you did not start.** Ask its owner.
- If someone says you are contending with their work, stop. Their robot
  is probably mid-procedure and physically somewhere specific.
- A robot being idle *this instant* is not the same as nobody using it.

## Known rough edges

- A board can advertise \`_mbserial._tcp\` (bridge alive) while having no
  \`_robotlink._tcp\` at all — that means its WiFi service is down, not
  that discovery is flaky.
- WiFi link discovery is unreliable; a WiFi link may appear later than
  you expect after host start. Open \`ID\` over another transport to check
  whether a robot is actually there before concluding it is absent.
- A \`.local\` name that resolves does so in ~5ms; one that does not takes
  ~5000ms to fail. Budget accordingly, and use \`dns.lookup\` —
  \`dns.resolve4\` cannot resolve \`.local\` at all.
`;
