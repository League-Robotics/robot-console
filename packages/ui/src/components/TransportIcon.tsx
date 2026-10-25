/**
 * TransportIcon -- one small inline SVG per link transport, for the
 * front-page card's connection chips (stakeholder, 2026-09-13: "make a
 * little card that's got a radio icon / a server icon / a Wi-Fi icon / a
 * USB icon. Depending on what you got, put the icon"). `mbserial` and
 * `mbrelay` are both "a host on the network", hence one server icon.
 */
import type { Transport } from "@robot-console/host/src/wsMessages.js";
import { Icon } from "./Icon";

export function transportIconName(transport: Transport): "usb" | "wifi" | "radio" | "server" {
  switch (transport) {
    case "usb":
      return "usb";
    case "wifi":
      return "wifi";
    case "radio":
      return "radio";
    default:
      return "server";
  }
}

/** Short human word for a transport, used next to the icon. */
export function transportShortName(transport: Transport): string {
  switch (transport) {
    case "usb":
      return "USB";
    case "wifi":
      return "Wi-Fi";
    case "radio":
      return "Radio";
    case "mbserial":
      return "Bridge";
    case "mbrelay":
      return "Relay";
    case "mbregistry":
      return "mbregistry";
    default:
      return transport;
  }
}

export function TransportIcon({ transport, size = 18 }: { transport: Transport; size?: number }) {
  return <Icon name={transportIconName(transport)} size={size} />;
}
