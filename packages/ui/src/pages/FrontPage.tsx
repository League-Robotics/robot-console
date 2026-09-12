/**
 * FrontPage.tsx — the front page (`/`, SUC-001), replacing the old
 * flat Devices tab as the console's landing page.
 *
 * Lists every endpoint from `WsProvider`'s live snapshot
 * (`useEndpoints`) as a card; the card *is* the navigation affordance
 * into that endpoint's own page (`/d/:endpointId`) -- a real
 * `react-router` `Link`, so middle-click/keyboard/screen-reader
 * navigation all work, not a `<div onClick>`.
 *
 * Rendering carries over the old flat Devices tab's `DeviceCard` states
 * verbatim (naming pending, flagged/unnamed, unresponsive, HID-only/no
 * serial port, linked pill) via the shared `nameDisplay`/`roleDisplay`
 * helpers (`../deviceDisplay.ts`) -- this is a presentation move, not a
 * redesign of what's shown. What's dropped: the inline
 * Connect/Disconnect control `DeviceCard` owned before sprint 004. A
 * manual Connect/Disconnect did **not** move anywhere -- `deviceRegistry.ts`
 * already opens a session automatically on attach
 * (`resolveNameAndOpen`), and `DeviceConsole`'s "open a link" hint
 * (ticket 008) covers the one remaining case that matters, reopening a
 * session that failed to identify, right where the student is already
 * looking to send a line. Flash controls, by contrast, moved to the
 * per-device page in sprint 004 and then back here (ticket 012-002):
 * `EndpointCard` renders the shared `FlashDialog` (`../components/
 * FlashDialog.tsx`, a "Flash" trigger plus the popup modal the flow
 * itself now runs in -- out-of-process work, 2026-09-08) for a
 * `canBeFlashed` device, as a sibling of the card's `Link` rather than
 * nested inside it -- an interactive element inside an `<a>` is invalid
 * markup that would fight the router's click handling, so the `Link`
 * wraps only the informational region and the action row sits beside
 * it, inside the `<li>`. This component takes no
 * `onOpen`/`onClose` callbacks because the front page never performed
 * those actions directly itself (`DeviceCard` did). The old
 * `DevicesTab.tsx`/`ConsoleTab.tsx` components ticket 008 redistributed
 * from are deleted, not kept around unrouted.
 *
 * **Relay-radio entries (added out-of-process, 2026-09-09):** the host
 * publishes a child endpoint for a robot reached through a relay
 * (`transport: "relay-radio"`, `viaRelay: { relayEndpointId, ... }` --
 * `wsMessages.ts`, frozen elsewhere) alongside the relay's own entry.
 * Such a child has no `usb` block (the relay owns the physical port),
 * so `EndpointCard` renders "via relay `<name>`" in place of the
 * Port/Device ID rows rather than a misleading "No serial port" -- the
 * relay's own display name is looked up from the same `devices` list
 * this component already has (`EndpointsList`'s `relayNameById`), never
 * a bare id when the relay is actually present in the snapshot. The
 * card's `Link` itself needs no special case: `/d/${device.endpointId}`
 * already resolves to the child's own route exactly like any other
 * endpoint.
 *
 * **WiFi entries (sprint 10 ticket 005):** ticket 003 already
 * synthesizes a `transport: "wifi"` `EndpointListEntry` (`endpointId:
 * "wifi-<name>"`, a `wifi: { host, port }` block, no `usb` block) for a
 * roster-remembered robot reachable over the network -- `EndpointCard`
 * already renders any `EndpointListEntry` generically (the `Link`, the
 * "Linked" pill, flash gating), so the only gap is the Port/Device ID
 * row, which assumes a physical USB device. In its place this card
 * shows the same `Connection`-labeled row the relay branch uses, reading
 * "WiFi · `<host>:<port>`" -- distinguishing it from both a plain USB
 * card and a "via relay `<name>`" one, with no new component needed.
 * This file is explicitly *not* scanned by `RobotPage.transportBlind
 * .test.ts` (see that file's own scope note), so knowing `transport`
 * here is fine; `RobotPage` itself still never sees this label or this
 * field.
 *
 * **One card per robot (out-of-process, 2026-09-10):** the host lists
 * one `EndpointListEntry` per *link* (a USB port, a WiFi address, a
 * relay child), so a robot plugged into USB while also advertising over
 * WiFi arrived as two cards with the same name -- the stakeholder's
 * "the same name does not exist twice" rule. `groupEndpointsByRobot`
 * folds every named endpoint into one group per name; the card's
 * informational `Link` goes to the group's *primary* endpoint (an open
 * link first, then USB over WiFi over a relay child -- see
 * `linkScore`), its badge/role come from the most specifically
 * identified member (a robot identified as a calibration build over
 * USB stays a calibration robot even when its WiFi link is down), and
 * a `Connections` list below the `Link` (a sibling, never nested inside
 * the anchor) shows every link with its own state and its own `Link`
 * to that endpoint's page. A single-link robot renders exactly as
 * before. Nameless endpoints never group (there is no name to group
 * by), and a relay is its own device with its own name.
 *
 * Split into a connected `FrontPage` (reads `WsProvider`'s selectors)
 * and a presentational `EndpointsList`/`EndpointCard`, mirroring the
 * old Devices tab's own split, so the list states can be exercised
 * directly in tests against plain `EndpointListEntry` fixtures.
 *
 * **Relay-bridging attempt state (sprint 013, 2026-09-11):**
 * `RelayQuickConnect` additionally reads the relay's own
 * `EndpointListEntry.relayBridge` field (set/cleared host-side by
 * `deviceRegistry.ts`'s `openRobotViaRelay`) to show "Connecting to
 * `<name>`…" (or "Trying remembered robots…" for a no-pick attempt) the
 * instant a Connect press starts a bridging attempt, and the failure
 * reason (`relayBridge.error`) once the attempt is exhausted -- both
 * states render before any `-via-<name>` child endpoint exists, closing
 * the gap where an exhausted connect only ever reached the console log.
 * `connectionState` (the relay's own "Linked"/"Unreachable: .../Not
 * linked" row) reads only `sessionOpen`/`sessionError` and is
 * deliberately never touched by `relayBridge` -- see `sprint.md` (sprint
 * 013)'s Architecture, "`relayBridge` is a different field, read
 * separately". The existing `child?.viaRelay` "Connected to `<name>`"
 * paragraph takes rendering priority over `relayBridge` if both were
 * ever present in one snapshot -- this should not happen per ticket
 * 002's contract, but the card degrades sensibly rather than
 * double-rendering if it does.
 *
 * **"Connected to `<name>`" requires an open session, not just a child
 * endpoint (sprint 013 follow-up, 013-003/013-004, 2026-09-11):** the
 * synthesized `-via-<name>` child is not deleted when its radio link
 * drops -- `deviceRegistry.ts#handleLinkError` leaves it listed with
 * `sessionOpen: false` and `sessionError` set; only a deliberate
 * Disconnect/`requestClose`, or the WiFi auto-switch, removes it. So
 * "Connected to `<name>` on channel X, group Y" renders only when
 * `child.viaRelay` exists **and** `child.sessionOpen === true`; when the
 * child exists with `sessionOpen === false`, the card instead renders
 * "Connection to `<name>` lost" (plus `child.sessionError` when
 * present), styled like the failed-bridge line, with Switch/Disconnect
 * still available so the student can retry or clean up.
 *
 * **Calibration classification (sprint 011 ticket 002):** a
 * `classification.type === "calibration"` card renders an additional
 * `data-testid="calibration-badge"` label ("Calibration robot", plus
 * the raw `classification.version` when present) alongside the header
 * row's existing name/flag/linked-pill markup -- purely additive; a
 * plain `"robot"` card's rendering is unchanged.
 *
 * **Sprint 5's remembered-robot roster:** a second, visually secondary
 * section, `RememberedRobotsSection`, rendered below the attached-
 * endpoint list -- robots this host has seen over USB before but are
 * not plugged in right now (the host already excludes currently-
 * attached names from `rememberedRobots`, so this component never
 * filters against `devices` itself). Per `sprint.md`'s Design
 * Rationale, a remembered robot is deliberately **not** a
 * `react-router` `Link` and not wrapped in one -- there is nothing to
 * navigate to this sprint (no endpoint, no session, no `/d/:endpointId`
 * route that would resolve), so it renders as plain, muted text with a
 * "Forget" button instead of a dead-ending link. Only rendered when
 * `rememberedRobots.length > 0`; the existing "No devices detected
 * yet" copy already covers the whole-page-empty case, and this sprint
 * deliberately ships no separate empty-state copy for an empty roster
 * (see the ticket).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { EndpointListEntry, RememberedRobotEntry } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus } from "../ws/WsProvider";
import {
  useConnectionStatus,
  useDiscoveredServices,
  useEndpoints,
  useRememberedRobots,
  useWsActions,
} from "../ws/WsProvider";
import { canBeFlashed, nameDisplay, roleDisplay } from "../deviceDisplay";
import { FlashDialog } from "../components/FlashDialog";
import { buildRobotOptions, RobotSelect, type RobotOption } from "./RelayPage";
import "./FrontPage.css";

export function FrontPage() {
  const status = useConnectionStatus();
  const devices = useEndpoints();
  const rememberedRobots = useRememberedRobots();
  const discoveredServices = useDiscoveredServices();
  const { send } = useWsActions();
  const robotOptions = buildRobotOptions(rememberedRobots, discoveredServices.robots);
  return (
    <EndpointsList
      status={status}
      devices={devices}
      rememberedRobots={rememberedRobots}
      onForgetRememberedRobot={(name) => send({ type: "forget-known-robot", name })}
      robotOptions={robotOptions}
      onRelayConnect={(relay, robotName) => {
        const child = devices.find((candidate) => candidate.viaRelay?.relayEndpointId === relay.endpointId);
        if (child) {
          send({ type: "session-close", endpointId: child.endpointId });
        }
        if (robotName === "") {
          send({ type: "session-open", endpointId: relay.endpointId, autoRobot: true });
          return;
        }
        // Ticket 006: no `radio` override sent here any more -- the
        // robot's radio address is resolved host-side from a
        // device-level override, the mbrelay registry, or the
        // name-derived default, in that order (`radioOverride.ts`'s
        // `override -> registry -> derived`). See `RelayPage.tsx`'s own
        // doc comment ("per-connect channel/group inputs removed").
        send({ type: "session-open", endpointId: relay.endpointId, robotName });
      }}
      onRelayDisconnect={(child) => send({ type: "session-close", endpointId: child.endpointId })}
    />
  );
}

export interface EndpointsListProps {
  status: ConnectionStatus;
  devices: EndpointListEntry[];
  /** Defaults to `[]` so existing call sites (and tests) that don't
   * care about the remembered-robot roster don't have to pass it. */
  rememberedRobots?: RememberedRobotEntry[];
  /** Defaults to a no-op so `rememberedRobots`-less call sites never
   * need to pass a handler that will never fire. */
  onForgetRememberedRobot?: (name: string) => void;
  /** OOP 2026-09-10: the names a relay card's own robot picker offers
   * (`RelayPage.buildRobotOptions`'s roster-plus-discovered list).
   * Defaults to `[]`, which renders the picker disabled with its
   * "no robots remembered yet" placeholder. */
  robotOptions?: RobotOption[];
  /** OOP 2026-09-10: a relay card's Connect press -- `robotName` is
   * `""` for "let the host pick" (`autoRobot`). */
  onRelayConnect?: (relay: EndpointListEntry, robotName: string) => void;
  /** OOP 2026-09-10: a relay card's Disconnect press for its current
   * via-relay child. */
  onRelayDisconnect?: (child: EndpointListEntry) => void;
}

