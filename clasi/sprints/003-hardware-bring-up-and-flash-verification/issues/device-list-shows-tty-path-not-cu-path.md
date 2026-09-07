---
status: in-progress
sprint: '003'
tickets:
- 003-001
---

# Device list shows the tty.* path, which a user must not open

## Description

The Devices tab and `linkError` messages show `/dev/tty.usbmodem2121102`.
On macOS a user who copies that path into a serial terminal will hang:
opening a `tty.*` device blocks waiting for DCD. The `cu.*` (callout)
form is the one that opens immediately.

## Cause

`devices.ts` surfaces `serialport`'s reported path verbatim.
`UsbSerialLink` translates `tty.` to `cu.` internally (`toCalloutPath`),
so the app works correctly — but the translated path never reaches the
UI, so what is displayed is not what is used.

## Proposed fix

Surface the callout path as the device's display path, on the host side
so every consumer agrees. Keep the raw path if it is useful for
diagnostics, but do not lead with it.

## Verification

The attached board shows `/dev/cu.usbmodem2121102` in the Devices tab
and in any link error text.
