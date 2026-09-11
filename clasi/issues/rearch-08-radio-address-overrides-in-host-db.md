---
status: pending
---

# Radio address overrides live in the host DB, not the browser

## Description

An instructor who moves a robot off its derived channel/group records
that in `RadioAddressDialog` or the Configuration tab, which writes
browser `localStorage` (`RadioAddressDialog.tsx:70`,
`ConfigurationPage.tsx:99-122`, `RelayPage.tsx:129-170`). Every connect
then sends `radio: {channel, group}` on `session-open`, which the host
treats as `addressSource: "explicit"` and never consults the mbrelay
registry or its own derivation (`04-ui.md` §3 item 2). Consequences:

- The override is per browser profile, not per robot. A second laptop,
  a cleared cache, or a different browser loses it.
- The host's background work (WiFi auto-switch today; the relay sweep
  in rearch-10) cannot know the override and probes the wrong address.
- Validation is duplicated with different rules in two components
  (`RadioAddressDialog.tsx:62-69` vs `ConfigurationPage.tsx:107-114`) and
  absent on the relay page's inputs.

Stakeholder decision (architecture §2): overrides are stored in the host
DB per device.

## Proposed resolution

- Store: `devices.radio_channel`, `radio_group`, `radio_source` already
  in the schema (rearch-01). `radio_source = 'override'` when set by a
  user; `'registry'` when a bridge learned it from the mbrelay registry
  with an authoritative outcome; NULL means derived.
- Wire: `set-radio-override {deviceId, channel, group}` and
  `{deviceId, clear: true}`; the snapshot carries
  `devices[].radio = {channel, group, source}` (rearch-06 shape).
  Validation in one place, host-side (`0–83`, `0–255`, integers);
  protocol gains the non-throwing `validateRadioAddress` (rearch-15, or
  do it here).
- Resolution order for every consumer (bridge, sweep, display):
  `override` → `registry` (non-mutating, cached) → `nameToRadioAddress`.
  `openRobotViaRelay`'s successor (rearch-09) and the sweeper (rearch-10)
  read from the device row, never from the client message.
- UI: `RadioAddressDialog` either deleted or reduced to a form that sends
  `set-radio-override`; Configuration tab's Radio panel reads
  `device.radio` and shows the source chip; `RelayPage` channel/group
  inputs become a per-connect *one-time* override only if the stakeholder
  wants that kept — default is to remove them and rely on the device
  override. Remove `readStoredAddress`/`writeStoredAddress` and the
  `radio` field from `session-open`.
- Migration nicety: on first run after upgrade the UI may offer to push
  any `localStorage` overrides it finds to the host, then clears them.

## Acceptance

- `set-radio-override` persists across a host restart and appears in the
  snapshot for the device.
- A bridge for a device with an override uses it; the AddressSourceChip
  shows "override".
- Clearing returns `source` to `derived` and the derived pair is shown.
- No `localStorage` key containing a channel or group remains in the UI.

## Depends on

rearch-01, rearch-06. UI part rides with rearch-07.

## References

- `docs/design/architecture.md` §2, §4, §9
- `docs/reviews/2026-09-11/04-ui.md` §3 item 2, §4
- `docs/design/usecases.md` UC-019
