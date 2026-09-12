/**
 * FrontPage.tsx — the front page (`/`, SUC-001), rewritten against
 * sprint 015's `Snapshot` contract (ticket 007; issue
 * `rearch-07-ui-renders-snapshot-drops-client-policy.md`).
 *
 * ## What changed from the pre-ticket-007 `EndpointsMessage` version
 *
 * The host now groups every link under its owning device
 * (`Snapshot.devices[].links[]`) and lists a USB board that hasn't
 * identified yet separately (`Snapshot.unassigned`), so this file no
 * longer has to: `groupEndpointsByRobot`/`linkScore`/`bestClassified`
 * (folding same-named endpoints into one card, scoring which link to
 * lead with) are deleted outright, not ported -- the host already did
 * that grouping. One card renders per `devices[]` row (host order);
 * `unassigned[]` boards get their own, simpler card (there is no name,
 * role, or classification to show for one yet -- just its `label` and
 * connection state).
 *
 * A device's own `role`/`kind`/`program` replace the old
 * `classification` object; there is no `classification.type ===
 * "unknown"` case left to render at the device level, because an
 * unidentified board isn't a device row at all any more (it's an
 * `unassigned` link) -- see `deviceDisplay.ts`'s own doc comment.
 * `nameError`/flagged-name rendering is gone for the same reason:
 * `SnapshotDevice.name` is always a resolved string.
 *
 * Per-link status text ("Linked" / "Connecting" / "Unreachable: …" /
 * "Retrying in Ns" / "Not seen since …") is now derived from
 * `SnapshotLink.state`/`reason`/`lastSeen`/`nextRetryAt` by
 * `deviceDisplay.ts`'s shared `linkStateText` (ticket 017-007: moved
 * there from this module's own former local copy), rather than from a
 * flat `sessionOpen`/`sessionError` pair.
 *
 * The remembered-robot roster (`Snapshot.rememberedRobots` in the old
 * contract) is gone as its own side list: a device the host still
 * knows about but isn't currently reachable simply has `links.length
 * === 0` (still present in `devices[]` because `owned: true` -- see
 * `projection.ts`'s own doc comment, "known but not currently
 * reachable is meaningfully different from not known") and is filtered
 * into `NotSeenRecentlySection` below from the very same `devices[]`
 * list — no separate roster to join. Forgetting one now sends
 * `{ type: "forget-device", deviceId }` (the device's numeric
 * `devices.id`), replacing the old name-keyed `forget-known-robot`.
 *
 * Relay quick-connect keeps its card (robot picker, Connect/Switch/
 * Disconnect), but now sends exactly `{ type: "session-open",
 * relayLinkId, name }` -- the old `radio` override argument and the
 * no-pick `autoRobot` request are both gone from the wire contract
 * (`wsMessages.ts`'s own `SessionOpenMessage` doc comment: "`autoRobot`'s
 * default-failover request has no replacement in this shape"), so the
 * Connect button now requires a picked name. `relayBridge`'s
 * connecting/failed states are carried over as `SnapshotRelay.bridging`,
 * looked up by the relay's own connectivity link id.
 *
 * **Flash trigger restored (sprint 015 ticket 008)**: `FlashDialog`/
 * `FlashControls` now speak `SnapshotLink` (`link.capabilities.flash`,
 * `useFlashProgress(linkId)`) -- the front-page Flash trigger this
 * ticket had dropped pending that migration (`04-ui.md` §1.2, "Flash
 * trigger (dialog) on card when role === null") is back, on
 * `UnassignedCard` (the direct successor of "role === null" under the
 * new contract -- see that component's own doc comment).
 *
 * **Sweep takeover rendering (sprint 016 ticket 004)**: the relay card's
 * own connect controls (`components/RelayConnectControls.tsx`, ticket
 * 017-007 -- extracted from this module's own former `RelayQuickConnect`,
 * now shared with `RelayPage.tsx` rather than each keeping an identical
 * copy) render "idle · sweeping `<name>`" (or plain "idle") while no
 * child is bridged and no `bridging` is in flight, mirroring
 * `RelayPage.tsx`'s own identical label -- both read
 * `deviceDisplay.ts`'s shared `findRelayChild` (guarded against a
 * sweep-only sighting being mistaken for a live child) and
 * `findSweepingCandidateName` (a client-side inference from
 * `SnapshotDevice.lastChecked`, since no wire field names "which
 * candidate is mid-probe right now" -- see that function's own doc
 * comment), and (ticket 016-007) `sweepRateSuffix`, appending "(fast)"/
 * "(slow)" once the sweeper has feature-detected rearch-12's
 * non-persisting `!CGT` tune for this relay. `DeviceCard`'s own per-link connection row also renders
 * "Last checked `<time>`" (`deviceDisplay.ts`'s `lastCheckedText`)
 * alongside a `via`-linked (radio/mbrelay) row's existing "(via relay
 * `<name>`)" label (`connectionLabel`, unchanged) -- architecture.md
 * §7.3's "Radio via `<relay>`" row.
 */