export function EndpointsList({
  status,
  devices,
  rememberedRobots = [],
  onForgetRememberedRobot = () => {},
  robotOptions = [],
  onRelayConnect = () => {},
  onRelayDisconnect = () => {},
}: EndpointsListProps) {
  return (
    <section className="front-page" aria-label="Devices">
      {status !== "open" && (
        <p className="connection-banner" role="status">
          {status === "connecting"
            ? "Connecting to robot-console…"
            : "Lost connection to robot-console — reconnecting…"}
        </p>
      )}
      {devices.length === 0 ? (
        <p className="devices-empty">
          No devices detected yet. Plug a micro:bit into a USB port.
        </p>
      ) : (
        <ul className="devices-list">
          {groupEndpointsByRobot(devices).map((group) => (
            <li key={group.key}>
              <RobotCard
                group={group}
                devices={devices}
                robotOptions={robotOptions}
                onRelayConnect={onRelayConnect}
                onRelayDisconnect={onRelayDisconnect}
              />
            </li>
          ))}
        </ul>
      )}
      {rememberedRobots.length > 0 && (
        <RememberedRobotsSection robots={rememberedRobots} onForget={onForgetRememberedRobot} />
      )}
    </section>
  );
}

/** One robot's worth of endpoints -- see this module's doc comment,
 * "One card per robot". Exported for `FrontPage.test.tsx`. */
