# robot-console — Use Cases

Actors:

- **Student / Instructor** — the person using the console. No assumed
  command-line or firmware background.
- **robot-console host** — the Node process (`packages/host`) started by
  `npx robot-console`, acting on the user's behalf against devices, the
  relay fleet, and GitHub Releases.

## UC-001 — Connect and identify a device over USB

**Actor:** Student

**Preconditions:** `npx robot-console` is running and the browser UI is
open. A micro:bit (blank, relay-flashed, or robot-flashed) is available.

**Main flow:**
1. Student plugs the micro:bit into a USB port.
2. The host detects a new DAPLink device (`VID 0x0D28 / PID 0x0204`) via
   `devices.ts` and reads its `serial_number`.
3. The host attaches over SWD (no halt, no reset) and reads
   `FICR.DEVICEID[1] @ 0x10000064` via `swdName.ts`.
4. The host hashes the device ID into the five-letter friendly name
   (`naming.ts`).
5. The host opens the serial port, sends `HELLO`, and reads the banner
   reply to determine role (relay vs robot) and confirm liveness,
   per the open-then-HELLO sequence (specification §6).
6. The device list on the **Devices** tab updates over the WebSocket to
   show the five-letter name, role, port, and UID.

**Postconditions:** The device appears in the Devices tab with a correct
name and role, and the student can identify it by its five-letter name
without reading any USB serial number.

**Error flows:**
- If SWD attach fails (unsupported chip, permissions issue), the host
  reports the device as detected but unnamed, and surfaces the error
  rather than silently omitting the device.
- If no banner reply arrives after `HELLO`, the device is listed as
  "unresponsive" rather than assigned a role.

---

## UC-002 — Install firmware on a blank micro:bit

**Actor:** Student

**Preconditions:** A blank (never-flashed) or differently-flashed
micro:bit is connected via USB and named per UC-001 (naming works on a
blank board because it reads the chip ID over SWD, not firmware output).

**Main flow:**
1. Student selects the device in the **Devices** tab and chooses a
   firmware to install (e.g., relay firmware).
2. The host fetches the hex server-side from
   `.../releases/download/v<TAG>/MICROBIT.hex` plus the companion
   `MICROBIT.hex.txt` manifest (`releases.ts`), and verifies the download
   against the manifest's sha256.
3. The host extracts the relevant block from the universal hex
   (`BLOCK_ID_V2 = 0x9903`) if needed.
4. The host flashes over SWD using DAPjs (`flash.ts`), reporting progress
   to the UI.
5. On completion, the UI shows which build (commit / built date / sha256)
   is now installed, from the manifest.
6. The device resets, boots the new firmware, and re-announces; the
   Devices tab updates its role accordingly.

**Postconditions:** The device runs the selected firmware and its role in
the Devices tab reflects that firmware's banner.

**Error flows:**
- If the SWD flash fails partway, the host reports failure and does not
  claim the new firmware is installed; MSD volume-copy fallback is
  attempted or offered.
- If the sha256 verification fails, the host refuses to flash and
  reports a download-integrity error.
- Calibration firmware is not yet available to select (open question 1 in
  `specification.md` §9) — the UI must not offer it as an option until a
  hex exists.

---

## UC-003 — Drive a robot over USB

**Actor:** Student

**Preconditions:** A robot-flashed micro:bit is connected via USB and
identified per UC-001.

**Main flow:**
1. Student opens the **Console** tab (or a drive control, if present) for
   the named robot.
2. The UI sends drive commands (e.g., `WHEELS_X`/`WHEELS_V`) over the
   `UsbSerialLink`, each paced ~10 ms apart to avoid overrunning the
   115200 link.
3. The robot replies with lowercase acks/nacks per the v6 session layer;
   the UI reflects sequence/ack state.
4. Student issues `STOP` or an e-stop to halt the robot.

**Postconditions:** The robot moves as commanded and the UI accurately
reflects the current sequence state.

**Error flows:**
- A `nack N` reply is interpreted as "next expected is N" (not
  "last good was N") and the session layer retransmits the correct frame
  reusing its original id.
- A lowercase inbound verb that is not a recognized reply is dropped
  silently — it is not this session's traffic.
- If writes are sent faster than the pacing budget, the console throttles
  rather than flooding the link.

---

## UC-004 — Drive a robot over the radio relay

**Actor:** Student

**Preconditions:** A relay-flashed micro:bit is connected via USB (or a
remote relay is available over `MbrelayLink`, see UC-008) and a
robot is powered and in radio range. Both relay and robot are identified
per UC-001.

