---
id: '006'
title: Radio address overrides in the host DB, host and UI
status: open
use-cases:
- SUC-007
depends-on:
- '005'
github-issue: ''
issue: rearch-08-radio-address-overrides-in-host-db.md
completes_issue: true
---
<!-- CLASI: Before changing code or making plans, review the SE process in CLAUDE.md -->

# Radio address overrides in the host DB, host and UI

## Description

Move radio channel/group overrides from browser `localStorage`
(`RadioAddressDialog.tsx:70`, `ConfigurationPage.tsx:99-122`,
`RelayPage.tsx:129-170`) into the host DB, per `architecture.md` §2's
decision. `devices.radio_channel`/`radio_group`/`radio_source` already
exist in the schema (sprint 014's rearch-01) — this ticket is the first
writer/reader of them.

- Host: `set-radio-override {deviceId, channel, group}` and
  `{deviceId, clear: true}` command handlers (dispatched by ticket 005's
  server command map). Validate `0–83`/`0–255`, integers, host-side, in
  one place. `radio_source = 'override'` when set by a user; the
  resolver order for every consumer is `override → registry
  (mbrelayRegistry.ts, non-mutating, cached) → nameToRadioAddress`
  (`@robot-console/protocol`). Ticket 004's `buildSnapshot` already
  reads `devices.radio_*` into `devices[].radio` — this ticket makes
  those columns real instead of always-NULL.
- UI: `RadioAddressDialog` sends `set-radio-override` instead of writing
  `localStorage`; `ConfigurationPage`'s Radio panel reads
  `device.radio` from the snapshot and shows the source
  (`AddressSourceChip`, unchanged component). Per rearch-08's default,
  remove `RelayPage`'s per-connect channel/group inputs and rely on the
  device-level override (flagged as Open Question 2 in `sprint.md`'s
  Architecture — confirm with the stakeholder before removing; if they
  want the one-time override kept, scope it as a follow-up rather than
  blocking this ticket). Remove `readStoredAddress`/`writeStoredAddress`
  and the `radio` field from any `session-open` call site still sending
  it.
- Migration nicety: on first load after upgrade, if the UI finds
  `localStorage` radio-override keys, offer to push them to the host via
  `set-radio-override` for the matching device, then clear them.

## Acceptance Criteria

- [ ] `set-radio-override` persists across a host restart (verified by
      reopening the store) and appears in the next `snapshot`'s
      `devices[].radio`.
- [ ] Clearing (`{deviceId, clear: true}`) returns `source` to `derived`
      and the snapshot shows the derived (`nameToRadioAddress`) pair.
- [ ] A device with an override resolves to it ahead of the registry or
      derived default (unit test against the resolver function directly,
      not requiring a live mbrelay).
- [ ] Invalid input (`channel` outside 0–83, `group` outside 0–255,
      non-integer) is rejected host-side with a `notice`, not written.
- [ ] `grep -rn "localStorage" packages/ui/src` shows no key holding a
      channel or group value.
- [ ] The migration-nicety prompt appears only when a `localStorage`
      override exists for a device also present in the snapshot, and
      clears the key after a successful push.

## Implementation Plan

**Approach**: Host-side resolver and command handler first (testable
without any UI), then the UI changes that consume it.

**Files to create**:
- `packages/host/src/radioOverride.ts` (validation + resolver:
  `override → registry → derived`)
- `packages/host/src/radioOverride.test.ts`

**Files to modify**:
- `packages/host/src/server.ts`: add `set-radio-override` to the command
  map (ticket 005's `Map<type, handler>`).
- `packages/host/src/wsMessages.ts`: add the `set-radio-override`
  client-message type (may already be stubbed by ticket 004 if
  convenient to land there instead — confirm during implementation).
- `packages/ui/src/components/RadioAddressDialog.tsx`: send
  `set-radio-override`; remove `localStorage` read/write.
- `packages/ui/src/components/ConfigurationPage.tsx`: read
  `device.radio` from the snapshot.
- `packages/ui/src/pages/RelayPage.tsx`: remove per-connect
  channel/group inputs (pending stakeholder confirmation per the Open
  Question) and `localStorage` prefill.
- `packages/ui/src/ws/WsProvider.tsx`: one-time migration-nicety check
  on startup.

**Testing plan**:
- Unit: resolver order (override/registry/derived), validation
  rejection cases.
- UI: FakeSocket test — `set-radio-override` sent on dialog submit; no
  `session-open` carries a `radio` field.
- Run: `npx vitest run packages/host/src/radioOverride.test.ts packages/ui/src/components/RadioAddressDialog.test.tsx packages/ui/src/components/ConfigurationPage.test.tsx`.

**Documentation updates**: none beyond `architecture.md` (already
documents this shape).
