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
 * Per-link status text ("Linked" / "Connecting" / "Couldn't connect: …"
 * / "Not seen since …") is now derived from
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
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus, LinkNotice, PendingRadioMigration } from "../ws/WsProvider";
import {
  useConnectionStatus,
  useDevices,
  useHasWsStore,
  useLinkNotices,
  useRadioMigrationOffers,
  useRelays,
  useSendable,
  useUnassigned,
  useWsActions,
} from "../ws/WsProvider";
import { cardLinks, connectionLabel, isCalibrationProgram, isLinkAnswering, isLinkUsable, lastCheckedText, linkStateText, nameDisplay, programVersionText, roleDisplay } from "../deviceDisplay";
import { TransportIcon, transportShortName } from "../components/TransportIcon";
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
  // Extended scope (team-lead, 2026-09-13), item B: a per-link Connect
  // button on a card with no usable link -- see `DeviceCard`'s own doc
  // comment. Threaded down as a plain prop, matching `onRelayConnect`
  // etc. above.
  const onLinkConnect = (linkId: string) => send({ type: "session-open", linkId });
  // Ticket 011 (carried from 009's send-gating sweep): read here (the
  // hook-bearing page) and threaded down as a plain prop -- `DevicesList`/
  // `RelayConnectControls` deliberately take no `WsProvider`-dependent
  // hooks of their own (existing tests mount `DevicesList` standalone,
  // with no provider in the tree), matching how `onRelayConnect`/
  // `robotOptions` etc. already reach them.
  const sendable = useSendable();
  // Bench defect 010 addendum (2026-09-13), fix item 3: same reasoning --
  // read the whole map once here, threaded down as a plain prop, rather
  // than a per-row hook `DeviceConnectionRow` (nested under `DevicesList`)
  // could never call without a variable number of hooks per render.
  const linkNotices = useLinkNotices();

  // Stakeholder (2026-09-13): "pay attention to things that are
  // connected or disconnected ... put it in a list of things we've seen
  // before, but don't put it on my list of things that are available."
  // A device is listed as available only when it has at least one link
  // that is not `stale` (`cardLinks`); a device whose every link has
  // aged out (unplugged, powered off, no longer advertised) goes to
  // "Not seen recently" instead of a card full of hidden connections.
  const present = devices.filter((device) => cardLinks(device).length > 0);
  // Ticket 017-010 fix (team-lead bench evidence, 2026-09-13): a
  // known-robots.json placeholder that hasn't merged with its real,
  // currently-linked row yet (e.g. `mergeNamePlaceholderIfAny` hasn't
  // run yet, or the merge is defined not to fire -- see
  // `store/placeholderMerge.ts`'s own doc comment) must never be listed
  // here under the same name a device card already shows -- that is
  // exactly the duplicate-`tovez` bench defect ("Not seen recently ·
  // tovez" alongside a real `tovez` card). Filtering by name, not id, is
  // deliberate: the whole point is to hide a *different* device row that
  // merely shares a name with one already on screen.
  const presentNames = new Set(present.map((device) => device.name));
  const notSeenRecently = devices.filter((device) => cardLinks(device).length === 0 && !presentNames.has(device.name));
  // De-duplicated (`Set`) for the same reason (ticket 017-010): an
  // unmerged placeholder sharing a name with a real device must not
  // offer that name twice in the relay picker.
  const robotOptions = Array.from(
    new Set(devices.filter((device) => device.kind === "robot").map((device) => device.name)),
  ).sort((a, b) => a.localeCompare(b));

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
        onLinkConnect={onLinkConnect}
        linkNotices={linkNotices}
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
  /** Extended scope (team-lead, 2026-09-13), item B: a card with no
   * usable link shows a Connect button per link instead of an open
   * arrow -- this is its press, sending exactly `{ type: "session-open",
   * linkId }`. Defaults to a no-op so call sites/tests that don't care
   * are unaffected. */
  onLinkConnect?: (linkId: string) => void;
  /** Whether a send is currently meaningful (`useSendable()`, threaded
   * down as a plain prop -- see `FrontPage`'s own doc comment). Gates
   * the relay quick-connect Connect/Switch button. Defaults to `true`
   * so call sites (and this component's own tests) that don't care
   * about disconnection state are unaffected. */
  sendable?: boolean;
  /** Bench defect 010 addendum (2026-09-13), fix item 3: every pending
   * link-scoped notice, keyed by `linkId` (`useLinkNotices()`, threaded
   * down as a plain prop -- see `FrontPage`'s own doc comment, same
   * reasoning as `sendable`/`onLinkConnect`). Defaults to an empty map
   * so call sites (and this component's own tests) that don't care are
   * unaffected. */
  linkNotices?: ReadonlyMap<string, LinkNotice>;
}

