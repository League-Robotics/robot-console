---
status: pending
---

# One-click calibration: `calj` and `calc` replace `calx`/`cala`, and the console's parser is dead

## RENAMED, 2026-09-19: `calj` -> `calwheels`, `calc` -> `calturn`

**Everything below says `calj`/`calc`. Those names are dead.** The
firmware session renamed both verbs about an hour after sending the
original contract:

| was | now |
| --- | --- |
| `calj (cm:number=90.5)` | **`calwheels (cm:number=90.5)`** |
| `calc (edges:number=10)` | **`calturn (edges:number=10)`** |

The JSON event names moved with them —
`calwheels.result` / `.quality` / `.span` / `.fail`, and
`calturn.result` / `.quality` / `.ch` / `.restored` / `.fail`.
**Field names *inside* the objects are unchanged**, so every field
description below still holds; only the `ev` values and the `RUN` verbs
changed.

That is now **three** naming generations in one project
(`calx`/`cala` -> `calj`/`calc` -> `calwheels`/`calturn`), which is a
reason to key the parser off the `ev` object's structure and the
`.result`/`.fail` suffix rather than hardcoding a verb list in more
places than strictly necessary.

## What Eric asked for (2026-09-18)

> "We're going to work on getting the calibration program working with the
> robot console, so we've got one-click buttons for the two new
> calibration programs."

## The contract, from the firmware side

Received from the `nezha-robot-template` session, which owns the
calibration image. **Only two calibrations survive; every other `cal*`
verb is deleted.**

| verb | what | field | signature |
| --- | --- | --- | --- |
| `calj` | distance / wheel travel (mm per shaft degree → wheel diameter) | eye-shaped: two parallel lines joined by a centre stripe; robot starts on clean white behind the start line | `calj (cm:number=90.5)` — tape-measured line-to-line distance |
| `calc` | rotation / effective track width `b` | alternating iron cross, eight 45° radial wedges; robot starts centred | `calc (edges:number=10)` |

`calx`, `cala`, `call` and `calt` are **gone** (`calt` was the previous
turn calibration, superseded by `calc`).

**Output is JSON lines**, one object per line, not the old prefixed
prose:

```
{"ev":"calc.result","b":11.071,"tw":11.42,"slip_at_tw":1.0315,"slope":0.9229,"gaps":32,"anchor_b":11.996}
{"ev":"calc.quality","sd":3.706,"spread":0.051,"ch":4,"gap":41.53,"sector":45,"spin":70,"wheel":7.33}
{"ev":"calc.ch","i":0,"n":10,"gap":41.553,"sd":2.755,"slope":0.9234}
{"ev":"calj.result","calib":0.7856,"diameter":90.03,"measured":90.5,"true":90.2,"error":0.3,"was":0.7878}
{"ev":"calj.quality","rms":0.52,"mean":0.4,"max":1.1,"xpm":3.3,"blind":37,"ticks":734,"acq":0,"bias":0.02,"heading":0.5}
{"ev":"calj.span","start":...,"finish":...}
{"ev":"calj.fail","why":"...","measured":10.5,"true":90.2}
{"ev":"calc.fail","gaps":2,"why":"too few usable gaps; centre the robot on the cross"}
```

**A run ends in exactly one of `<cal>.result` or `<cal>.fail`.** That is
the entire success/failure contract — no prose parsing.

## What this breaks in the console (verified in source)

- `packages/ui/src/components/CalibrationReport.ts` declares
  `export type CalibrationPrefix = "CALX" | "CALA"` and parses prefixed
  prose. Against JSON lines **it matches nothing**. The parse layer is a
  rewrite, not a tweak.
- `DistanceCalibrationWizard.tsx:225` runs `["calx"]`;
  `RotationCalibrationWizard.tsx:305` runs `["cala"]`. Both verbs no
  longer exist.
- `CalibrationPage.tsx` labels and gates on those names.

