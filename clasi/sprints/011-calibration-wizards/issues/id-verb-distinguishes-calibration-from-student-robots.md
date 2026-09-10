---
status: in-progress
sprint: '011'
tickets:
- 011-001
- 011-002
---

# The `ID` verb distinguishes calibration from student robots — the fourth device type is unblocked

## Description

The roadmap recorded student-robot vs calibration-robot as **blocked upstream**,
because every robot build hardcodes the same banner role (`wire_handler.cpp`
emits `device NEZHA2 robot %s %s`). The stakeholder chose to wait for a firmware
change that would make the role settable, and the device-type union was
deliberately designed so a fourth member would be purely additive.

**That firmware change is not needed.** The `ID` verb already carries the
distinction, and has all along.

Observed on two different robots:

```
# stakeholder's robot, running the calibration build (over mbdeploy):
id
ID
id diffdrive calibration-0.20260907.2 1.20260907.5 gopiv
HELLO
device NEZHA2 robot gopiv 2175407711

# this bench's robot zavaz, flashed with tovez-1.20260905.1-release-fieldverified.hex:
ID
<< id diffdrive tovez 1.20260905.1 zavaz
VER
<< ver 1.20260905.1
```

The grammar is:

```
id <product> <program> <version> <name>
```

- `product` — `diffdrive` on both
- **`program` — the discriminator.** `calibration-0.20260907.2` on the
  calibration build; `tovez` on the student build.
- `version` — firmware version, also available from `VER`
- `name` — the five-letter name, matching the SWD name

Note the two robots' banners are **identical in shape** (`device NEZHA2 robot
<name> <serial>`) — confirming the banner genuinely cannot distinguish them and
that `ID` is the only available signal.

`id` is already in `REPLY_VERBS` in `packages/protocol/src/v6/codec.ts`, so the
reply decodes today with no codec change.

## Cause

Not a defect. The project modelled device type from the boot banner alone
(`classifyBanner` in `packages/protocol/src/deviceType.ts`), which is the right
source for relay-vs-robot but carries nothing about *which program* a robot is
running. Nobody had looked at `ID`'s reply, because until sprint 004 no robot
had ever been observed answering anything.

## Proposed fix

Extend classification with a second, optional signal:

1. After a successful identify where `type === "robot"`, send `ID` and parse the
   reply's `program` field. `ID` is unsequenced and safe — unlike `HELLO`, it does
   not reset the sequence.
2. Classify `program` matching `calibration-*` as the calibration robot type;
   anything else stays the plain robot type. Preserve the raw `program` and
   `version` strings verbatim for display and diagnostics, exactly as `role` is
   preserved today.
3. Add the fourth member to `DeviceType`. The union was built for this: the wire
   contract already says an unrecognized `type` **must** be treated as
   `"unknown"`, and the UI page dispatch already has a `default` arm, so an older
   client against a newer host degrades rather than breaks.
4. A robot that does not answer `ID` (older firmware, or a build without the
   verb) must remain the plain robot type — absence of the reply is not evidence
   of a student build, and must not be treated as such.

**Design caution:** match on the `calibration-` prefix, not on an exact version
string, and keep the match in one place. The vocabulary of program names is not
controlled by this project, so treat an unrecognized program as "some robot
program", never as an error.

## Verification

- A robot running the calibration build classifies as the calibration type, and
  its device page reflects that.
- A robot running a student build (`zavaz` with `tovez`, on this bench) classifies
  as a plain robot.
- A robot that does not answer `ID` still classifies as a plain robot, not as
  unknown and not as calibration.
- The raw `program` and `version` strings are visible somewhere in the UI for
  diagnostics.

## Related

- `robot-console-architecture-and-roadmap.md` — records the fourth type as
  deferred pending a firmware change; this supersedes that reasoning
- `docs/design/specification.md` §7 "Blocked on firmware" item 2 and §9 Q3(b) —
  both describe the settable-role request. That firmware change would still be
  *nice* (a self-describing banner beats a second round trip), but it is no
  longer a blocker for the console.
- Sprint 006's `RobotPage` is where a calibration-specific page would diverge;
  sprint 010's calibration wizards are the eventual consumer.