**Main flow:**
1. Student selects the relay and target robot in the **Devices** tab.
2. The host resolves the robot's actual `(channel, group)` **lazily, for
   this one name, at connect time** — never prefetched. It finds mbrelay's
   name registry by browsing `_mbrelay._tcp`, whose TXT record advertises
   the registry port (verified live: instance `torture` at
   `torture.local.:8760`, TXT `registry=8761`), then calls `GET
   /names/<name>` on that port. This call **mutates the registry**: on a
   miss, the registry derives an address locally, persists it, and still
   replies HTTP 200 with `source: derived` — so "the call succeeded" is
   not the same as "the registry knew." There are **three outcomes, not
   two**: **authoritative** (the registry actually knew), **derived** (the
   registry only echoed its own just-made guess — surfaced as prominently
   as a fallback, since the failure mode is identical to not knowing), and
   **unreachable** (the host falls back to its own locally-derived
   `(channel, group)` from `radioAddress.ts`). Whenever a derived address
   (registry-derived or locally-derived) is in use, the UI visibly flags
   it — never silently.
3. The host configures the relay's command plane: `!ECHO OFF`,
   `!MODE RAW250`, `!CG <ch> <grp>`, `!P 7`, then `!GO` to enter the data
   plane (`RelayRadioLink`).
4. Student drives the robot as in UC-003; every message is kept within
   one radio frame (≤247 bytes in RAW250 mode) because the radio is
   fire-and-forget with no retransmit.
5. To stop driving and reclaim the command plane, the UI disconnects and
   reconnects the relay (the data plane has no in-band escape after
   `!GO`; over TCP a break cannot be sent at all).

**Postconditions:** The robot responds to commands relayed over radio,
and the UI shows which of the three outcomes (authoritative, derived, or
unreachable/local-derived) was used to resolve the address.

**Error flows:**
- If the registry lookup fails and the derived-address fallback is also
  wrong (robot on a different channel/group), commands appear to have no
  effect; the UI should make the fallback-in-use state visible so this is
  diagnosable rather than silent.
- A `source: derived` reply from the registry is not proof the registry
  knew the robot's address — it can be the registry's own just-derived
  guess, returned with HTTP 200. Treat it as a fallback, not a hit, when
  deciding how much to trust it over the locally-derived default.
- Because the registry GET is mutating, the host must not prefetch or
  batch-resolve names (e.g. to populate a robot-picker dropdown) — doing
  so would enrol every prefetched name into the shared registry's
  `_learned` state, an unwanted side effect on shared classroom
  infrastructure.
- If a message would exceed the frame size limit, the host refuses to
  send it as a single unsplittable frame rather than silently
  fragmenting (fragmentation is not supported by the radio).

---

## UC-005 — Watch telemetry

**Actor:** Student

**Preconditions:** A robot is connected (USB, relay, or WiFi) and
running firmware that emits telemetry.

**Main flow:**
1. Student opens the **Telemetry** tab and subscribes (e.g., via `TLM`).
2. The robot streams telemetry at 20 Hz; the header (`thdr`) auto-refreshes
   every 20 frames.
3. The host's telemetry decoder (`v6/telemetry.ts`) zips each `thdr`
   against each `t` frame positionally — schemaless, so the same decoder
   handles 12-column POSE, 20-column FULL, and radio-robot-lib's 7/11
   variants without branching.
4. The UI applies unit conversions correctly: `ox`/`oy` are already mm;
   `oh` is centidegrees and is **not** divided; `rotation`/`omega` are
   milliradians.
5. The UI renders wheel-speed bars and time-series charts from the
   decoded frames, updating live.

**Postconditions:** The student sees live, correctly-scaled telemetry.

**Error flows:** See UC-009 (recovering a missed telemetry header).

---

## UC-006 — Run a distance calibration

**Actor:** Student

**Preconditions:** A robot running calibration-capable firmware is
connected. (Per specification §9 open question 1, calibration firmware
does not yet exist — this use case describes the intended flow once it
does; the console feature-detects its absence and does not offer this
wizard without it.)

**Main flow:**
1. Student opens the **Calibrate** tab and selects the distance
   calibration wizard.
2. The wizard drives the robot forward via a `RUN:` program; the robot
   inches forward until it detects a first black line and sets a
   distance counter to zero.
3. The robot continues to a second line 90 cm away.
4. The wizard reports how far the robot's internal counter thought it
   had driven, compared to the known 90 cm.
5. On completion, the wizard emits a MakeCode snippet reflecting the
   calibrated distance parameter.
6. Student copies the snippet into their own MakeCode program.

**Postconditions:** The student has a calibrated distance constant ready
to paste into their program.

**Error flows:**
- If the robot never detects the first line, the wizard times out and
  reports failure rather than reporting a bogus calibration.
- Because the v6 `RUN` verb is currently a stub (specification §9 open
  question 3), the wizard depends on the cleartext `RUN:name:arg` path
  with no sequence id; if that path is unavailable, the wizard cannot
  run and reports so clearly.

