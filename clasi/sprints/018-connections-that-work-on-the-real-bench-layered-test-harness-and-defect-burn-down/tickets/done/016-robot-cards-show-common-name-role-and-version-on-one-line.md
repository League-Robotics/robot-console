---
id: '016'
title: Robot cards show common name, role and version on one line
status: done
use-cases: []
depends-on: []
github-issue: ''
issue: ''
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Robot cards show common name, role and version on one line

## Description

Stakeholder (2026-09-13, verbatim intent): "For robots, when you show
the announcement, show the common name, the role, and the version
number all on the same line. It doesn't just say NEZHA2; it says
common name, role, then version number."

Today the front-page card's role line (`packages/ui/src/deviceDisplay.ts`
`roleDisplay`, rendered in `FrontPage.tsx` and `RelayPage.tsx`) shows
only `device.role` (e.g. `NEZHA2`). The banner `device NEZHA2 robot
gopiv 2175407711` / `DEVICE:<role>:<common_name>:<name>:<serial>`
carries `commonName` (`packages/protocol/src/banner.ts` `parseBanner`
returns it), but the host never stores it: `devices` has no
`common_name` column and `SnapshotDevice`
(`packages/host/src/wsMessages.ts`) has no `commonName`. The version
comes from the `ID` reply (`id diffdrive calibration-0.20260913.1
1.20260912.8 gopiv`) and is already `device.version`.

## Acceptance Criteria

- [x] Store migration adds nullable `devices.common_name`; the
      connector (and any other banner-identify path, e.g. the relay
      bridger) writes it from the parsed banner alongside `role`,
      never overwriting a known value with null.
- [x] `SnapshotDevice.commonName: string | null` in the wire contract
      and projection; golden snapshot fixture updated intentionally.
- [x] For `kind === "robot"`, the card's identity line reads
      `<commonName> · <role> · <version>` on one line, omitting any
      part that is unknown (e.g. `robot · NEZHA2` when no version yet;
      `Role unknown` only when all three are missing). Relays keep
      today's text (role, or `mbrelay host`/`mbserial host`).
- [x] Unit tests: migration, connector write, projection field,
      `roleDisplay` formatting for full/partial/empty robot data and
      unchanged relay text.
- [x] Evidence: `npx vitest run packages/host packages/ui
      packages/protocol`, `npm run typecheck`, `npm run build`,
      `npm run vite:build -w @robot-console/ui` green; headless-Chrome
      screenshot of the front page from a host on a scratch copy of
      the state DB.

## Implementation Plan

**Approach**: thread `commonName` end to end in the order data flows —
schema/migration first, then the write path (connector + relay
bridger identify path), then the wire contract and projection, then
the display formatter — so each layer can be unit-tested against a
known-good value before the next layer consumes it, rather than
changing display code against data that isn't actually stored yet.

**Files to create**:
- a new migration file alongside the existing `devices` migrations
  (match this codebase's existing migration-file convention/location)

**Files to modify**:
- `packages/host/src/store` — `devices` table schema/migration,
  read/write helpers for the new `common_name` column
- the connector's banner-identify path (writes `role`/`commonName` from
  `parseBanner`)
- the relay bridger's own banner-identify path, if it separately
  upserts device identity (per the description's "any other
  banner-identify path")
- `packages/host/src/wsMessages.ts` — `SnapshotDevice.commonName`
- `packages/host/src/projection.ts` (or wherever `SnapshotDevice` is
  projected from store rows)
- `packages/ui/src/deviceDisplay.ts` — `roleDisplay`, to compose
  `<commonName> · <role> · <version>` for `kind === "robot"`, omitting
  unknown parts, unchanged for relays
- golden snapshot fixture(s) under `packages/host` that pin
  `SnapshotDevice` shape

**Testing plan**: unit tests for the migration (column exists,
nullable, default null); a connector/bridger test confirming
`commonName` is written from a parsed banner and never overwritten by a
null on a repeat identify; a projection test confirming `commonName`
flows through to `SnapshotDevice`; `roleDisplay` tests for full data,
missing version, missing commonName, all-unknown (robot), and
unchanged relay text. Scoped run: `npx vitest run packages/host
packages/ui packages/protocol`. Then `npm run typecheck`, `npm run
build`, `npm run vite:build -w @robot-console/ui`. Evidence screenshot:
start a host against a scratch copy of the state DB (never the
stakeholder's live `console.sqlite`), headless-Chrome screenshot of the
front page showing a robot card's one-line identity text.

**Documentation updates**: none beyond this ticket's completion notes.