export interface RobotGroup {
  /** The robot's name, or the lone endpoint's id for a nameless one. */
  key: string;
  /** The endpoint the card's open-arrow leads to -- see {@link linkScore}. */
  primary: EndpointListEntry;
  /** Every endpoint in the group, best first. */
  members: EndpointListEntry[];
}

const TRANSPORT_RANK: Record<string, number> = { usb: 3, wifi: 2, "relay-radio": 1, mbrelay: 1, mbserial: 1 };
const CLASSIFICATION_RANK: Record<string, number> = { calibration: 3, relay: 3, robot: 2, unknown: 0 };

/** Which of a robot's links the card should lead to: an open link beats
 * a closed one; among equals, a direct USB link beats WiFi beats a relay
 * child (the same preference `deviceRegistry.ts`'s auto-switch encodes);
 * a link that has identified beats one that hasn't. */
function linkScore(device: EndpointListEntry): number {
  return (
    (device.sessionOpen ? 100 : 0) +
    (TRANSPORT_RANK[device.transport] ?? 0) * 10 +
    (CLASSIFICATION_RANK[device.classification.type] ?? 0)
  );
}

/** Fold the host's per-link endpoint list into one group per robot
 * name, preserving the host's order for the groups' first appearance.
 * Exported for `FrontPage.test.tsx`. */
