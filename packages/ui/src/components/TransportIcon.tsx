/**
 * TransportIcon -- one small inline SVG per link transport, for the
 * front-page card's connection chips (stakeholder, 2026-09-13: "make a
 * little card that's got a radio icon / a server icon / a Wi-Fi icon / a
 * USB icon. Depending on what you got, put the icon"). `mbserial` and
 * `mbrelay` are both "a host on the network", hence one server icon.
 */
import type { Transport } from "@robot-console/host/src/wsMessages.js";

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
  const name = transportIconName(transport);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    "data-icon": name,
  };
  switch (name) {
    case "usb":
      return (
        <svg {...common}>
          <path d="M12 3v14" />
          <path d="M12 3l-2.5 3M12 3l2.5 3" />
          <path d="M12 12l4-2V7.5" />
          <path d="M12 14l-4-2v-1.5" />
          <circle cx="16" cy="6" r="1.2" />
          <rect x="6.8" y="8.6" width="2.4" height="2.4" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      );
    case "wifi":
      return (
        <svg {...common}>
          <path d="M2.5 8.5a15 15 0 0 1 19 0" />
          <path d="M5.5 12a10.5 10.5 0 0 1 13 0" />
          <path d="M8.5 15.5a6 6 0 0 1 7 0" />
          <circle cx="12" cy="19" r="1.2" fill="currentColor" />
        </svg>
      );
    case "radio":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2" />
          <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
          <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
          <path d="M19 5a10 10 0 0 1 0 14" />
          <path d="M5 19A10 10 0 0 1 5 5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <circle cx="7" cy="7.5" r="1" fill="currentColor" />
          <circle cx="7" cy="16.5" r="1" fill="currentColor" />
        </svg>
      );
  }
}
