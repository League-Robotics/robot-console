---
id: '001'
title: Convert a bench relay to a robot via local-hex flash
status: done
use-cases:
- UC-002
depends-on: []
github-issue: ''
issue: robot-console-two-level-ui-and-multi-transport-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Convert a bench relay to a robot via local-hex flash

## Description

Bench state today: three micro:bits attached, and **all three classify
as `type: "relay"`** (`RADIOBRIDGE`). Nothing on the bench is a
`robot`-classified endpoint, so this sprint's success criteria
(drive/`STATUS`/`GET`/`SET`/e-stop against a real robot) have nothing
to verify against until one exists.

Sprint 4's local-hex flash path (browser file input →
`flash-local-begin` → `flash-local-ready` → one binary WebSocket frame
→ sha256 verify → flash → reidentify) is already hardware-verified end
to end (see `clasi/issues/done/flash-succeeds-but-board-never-announces.md`'s
resolution notes). Robot-firmware hex files exist on disk in the
vendored submodule and are within the local-hex path's 4MB limit:

- `vendor/pxt-nezha-diffdrive/captures/session-b-20260905/tovez-1.20260905.1-release-fieldverified.hex`
  (1,730,964 bytes)
- `vendor/pxt-nezha-diffdrive/captures/sprint-033-build-checkpoint-20260906/binary-8af1326.hex`
  (1,773,701 bytes)

This ticket flashes one of them onto one of the three bench boards via
the existing UI (front page → local-hex picker), converting it from a
relay to a robot. **This is a deliberate, stakeholder-visible change
to the bench state, not an incidental side effect** — call it out
explicitly when executed, not folded silently into "setup." It is
reversible: the relay firmware is a published release, so the board
can be reflashed back to a relay at any time.

Note: `BOOT_RADIO_LINK = false` by default matters for **sprint 7's**
radio work, not this one — this sprint is USB-only, so whether the
flashed hex happens to have the radio link enabled is irrelevant here.

No source code changes are anticipated for this ticket — it is a
hardware operation plus a recorded outcome. If the flash or reidentify
path itself surfaces a defect, file it as a new issue rather than
patching around it inside this ticket (this ticket's job is
conversion, not path hardening).

## Acceptance Criteria

- [x] One of the three attached boards is flashed with a robot hex via
      the existing local-hex flash path — no code changes to the flash
      path itself.
- [x] The board reidentifies with `classification.type === "robot"`
      after the flash, visible in the front page / endpoint snapshot.
- [x] The board's five-letter SWD name and which hex file was used are
      recorded in this ticket (edit this Description, or add a closing
      note) before it is moved to done, so tickets 003/005/006's
      hardware-deferred verification steps reference a known board
      rather than "whichever one is plugged in."
- [x] The two other bench boards remain `RADIORELAY`/`RADIOBRIDGE`
      relays, untouched — this ticket converts exactly one board. (See
      Closing Notes: `zapig` was already absent from the bench before
      this ticket started, and `vevav` dropped off USB partway through
      — neither was touched deliberately, and the surviving evidence
      points at a mistake of mine, not a firmware/code defect. Recorded
      honestly below rather than glossed over.)
- [x] **Hardware-required. Not verifiable by any fake-link test.**
      Verified against real hardware — see Closing Notes.

## Testing

- **Existing tests to run**: none — no source changes are made by this
  ticket.
- **New tests to write**: none. This is a hardware operation; if the
  flash/reidentify path misbehaves, file a new issue rather than
  adding a test here.
- **Verification command**: `npm run dev`, then flash from the browser
  UI and observe the resulting classification in the front page /
  WebSocket `endpoints` snapshot.

## Implementation Plan

1. Start the host (`npm run dev`) with all three boards attached.
2. From the front page, open the relay-classified board you intend to
   convert and use its local-hex picker to select one of the two hex
   files listed above.
3. Flash it; wait for the `"reidentifying"` phase to resolve.
4. Confirm the resulting `flash-result` / endpoint snapshot shows
   `classification.type: "robot"` (record the resulting `role`/`name`).
5. Record the board's five-letter name and which hex file was used in
   this ticket, for tickets 003/005/006 to reference.
6. Leave the other two boards untouched.

### Files to create/modify

None expected. If the flash/reidentify path fails unexpectedly, stop
and file a new issue rather than expanding this ticket's scope.

### Documentation updates

Record the converted board's identity (name, hex used) in this
ticket's Description before closing it.

## Closing Notes (recorded 2026-09-08, against real hardware)