export function groupEndpointsByRobot(devices: EndpointListEntry[]): RobotGroup[] {
  const groups = new Map<string, EndpointListEntry[]>();
  for (const device of devices) {
    const key = device.name ?? `endpoint:${device.endpointId}`;
    const members = groups.get(key);
    if (members) {
      members.push(device);
    } else {
      groups.set(key, [device]);
    }
  }
  return [...groups.entries()].map(([key, members]) => {
    const sorted = [...members].sort((a, b) => linkScore(b) - linkScore(a));
    return { key, primary: sorted[0]!, members: sorted };
  });
}

/** The member whose classification is most specific -- the primary on
 * a tie, so a single-link group is unaffected. */
function bestClassified(group: RobotGroup): EndpointListEntry {
  let best = group.primary;
  for (const member of group.members) {
    if ((CLASSIFICATION_RANK[member.classification.type] ?? 0) > (CLASSIFICATION_RANK[best.classification.type] ?? 0)) {
      best = member;
    }
  }
  return best;
}

/** The relay's own display name for a `viaRelay.relayEndpointId`, per
 * `nameDisplay`'s own rules -- falls back to the bare id only when the
 * relay itself isn't (or is no longer) present in this snapshot, which
 * should not happen in practice (the relay stays listed, session-closed,
 * while its child exists) but must never crash a card over a lookup
 * miss. */
function relayDisplayName(devices: EndpointListEntry[], relayEndpointId: string): string {
  const relay = devices.find((candidate) => candidate.endpointId === relayEndpointId);
  return relay ? nameDisplay(relay).text : relayEndpointId;
}

/** A short label for one link: "USB · /dev/… · ID 0002", "WiFi ·
 * host:port", "Radio via relay <name>". The USB form keeps the port
 * and short device id a student matches against the physical board. */
function connectionLabel(device: EndpointListEntry, devices: EndpointListEntry[]): string {
  if (device.viaRelay) {
    return `Radio via relay ${relayDisplayName(devices, device.viaRelay.relayEndpointId)}`;
  }
  if (device.transport === "wifi") {
    return device.wifi ? `WiFi · ${device.wifi.host}:${device.wifi.port}` : "WiFi";
  }
  const port = device.usb?.port ?? "No serial port";
  return device.usb?.displaySerial ? `USB · ${port} · ID ${device.usb.displaySerial}` : `USB · ${port}`;
}

function connectionState(device: EndpointListEntry): string {
  if (device.sessionOpen) {
    return "Linked";
  }
  if (device.sessionError) {
    return `Unreachable: ${device.sessionError}`;
  }
  return "Not linked";
}

/** An arrow glyph for the open/back buttons -- inline SVG so it needs
 * no icon font and inherits `currentColor`. */
