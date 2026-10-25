import type { SnapshotDevice, SnapshotLink, Transport } from "@robot-console/host/src/wsMessages.js";
import { cardLinks, isLinkAnswering, isLinkUsable } from "./deviceDisplay";

/** The one status-colour rule: white `idle` can connect, green `linked`
 * connected, yellow `warn` connected but degraded, red `error` failed,
 * dashed `absent` known but not reachable now. */
export type Status = "linked" | "idle" | "warn" | "error" | "absent";

const STATUS_WORD: Record<Status, string> = {
  linked: "connected",
  idle: "can connect",
  warn: "connected, not answering",
  error: "failed",
  absent: "not reachable now",
};

export function linkStatus(link: SnapshotLink, kind: SnapshotDevice["kind"] = "robot", now: number = Date.now()): Status {
  switch (link.state) {
    case "connected":
      if (kind === "relay") return "linked";
      return isLinkAnswering(link, now) ? "linked" : "warn";
    case "unresponsive":
      return "warn";
    case "failed":
      return "error";
    case "stale":
      return "absent";
    default:
      return "idle";
  }
}

export function statusWord(status: Status, link?: SnapshotLink): string {
  if (link?.state === "connecting") return "connecting";
  return STATUS_WORD[status];
}

/** "Radio: connected" -- every status mark carries one, colour never stands alone. */
export function statusTitle(label: string, status: Status, link?: SnapshotLink): string {
  return `${label}: ${statusWord(status, link)}`;
}

export function deviceStatus(device: SnapshotDevice, now: number = Date.now()): Status {
  const statuses = cardLinks(device).map((link) => linkStatus(link, device.kind, now));
  if (statuses.length === 0) return "absent";
  if (statuses.includes("linked")) return "linked";
  if (statuses.includes("warn")) return "warn";
  if (statuses.every((status) => status === "error")) return "error";
  return "idle";
}

/** Which link a device's Open control leads to: a usable link, or a
 * relay's own link (a relay's link rarely holds a session itself). */
export function primaryLinkFor(device: SnapshotDevice): SnapshotLink | undefined {
  const usable = device.links.find((link) => isLinkUsable(link));
  if (usable) {
    return usable;
  }
  return device.kind === "relay" ? device.links[0] : undefined;
}

export type DeviceKindIcon = "robot" | "radio" | "bridge" | "joystick" | "help";

/** A relay on this computer's USB is a radio micro:bit; any other relay is a bridge elsewhere. */
export function deviceKindIcon(device: SnapshotDevice): DeviceKindIcon {
  switch (device.kind) {
    case "robot":
      return "robot";
    case "joystick":
      return "joystick";
    case "relay":
      return device.links.some((link) => link.transport === "usb") ? "radio" : "bridge";
  }
}

export function reachedByText(transport: Transport, kind: SnapshotDevice["kind"]): string {
  switch (transport) {
    case "usb":
      return "USB";
    case "wifi":
      return "Wi-Fi";
    case "radio":
      return "radio";
    case "mbregistry":
      return "mbregistry";
    case "mbrelay":
      return kind === "relay" ? "network" : "radio";
    case "mbserial":
      return "network";
  }
}

export const BENCH_RECENT_MS = 10 * 60_000;

export function ageText(since: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  return minutes < 1 ? "<1 min" : `${minutes} min`;
}

export interface BenchEntry {
  key: string;
  icon: DeviceKindIcon;
  name: string;
  status: Status;
  note: string;
  linkId?: string | undefined;
  deviceId?: number;
}

/** On the bench: every device with a current link, plus anything seen
 * in the last {@link BENCH_RECENT_MS}, plus boards plugged in that have
 * not identified yet. */
export function benchEntries(
  devices: readonly SnapshotDevice[],
  unassigned: readonly SnapshotLink[],
  now: number = Date.now(),
): BenchEntry[] {
  const present: BenchEntry[] = [];
  const recent: Array<BenchEntry & { lastSeen: number }> = [];
  for (const device of devices) {
    const links = cardLinks(device);
    if (links.length > 0) {
      const status = deviceStatus(device, now);
      const shown =
        links.find((link) => linkStatus(link, device.kind, now) === status) ?? links[0]!;
      present.push({
        key: `device-${device.id}`,
        icon: deviceKindIcon(device),
        name: device.name,
        status,
        note: reachedByText(shown.transport, device.kind),
        linkId: primaryLinkFor(device)?.id,
        deviceId: device.id,
      });
    } else if (now - device.lastSeen <= BENCH_RECENT_MS) {
      recent.push({
        key: `device-${device.id}`,
        icon: deviceKindIcon(device),
        name: device.name,
        status: "absent",
        note: ageText(device.lastSeen, now),
        deviceId: device.id,
        lastSeen: device.lastSeen,
      });
    }
  }
  for (const link of unassigned) {
    present.push({
      key: `link-${link.id}`,
      icon: "help",
      name: "Unknown board",
      status: "linked",
      note: reachedByText(link.transport, "robot"),
      linkId: link.id,
    });
  }
  recent.sort((a, b) => b.lastSeen - a.lastSeen);
  return [...present, ...recent.map(({ lastSeen: _lastSeen, ...entry }) => entry)];
}

/** The front page's groups, shared with the sidebar's Browse counts. A
 * device is present while it has a non-stale link; a robot this console
 * owns stays present with none (it can still be reached by radio). Every
 * other device goes to Not seen recently, unless a present device already
 * shows its name (an unmerged placeholder row). `heldDown` keeps devices
 * with a radio attempt outstanding down there until a link is usable. */
export function frontPageGroups(devices: readonly SnapshotDevice[], heldDown: ReadonlySet<number> = new Set()) {
  const presentBeforeHold = devices.filter(
    (device) => cardLinks(device).length > 0 || (device.kind === "robot" && device.owned),
  );
  const present = presentBeforeHold.filter((device) => !heldDown.has(device.id));
  const presentNames = new Set(present.map((device) => device.name));
  const notSeenRecently = devices.filter(
    (device) => (cardLinks(device).length === 0 || heldDown.has(device.id)) && !presentNames.has(device.name),
  );
  return {
    present,
    notSeenRecently,
    robots: present.filter((device) => device.kind === "robot"),
    bridges: present.filter((device) => device.kind === "relay"),
    joysticks: present.filter((device) => device.kind === "joystick"),
  };
}
