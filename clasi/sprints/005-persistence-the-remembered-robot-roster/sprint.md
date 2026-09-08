---
id: "005"
title: "Persistence: the remembered-robot roster"
status: roadmap
branch: sprint/005-persistence-the-remembered-robot-roster
use-cases: []
issues: []
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Sprint 005: Persistence: the remembered-robot roster

## Goals

Introduce the project's **first persistence layer** — a small, on-disk
roster of robots the console has identified over USB — and give it a
boundary of its own before anything downstream (the relay dropdown in
sprint 7, mDNS gating in sprints 7/9) starts consuming it. Today there
is no database, no JSON store, not even `localStorage`: state dies with
the process and a replug resets a device entirely. This sprint makes the
foundational, easy-to-get-wrong decisions — on-disk location, file
format, schema versioning, corruption handling, what counts as "seen,"
how a user forgets a robot — once, deliberately, rather than letting
them be made implicitly by whichever later sprint happens to need a
place to write.

Concretely: a `knownRobots.ts` store in `packages/host`, written only on
a successful USB identify that classifies as `type === "robot"` with
banner evidence; read at boot; exposed over the wire as a `remembered`
presence state; rendered on the front page so a robot that is not
currently plugged in is still visible and nameable; and an explicit
"forget this robot" action, since this store has no automatic expiry.

This sprint depends on **sprint 4** (being planned concurrently) for the
device-type union and endpoint model — the roster stores a `type` and a
name that sprint 4 defines — and does not duplicate that work.

## Problem

There is no persistence anywhere in the project. A robot identified over
USB today is known only for the life of the host process; unplug it and
the console has no memory of it. That blocks two things the roadmap
needs later: a relay dropdown that lists robots by name without a robot
being physically present, and an mDNS gate that only shows advertisements
from robots a classroom has actually seen (rather than trusting any
device that advertises itself, which would be self-fulfilling and would
let a whole classroom of strangers' robots leak into a student's view).

Because this is the *first* store the project has ever needed, the
decisions made here — file location, format, versioning, corruption
recovery, identity key, expiry policy — are foundational. Made well once,
with tests, they are reused by nothing (this sprint deliberately does not
generalize the store for other data) but they set the pattern anyone
adding a second store later will follow or deviate from with reason.

## Solution

Add `packages/host/src/store/knownRobots.ts`: a plain-JSON, versioned,
file-backed store of one record per five-letter robot name (the nRF
`FICR.DEVICEID[1]`-derived target identity used everywhere else in the
system — the dropdown, `radioAddress.ts`, the mbrelay registry, mDNS —
not the USB serial, which comes from a different chip per spec §2.2 and
is only a display hint).

- **Write path**: hook into the successful-USB-identify path (the same
  point sprint 4's device classification lands) and write only when
  `type === "robot"` with banner evidence. Not on mDNS sightings (that
  would make the gate self-fulfilling), not on relay-mediated sightings
  (that would enroll an entire classroom's robots from one relay).
- **Read path**: load at host boot; corrupt, missing, or unknown-version
  files degrade to an empty roster with a warning, never a crash,
  matching `config.ts`'s existing "never fatal" discipline. A file
  written by a *newer* version of the code than is currently running is
  loaded as empty and the store refuses to write, so an older `npx`
  invocation on a shared machine cannot clobber a newer install's data.
- **Location**: `${XDG_STATE_HOME:-~/.local/state}/robot-console/known-robots.json`,
  overridable via `ROBOT_CONSOLE_STATE_DIR`, following the existing
  `ROBOT_CONSOLE_*` env convention in `config.ts`. Not the repo root
  (an `npx robot-console` user has no repo to write into) and not
  `localStorage` (the enrollment gate must be enforced host-side, not by
  a browser that could be pointed at any host).
- **Format**: plain JSON with a `version` field. No SQLite (a native
  dependency on top of `node-hid`/`serialport`, which already make `npx`
  install fragile) and no lowdb (a dependency for what is realistically
  forty lines of read/write/atomic-rename code).
- **Durability**: writes are atomic (temp file + rename) and debounced,
  since replugging a board tends to arrive in bursts. A write failure
  never fails the underlying USB sighting — persistence is a side effect,
  not a precondition. The filesystem access is injected as a seam
  (mirroring `flash.ts`'s `WriteFileFn`) so the whole store is unit
  testable against a temp directory with no real disk-timing dependency.
- **Exposure**: the roster is surfaced over the existing WebSocket
  contract as a `remembered` presence state (alongside whatever presence
  states sprint 4 already defines), so a robot that is not currently
  attached still appears — greyed out — in the front-page device list,
  with its name and `lastSeenAt`.
- **Forgetting**: no automatic expiry — a classroom that meets weekly
  would have its actually-wanted robots aged out by any reasonable expiry
  window. Instead, an explicit "forget this robot" action removes a
  record on request, and `lastSeenAt` is shown so a stale entry is at
  least visible before a person decides to remove it.

**Distinction preserved in the design**: the relay dropdown (sprint 7)
and the mDNS advertisement gate (sprints 7/9) are two different
mechanisms consuming the same roster, not one mechanism. A radio robot
advertises nothing at all — the radio link is silent and fire-and-forget
— so the dropdown is purely roster-driven with no discovery in the loop.
Gating against the roster applies only to network-discovered peers
(mDNS). This sprint's store is deliberately agnostic to which consumer
reads it; neither consumer is built here.

## Success Criteria

- A successful USB identify of a `type === "robot"` device writes (or
  refreshes) a roster record keyed by the robot's five-letter name.
- Restarting the host process preserves the roster — a robot last seen
  before restart still appears, marked `remembered`, on the front page
  even while unplugged.
- Corrupting, truncating, or deleting the roster file, or pointing at a
  file with an unrecognized `version`, never crashes the host — the
  roster degrades to empty with a logged warning.
- A roster file with a `version` newer than the running code's is loaded
  as empty and no write occurs — verified by test, not just by
  inspection.
- A user can remove a robot from the roster via an explicit "forget this
  robot" action, and the removal persists across a restart.
- The entire feature — round-trip, corruption recovery, version-mismatch
  handling, concurrent/bursty writes — is provable against a temp
  directory with **no hardware and no deferred criteria**. That is
  unusual for this project and worth stating plainly in the ticket
  verification sections.

## Scope

### In Scope

- `packages/host/src/store/knownRobots.ts`: the store itself — schema,
  versioning, atomic+debounced writes, injectable fs seam, corruption and
  version-mismatch handling.
- Wiring the store's write path into the successful-USB-identify flow
  (robot type, banner evidence only).
- Loading the store at host boot.
- Exposing roster entries over the wire as a `remembered` presence state,
  consistent with sprint 4's presence model.
- Rendering remembered-but-unplugged robots in the front-page device
  roster (name, `lastSeenAt`, greyed to distinguish from attached
  devices).
- An explicit "forget this robot" action (UI affordance plus the host
  operation that removes the record).

### Out of Scope

- Anything that *consumes* the roster for its intended downstream
  purposes: the relay dropdown (sprint 7) and mDNS advertisement gating
  (sprints 7/9) — there is no mDNS in the project yet.
- Persisting anything other than the known-robots roster: console
  scrollback, telemetry history, UI preferences, link/session history.
  This store will attract requests for all of these; say no now.
- Any new device-type or transport modeling — that belongs to sprint 4,
  which this sprint depends on and does not duplicate.
- Automatic expiry of roster entries (explicitly rejected — see
  Solution).

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
