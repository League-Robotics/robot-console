---
status: pending
---

# The bench harness's exclusivity check answers the wrong question: "not held right now" is not "nobody is using this robot"

## Evidence (2026-09-18, cross-session collision on the live playfield)

Sprint 020 ticket 002's diagnostic ran with `--skip-held
--allow-shared-bench`, which I had told a peer session would keep my
harness off the robot it was working on. **It did not.** My process took
`tovez`'s mbserial daemon —
`192.168.1.40:55467 -> 192.168.4.53:37481 (ESTABLISHED)` — and two of
that session's staging runs died with `BrokenPipeError` mid-script,
leaving a robot physically half-positioned on the playfield. Earlier the
same day the same thing happened with a lingering `bench-ab.mjs` process.

The peer diagnosed it precisely, from its own side:

> "my tooling opens and closes one connection per step, so a
> census-at-start check will never see me holding anything"

and then generalized it better than I had:

> **"'not held right now' and 'nobody is using this robot' are different
> claims, and only the second one is the safety property."**

## The defect

`scripts/bench/layer1/exclusivity.ts` takes a **census at run start** and
treats "no current holder" as "free to take". Both flags inherit that
flaw:

- `--skip-held` skips resources that are held **at the instant it looks**.
- `--allow-shared-bench` disables the extra caution applied when a
  running robot-console host is detected — again, based on a
  point-in-time observation.

Against any workload that **cycles its connections** — one open/close per
step, which is how a scripted robot procedure naturally behaves — the
census reliably observes nothing and the harness claims the resource in
the gap. The flag is not "leave other people's robots alone"; it is
"don't fight over what is busy this instant", which is close to useless
for the case it is reached for.

This matters because the flag is *offered* as a safety guarantee. I
offered it as one to a peer, in writing, and it failed them within
minutes. A check that is trusted and wrong is worse than no check.

## The compounding cause: hosts enumerate

A host process reaches for **whatever it can discover**, regardless of
what it was asked to do. The sprint-020 diagnostic was nominally scoped
to `gopiv` and grabbed `tovez` anyway, purely because `tovez` was
discoverable. This is now the **third** independent demonstration:

1. Sprint 019 ticket 006: an "isolated" second host — own port, own state
   dir — connected to the real robot `vevov` over WiFi within a minute.
2. Sprint 020 ticket 002: a lingering `bench-ab.mjs` held `tovez`'s
   mbserial socket after its measurement had finished.
3. Sprint 020 ticket 002: the `gopiv` diagnostic took `tovez`.

## What to do

- **State the real safety property.** A resource is safe to take when
  nobody *intends* to use it, not when nobody holds it this instant.
  That needs a claim/lease with a duration and an owner — the shape
  `relay_leases` already has inside the store — not a census.
- **Scope a run to the devices it actually needs.** A diagnostic aimed at
  one robot should be incapable of touching another. Enumeration should
  be opt-in, not the default.
- **Stop presenting `--allow-shared-bench` as protection for other
  people's work.** At minimum correct its documentation in
  `scripts/bench/run.sh` and `scripts/bench/README.md`, which currently
  read as though it makes sharing safe.

## The enumeration half, located in code (2026-09-18, sprint 020 ticket 003)

Ticket 003 refused to start its verification runs after finding the
concrete mechanism, and it is worse than "hosts tend to grab things":

**`scripts/bench/layer1/index.ts`'s WiFi-announced dial loop (~line 357)
dials every `_robotlink._tcp` service the passive mDNS browse discovers,
unconditionally.** It is not gated by `known-robots.json`, not by
"owned" status, and not by any CLI flag. `--skip-held` and
`--allow-shared-bench` are both irrelevant to it — the robot is not
*held*, it is merely *discoverable*, and discoverable is all the loop
requires.

So the harness cannot be asked to leave a specific robot alone. A
promise to stay off a given device cannot be kept while running
`scripts/bench/run.sh` at all. That promise was made to a peer session
in writing and was, it turns out, unkeepable.

**And the subnets are not isolation.** This host's `en0` and `en1` both
carry a `/21` netmask covering `192.168.0.0`-`192.168.7.255`, so
`gopiv` (192.168.1.x) and `tovez` (192.168.4.x) sit in **one broadcast
domain**. Every argument in this project that treated the two subnets as
separating the fixtures — including in this issue's own earlier framing
and in sprint 021's planning notes — was wrong. mDNS reaches across
them freely.

### What that adds to the fix

The scoping requirement is now concrete and testable: **a run must be
able to name the devices it may touch, and dial nothing else.** That is
a change to Layer 1's dial loop, not just to a flag's documentation.
Note that Layer 2/3 *can* already be fenced (a synthetic single-robot
`known-robots.json` under a scratch `ROBOT_CONSOLE_STATE_DIR` works, and
was validated in 020-002) — it is Layer 1 alone that has no such gate.

Pair this with [[reconciler-stop-leaks-open-sessions]]: an unconstrained
dial is bad, and an unconstrained dial that then *fails to release the
socket* is what actually put a robot in a rail.

## Related

- [[shared-console-host-daemon-cli-and-discovery]] — sprint 021's
  "attach to the running host, never start a second" work is the
  structural fix for the enumeration half. This issue is the harness-side
  half and should probably be fixed alongside it.
- A peer working `pxt-nezha-diffdrive` reported the same *class* of
  failure from the other direction the same day: `tools/field_calibration.json`
  recorded tovez's tag mount as 0° residual when it is physically −90°,
  and a 98 cm leg driven off that record put the robot into the north
  rail. Same shape — a record asserting something about hardware that
  nothing had checked against the hardware itself. Different repo, not
  ours to fix, noted because the pattern is the point.