import { Link } from "react-router";
import type { SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus, PendingRadioMigration } from "../ws/WsProvider";
import {
  useConnectionStatus,
  useDevices,
  useRadioMigrationOffers,
  useRelays,
  useSendable,
  useUnassigned,
  useWsActions,
} from "../ws/WsProvider";
import { isCalibrationProgram, lastCheckedText, linkStateText, nameDisplay } from "../deviceDisplay";
import { FlashDialog } from "../components/FlashDialog";
import { RelayConnectControls } from "../components/RelayConnectControls";
import "./FrontPage.css";

export function FrontPage() {
  const status = useConnectionStatus();
  const devices = useDevices();
  const unassigned = useUnassigned();
  const relays = useRelays();
  const radioMigrationOffers = useRadioMigrationOffers();
  const { send, resolveRadioMigration } = useWsActions();
  // Ticket 011 (carried from 009's send-gating sweep): read here (the
  // hook-bearing page) and threaded down as a plain prop -- `DevicesList`/
  // `RelayConnectControls` deliberately take no `WsProvider`-dependent
  // hooks of their own (existing tests mount `DevicesList` standalone,
  // with no provider in the tree), matching how `onRelayConnect`/
  // `robotOptions` etc. already reach them.
  const sendable = useSendable();

  const present = devices.filter((device) => device.links.length > 0);
  const notSeenRecently = devices.filter((device) => device.links.length === 0);
  const robotOptions = devices
    .filter((device) => device.kind === "robot")
    .map((device) => device.name)
    .sort((a, b) => a.localeCompare(b));

  return (
    <>
      <RadioMigrationOffers offers={radioMigrationOffers} onResolve={resolveRadioMigration} />
      <DevicesList
        status={status}
        devices={present}
        unassigned={unassigned}
        relays={relays}
        notSeenRecently={notSeenRecently}
        robotOptions={robotOptions}
        sendable={sendable}
        onForgetDevice={(deviceId) => send({ type: "forget-device", deviceId })}
        onRelayConnect={(relayLinkId, name) => send({ type: "session-open", relayLinkId, name })}
        onRelayDisconnect={(linkId) => send({ type: "session-close", linkId })}
      />
    </>
  );
}

/** One dismissible offer per leftover `localStorage` radio override
 * found for a device in the snapshot -- see `WsProvider.tsx`'s own doc
 * comment ("Migration nicety", carried from ticket 006). Rendered above
 * the device list so it's the first thing a returning student with an
 * old browser cache sees, once, and never again once resolved. */