function ArrowIcon({ direction }: { direction: "forward" | "back" }) {
  const points = direction === "forward" ? "9 5 16 12 9 19" : "15 5 8 12 15 19";
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <line
        x1={direction === "forward" ? "4" : "20"}
        y1="12"
        x2={direction === "forward" ? "16" : "8"}
        y2="12"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One robot's card -- see this module's doc comment, "One card per
 * robot". Nothing in the informational region navigates (the
 * stakeholder's 2026-09-10 direction): the only way into the robot's
 * page is the open-arrow button on the right (`data-testid=
 * "device-<primaryId>"`, a real `Link`), and each extra link listed
 * under the card carries its own small arrow to that link's page. A
 * relay's card additionally carries the robot picker + Connect from
 * `RelayPage`, so a relay can be pointed at a robot without opening
 * its page first. */
function RobotCard({
  group,
  devices,
  robotOptions,
  onRelayConnect,
  onRelayDisconnect,
}: {
  group: RobotGroup;
  devices: EndpointListEntry[];
  robotOptions: RobotOption[];
  onRelayConnect: (relay: EndpointListEntry, robotName: string) => void;
  onRelayDisconnect: (child: EndpointListEntry) => void;
}) {
  const primary = group.primary;
  const identified = bestClassified(group);
  const name = nameDisplay(primary);
  const role = roleDisplay(identified);
  const isCalibration = identified.classification.type === "calibration";
  const isRelay = primary.classification.type === "relay";

  return (
    <div className="device-card" data-testid={`device-card-${primary.endpointId}`}>
      <div className="device-card-main">
        <div className="device-card-body">
          <div className="device-card-header">
            <h3 className={name.flagged ? "device-name device-name-flagged" : "device-name"}>{name.text}</h3>
            {name.flagged && <span className="device-flag">Unnamed / naming failed</span>}
            {isCalibration && (
              <span className="device-calibration-badge" data-testid="calibration-badge">
                {identified.classification.version
                  ? `Calibration robot · ${identified.classification.version}`
                  : "Calibration robot"}
              </span>
            )}
            {primary.sessionOpen && <span className="device-linked-pill">Linked</span>}
          </div>

          {name.flagged && primary.nameError && <p className="device-note">{primary.nameError.message}</p>}

          <dl className="device-fields">
            <div>
              <dt>Role</dt>
              <dd>{role}</dd>
            </div>
          </dl>

          <ul className="device-connections" aria-label={`Connections for ${name.text}`}>
            {group.members.map((member) => (
              <li key={member.endpointId} className="device-connection" data-testid={`device-link-${member.endpointId}`}>
                <span className="device-connection-label">{connectionLabel(member, devices)}</span>
                <span className={member.sessionOpen ? "device-connection-state device-connection-open" : "device-connection-state"}>
                  {connectionState(member)}
                </span>
                {member !== primary && (
                  <Link
                    to={`/d/${member.endpointId}`}
                    className="device-connection-open-button"
                    aria-label={`Open ${name.text} over ${connectionLabel(member, devices)}`}
                    data-testid={`device-row-open-${member.endpointId}`}
                  >
                    <ArrowIcon direction="forward" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>

        <Link
          to={`/d/${primary.endpointId}`}
          className="device-open-button"
          aria-label={`Open ${name.text}`}
          title={`Open ${name.text}`}
          data-testid={`device-${primary.endpointId}`}
        >
          <ArrowIcon direction="forward" />
        </Link>
      </div>

      {isRelay && (
        <RelayQuickConnect
          relay={primary}
          devices={devices}
          robotOptions={robotOptions}
          onConnect={onRelayConnect}
          onDisconnect={onRelayDisconnect}
        />
      )}

      {canBeFlashed(primary) && (
        <div className="device-card-actions" data-testid={`device-actions-${primary.endpointId}`}>
          <FlashDialog endpoint={primary} />
        </div>
      )}
    </div>
  );
}

/** OOP 2026-09-10: a relay card's own robot picker + Connect/Disconnect
 * -- `RelayPage`'s `RobotSelect` reused verbatim, so a relay can be
 * pointed at a robot from the front page. The radio address sent is
 * whatever `RelayPage` last stored for that name, else the name-derived
 * default (`FrontPage`'s `onRelayConnect`); the editable override
 * stays on `RelayPage`. Uncontrolled selection state lives here, per
 * card. */
function RelayQuickConnect({
  relay,
  devices,
  robotOptions,
  onConnect,
  onDisconnect,
}: {
  relay: EndpointListEntry;
  devices: EndpointListEntry[];
  robotOptions: RobotOption[];
  onConnect: (relay: EndpointListEntry, robotName: string) => void;
  onDisconnect: (child: EndpointListEntry) => void;
}) {
  const child = devices.find((candidate) => candidate.viaRelay?.relayEndpointId === relay.endpointId);
  const [selectedName, setSelectedName] = useState<string>(child?.viaRelay?.robotName ?? "");
  useEffect(() => {
    if (child?.viaRelay) {
      setSelectedName(child.viaRelay.robotName);
    }
  }, [child?.viaRelay?.robotName]);

  // Sprint 13 ticket 003: `relayBridge` covers the two states that have
  // no other representation -- "connecting" and "failed" -- both of
  // which can occur before any `-via-<name>` child exists. `child
  // ?.viaRelay`'s "Connected to <name>"/"Connection to <name> lost"
  // paragraph above takes priority if both were somehow present in the
  // same snapshot (should not happen per ticket 002's contract; this
  // just avoids double-rendering if it ever does).
  const bridge = child?.viaRelay ? undefined : relay.relayBridge;

  // Sprint 013 follow-up (013-003/013-004): a child endpoint existing is
  // not the same as being connected -- `deviceRegistry.ts#handleLinkError`
  // leaves a dropped radio link's synthesized child listed with
  // `sessionOpen: false` and `sessionError` set rather than deleting it
  // (only Disconnect/`requestClose`, or the WiFi auto-switch, removes the
  // child outright), so "Connected to <name>" must require
  // `child.sessionOpen === true`, not just the child's existence.

  return (
    <div className="device-relay-connect" data-testid={`relay-quick-connect-${relay.endpointId}`}>
      {child?.viaRelay && child.sessionOpen && (
        <p className="device-relay-connected">
          Connected to {child.viaRelay.robotName} on channel {child.viaRelay.channel}, group {child.viaRelay.group}
        </p>
      )}
      {child?.viaRelay && !child.sessionOpen && (
        <p className="device-relay-failed" data-testid={`relay-quick-lost-${relay.endpointId}`}>
          Connection to {child.viaRelay.robotName} lost{child.sessionError ? `: ${child.sessionError}` : ""}
        </p>
      )}
      {bridge?.state === "connecting" && (
        <p className="device-relay-connecting" data-testid={`relay-quick-connecting-${relay.endpointId}`}>
          {bridge.robotName ? `Connecting to ${bridge.robotName}…` : "Trying remembered robots…"}
        </p>
      )}
      {bridge?.state === "failed" && (
        <p className="device-relay-failed" data-testid={`relay-quick-failed-${relay.endpointId}`}>
          {bridge.error}
        </p>
      )}
      <div className="device-relay-connect-row">
        <RobotSelect options={robotOptions} value={selectedName} onChange={setSelectedName} />
        <button
          type="button"
          className="device-relay-connect-button"
          disabled={!relay.sessionOpen && !child}
          onClick={() => onConnect(relay, selectedName)}
        >
          {child ? "Switch" : "Connect"}
        </button>
        {child && (
          <button type="button" className="device-relay-disconnect-button" onClick={() => onDisconnect(child)}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

/** The remembered-robot roster, rendered only when non-empty (see this
 * module's doc comment). Visually secondary to the attached-endpoint
 * list above it -- muted text, no `Link`, a plain "Forget" button --
 * since these are robots that are not reachable right now, only
 * remembered by name for later. */
function RememberedRobotsSection({
  robots,
  onForget,
}: {
  robots: RememberedRobotEntry[];
  onForget: (name: string) => void;
}) {
  return (
    <section className="remembered-robots" aria-label="Remembered robots">
      <h2 className="remembered-robots-heading">Robots remembered from before</h2>
      <p className="remembered-robots-hint">
        These are robots this computer has seen plugged in before. They
        aren&apos;t plugged in right now, but their names are remembered so
        you can reach them again later, over a relay or the network.
      </p>
      <ul className="remembered-robots-list">
        {robots.map((robot) => (
          <li key={robot.name}>
            <RememberedRobotCard robot={robot} onForget={onForget} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One remembered robot -- name, when it was last seen, and a "Forget"
 * button. Deliberately plain markup, not a `Link`: there is nothing to
 * navigate to (see this module's doc comment). */
function RememberedRobotCard({
  robot,
  onForget,
}: {
  robot: RememberedRobotEntry;
  onForget: (name: string) => void;
}) {
  return (
    <div className="remembered-robot-card" data-testid={`remembered-robot-${robot.name}`}>
      <div className="remembered-robot-header">
        <h3 className="remembered-robot-name">{robot.name}</h3>
      </div>
      <p className="remembered-robot-note">
        Last seen {new Date(robot.lastSeenAt).toLocaleString()}
      </p>
      <button
        type="button"
        className="remembered-robot-forget"
        onClick={() => onForget(robot.name)}
      >
        Forget
      </button>
    </div>
  );
}
