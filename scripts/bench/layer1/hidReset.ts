/**
 * hidReset.ts — 018-003 Step 0 hardening, opt-in only
 * (`--hid-reset-silent-relays`): attempt a DAPLink vendor-command reset
 * against a relay that stays silent even after this harness's own UART
 * break-reset retry (`usbProbe.ts`'s own retry-on-timeout path) —
 * observed live against `vevav` (USB `/dev/cu.usbmodem2121402`), which
 * produced no banner at all even after one break during the 018-002
 * bench run.
 *
 * ## Why this reaches into `packages/host`, unlike every other probe here
 *
 * Every other Layer 1 module deliberately avoids importing host
 * internals — `lineReassembler.ts`'s own doc comment: talking to the
 * wire directly, not the host's code paths, is what keeps a host bug
 * from being invisibly masked by sharing its parser. A DAPLink vendor
 * HID reset is different in kind: it is not wire-protocol logic worth
 * (or safely) reimplementing a second time against the vendored `dapjs`
 * transport — it is a genuine hardware side effect (reset a live
 * board), and the ticket itself names the exact function to
 * (optionally) call: `packages/host/src/flash.ts`'s `resetViaDapLink`.
 * This module imports the **compiled** build
 * (`packages/host/dist/{devices,flash}.js`), mirroring Layer 2's own
 * "run the shipped artifact, not a source shortcut" precedent — `npm
 * run build` is a documented prerequisite, same as Layer 2's.
 *
 * ## HID reset vs. the serial `cu.` path this harness otherwise opens
 *
 * `resetViaDapLink` talks to the DAPLink interface chip's own
 * vendor-specific HID endpoint (`dapjs`'s `DAPLink` class) — a
 * different USB personality from the `cu.` serial port `usbProbe.ts`
 * opens for `HELLO`/`ID`. The two are correlated only by the KL27
 * interface chip's shared USB serial number
 * (`packages/host/src/devices.ts`'s `enumerateDaplinkDevices`/
 * `joinDaplinkDevices`), so this module must enumerate DAPLink devices
 * again (a fresh, independent enumeration — never sharing a handle with
 * `usbProbe.ts`'s already-open serial connection) and find the entry
 * whose serial-port callout path matches the one this harness is
 * investigating.
 *
 * **Never invoked unless the caller explicitly opts in.** Resetting a
 * physical board is a stronger action than anything else in this
 * harness ever does on its own (Layer 1 otherwise sends only
 * `HELLO`/`ID`/`?`, or one UART break) — this must never run
 * automatically, and never flashes anything (`resetViaDapLink` only
 * ever resets, it never writes firmware).
 */
import { enumerateDaplinkDevices, toCalloutPath, type DaplinkDevice } from "../../../packages/host/dist/devices.js";
import { resetViaDapLink } from "../../../packages/host/dist/flash.js";

export interface HidResetAttempt {
  attempted: boolean;
  ok?: boolean;
  detail: string;
}

/**
 * Find the joined `DaplinkDevice` whose serial-port callout path matches
 * `calloutPath` exactly (both sides already normalized to the `cu.`
 * callout form via {@link toCalloutPath}) — pure given an already-
 * enumerated device list, so the matching rule is directly testable
 * without any real HID/serial enumeration.
 */
export function findDeviceForCalloutPath(devices: readonly DaplinkDevice[], calloutPath: string): DaplinkDevice | undefined {
  return devices.find((d) => d.serialPort !== undefined && toCalloutPath(d.serialPort.path) === calloutPath);
}

/**
 * Best-effort: enumerate DAPLink devices fresh, find the one at
 * `calloutPath`, and attempt exactly one `resetViaDapLink` call against
 * its HID handle. Never throws — every failure mode (no matching
 * device, no HID path resolved, the reset call itself failing) resolves
 * to `{ attempted: ..., ok: false, detail: "..." }` instead, matching
 * this harness's own "failure is a value" convention throughout.
 */
export async function attemptSilentRelayHidReset(calloutPath: string): Promise<HidResetAttempt> {
  const devices = await enumerateDaplinkDevices();
  const device = findDeviceForCalloutPath(devices, calloutPath);
  if (device === undefined) {
    return { attempted: false, detail: `no DAPLink device found via HID/serial enumeration matching ${calloutPath}` };
  }
  if (device.hid?.path === undefined) {
    return {
      attempted: false,
      detail: `matched device (serial ${device.displaySerial}) but no HID path was resolved (availability: ${device.availability})`,
    };
  }
  const result = await resetViaDapLink(device);
  return result.ok
    ? { attempted: true, ok: true, detail: `DAPLink reset command completed for ${calloutPath} (serial ${device.displaySerial})` }
    : { attempted: true, ok: false, detail: `DAPLink reset failed for ${calloutPath} (serial ${device.displaySerial}): ${result.error}` };
}