export function RadioMigrationOffers({
  offers,
  onResolve,
}: {
  offers: PendingRadioMigration[];
  onResolve: (deviceId: number, apply: boolean) => void;
}) {
  if (offers.length === 0) {
    return null;
  }
  return (
    <ul className="radio-migration-offers" aria-label="Saved radio addresses found on this browser">
      {offers.map((offer) => (
        <li key={offer.deviceId} className="radio-migration-offer" data-testid={`radio-migration-offer-${offer.deviceId}`} role="status">
          <span>
            Found a saved radio address for {offer.name} (channel {offer.channel}, group {offer.group}) from before this
            computer stored it. Apply it to this device?
          </span>
          <button type="button" onClick={() => onResolve(offer.deviceId, true)}>
            Apply
          </button>
          <button type="button" onClick={() => onResolve(offer.deviceId, false)}>
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface DevicesListProps {
  status: ConnectionStatus;
  /** Devices with at least one current link -- see `FrontPage`'s own
   * split. */
  devices: SnapshotDevice[];
  unassigned: SnapshotLink[];
  relays?: SnapshotRelay[];
  /** Devices the host still knows about (`owned: true`) but with no
   * current link -- rendered as "not seen recently", not folded into
   * the main list. Defaults to `[]` so call sites that don't care don't
   * have to pass it. */
  notSeenRecently?: SnapshotDevice[];
  onForgetDevice?: (deviceId: number) => void;
  /** Names a relay card's own robot picker offers -- every `kind:
   * "robot"` device's name, host order sorted. Defaults to `[]`, which
   * renders the picker disabled with its "no robots known yet"
   * placeholder. */
  robotOptions?: string[];
  /** A relay card's Connect/Switch press. */
  onRelayConnect?: (relayLinkId: string, name: string) => void;
  /** A relay card's Disconnect press for its currently-bridged link. */
  onRelayDisconnect?: (linkId: string) => void;
  /** Whether a send is currently meaningful (`useSendable()`, threaded
   * down as a plain prop -- see `FrontPage`'s own doc comment). Gates
   * the relay quick-connect Connect/Switch button. Defaults to `true`
   * so call sites (and this component's own tests) that don't care
   * about disconnection state are unaffected. */
  sendable?: boolean;
}

export function DevicesList({
  status,
  devices,
  unassigned,
  relays = [],
  notSeenRecently = [],
  onForgetDevice = () => {},
  robotOptions = [],
  onRelayConnect = () => {},
  onRelayDisconnect = () => {},
  sendable = true,
}: DevicesListProps) {
  const empty = devices.length === 0 && unassigned.length === 0;
  return (
    <section className="front-page" aria-label="Devices">
      {status !== "open" && (
        <p className="connection-banner" role="status">
          {status === "connecting"
            ? "Connecting to robot-console…"
            : "Lost connection to robot-console — reconnecting…"}
        </p>
      )}
      {empty ? (
        <p className="devices-empty">No devices detected yet. Plug a micro:bit into a USB port.</p>
      ) : (
        <ul className="devices-list">
          {devices.map((device) => (
            <li key={device.id}>
              <DeviceCard
                device={device}
                devices={devices}
                relays={relays}
                robotOptions={robotOptions}
                onRelayConnect={onRelayConnect}
                onRelayDisconnect={onRelayDisconnect}
                sendable={sendable}
              />
            </li>
          ))}
          {unassigned.map((link) => (
            <li key={link.id}>
              <UnassignedCard link={link} />
            </li>
          ))}
        </ul>
      )}
      {notSeenRecently.length > 0 && (
        <NotSeenRecentlySection devices={notSeenRecently} onForget={onForgetDevice} />
      )}
    </section>
  );
}

/** Which link a device card's main open-arrow should lead to: the one
 * with an open session, else the first link the host reports. This is
 * a display choice over links the host has *already* grouped under one
 * device (unlike the retired `linkScore`, which scored/grouped
 * possibly-different devices across transports itself) -- not a
 * re-implementation of host auto-switch policy. */
function primaryLinkFor(device: SnapshotDevice): SnapshotLink | undefined {
  return device.links.find((link) => link.session !== undefined) ?? device.links[0];
}

/** A short label for one link: the host-built `label` (e.g. "USB ·
 * /dev/tty.usbmodem1234", "Radio · ch41/grp3"), with the relay's own
 * name appended for a `via` link so a student doesn't have to resolve
 * `via.relayLinkId` themselves. */
function connectionLabel(link: SnapshotLink): string {
  return link.via ? `${link.label} (via relay ${link.via.relayName})` : link.label;
}


/** An arrow glyph for the open buttons -- inline SVG so it needs no
 * icon font and inherits `currentColor`. */
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

/** One device's card. Nothing in the informational region navigates:
 * the only way into a link's page is an open-arrow button (the card's
 * primary link on the right; every other link gets its own small arrow
 * in the Connections list), each a real `Link`. A relay device
 * additionally carries the robot picker + Connect/Switch/Disconnect
 * (`RelayConnectControls`, ticket 017-007 -- shared with `RelayPage.tsx`). */
function DeviceCard({
  device,
  devices,
  relays,
  robotOptions,
  onRelayConnect,
  onRelayDisconnect,
  sendable,
}: {
  device: SnapshotDevice;
  devices: SnapshotDevice[];
  relays: SnapshotRelay[];
  robotOptions: string[];
  onRelayConnect: (relayLinkId: string, name: string) => void;
  onRelayDisconnect: (linkId: string) => void;
  sendable: boolean;
}) {
  const primary = primaryLinkFor(device);
  const linked = device.links.some((link) => link.state === "connected");
  const isRelay = device.kind === "relay";
  const isCalibration = isCalibrationProgram(device.program);

  return (
    <div className="device-card" data-testid={`device-card-${device.id}`}>
      <div className="device-card-main">
        <div className="device-card-body">
          <div className="device-card-header">
            <h3 className="device-name">{nameDisplay(device).text}</h3>
            {isCalibration && (
              <span className="device-calibration-badge" data-testid="calibration-badge">
                {device.version ? `Calibration robot · ${device.version}` : "Calibration robot"}
              </span>
            )}
            {linked && <span className="device-linked-pill">Linked</span>}
          </div>

          <dl className="device-fields">
            <div>
              <dt>Role</dt>
              <dd>{device.role ?? "No role announced"}</dd>
            </div>
          </dl>

          <ul className="device-connections" aria-label={`Connections for ${device.name}`}>
            {device.links.map((link) => (
              <li key={link.id} className="device-connection" data-testid={`device-link-${link.id}`}>
                <span className="device-connection-label">{connectionLabel(link)}</span>
                <span className={link.state === "connected" ? "device-connection-state device-connection-open" : "device-connection-state"}>
                  {linkStateText(link)}
                </span>
                {lastCheckedText(device, link) && (
                  <span className="device-connection-last-checked" data-testid={`device-link-lastchecked-${link.id}`}>
                    {lastCheckedText(device, link)}
                  </span>
                )}
                {link !== primary && (
                  <Link
                    to={`/d/${link.id}`}
                    className="device-connection-open-button"
                    aria-label={`Open ${device.name} over ${connectionLabel(link)}`}
                    data-testid={`device-link-open-${link.id}`}
                  >
                    <ArrowIcon direction="forward" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>

        {primary && (
          <Link
            to={`/d/${primary.id}`}
            className="device-open-button"
            aria-label={`Open ${device.name}`}
            title={`Open ${device.name}`}
            data-testid={`device-open-${device.id}`}
          >
            <ArrowIcon direction="forward" />
          </Link>
        )}
      </div>

      {isRelay && (
        <RelayConnectControls
          variant="card"
          relay={device}
          devices={devices}
          relays={relays}
          robotOptions={robotOptions}
          onConnect={onRelayConnect}
          onDisconnect={onRelayDisconnect}
          sendable={sendable}
        />
      )}
    </div>
  );
}

/** A USB board not yet identified to any device
 * (`Snapshot.unassigned[]`) -- its own, simpler card: no name, role, or
 * calibration badge to show yet, just the link's own label and status.
 *
 * **Flash trigger restored (sprint 015 ticket 008)**: the pre-ticket-007
 * front-page card offered a Flash trigger (dialog) whenever `role ===
 * null` -- the direct successor of that state is exactly this card (a
 * board with no `devices` row at all yet), so `FlashDialog` is mounted
 * here, self-gated on `canBeFlashed(link)` exactly as it is on
 * `UnknownDevicePage`. Ticket 007 dropped this pending `FlashDialog`'s
 * own migration off the retired `EndpointListEntry` contract (this
 * ticket's own file scope); it's back now that `FlashDialog` speaks
 * `SnapshotLink`. */
function UnassignedCard({ link }: { link: SnapshotLink }) {
  return (
    <div className="device-card" data-testid={`unassigned-card-${link.id}`}>
      <div className="device-card-main">
        <div className="device-card-body">
          <div className="device-card-header">
            <h3 className="device-name">Unidentified board</h3>
          </div>
          <dl className="device-fields">
            <div>
              <dt>Connection</dt>
              <dd>{link.label}</dd>
            </div>
          </dl>
          <p className="device-connection-state" data-testid={`unassigned-status-${link.id}`}>
            {linkStateText(link)}
          </p>
          <FlashDialog link={link} name={link.label} />
        </div>
        <Link
          to={`/d/${link.id}`}
          className="device-open-button"
          aria-label="Open unidentified board"
          title="Open unidentified board"
          data-testid={`unassigned-open-${link.id}`}
        >
          <ArrowIcon direction="forward" />
        </Link>
      </div>
    </div>
  );
}

/** Devices the host still knows about but has no current link for --
 * "not seen recently", filtered from the same `devices[]` list rather
 * than joined from a separate roster (see this module's own doc
 * comment). Rendered only when non-empty. Deliberately not a
 * `react-router` `Link` -- there is no link to navigate to. */
function NotSeenRecentlySection({
  devices,
  onForget,
}: {
  devices: SnapshotDevice[];
  onForget: (deviceId: number) => void;
}) {
  return (
    <section className="remembered-robots" aria-label="Devices not seen recently">
      <h2 className="remembered-robots-heading">Not seen recently</h2>
      <p className="remembered-robots-hint">
        These devices are known to this host but aren&apos;t reachable right now.
      </p>
      <ul className="remembered-robots-list">
        {devices.map((device) => (
          <li key={device.id}>
            <div className="remembered-robot-card" data-testid={`not-seen-device-${device.id}`}>
              <div className="remembered-robot-header">
                <h3 className="remembered-robot-name">{nameDisplay(device).text}</h3>
              </div>
              <p className="remembered-robot-note">Last seen {new Date(device.lastSeen).toLocaleString()}</p>
              <button
                type="button"
                className="remembered-robot-forget"
                data-testid={`not-seen-forget-${device.id}`}
                onClick={() => onForget(device.id)}
              >
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
