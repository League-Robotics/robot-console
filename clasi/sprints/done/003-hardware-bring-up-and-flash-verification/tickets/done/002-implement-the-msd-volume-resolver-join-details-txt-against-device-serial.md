---
id: '002'
title: 'Implement the MSD volume resolver: join DETAILS.TXT against device serial'
status: done
use-cases:
- SUC-002
depends-on: []
github-issue: ''
issue: msd-fallback-volume-matching-heuristic-unimplemented.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Implement the MSD volume resolver: join DETAILS.TXT against device serial

## Description

`packages/host/src/flash.ts`'s `defaultResolveVolumePath` is a documented
placeholder: it returns the first `/Volumes/MICROBIT*` directory it finds,
ignoring which device was asked for. This ticket replaces it with a real
join, following `radio_relay/scripts/flash-local.js`'s template
(`specification.md` §4.5): read each mounted `MICROBIT*` volume's
`DETAILS.TXT`, extract its unique id, and match it against the target
`DaplinkDevice.serialNumber` `devices.ts` already resolves.

**This ticket is desk-only.** The hard part — picking the *right* volume
when *several are mounted* — genuinely needs two physical boards to prove,
which is deferred to ticket 006 (`completes_issue: false` here reflects
that this ticket alone does not satisfy the issue's own stated
verification bar; ticket 006's two-board check is what closes the issue).
This ticket's job is to make the join logic real and hardware-free-provable
via fixtures — a criterion that must pass regardless of what's on the
bench.

## Acceptance Criteria

- [x] provable-without-hardware: the `DETAILS.TXT`-to-serial join logic is
      unit-tested against fixture `DETAILS.TXT` content covering: a unique
      match (one candidate volume's id matches the device serial), no match
      (no candidate volume's id matches), and multiple candidate volumes
      (only the one whose id actually matches is returned, not the first
      one found).
- [x] provable-without-hardware: when no `MICROBIT*` volumes are mounted at
      all, or the volume listing itself fails (mirrors today's `readdir`
      try/catch), resolution returns `undefined`, unchanged from today's
      behavior.
- [x] provable-without-hardware: every existing `flash.test.ts` test still
      passes unmodified — they all inject their own `resolveVolumePath`
      per the module's documented test convention, so this change must not
      alter `flash()`'s public contract or its `FlashOptions` shape in a
      way that breaks existing injection.
- [x] `npm run build` passes.
- [x] Not a checkbox, but note it in this ticket's notes on completion: the
      real-hardware, two-board proof that this correctly discriminates
      between multiple *physically mounted* volumes is explicitly out of
      scope here — see ticket 006.

## Notes on completion

- The join is a real, exact string match: `DETAILS.TXT`'s `Unique ID`
  field against `DaplinkDevice.serialNumber`, verified character-for-
  character identical against a real attached board (`Unique ID:
  99063602000528202e78ea8f7143163f000000006e052820`, matching that same
  board's `serialNumber` from `enumerateDaplinkDevices()`). Never a
  prefix/suffix heuristic.
- `defaultResolveVolumePath(device, options?)` in `packages/host/src/
  flash.ts` is now exported (was private) so it is directly unit-testable.
  It takes an optional second parameter `{ listVolumeNames?: () =>
  Promise<string[]>; readTextFile?: ReadTextFileFn }`, both defaulting to
  the real filesystem (`readdir("/Volumes")`, `fs.readFile(..., "utf-8")`).
  `FlashOptions.resolveVolumePath`'s public single-argument shape is
  unchanged — `defaultResolveVolumePath`'s extra optional parameter is
  assignable to it, so `flash()`'s existing default wiring
  (`options?.resolveVolumePath ?? defaultResolveVolumePath`) needed no
  change.
- New pure, filesystem-free exports: `parseDetailsTxt(text): Record<string,
  string>` (splits each non-comment, non-blank line on its *first* `:`,
  tolerant of keys containing spaces like `Unique ID`/`Daplink Mode`) and
  `findMatchingVolume(candidates: VolumeCandidate[], serialNumber):
  string | undefined` (exact match against the `Unique ID` field only).
  `ReadTextFileFn` is a new exported type mirroring the existing
  `WriteFileFn` injection pattern.
- Behavior with zero/one/several candidates: zero `MICROBIT*` volumes (or
  a failed listing) returns `undefined`, exactly mirroring the old
  placeholder's `readdir` try/catch. One candidate returns its path only
  if its `Unique ID` matches, else `undefined`. Several candidates: each
  is read and parsed independently, a volume with a missing/unreadable
  `DETAILS.TXT` is skipped (not a failure of the whole resolution), and
  the one whose `Unique ID` actually matches is returned regardless of
  discovery order.
- Tests: `npm test -- packages/host/src/flash.test.ts` — 41 passed
  (existing 31 plus 10 new, covering `parseDetailsTxt`,
  `findMatchingVolume`, and `defaultResolveVolumePath`'s zero/one/several/
  missing-file/non-MICROBIT-entry cases). `npm run build` — all three
  workspaces (`host`, `protocol`, `ui`) typecheck clean.
- For ticket 006: with two real boards attached, call
  `defaultResolveVolumePath(device)` with no options (real filesystem) —
  it will `readdir("/Volumes")`, read each mounted `MICROBIT*` volume's
  real `DETAILS.TXT`, and match on `Unique ID` against `device.
  serialNumber` from `enumerateDaplinkDevices()`. The only thing this
  ticket could not prove is whether *both* boards' `DETAILS.TXT` files
  are actually mounted and readable at the paths this code assumes
  (`/Volumes/MICROBIT*/DETAILS.TXT`) when two boards are attached
  simultaneously (e.g. macOS's exact naming for the second volume,
  such as `MICROBIT 1` — the discovery filter (`startsWith("MICROBIT")`)
  already tolerates that, but it has only been exercised against a
  fixture name, not real second-volume mount behavior).

## Implementation Plan

**Approach:**
1. Add an injectable file-read seam to `flash.ts`, mirroring the existing
   `WriteFileFn` pattern: `export type ReadTextFileFn = (filePath: string)
   => Promise<string>`, defaulting to `fs.readFile(path, "utf-8")` from
   `node:fs/promises` (already imported in this file's neighborhood).
2. Add a pure, exported helper parsing `DETAILS.TXT`'s `KEY: value` line
   format (per `flash-local.js`'s `readDetails()`), e.g.
   `parseDetailsTxt(text: string): Record<string, string>`, and a second
   pure helper `findMatchingVolume(candidates: Array<{ volumePath: string;
   details: Record<string, string> }>, serialNumber: string): string |
   undefined` that does the actual serial-number join. Keep these two
   functions directly unit-testable without touching the filesystem at
   all.
3. Rewrite `defaultResolveVolumePath(device)` to: list `/Volumes/MICROBIT*`
   entries (unchanged from today), read each one's `DETAILS.TXT` via the
   new injectable read fn (skip a volume whose `DETAILS.TXT` is missing or
   unreadable rather than failing the whole resolution), parse each with
   `parseDetailsTxt`, and hand the collected candidates to
   `findMatchingVolume`.
4. Determine the exact `DETAILS.TXT` field DAPLink uses for the "unique id"
   by inspecting `flash-local.js`'s own matching logic (read during
   planning at `/Volumes/Proj/proj/league-projects/microbit/radio_relay/scripts/flash-local.js`)
   — confirm the field name and matching convention (whole-string vs
   substring match against the USB serial) before writing fixtures.
5. Expose whatever new injection point tests need (either export
   `parseDetailsTxt`/`findMatchingVolume` directly for isolated unit tests,
   or add a `readTextFile` option to `FlashOptions` the same way
   `writeFile` exists today — prefer testing the pure helpers directly
   since they need no filesystem at all).

**Files to modify:**
- `packages/host/src/flash.ts`
- `packages/host/src/flash.test.ts`

**Testing plan:** `npm test -- packages/host/src/flash.test.ts` (scoped),
then `npm run build`.

**Documentation updates:** none — `flash.ts`'s module doc comment already
describes this as a "known, deferred gap"; update that comment to reflect
that the join logic is now real (desk-verified) but the multi-board
hardware proof remains deferred to ticket 006, so a future reader isn't
misled either direction.
