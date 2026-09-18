---
id: '021'
title: 'Shared Console Host: Daemon CLI, LAN Discovery, and Flash Timeout Recovery'
status: roadmap
branch: sprint/021-shared-console-host-daemon-cli-lan-discovery-and-flash-timeout-recovery
use-cases: []
issues:
- shared-console-host-daemon-cli-and-discovery.md
- mcp-flash-outlives-client-timeout.md
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 021: Shared Console Host: Daemon CLI, LAN Discovery, and Flash Timeout Recovery

## Goals

Ship one shared console host on the bench LAN: a daemon CLI to
start/stop/status it plus a browser-open verb, self-advertisement so
agents and people find the live host wherever it runs, and LAN binding
so machines beyond the stakeholder's own Mac can reach it. Also fix a
small, unrelated rough edge in the same MCP surface: `request_flash`
outliving a default MCP client timeout.

**Depends on Sprint 020 (WiFi Discovery Reliability) merging first.**
Both this sprint's self-advertisement and the existing `_robotlink._tcp`
discovery it reuses sit on the same mDNS machinery
(`watchers/mdnsWatcher.ts`, `discovery/wifiOnDemand.ts`) that 020 fixes.
Building and testing "agents find the live host" on top of a discovery
layer currently succeeding 2 times in 10 (019-009's gate) would mean
diagnosing two overlapping failure modes at once and re-doing this
sprint's discovery verification after 020 lands anyway. Do not start
this sprint's discovery/advertisement work before 020 is merged to
`main`.

## Problem

Today, per code verified 2026-09-18: the MCP server is mounted
in-process inside the console host, so with no host running there is no
MCP endpoint at all and no lifecycle verb to start one. The host is
bound to `127.0.0.1` only and advertises itself nowhere, so a host on a
non-default port is undiscoverable and unreachable from other bench
machines. Worse, `server.ts`'s `EADDRINUSE` handler tells a second
caller to start *another* host on a different port — backwards for a
shared singleton, and the exact mechanism that let an "isolated" second
host grab the real robot `vevov` over WiFi within a minute during sprint
019 ticket 006, despite its own port and state dir.

Separately: `request_flash` deliberately awaits the flash task's
terminal promise so the MCP response carries the real outcome (avoiding
a polling design where a snapshot overlay disappears the instant a
flash settles). But a real flash can outlast a client's default 60 s MCP
timeout — confirmed live in 019-008, where `tigez` flashed successfully
but the calling client never received the result. A timeout then looks
identical to a failure, risking a needless retry of a flash that already
succeeded.

## Solution

**Daemon and discovery** (after Sprint 020 lands):
- A CLI (`robot-console start` / `stop` / `status` / a browser-open
  verb) that manages the host as a daemon. `start` is idempotent: if a
  host is already running, report it and succeed rather than starting a
  second one.
- Self-advertisement (e.g. `_robotconsole._tcp`) with the host's actual
  port, reusing the existing mDNS idiom the codebase already applies to
  `_mbserial._tcp` / `_mbflash._tcp` / `_mbrelay._tcp` / `_robotlink._tcp`
  rather than inventing a new mechanism.
- LAN binding beyond `127.0.0.1` — the bench spans subnets (the Mac on
  192.168.1.x, `naught` on 192.168.4.x), so which interface(s) to bind is
  itself work to figure out, not an assumed given.
- Invert the already-running semantic: `EADDRINUSE` (or a discovery hit
  showing a live host) means *attach to it*, never "pick another port."

**Flash timeout recovery**: make the flash outcome recoverable when a
client's own timeout fires before the flash settles, using the durable
`agent_actions` record (019-006) that already stores `result` and
`result_reason` for every executed flash — a lookup keyed by a returned
handle reads an existing audit row, it does not reintroduce the
approval-gate machinery sprint 019 removed. Whether to also keep
returning the outcome inline when the flash settles within the client's
window (belt-and-suspenders) versus recovery-only is a Detail Mode
design decision, not decided here.

## Success Criteria

- A host not currently running can be started by a CLI command; a
  second `start` against an already-running host reports that and exits
  successfully without starting a second process.
- `stop` and `status` work against a daemonized host; the browser-open
  verb reaches the running host's actual (possibly non-default) port.
- The host advertises itself over mDNS with its real port, and can be
  bound to reach at least one non-localhost interface on the bench.
- A second host start attempt against a running host never independently
  claims hardware (the `vevov`-grab failure mode from 019-006 does not
  recur).
- A flash whose MCP call times out before settling has its outcome
  recoverable afterwards by the caller, without re-flashing.

## Scope

### In Scope

- Daemon CLI: start/stop/status verbs, a browser-open verb, pidfile
  and/or discovery-based liveness detection, idempotent `start`.
- mDNS self-advertisement of the console host, reusing existing
  `mdnsWatcher.ts` idiom.
- LAN binding strategy given the bench's multiple subnets (investigate;
  do not assume a single obvious interface).
