/**
 * AppHeader.tsx — the workspace top bar, mounted once beside the route
 * tree. On the device list it names the page; on a device page it is the
 * device's header: back button, name pill, meta line, the active
 * connection (with Connect / switch-link when it is not usable) and the
 * toolbar (Radio, Wi-Fi, Flash, Forget). It also carries the
 * disconnected-from-host banner.
 */
import { ForgetDeviceDialog, TrashIcon } from "./ForgetDeviceDialog";
import { Link, useMatch } from "react-router";
import type { FirmwareKind, SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import {
  ALL_FLASHABLE_FIRMWARE,
  connectionLabel,
  currentRelayChild,
  isLinkUsable,
  linkStateText,
  plainFailureReason,
  deviceMetaText,
} from "../deviceDisplay";
import { deviceStatus, linkStatus } from "../status";
import {
  useDeviceForLink,
  useDevices,
  useHostConnection,
  useLink,
  useRelays,
  useSendable,
  useWsActions,
} from "../ws/WsProvider";
import { FlashDialog } from "./FlashDialog";
import { Icon } from "./Icon";
import { RadioAddressDialog } from "./RadioAddressDialog";
import { relayStatusText } from "./RelayConnectControls";
import { TransportIcon } from "./TransportIcon";
import { WifiCredentialsDialog } from "./WifiCredentialsDialog";
import "./AppHeader.css";

/** The banner's text for each disconnected/stale combination -- `null`
 * when nothing needs saying. */
export function disconnectedBannerText(status: "connecting" | "open" | "closed", stale: boolean): string | null {
  if (status === "connecting") {
    return "Connecting to the host…";
  }
  if (status === "closed") {
    return "Disconnected from the host — reconnecting…";
  }
  if (stale) {
    return "Reconnected — waiting for the latest state…";
  }
  return null;
}

/**
 * The connection text for a routed robot (or unassigned) link that is
 * not usable: plain "Not connected" with no session, otherwise "Not
 * connected over `<label>`" plus the plain-worded reason. Callers check
 * {@link isLinkUsable} first.
 */
export function connectionStatusText(link: SnapshotLink, kind: SnapshotDevice["kind"] = "robot"): string {
  if (link.session === undefined) {
    return "Not connected";
  }
  return link.reason
    ? `Not connected over ${connectionLabel(link)}: ${plainFailureReason(link.reason, link.transport, kind)}`
    : `Not connected over ${connectionLabel(link)}`;
}

/**
 * The connection text for a relay's own link: its bridging state while
 * the relay itself is reachable, otherwise why it cannot be reached. A
 * relay never has a session of its own, so this never mentions one.
 */
export function relayConnectionStatusText(
  link: SnapshotLink,
  relayInfo: SnapshotRelay | undefined,
  devices: readonly SnapshotDevice[],
  child: { device: SnapshotDevice; link: SnapshotLink } | undefined,
  now: number = Date.now(),
): string {
  if (link.state === "connected" || link.state === "connecting") {
    return relayStatusText({ relayInfo, devices, relayLinkId: link.id }, child).text;
  }
  return linkStateText(link, now, "relay");
}

/** The first other usable link on `device` -- the "Use `<label>` instead" target. */
function usableSiblingLink(device: SnapshotDevice | undefined, link: SnapshotLink): SnapshotLink | undefined {
  return device?.links.find((candidate) => candidate.id !== link.id && isLinkUsable(candidate));
}

export interface AppHeaderProps {
  /** Opens the sidebar drawer at narrow widths; no menu button without it. */
  onOpenNav?: () => void;
}

export function AppHeader({ onOpenNav }: AppHeaderProps = {}) {
  const homeMatch = useMatch("/");
  const deviceMatch = useMatch("/d/:linkId");
  const linkId = deviceMatch?.params.linkId;
  const link = useLink(linkId ?? "");
  const device = useDeviceForLink(linkId);
  const name = device?.name ?? link?.label ?? "";
  const { status, stale } = useHostConnection();
  const bannerText = disconnectedBannerText(status, stale);
  const { send } = useWsActions();
  const sendable = useSendable();
  const usable = link ? isLinkUsable(link) : false;
  const sibling = link ? usableSiblingLink(device, link) : undefined;
  // Every hook runs every render; the relay lookups are only read for a relay's own link.
  const isRelayLink = device?.kind === "relay";
  const devices = useDevices();
  const relays = useRelays();
  const relayInfo = isRelayLink && link ? relays.find((r) => r.linkId === link.id) : undefined;
  const relayChild = isRelayLink && link ? currentRelayChild(devices, link.id) : undefined;
  // An identified device's page offers only its own firmware kind; local hex only before it identifies.
  const allowedFirmware: readonly FirmwareKind[] =
    device?.kind === "robot" ? ["robot"] : device?.kind === "relay" ? ["relay"] : ALL_FLASHABLE_FIRMWARE;
  const allowLocalHex = device === undefined;
  const radioTools = device !== undefined && device.kind !== "relay" ? device : undefined;
  const nameStatus = device ? deviceStatus(device) : link ? linkStatus(link) : "idle";

  return (
    <header className="app-header lg-top" data-variant={homeMatch ? "list" : "device"}>
      {bannerText && (
        <p className="app-header-banner" role="status" data-testid="disconnected-banner">
          {bannerText}
        </p>
      )}
      {onOpenNav && (
        <button
          type="button"
          className="lg-tb lg-tb--icon app-header-menu"
          aria-label="Show navigation"
          title="Show navigation"
          onClick={onOpenNav}
        >
          <Icon name="menu" />
        </button>
      )}
      {homeMatch && <span className="lg-top__title">Devices</span>}
      {!homeMatch && (
        <Link to="/" className="lg-top__back app-header-back" aria-label="Back to devices" title="Back to devices">
          <Icon name="arrow-left" />
        </Link>
      )}
      {link && (
        <div className="lg-top__ident">
          <h1 className="lg-name lg-name--lg" data-status={nameStatus} data-testid="app-header-name">
            {name}
          </h1>
          {device && (
            <p className="lg-meta" data-testid="app-header-meta">
              {deviceMetaText(device)}
            </p>
          )}
        </div>
      )}
      {link && (
        <div className="lg-top__conn app-header-connection" data-testid="app-header-connection">
          <TransportIcon transport={link.transport} size={14} />
          <span className="app-header-connection-label">{connectionLabel(link)}</span>
          {isRelayLink ? (
            // A relay is connected by picking a robot on its own page, never from here.
            <span className="app-header-connection-state" data-testid="app-header-connection-state">
              {relayConnectionStatusText(link, relayInfo, devices, relayChild)}
            </span>
          ) : usable ? (
            <span className="app-header-connection-state" data-testid="app-header-connection-state">
              {linkStateText(link, undefined, device?.kind)}
            </span>
          ) : (
            <>
              <span className="app-header-connection-state app-header-not-usable" data-testid="app-header-not-usable">
                {connectionStatusText(link, device?.kind)}
              </span>
              <button
                type="button"
                className="lg-btn lg-btn--sm app-header-connect"
                data-testid="app-header-connect"
                disabled={!sendable}
                onClick={() => send({ type: "session-open", linkId: link.id })}
              >
                Connect
              </button>
              {sibling && (
                <Link to={`/d/${sibling.id}`} className="app-header-switch-link" data-testid="app-header-switch-link">
                  Use {connectionLabel(sibling)} instead
                </Link>
              )}
            </>
          )}
        </div>
      )}
      {link && (
        <div className="lg-tools app-header-actions">
          {/* `radio.group === 0` is projection's "no radio identity" placeholder (nezsim simulated boards). */}
          {radioTools && radioTools.radio.group !== 0 && (
            <RadioAddressDialog
              deviceId={radioTools.id}
              name={radioTools.name}
              radio={radioTools.radio}
              triggerClassName="lg-tb"
              triggerContent={
                <>
                  <Icon name="radio" size={16} />
                  Radio
                </>
              }
            />
          )}
          {radioTools && (
            <WifiCredentialsDialog
              linkId={link.id}
              linkOpen={isLinkUsable(link)}
              name={radioTools.name}
              triggerClassName="lg-tb"
              triggerContent={
                <>
                  <Icon name="wifi" size={16} />
                  Wi-Fi
                </>
              }
            />
          )}
          {radioTools && <span className="lg-tools__sep" aria-hidden="true" />}
          {/* Only a directly attached USB link can flash; elsewhere FlashDialog's own gate decides. */}
          <FlashDialog
            link={link}
            name={name}
            forceShow={link.transport === "usb"}
            triggerClassName="lg-tb lg-tb--primary"
            triggerContent={
              <>
                <Icon name="bolt" size={16} />
                Flash
              </>
            }
            allowedFirmware={allowedFirmware}
            allowLocalHex={allowLocalHex}
          />
          {device && (
            <ForgetDeviceDialog
              deviceId={device.id}
              name={device.name}
              triggerIcon={<TrashIcon />}
              triggerClassName="lg-tb lg-tb--icon lg-tb--danger"
            />
          )}
        </div>
      )}
    </header>
  );
}
