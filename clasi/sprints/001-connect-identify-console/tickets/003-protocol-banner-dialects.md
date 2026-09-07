---
id: '003'
title: 'protocol: banner.ts (colon + space dialects)'
status: done
use-cases:
- SUC-001
depends-on:
- '001'
github-issue: ''
issue: robot-console-architecture-and-roadmap.md
completes_issue: false
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# protocol: banner.ts (colon + space dialects)

## Description

Build `packages/protocol/src/banner.ts`, which parses a device's boot
banner line into role and identity fields. Per `sprint.md`'s Architecture
and the source issue, **both dialects are live on the fleet
simultaneously** — this module must parse both, not pick one:

- **Colon form** (relays): `DEVICE:RADIOBRIDGE:relay:getez:1779042496`.
  Serial number radix depends on which of the two colon-form device
  types precedes it: **hexadecimal** for legacy `RADIORELAY`,
  **decimal** for `RADIOBRIDGE`. Get this per-type radix right — do not
  assume one radix for the whole colon dialect.
- **Space form** (what robots emit today, lowercase):
  `device NEZHA2 robot vevov 1198504156`.

`microbit-console`'s existing parser handles only the colon form and
would fail to identify a robot — this is called out explicitly in the
issue as the wrong approach to copy. Do not reference or port that
parser's structure.

The output should be a single typed result regardless of which dialect
matched (e.g. `{ deviceType, role, name, serial }`), so `UsbSerialLink`
(ticket 008) and `server.ts` (ticket 009) don't need to know which
dialect a given device speaks.

## Acceptance Criteria

- [x] `banner.ts` correctly parses the colon-form example
      `DEVICE:RADIOBRIDGE:relay:getez:1779042496`, with the serial
      number read as **decimal** (`RADIOBRIDGE`).
- [x] `banner.ts` correctly parses a legacy colon-form `RADIORELAY`
      example with the serial number read as **hexadecimal**.
- [x] `banner.ts` correctly parses the space-form example
      `device NEZHA2 robot vevov 1198504156`.
- [x] Both dialects produce the same shaped output type (role, name,
      serial, and whatever device-type/kind field distinguishes them),
      so downstream code branches on the parsed result, not on which
      regex/grammar matched.
- [x] A line matching neither grammar returns a clear "not a banner"
      result (or throws a typed error) rather than a partial/garbage
      parse.
- [x] All tests run under `npm test` with no hardware attached.

## Testing

- **Existing tests to run**: `npm test` (protocol suite from tickets
  001-002 continues passing).
- **New tests to write**: one test per dialect example above (at
  minimum the three named examples: `RADIOBRIDGE` colon-decimal,
  legacy `RADIORELAY` colon-hex, and the space form), plus a
  not-a-banner negative case.
- **Verification command**: `npm test -- packages/protocol`.

## Implementation Plan

**Approach**:
1. Define the shared output type for a parsed banner (role, name,
   serial, device-type/kind).
2. Implement the colon-form grammar first, handling the
   `RADIORELAY`-is-hex vs. `RADIOBRIDGE`-is-decimal serial radix switch
   explicitly (e.g. a lookup keyed on the parsed device-type token, not
   an inferred heuristic).
3. Implement the space-form grammar (`device <TYPE> <role> <name>
   <serial>`, lowercase).
4. Combine both into a single `parseBanner(line: string)` entry point
   that tries both grammars and returns the shared output type, or a
   clear negative result if neither matches.
5. Write tests against the three example lines from the issue/
   specification plus a negative case.

**Files to create**:
- `packages/protocol/src/banner.ts`
- `packages/protocol/src/banner.test.ts`

**Files to modify**: none.

**Testing plan**: `npm test` from the repo root, covering both dialects
and the negative case.

**Documentation updates**: none beyond inline comments on the two
grammars and the radix-per-device-type rule (easy to get backwards
later without a comment marking it explicitly).