/** Stable empty-map default for {@link DevicesListProps.linkNotices} --
 * avoids allocating a fresh `Map` every render for every call site that
 * does not pass one. */
const EMPTY_LINK_NOTICES: ReadonlyMap<string, LinkNotice> = new Map();

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
  onLinkConnect = () => {},
  sendable = true,
  linkNotices = EMPTY_LINK_NOTICES,
}: DevicesListProps) {
  const empty = devices.length === 0 && unassigned.length === 0;
  const robots = devices.filter((device) => device.kind !== "relay");
  const bridges = devices.filter((device) => device.kind === "relay");
  const renderCard = (device: SnapshotDevice) => (
    <li key={device.id}>
      <DeviceCard
        device={device}
        devices={devices}
        relays={relays}
        robotOptions={robotOptions}
        onRelayConnect={onRelayConnect}
        onRelayDisconnect={onRelayDisconnect}
        onLinkConnect={onLinkConnect}
        sendable={sendable}
        linkNotices={linkNotices}
      />
    </li>
  );
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
        <>
          {/* Stakeholder (2026-09-13): the home page lists things in
              groups -- robots of any sort (however connected, plus
              unidentified boards), then radio bridges, then not seen
              recently. */}
          {(robots.length > 0 || unassigned.length > 0) && (
            <section className="devices-group" aria-label="Robots" data-testid="devices-group-robots">
              <h2 className="devices-group-heading">Robots</h2>
              <ul className="devices-list">
                {robots.map(renderCard)}
                {unassigned.map((link) => (
                  <li key={link.id}>
                    <UnassignedCard link={link} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {bridges.length > 0 && (
            <section className="devices-group" aria-label="Radio bridges" data-testid="devices-group-bridges">
              <h2 className="devices-group-heading">Radio bridges</h2>
              <ul className="devices-list">{bridges.map(renderCard)}</ul>
            </section>
          )}
        </>
      )}
      {notSeenRecently.length > 0 && (
        <NotSeenRecentlySection devices={notSeenRecently} onForget={onForgetDevice} />
      )}
    </section>
  );
}

/** Which link a device card's main open-arrow should lead to: a usable
 * link (see `deviceDisplay.ts`'s `isLinkUsable`), preferring the first
 * one. This is a display choice over links the host has *already*
 * grouped under one device (unlike the retired `linkScore`, which
 * scored/grouped possibly-different devices across transports itself)
 * -- not a re-implementation of host auto-switch policy.
 *
 * **Extended scope (team-lead, 2026-09-13), item B**: before this
 * change, a card with NO usable link still fell back to `links[0]`,
 * producing an open arrow into a device the student could not actually
 * use -- exactly the bench complaint ("How is it letting me go into it
 * if it's not connected?"). Now, a non-relay device with no usable link
 * gets no primary at all (`DeviceCard` renders no open arrow, and a
 * per-link Connect row instead -- see its own doc comment). A relay
 * device keeps the old fallback: its own connectivity link legitimately
 * has no session most of the time (`RelayConnectControls` owns the
 * actual bridge/session lifecycle, not this link directly), so relay
 * cards must keep their existing open arrow and relay controls
 * regardless. */
function primaryLinkFor(device: SnapshotDevice): SnapshotLink | undefined {
  const usable = device.links.find((link) => isLinkUsable(link));
  if (usable) {
    return usable;
  }
  return device.kind === "relay" ? device.links[0] : undefined;
}

/** A link's state qualifying it for the per-link Connect button
 * (extended scope, team-lead 2026-09-13, item B) -- every state a
 * student could plausibly open a session from. Deliberately excludes
 * `connecting` (already in flight); `connected` (a `connected`-but-no-
 * session link is a brief in-between moment, not one to offer a second
 * open for); and `closed_by_user` (the spec's own exact five-state list
 * -- a student who deliberately closed a link is not offered it back
 * from the front page; they can still reopen it from the device page
 * itself). */
const CONNECT_BUTTON_STATES = new Set<SnapshotLink["state"]>([
  "connectable",
  "discovered",
  "failed",
  "stale",
  "unresponsive",
]);


/** A device's current (non-stale) usb link, if it has one -- the gate
 * for the front-page lightning Flash trigger (ticket 018-015). A usb
 * link's `capabilities.flash` is unconditionally true
 * (`projection.ts`'s own comment, "a usb link can always be flashed
 * (unchanged)"), so finding one here is sufficient to know
 * `FlashDialog`'s own `canBeFlashed` gate will pass -- no need to
 * duplicate that check here. */
function currentUsbLink(device: SnapshotDevice): SnapshotLink | undefined {
  return device.links.find((link) => link.transport === "usb" && link.state !== "stale");
}

/** A lightning-bolt glyph for the Flash trigger buttons -- inline SVG,
 * `currentColor` stroke, matching `ArrowIcon`'s/`TransportIcon.tsx`'s
 * own pattern so it needs no icon font. */
function LightningIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <polygon
        points="13 2 4 14 11 14 9 22 20 10 13 10 13 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
 * primary link on the right; every other *usable* link gets its own
 * small arrow in the Connections list), each a real `Link`. A relay
 * device additionally carries the robot picker + Connect/Switch/
 * Disconnect (`RelayConnectControls`, ticket 017-007 -- shared with
 * `RelayPage.tsx`).
 *
 * **Extended scope (team-lead, 2026-09-13), item B**: when
 * `primaryLinkFor` finds no usable link for a non-relay device, this
 * card renders no open arrow at all -- neither the main one nor any
 * per-link one, since none of them lead anywhere the student could
 * actually use right now (the bench complaint this fixes: "How is it
 * letting me go into it if it's not connected?"). Each link row shows
 * its own state text and (when present) its `reason` in plain words,
 * plus a Connect button for any link whose state is one a session could
 * plausibly be opened from ({@link CONNECT_BUTTON_STATES}) -- gated by
 * `sendable` (this card's own `useSendable()`, threaded down as a plain
 * prop like every other send-capable control on this page).
 *
 * **Ticket 017-010 fix (team-lead bench walk, 2026-09-13)**: the
 * per-link arrow's condition was `primary && link !== primary`, which
 * rendered an arrow into *any* non-primary link regardless of that
 * link's own usability -- e.g. a `gopiv` WiFi row showing `Not linked`
 * still got an arrow, because the card's mbserial link was primary and
 * the WiFi link merely wasn't it. The arrow now requires
 * `isLinkUsable(link)` directly, not just "isn't the primary". Likewise
 * the per-link Connect button was gated `!primary && CONNECT_BUTTON_
 * STATES.has(link.state)`, which hid Connect on a connectable link the
 * moment *any other* link on the card became primary -- exactly the
 * gopiv row, which had a usable mbserial primary and so was denied a
 * Connect button on its own separately-connectable WiFi link. Connect
 * is now offered on every link whose own state qualifies, independent
 * of whether some other link on the card is primary. */
function DeviceCard({
  device,
  devices,
  relays,
  robotOptions,
  onRelayConnect,
  onRelayDisconnect,
  onLinkConnect,
  sendable,
  linkNotices,
}: {
  device: SnapshotDevice;
  devices: SnapshotDevice[];
  relays: SnapshotRelay[];
  robotOptions: string[];
  onRelayConnect: (relayLinkId: string, name: string) => void;
  onRelayDisconnect: (linkId: string) => void;
  onLinkConnect: (linkId: string) => void;
  sendable: boolean;
  linkNotices: ReadonlyMap<string, LinkNotice>;
}) {
  const primary = primaryLinkFor(device);
  // Ticket 018-010: "Linked" requires a session that has actually
  // answered, not just `state === "connected"` -- bench defect:
  // `vevov`'s mbserial bridge accepted a TCP connection and flipped its
  // link to `connected` while its own robot never once replied to
  // `HELLO`, and this pill still showed green. See `deviceDisplay.ts`'s
  // `isLinkAnswering` doc comment.
  const linked = device.links.some((link) => isLinkAnswering(link));
  const isRelay = device.kind === "relay";
  const isCalibration = isCalibrationProgram(device.program);
  // Ticket 018-015: "Make the flash button pop up when the device is
  // on USB ... the flash button shows below the open arrow; arrow in
  // the upper corner, flash button lower right." Gated on the device's
  // own current usb link (`currentUsbLink`), independent of `primary`
  // -- a device can be flashable over usb while its primary/open arrow
  // leads over a different transport (or not exist at all). Also
  // gated on `useHasWsStore()` -- see that hook's own doc comment --
  // so a `DeviceCard`-focused test with no `WsProvider` in the tree
  // keeps working exactly as before.
  const usbLink = currentUsbLink(device);
  const hasWsStore = useHasWsStore();

  return (
    <div className="device-card" data-testid={`device-card-${device.id}`}>
      <div className="device-card-main">
        <div className="device-card-body">
          <div className="device-card-header">
            <h3 className="device-name">{nameDisplay(device).text}</h3>
            {isCalibration && (
              <span className="device-calibration-badge" data-testid="calibration-badge">
                {/* Ticket 018-017: the release version comes from
                    `device.program` (e.g. `calibration-0.20260913.1` ->
                    `0.20260913.1`), never `device.version` -- that's the
                    pxt-nezha-diffdrive library version, not the
                    calibration release. Same fix as `roleDisplay`'s. */}
                {device.program !== null ? `Calibration robot · ${programVersionText(device.program)}` : "Calibration robot"}
              </span>
            )}
            {linked && <span className="device-linked-pill">Linked</span>}
          </div>

          <p className="device-role" data-testid={`device-role-${device.id}`}>
            {roleDisplay(device)}
          </p>

          {/* Stakeholder (2026-09-13): "I don't care if there's MB serial
              and radio. I just want to get to the device ... make a
              little card that's got a radio icon / server icon / Wi-Fi
              icon / USB icon. If I hover over the icon, give me a pop-up
              with all the details." One chip per live link; the full
              row (state, reason, last checked, Connect) lives in the
              chip's hover/focus popover. Everything older is on the
              robot page's Diagnostics tab. */}
          <ul className="device-connections" aria-label={`Connections for ${device.name}`}>
            {cardLinks(device).map((link) => (
              <LinkChip
                key={link.id}
                device={device}
                link={link}
                primary={primary}
                sendable={sendable}
                onLinkConnect={onLinkConnect}
                notice={linkNotices.get(link.id)}
              />
            ))}
          </ul>
        </div>

        {(primary || (usbLink && hasWsStore)) && (
          <div className="device-card-side">
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
            {usbLink && hasWsStore && (
              <FlashDialog
                link={usbLink}
                name={device.name}
                triggerIcon={<LightningIcon />}
                triggerClassName="device-flash-button"
              />
            )}
          </div>
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

/** One link row inside a `DeviceCard`'s Connections list -- split out
 * from `DeviceCard` (bench defect 010 addendum, 2026-09-13, fix item 3)
 * for readability; it takes no `WsProvider`-dependent hook of its own
 * (`notice` arrives as a plain prop, `linkNotices.get(link.id)`, computed
 * by its caller) -- `DevicesList`/`DeviceCard` deliberately take none
 * (this file's own doc comment on `sendable`/`robotOptions`), and a hook
 * called once per row inside `device.links.map()` would in any case call
 * a varying number of hooks per `DeviceCard` render, violating the rules
 * of hooks.
 *
 * **Ticket 017-010 defect (team-lead bench walk, 2026-09-13)**: a
 * refused or failed Connect press produced no visible change on the
 * card at all -- `reconciler.ts`'s `requestOpen` returning a
 * `refusedReason` only ever reached the student as a `notice` broadcast
 * (`server.ts`), which the front page never read (only the per-link
 * device console did). This row now shows that notice's text directly
 * underneath its own state line, via `WsProvider.tsx`'s existing
 * link-scoped notice stream (`useLinkNotices`) -- no redesign, the
 * notice disappears again once the link is next reported `connected`
 * (`WsProvider.tsx`'s own `applySnapshot`).
 *
 * **Bench defect (team-lead walk 017-012, 2026-09-13)**: the `torture`
 * relay card showed a row-level Connect button on the relay's own
 * connectivity link. Opening a relay pool's own link is not a student
 * action -- a relay card already gets its robot-picker Connect via
 * `RelayConnectControls` below -- so the Connect button here is
 * suppressed for `device.kind === "relay"` regardless of the link's
 * own state.
 *
 * **Reason shown once (team-lead bench walk, 2026-09-13)**: this row
 * used to also render `link.reason` verbatim in its own span whenever
 * there was no primary link -- but `linkStateText` above it already
 * folds a `failed`/`unresponsive` link's `reason` (plain-worded via
 * `deviceDisplay.ts`'s `plainFailureReason`) straight into the state
 * text, so the raw span duplicated the same sentence a second time,
 * unmapped (the bench-reported `tovez` card: the reason text appearing
 * twice, once with the internal `connector:`/`link "id"` plumbing still
 * attached). That span is gone outright -- `linkStateText` is now the
 * only place a link's reason is ever shown -- and `notice` (a distinct
 * refused-Connect message from `useLinkNotices`, not derived from
 * `link.reason` at all) remains the only *other* thing this row renders
 * below the state line.
 *
 * **Retry countdown ticks (team-lead walk 017-012, 2026-09-13)**: when
 * `linkStateText` does show a "· retrying in Ns" suffix (a genuinely
 * future `nextRetryAt`), it must visibly count down rather than freeze
 * at whatever number the row first rendered with -- a frozen countdown
 * is exactly the "Retrying in 0s" staleness this same bench walk fixed
 * for the past-`nextRetryAt` case, just one render later. `now` is this
 * row's own local re-render clock (not `Date.now()` read fresh on every
 * render, since nothing else re-renders this row once a second on its
 * own): a `setInterval` armed only while `link.nextRetryAt` is set, and
 * self-clearing once that moment has passed, so a link with no pending
 * retry (the common case) never starts a timer at all. */
/** The chip's own state class: linked (answering session), open
 * (connected but not yet answering), busy (connecting), failed, or
 * idle (connectable/discovered/closed). */
function chipState(link: SnapshotLink): "linked" | "open" | "busy" | "failed" | "idle" {
  if (isLinkAnswering(link)) {
    return "linked";
  }
  if (link.state === "connected") {
    return "open";
  }
  if (link.state === "connecting") {
    return "busy";
  }
  if (link.state === "failed" || link.state === "unresponsive") {
    return "failed";
  }
  return "idle";
}

/** One connection chip: transport icon + one short word, with the full
 * `DeviceConnectionRow` in a popover shown on hover or keyboard focus. A
 * usable chip is itself a link into the device over that connection. */
function LinkChip(props: {
  device: SnapshotDevice;
  link: SnapshotLink;
  primary: SnapshotLink | undefined;
  sendable: boolean;
  onLinkConnect: (linkId: string) => void;
  notice: LinkNotice | undefined;
}) {
  const { device, link } = props;
  const state = chipState(link);
  // Stakeholder (2026-09-13): "reduce this down to just the icons and
  // not the name" -- the chip is the icon alone; the short name ("Radio
  // via vevav") is the popover's title and the accessible label.
  const short = link.via ? `${transportShortName(link.transport)} via ${link.via.relayName}` : transportShortName(link.transport);
  const face = <TransportIcon transport={link.transport} size={20} />;
  return (
    <li className="device-chip" data-state={state} data-testid={`device-chip-${link.id}`}>
      {isLinkUsable(link) ? (
        <Link to={`/d/${link.id}`} className="device-chip-face" aria-label={`Open ${device.name} over ${connectionLabel(link)}`}>
          {face}
        </Link>
      ) : (
        <button type="button" className="device-chip-face" aria-label={`${connectionLabel(link)}: ${linkStateText(link, undefined, device.kind)}`}>
          {face}
        </button>
      )}
      <div className="device-chip-popover" role="tooltip">
        <p className="device-chip-popover-title">{short}</p>
        <DeviceConnectionRow {...props} />
      </div>
    </li>
  );
}

function DeviceConnectionRow({
  device,
  link,
  primary,
  sendable,
  onLinkConnect,
  notice,
}: {
  device: SnapshotDevice;
  link: SnapshotLink;
  primary: SnapshotLink | undefined;
  sendable: boolean;
  onLinkConnect: (linkId: string) => void;
  notice: LinkNotice | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const target = link.nextRetryAt;
    if (target === null) {
      return undefined;
    }
    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= target) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [link.nextRetryAt]);

  return (
    <div className="device-connection" data-testid={`device-link-${link.id}`}>
      <span className="device-connection-label">{connectionLabel(link)}</span>
      <span className={link.state === "connected" ? "device-connection-state device-connection-open" : "device-connection-state"}>
        {linkStateText(link, now, device.kind)}
      </span>
      {notice && (
        <span className="device-connection-notice" data-testid={`device-link-notice-${link.id}`} role="status">
          {notice.text}
        </span>
      )}
      {lastCheckedText(device, link) && (
        <span className="device-connection-last-checked" data-testid={`device-link-lastchecked-${link.id}`}>
          {lastCheckedText(device, link)}
        </span>
      )}
      {isLinkUsable(link) && link !== primary && (
        <Link
          to={`/d/${link.id}`}
          className="device-connection-open-button"
          aria-label={`Open ${device.name} over ${connectionLabel(link)}`}
          data-testid={`device-link-open-${link.id}`}
        >
          <ArrowIcon direction="forward" />
        </Link>
      )}
      {device.kind !== "relay" && CONNECT_BUTTON_STATES.has(link.state) && (
        <button
          type="button"
          className="device-connection-connect-button"
          data-testid={`device-link-connect-${link.id}`}
          disabled={!sendable}
          onClick={() => onLinkConnect(link.id)}
        >
          Connect
        </button>
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
          <FlashDialog link={link} name={link.label} triggerIcon={<LightningIcon />} triggerClassName="device-flash-button" />
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