---

## UC-007 — Run a rotation calibration

**Actor:** Student

**Preconditions:** Same as UC-006 — calibration-capable firmware
connected; the robot has a front-mounted beam pointer.

**Main flow:**
1. Student opens the **Calibrate** tab and selects the rotation
   calibration wizard.
2. The wizard drives the robot via a `RUN:` program to attempt a full
   360° turn.
3. Student uses on-screen nudge buttons to walk the robot's turn in until
   the beam pointer returns to its starting orientation, dialling in the
   wheelbase parameter.
4. On completion, the wizard emits a MakeCode snippet reflecting the
   calibrated wheelbase.
5. Student copies the snippet into their own MakeCode program.

**Postconditions:** The student has a calibrated wheelbase constant ready
to paste into their program.

**Error flows:**
- Same `RUN:` stub dependency as UC-006.
- If nudge commands are sent faster than the pacing budget, the console
  throttles them rather than overrunning the link.

---

## UC-008 — Discover a remote relay over mDNS

**Actor:** Student

**Preconditions:** A relay is running remotely and advertising over mDNS
(not plugged into the student's own machine).

**Main flow:**
1. The host's `mdns.ts` browses `_mbrelay._tcp` (and `_mbserial._tcp`,
   `_mbflash._tcp` for remote boards).
2. A remote relay's service record is discovered, including host and
   port for its TCP endpoint (:8760).
3. The host connects via `MbrelayLink`, setting `TCP_NODELAY`, and the
   same line grammar as a local relay applies unchanged.
4. The relay appears in the **Devices** tab alongside any locally-attached
   devices.

**Postconditions:** The student can select and use the remote relay
exactly as they would a local one (UC-004), since the session layer
treats every transport as the same newline-delimited line stream.

**Error flows:**
- If the mDNS browse finds no services, the Devices tab shows no remote
  relays rather than erroring.
- If the TCP connection drops, the UI reflects the relay as disconnected;
  reconnecting requires a fresh connect (no in-band recovery over TCP, per
  specification §6).

---

## UC-009 — Recover a missed telemetry header

**Actor:** robot-console host (automatic, on behalf of the student)

**Preconditions:** A telemetry subscription (UC-005) is active, and a
`thdr` frame was missed (e.g., the student joined mid-stream or a frame
was dropped).

**Main flow:**
1. The decoder detects that it has `t` frames without a matching `thdr`
   it can zip against.
2. The host issues `TLM HDR` (not `TLM NOW`) to request the header
   explicitly.
3. The robot replies with the current header; frames are auto-refreshed
   every 20 frames regardless, so recovery also happens passively within
   at most one refresh interval.
4. The decoder resumes zipping `thdr` against `t` correctly.

**Postconditions:** Telemetry display resumes correct decoding without
the student needing to manually resubscribe.

**Error flows:**
- If `TLM HDR` also goes unanswered, the Telemetry tab shows a stale/no-data
  indicator rather than rendering frames against a guessed header.

---

## UC-010 — Switch a robot from radio to WiFi

**Actor:** robot-console host (automatic) / Student (observes)

**Preconditions:** A robot is already provisioned with WiFi credentials
by some means outside the console (per specification §9 open question 2,
the console itself has no runtime provisioning path) and is currently
connected over radio (UC-004).

**Main flow:**
1. The host's `mdns.ts` browses for **both** `_robotlink._tcp` and
   `_robotlink._udp` — the robot advertises under both service types
   simultaneously.
2. A matching service appears on either type: instance `<name> robot
   link`, host `<name>.local`, port 7654, TXT record `name=<name>
   role=robot link=v6 port=7654`. (Verified against live advertisements
   from robots `vevov` and `gopiv`; an earlier draft of this use case said
   `_robotlink._udp` only with `link=v6-udp` in the TXT record, which is
   wrong and would match nothing.)
3. The host matches the advertised name against the currently-connected
   radio robot.
4. The host opens a `WifiUdpLink` (UDP to the robot on :7654, bound
   locally to :7655) and switches the active session to it. The robot
   serves the same line grammar over TCP on the same port, so a TCP link
   is a legitimate alternative here — this use case describes the UDP
   path as the one currently implemented (§4.3).
5. The Devices/Console tabs reflect the robot as connected over WiFi
   rather than radio.

**Postconditions:** The robot is controlled over WiFi; radio link is no
longer in use for that robot.

**Error flows:**
- If neither `_robotlink._tcp` nor `_robotlink._udp` appears, the robot
  continues on radio indefinitely — WiFi is opportunistic, not required.
- Because the console has no runtime WiFi provisioning path, an
  unprovisioned robot never advertises `_robotlink._tcp`/`._udp` and this
  use case does not apply to it; the console cannot provision it itself.
