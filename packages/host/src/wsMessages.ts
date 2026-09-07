/**
 * wsMessages.ts — the one WebSocket message contract between `server.ts`
 * and the browser UI (`packages/ui`, tickets 010/011, and every later
 * sprint that extends this same channel).
 *
 * Per `docs/design/specification.md` §4.7: one WebSocket carries
 * device-list updates and line traffic (telemetry frames join this same
 * channel in sprint 4, not this one). Per this ticket: the shape is
 * `type`-discriminated so both the Devices tab and the Console tab can
 * share one connection and dispatch on `type`, and it lives in exactly
 * one place so both sides of the socket agree on it.
 *
 * This module is pure type/shape definitions plus small, dependency-free
 * type guards for the client -> server direction (server.ts needs to
 * validate untrusted JSON arriving over the socket). It holds no naming,
 * framing, or sequencing logic of its own -- see `server.ts`'s own doc
 * comment for why that boundary matters.
 *
 * Direction:
 *   - client -> server: {@link OpenDeviceMessage}, {@link CloseDeviceMessage},
 *     {@link LineMessage} (always `direction: "tx"` in this direction).
 *   - server -> client: {@link DevicesMessage}, {@link LineMessage}
 *     (always `direction: "rx"` in this direction -- an inbound line
 *     from the device), {@link ErrorMessage}.
 *   `LineMessage` is one shared shape used in both directions,
 *   discriminated further by its own `direction` field, per the
 *   ticket's own example (`{ type: 'line', deviceId, direction, line }`).
 */

/** One device as shown in the Devices tab. Keyed by {@link id} (the USB
 * serial number -- `devices.ts`'s join key -- not the OS port path,
 * which renumbers across replugs). */
export interface DeviceListEntry {
  /** Stable id for this device across snapshots: the USB serial number
   * of the DAPLink interface chip (same value as {@link serialNumber}). */
  id: string;
  /** Full USB serial number of the DAPLink interface chip -- the UID
   * the ticket calls for, shown *alongside* {@link name}, never instead
   * of it (they are different values from different chips). */
  serialNumber: string;
  /** Short display form of {@link serialNumber}, sliced from its
   * board-unique middle field (`devices.ts`'s `shortSerialDisplay`) --
   * safe to show next to two boards that share an interface-chip
   * build's prefix/suffix. */
  displaySerial: string;
  /** Five-letter friendly name from `swdName.ts`, or `null` while
   * unresolved or unresolvable. Never a USB-serial-derived fallback --
   * see `swdName.ts`'s own module doc for why. */
  name: string | null;
  /** Present only when SWD name resolution failed. `reason`/`message`
   * mirror `swdName.ts`'s `SwdNameFailure` so the UI can show *why*,
   * never silently omit the device or invent a fallback name. */
  nameError?: { reason: string; message: string };
  /** Banner role token (e.g. `"RADIOBRIDGE"`, `"NEZHA2"`), populated
   * once a `UsbSerialLink` to this device is open; `null` before that,
   * or if the open attempt failed or timed out (e.g. a silently-running
   * board that never replies to `HELLO` -- see the ticket). */
  role: string | null;
  /** OS serial port path, or `null` if this device was only found on
   * its HID persona (`devices.ts`'s `DeviceAvailability`). */
  port: string | null;
  /** Whether `server.ts` currently has an open `UsbSerialLink` to this
   * device. */
  linkOpen: boolean;
  /** Present only when the most recent link-open attempt failed (e.g.
   * a `HELLO` reply timeout against a silent board). Cleared on a
   * subsequent successful open. */
  linkError?: string;
}

/** Which way a line is travelling on the shared `"line"` message shape:
 * `"tx"` — client -> server -> device; `"rx"` — device -> server ->
 * client. */
export type LineDirection = "tx" | "rx";

/** A single protocol line, either sent to a device (`direction: "tx"`,
 * client -> server) or received from one (`direction: "rx"`, server ->
 * client). `line` is the raw wire text (no trailing newline). */
export interface LineMessage {
  type: "line";
  deviceId: string;
  direction: LineDirection;
  line: string;
}

/** Server -> client: the full current device list. Sent once on
 * connect and again on every live attach/detach/state change -- always
 * a full snapshot, never a delta, so a client that missed an update
 * self-heals on the next one. */
export interface DevicesMessage {
  type: "devices";
  devices: DeviceListEntry[];
}

/** Client -> server: open (or re-open, e.g. after a failed attempt) a
 * link to a device. */
export interface OpenDeviceMessage {
  type: "open";
  deviceId: string;
}

/** Client -> server: close an open link to a device. */
export interface CloseDeviceMessage {
  type: "close";
  deviceId: string;
}

/** Server -> client: something went wrong. `deviceId` is present when
 * the error is scoped to one device (a failed open, a send to a device
 * with no open link); absent for a connection-level problem (malformed
 * message). Never thrown as an uncaught exception on the server side --
 * see `server.ts` and `deviceRegistry.ts`'s own doc comments. */
export interface ErrorMessage {
  type: "error";
  deviceId?: string;
  message: string;
}

/** Every message shape a client may send. */
export type ClientMessage = OpenDeviceMessage | CloseDeviceMessage | LineMessage;

/** Every message shape the server may send. */
export type ServerMessage = DevicesMessage | LineMessage | ErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate and narrow an arbitrary parsed-JSON value into a
 * {@link ClientMessage}, or `undefined` if it does not match any known
 * shape. This is the one place untrusted client input is trusted from
 * -- `server.ts` calls this before acting on anything a WebSocket
 * client sends, rather than trusting `type` and reaching into fields
 * unchecked.
 */
export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  switch (value.type) {
    case "open":
      return isNonEmptyString(value.deviceId) ? { type: "open", deviceId: value.deviceId } : undefined;
    case "close":
      return isNonEmptyString(value.deviceId) ? { type: "close", deviceId: value.deviceId } : undefined;
    case "line":
      return isNonEmptyString(value.deviceId) &&
        value.direction === "tx" &&
        typeof value.line === "string"
        ? { type: "line", deviceId: value.deviceId, direction: "tx", line: value.line }
        : undefined;
    default:
      return undefined;
  }
}