**What survives**: `packages/ui/src/lib/calibration.ts:109` already
computes `rotationalSlip = measuredTrackWidthCm / effectiveTrackWidthCm`
— the exact division the firmware cannot do for itself. The math is
already here; it needs a trustworthy per-robot input.

## The trap that would silently mis-calibrate every robot

**`slip_at_tw` is NOT the robot's rotational slip.** `calc` overwrites
the robot's geometry with an *anchor* track width before running, and
`slip_at_tw` is `tw/b` against that anchor. The correct value is

    rotational_slip = <that robot's own caliper track width> / b

with `b` from `calc.result`. Fleet caliper widths: 111.4, 111.6, 113.6,
114.4 mm, against an anchor of 114.2. They live in `radio-robot-lib`
`config/robots/<name>.json` under `geometry.trackwidth`.

## What can actually be written back (measured on hardware)

| field | SET over the wire? |
| --- | --- |
| `rotational_slip` | **works** — so `calc`'s result can be one-click |
| `travel_calib` | `err 1` — no such config field |
| `trackwidth` | `err 1` — no such config field |

So **`calj`'s result cannot be applied live at all** — it needs a
rebuild and reflash. The UI must not imply symmetry between the two
buttons: `calc` gets Apply, `calj` gets its number plus the reflash
path and **no Apply control at all** (not a disabled one, not one that
errors).

## The open question that gates the design

**`calc` leaves the anchor geometry in the robot and does not restore
it.** After a `calc` run the robot is mis-calibrated until reset or
reflash, and `SET rotational_slip` alone does **not** fix it because
`trackwidth` is not settable.

A one-click button that silently leaves the robot wrong is worse than no
button. Asked the firmware session whether `calc` can restore geometry
on both the `.result` and `.fail` paths. **If yes**, `calc` is genuinely
one-click. **If no**, the honest UI is "calibrated — this robot now needs
a reflash before use", which is a materially worse feature and Eric
should be told that is what he is getting.

## Track width provenance — undecided

Three options, and option 2 carries a known hazard:

1. Human types the caliper number (roughly today's wizard). Reliable;
   kills one-click.
2. Console reads `radio-robot-lib config/robots/<name>.json`. One-click,
   but it is **a stored record asserting a physical fact that nothing
   re-checks** — the same shape that drove a robot into the north rail on
   this bench the same day (`field_calibration.json` recorded a tag mount
   at 0° when it was physically −90°). If we take this route the UI must
   *show* the number used and its source, so a wrong record is visible
   rather than silent. See [[bench-exclusivity-census-is-unsound]]'s
   Related section for that incident.
3. Firmware emits it — believed impossible; nothing in its API reads
   geometry back.

## Two wire behaviours to design around

1. **A motion command sent while the robot is `active` is silently not
   executed** — no error, no reply. Poll `done` in STATUS and only send
   the next command once it increments. The firmware session lost 2 of 8
   legs to fixed sleeps, and warns that **a never-run tour reports a
   perfect closure** because the robot never moved. Our side must not be
   able to report success for a run that never happened.
2. **Lines emitted during a RUN are best-effort and get dropped.**
   `Protocol::writeWifi` skips backpressure while a motion obligation is
   live, so the 8-slot ring drops the newest line; reports are packed
   several JSON objects per frame. Never assume an expected line arrived
   — key only off `.result`/`.fail`.

## Asked for, not yet received

- The geometry-restore answer (gates the design).
- **A real capture** of one actual `calj` run and one actual `calc` run
  as they came off the wire, including a failure. Write the parser
  against that, not against this spec — this project has been burned
  repeatedly by specs diverging from hardware.
- Confirmation `calj`/`calc` appear in `FUNCS` (the wizards gate their Go
  button on presence, and distinguish "no answer yet" from "answered,
  function absent" — worth keeping).
- Confirmation of the editable arg defaults `cm=90.5`, `edges=10`.
