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
 * `EndpointCard` renders the shared `FlashControls` (`../components/
 * FlashControls.tsx`) for a `canBeFlashed` device, as a sibling of the
 * card's `Link` rather than nested inside it -- an interactive element
 * inside an `<a>` is invalid markup that would fight the router's click
 * handling, so the `Link` wraps only the informational region and the
 * action row sits beside it, inside the `<li>`. This component takes no
 * `onOpen`/`onClose` callbacks because the front page never performed
 * those actions directly itself (`DeviceCard` did). The old
 * `DevicesTab.tsx`/`ConsoleTab.tsx` components ticket 008 redistributed
 * from are deleted, not kept around unrouted.
 *
 * Split into a connected `FrontPage` (reads `WsProvider`'s selectors)
 * and a presentational `EndpointsList`/`EndpointCard`, mirroring the
 * old Devices tab's own split, so the list states can be exercised
 * directly in tests against plain `EndpointListEntry` fixtures.
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
import { Link } from "react-router";
import type { EndpointListEntry, RememberedRobotEntry } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus } from "../ws/WsProvider";
import { useConnectionStatus, useEndpoints, useRememberedRobots, useWsActions } from "../ws/WsProvider";
import { canBeFlashed, nameDisplay, roleDisplay } from "../deviceDisplay";
import { FlashControls } from "../components/FlashControls";
import "./FrontPage.css";

export function FrontPage() {
  const status = useConnectionStatus();
  const devices = useEndpoints();
  const rememberedRobots = useRememberedRobots();
  const { send } = useWsActions();
  return (
    <EndpointsList
      status={status}
      devices={devices}
      rememberedRobots={rememberedRobots}
      onForgetRememberedRobot={(name) => send({ type: "forget-known-robot", name })}
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
}

export function EndpointsList({
  status,
  devices,
  rememberedRobots = [],
  onForgetRememberedRobot = () => {},
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
          {devices.map((device) => (
            <li key={device.endpointId}>
              <EndpointCard device={device} />
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

/** One endpoint's card -- the informational region is a `Link` to its
 * device page, per the "an arrow on the box, or maybe you just click
 * the box" stakeholder note (`sprint.md`'s SUC-001): the student can
 * click anywhere in that region, not just a small affordance inside
 * it. A flash action row (ticket 012-002) is a sibling of the `Link`,
 * inside the same `<li>` -- not nested inside the `<a>`, which would
 * put a `<button>`/`<input>` inside an anchor (invalid HTML that would
 * also fight the router's own click handling). */
function EndpointCard({ device }: { device: EndpointListEntry }) {
  const name = nameDisplay(device);
  const role = roleDisplay(device);

  return (
    <>
      <Link
        to={`/d/${device.endpointId}`}
        className="device-card"
        data-testid={`device-${device.endpointId}`}
      >
        <div className="device-card-header">
          <h3 className={name.flagged ? "device-name device-name-flagged" : "device-name"}>
            {name.text}
          </h3>
          {name.flagged && <span className="device-flag">Unnamed / naming failed</span>}
          {device.sessionOpen && <span className="device-linked-pill">Linked</span>}
        </div>

        {name.flagged && device.nameError && (
          <p className="device-note">{device.nameError.message}</p>
        )}

        <dl className="device-fields">
          <div>
            <dt>Role</dt>
            <dd>{role}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{device.usb?.port ?? "No serial port"}</dd>
          </div>
          <div>
            <dt>Device ID</dt>
            <dd title={device.usb?.serialNumber}>{device.usb?.displaySerial}</dd>
          </div>
        </dl>

        {device.sessionError && (
          <p className="device-note">Link attempt: {device.sessionError}</p>
        )}
      </Link>

      {canBeFlashed(device) && (
        <div className="device-card-actions" data-testid={`device-actions-${device.endpointId}`}>
          <FlashControls endpoint={device} />
        </div>
      )}
    </>
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