- Inverting `EADDRINUSE` / already-running handling from "start
  elsewhere" to "attach here."
- `request_flash` timeout recovery via the existing `agent_actions`
  durable record.
- The open questions listed in `shared-console-host-daemon-cli-and-discovery.md`
  (daemonization mechanism, stale-pidfile handling, log destination, MCP
  client reconnect behavior on host restart, bind-interface choice,
  local-vs-shareable URL for the open verb) are resolved during Detail
  Mode planning for this sprint, not pre-decided here.

### Out of Scope

- Any gate, approval prompt, or "safe mode" for drive/flash on the LAN.
  This is accepted, recorded risk from the stakeholder's own explicit
  choice (sprint 019 removed the approval subsystem at his direction);
  re-opening it is out of scope for this sprint.
- An always-on launchd service as the *primary* start-up model — the
  stakeholder chose CLI-driven start/stop over both "ask before
  starting" and "always-on service." launchd may still be considered as
  a crash-recovery implementation detail underneath the CLI, not as a
  replacement for it.
- The WiFi discovery reliability fix itself (Sprint 020) — this sprint
  consumes that fix as a merged prerequisite and does not re-attempt it.
- USB-attached and host-attached relay verification — no USB serial
  devices are attached to the bench as of this writing.
- Making `agent_actions` a pending/lifecycle table — it stays
  append-only, describing only things that already happened; a timeout
  recovery read is not a pending state.

## Test Strategy

(Describe the overall testing approach for this sprint: what types of tests,
what areas need coverage, any integration or system-level testing needed.)

## Architecture

(Architecture for this sprint's change, sized to the change — a
one-paragraph note for a trivial sprint, a fuller write-up with
component/data-model detail for a substantial one. May read "N/A —
trivial" when the change has no architectural impact.)

### Architecture Overview

(High-level structure and component relationships, if applicable.)

### Design Rationale

(Significant decisions with alternatives considered and reasoning, if
applicable.)

### Migration Concerns

(Data migration, backward compatibility, deployment sequencing — or
"None" if not applicable.)

## Use Cases

(Use cases sized to the change — may read "N/A — trivial" for small
sprints that don't warrant new or updated use cases.)

### SUC-001: (Title)
Parent: UC-XXX

- **Actor**: (Who)
- **Preconditions**: (What must be true before)
- **Main Flow**:
  1. (Step)
- **Postconditions**: (What is true after)
- **Acceptance Criteria**:
  - [ ] (Criterion)

## GitHub Issues

(GitHub issues linked to this sprint's tickets. Format: `owner/repo#N`.)

## Definition of Ready

Before tickets can be created, all of the following must be true:

- [ ] Sprint planning document is complete (sprint.md, including its
      Architecture and Use Cases sections)
- [ ] Architecture review passed (or skipped, for changes with no
      architectural impact)
- [ ] Stakeholder has approved the sprint plan

## Tickets

| # | Title | Depends On |
|---|-------|------------|

Tickets execute serially in the order listed.