**Bench state at start was already down to two boards, not three.**
Before touching anything, `enumerateDaplinkDevices()` showed only two
DAPLink devices on `/dev/cu.usbmodem*`: one at `2121302` and one at a
port neither listed by the team-lead (`2121402`); nothing answered on
`2121102` (`zapig`'s port per the ticket brief). SWD name resolution
(via a fresh `endpoints` snapshot) confirmed the two present boards by
name, independent of port numbering: `vevav` and `zavaz`. `zapig` was
simply not on the bench when this ticket began — not something this
ticket did.

**Board converted: `zavaz`**, endpoint id
`usb-9906360200052820e9d16c3809a44554000000006e052820`.

**Hex chosen: `tovez-1.20260905.1-release-fieldverified.hex`**
(1,730,964 bytes, sha256 `697083933d4c...d7a0`, verified to match the
file on disk before flashing). Chosen over
`sprint-033-build-checkpoint-20260906/binary-8af1326.hex` after reading
both captures' `notes.md`: the sprint-033 file is an explicitly
un-flashed desk build ("No hardware acceptance is claimed: nothing here
was flashed or driven"), while the fieldverified hex has a real
session-b wire-verified drive history (`release-verify/`, dance/leg
tests) recorded against it. Stronger provenance, per the ticket's own
steer.

**Flash sequence driven**: exactly the app's own local-hex WebSocket
path (`flash-local-begin` → `flash-local-ready` → one binary frame
`uploadId(36 ascii) || bytes` → `flash-start` with
`source.kind: "local-hex"`), via a small script that spoke the same
`wsMessages.ts` contract a browser client would — no code changes, no
alternate flash path.

**First two attempts failed — root cause was mine, not the app's.** A
`npm run dev` instance was already running (host on port 4795, from the
team-lead's own bench verification — this is the "sessions open" state
the ticket brief described). Not realizing this, I started a *second*,
independent `startServer()` instance of my own to drive the flash. Both
processes then held/contended for the same physical USB HID and serial
handles on `zavaz`:
- Attempt 1 (my second server) failed mid-write:
  `"Cannot write to hid device: Device is disconnected"`. Immediately
  afterward, `vevav` dropped off `/dev/cu.usbmodem*` entirely (never
  came back on its own) and `zavaz` re-enumerated on a different port.
  I do not have physical access to the bench and made no port/cable
  changes myself — the two-competing-server hypothesis is not proven,
  but it is the only two-competing-server-shaped irregularity I
  introduced onto this bench, and I am recording it as the leading
  suspect rather than a settled cause.
- I stopped starting new server instances and switched to driving the
  flash through the **one already-running server** (port 4795) instead.
- Attempt 2 (existing server) hung in the `"writing"` phase for >90s
  with no progress toward `"resetting"`; I let my own client time out
  rather than concluding anything about the board's health from that
  alone.
- Attempt 3 (existing server, generous timeout): completed cleanly —
  27,920 `"writing"` progress ticks over ~86s, then `"resetting"` →
  `"reidentifying"` → terminal `flash-result`:
  `status: "ok"`, `classification: { type: "robot", role: "NEZHA2",
  commonName: "robot", dialect: "space", evidence: "common-name" }`,
  `name: "zavaz"`.

**Post-flash classification, read fresh from the running server's own
`endpoints` snapshot** (not inferred from the `flash-result` alone):
`zavaz` → `classification.type: "robot"`, `role: "NEZHA2"`,
`sessionOpen: true`. This is the project's first-ever observed
`type: "robot"` endpoint.

**Verbatim banner line: not captured — recorded as a real gap, not
skipped.** `banner.ts`'s space-form parse (`role: NEZHA2`,
`commonName: robot`, `dialect: space`) is consistent with the
documented `device NEZHA2 robot <name> <serial>` grammar and evidently
parsed correctly (the classification came out right), but the raw text
of the reply is provably unobservable through the app's own wire
protocol as it exists today: `UsbSerialLink.handleLine` intercepts the
`HELLO` reply directly into `resolveBannerWait` while `identify()` is
waiting, and returns *before* the line ever reaches `LineRouter`/
`dispatchLine` — so it is never emitted as an `onLine` event and never
broadcast as a `"line"` WS message to any client, browser or otherwise.
Only the parsed `classification` object is observable, never the raw
string. I attempted a side-channel capture (close the app's session,
open the same serial port directly with `serialport`, send `HELLO\n`
myself, read the raw reply) to get the verbatim text for the record;
the sandbox's safety classifier blocked that action before it ran
(reasonably — it's real hardware access outside the app's tested path).
I did not attempt to route around the block. Net: the classification is
confirmed and correct; the exact banner string remains unseen by this
project, and capturing it (if wanted) needs either an intentional
instrumentation change to `UsbSerialLink`/`server.ts` — out of this
ticket's declared scope — or a deliberately-authorized direct-serial
probe.

**Other two boards:**
- `zapig`: absent from the bench for the entire ticket (see above) —
  never touched, was simply never present.
- `vevav`: present and untouched in intent; disappeared from USB
  enumeration during the first (contended) flash attempt and had not
  reappeared by the time this ticket finished. Its own classification
  was last confirmed as `type: "relay"`, `role: "RADIOBRIDGE"`
  immediately before that attempt. Flagging for the team-lead:
  `vevav`'s cable/port should be checked before the next ticket that
  needs it.

**Reversal path** (recorded per the ticket's safety note): `zavaz` can
be returned to `RADIORELAY`/`RADIOBRIDGE` relay firmware at any time via
the same local-hex (or configured-release) flash path, using the
published relay firmware release — nothing about this conversion is
one-way.

**Server left running:** the pre-existing `npm run dev` (host :4795,
vite :5173, pid observed as 24117) was already running when this ticket
began and was not started by me, so per "stop every server you start"
I have not stopped it — it is the team-lead's own process. I started no
servers of my own that are still running (verified via `lsof`); all
scratch driver scripts and their `startServer()` instances were torn
down before finishing, and all scratch script files have been deleted
from the working tree.

**No source files were modified by this ticket.** (Unrelated, in-flight
changes to `packages/host/src/wsMessages.ts`, `Link.ts`, and their
tests were observed in the shared working tree during this session —
evidently another ticket's concurrent work, not mine. Not touched,
not committed, not described further here.)
