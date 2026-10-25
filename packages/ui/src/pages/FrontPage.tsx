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
import { CollapsibleGroup } from "../components/CollapsibleGroup";
import { ForgetDeviceDialog, TrashIcon } from "../components/ForgetDeviceDialog";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import type { ConnectionStatus, LinkNotice, PendingRadioMigration } from "../ws/WsProvider";
import {
  useConnectionStatus,
  useDevices,
  useHasWsStore,
  useLinkNotices,
  useRadioMigrationOffers,
  useSendable,
  useUnassigned,
  useWsActions,
} from "../ws/WsProvider";
import {
  ALL_FLASHABLE_FIRMWARE,
  allocateRadioBridge,
  cardLinks,
  connectionLabel,
  findLink,
  isCalibrationProgram,
  isLinkActive,
  isLinkAnswering,
  isLinkUsable,
  isRadioLink,
  lastCheckedText,
  linkStateText,
  nameDisplay,
  programVersionText,
  radioChildLinkId,
  relayConnections,
  roleDisplay,
} from "../deviceDisplay";
import { TransportIcon, transportShortName } from "../components/TransportIcon";
import { Icon } from "../components/Icon";
import { deviceStatus, frontPageGroups, linkStatus, primaryLinkFor, statusTitle, statusWord, type Status } from "../status";
import { FlashDialog } from "../components/FlashDialog";
import "./FrontPage.css";

export function FrontPage() {
  const status = useConnectionStatus();
  const devices = useDevices();
  const unassigned = useUnassigned();
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

  /** Radio attempts started from a "Not seen recently" card, by device
   * id. `trying` holds the card down here until contact is made;
   * `failed` leaves it down with an explanation. Lives at this level,
   * not in the button, because the section a device belongs to is
   * decided here -- the button cannot both be inside the card and
   * decide whether the card exists. */
  const [radioAttempts, setRadioAttempts] = useState<Record<number, { state: "trying" | "failed"; message?: string }>>({});

  // Contact made: drop the hold so the device takes its place up top.
  // Keyed off the snapshot rather than off an ack, so it is the same
  // fact the rest of the page is already rendering from.
  useEffect(() => {
    const arrived = devices.filter(
      (device) => radioAttempts[device.id]?.state === "trying" && device.links.some(isLinkUsable),
    );
    if (arrived.length === 0) return;
    setRadioAttempts((previous) => {
      const next = { ...previous };
      for (const device of arrived) {
        delete next[device.id];
      }
      return next;
    });
  }, [devices, radioAttempts]);

  // A radio attempt holds its device in Not seen recently until a link is
  // genuinely usable: it moves up when it goes green, not when clicked.
  const heldDown = new Set(
    devices
      .filter((device) => radioAttempts[device.id] !== undefined && !device.links.some(isLinkUsable))
      .map((device) => device.id),
  );
  const { present, notSeenRecently, robots } = frontPageGroups(devices, heldDown);
  useScrollToHash();
  const linkedCount = present.filter((device) => deviceStatus(device) === "linked").length;
  return (
    <>
      <div className="front-page-head">
        <h1>Devices</h1>
        <p className="front-page-summary">
          {robots.length} {robots.length === 1 ? "robot" : "robots"} · {linkedCount} linked · {notSeenRecently.length} not seen recently
        </p>
      </div>
      <RadioMigrationOffers offers={radioMigrationOffers} onResolve={resolveRadioMigration} />
      <DevicesList
        status={status}
        devices={present}
        unassigned={unassigned}
        notSeenRecently={notSeenRecently}
        sendable={sendable}
        onForgetDevice={(deviceId) => send({ type: "forget-device", deviceId })}
        onRadioConnect={(relayLinkId, name) => send({ type: "session-open", relayLinkId, name })}
        radioAttempts={radioAttempts}
        onRadioAttempt={(deviceId, attempt) =>
          setRadioAttempts((previous) => {
            if (attempt === null) {
              const next = { ...previous };
              delete next[deviceId];
              return next;
            }
            return { ...previous, [deviceId]: attempt };
          })
        }
        onLinkClose={(linkId) => send({ type: "session-close", linkId })}
        onLinkConnect={onLinkConnect}
        linkNotices={linkNotices}
      />
    </>
  );
}

/** Scrolls the element named by the URL hash into view (the sidebar's
 * bench rows and Browse links), opening the collapsed group it sits in. */
function useScrollToHash(): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!target) return;
    const hidden = target.closest<HTMLElement>(".devices-group-content[hidden]");
    if (hidden) {
      document.querySelector<HTMLButtonElement>(`[aria-controls="${hidden.id}"]`)?.click();
    }
    target.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [hash]);
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
  /** Devices the host still knows about (`owned: true`) but with no
   * current link -- rendered as "not seen recently", not folded into
   * the main list. Defaults to `[]` so call sites that don't care don't
   * have to pass it. */
  notSeenRecently?: SnapshotDevice[];
  onForgetDevice?: (deviceId: number) => void;
  /** A robot's radio chip press: bridge the robot named `name` through
   * the radio bridge `allocateRadioBridge` picked. */
  onRadioConnect?: (relayLinkId: string, name: string) => void;
  /** A connection chip's press on a link that is on: close it. */
  onLinkClose?: (linkId: string) => void;
  /** A connection chip's press on a link that is off: open it, sending
   * exactly `{ type: "session-open", linkId }`. Defaults to a no-op so
   * call sites/tests that don't care are unaffected. */
  onLinkConnect?: (linkId: string) => void;
  /** Whether a send is currently meaningful (`useSendable()`, threaded
   * down as a plain prop -- see `FrontPage`'s own doc comment). Gates
   * every connection chip's toggle. Defaults to `true`
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
  /** Outstanding/failed radio attempts from "Not seen recently" cards,
   * by device id -- owned by {@link FrontPage}, which needs them to
   * decide which section a device belongs to. Defaults to empty. */
  radioAttempts?: Record<number, { state: "trying" | "failed"; message?: string }>;
  /** Report an attempt starting, failing, or being abandoned. */
  onRadioAttempt?: (deviceId: number, attempt: { state: "trying" | "failed"; message?: string } | null) => void;
}

/** Stable empty-map default for {@link DevicesListProps.linkNotices} --
 * avoids allocating a fresh `Map` every render for every call site that
 * does not pass one. */
const EMPTY_LINK_NOTICES: ReadonlyMap<string, LinkNotice> = new Map();

/** Stable empty default for {@link DevicesListProps.radioAttempts},
 * same reasoning as {@link EMPTY_LINK_NOTICES}. */
const EMPTY_RADIO_ATTEMPTS: Record<number, { state: "trying" | "failed"; message?: string }> = {};

export function DevicesList({
  status,
  devices,
  unassigned,
  notSeenRecently = [],
  onForgetDevice = () => {},
  onRadioConnect = () => {},
  onLinkClose = () => {},
  onLinkConnect = () => {},
  sendable = true,
  linkNotices = EMPTY_LINK_NOTICES,
  radioAttempts = EMPTY_RADIO_ATTEMPTS,
  onRadioAttempt = () => {},
}: DevicesListProps) {
  const empty = devices.length === 0 && unassigned.length === 0;
  // 2026-09-21: joysticks get their own group. `robots` was written as
  // "not a relay", which quietly swept every future kind into the Robots
  // list -- a joystick would have appeared there, under a heading that
  // is wrong about what it is. Each group now names the kind it wants,
  // so the next kind added is missing from the page (visible, fixable)
  // rather than silently mislabelled (invisible).
  const robots = devices.filter((device) => device.kind === "robot");
  const bridges = devices.filter((device) => device.kind === "relay");
  const joysticks = devices.filter((device) => device.kind === "joystick");
  const renderCard = (device: SnapshotDevice) => (
    <li key={device.id}>
      <DeviceCard
        device={device}
        devices={devices}
        onRadioConnect={onRadioConnect}
        onLinkClose={onLinkClose}
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
        <p className="devices-empty lg-empty">No devices detected yet. Plug a micro:bit into a USB port.</p>
      ) : (
        <>
          {/* Stakeholder (2026-09-13): the home page lists things in
              groups -- robots of any sort (however connected, plus
              unidentified boards), then radio bridges, then not seen
              recently. */}
          {robots.length > 0 && (
            <section className="devices-group" id="group-robots" aria-label="Robots" data-testid="devices-group-robots">
              <h2 className="devices-group-heading">Robots</h2>
              <ul className="devices-list lg-cards">{robots.map(renderCard)}</ul>
            </section>
          )}
          {/* Boards plugged into this computer that are not a robot, a
              radio bridge or a joystick -- blank, or running something
              else. Listed so they can be flashed. */}
          {unassigned.length > 0 && (
            <section className="devices-group" id="group-unknown" aria-label="Unknown" data-testid="devices-group-unknown">
              <h2 className="devices-group-heading">Unknown</h2>
              <p className="remembered-robots-hint">
                Plugged into this computer, but not a robot, radio bridge or joystick. Flash one to make it one.
              </p>
              <ul className="devices-list lg-cards">
                {unassigned.map((link) => (
                  <li key={link.id}>
                    <UnassignedCard link={link} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {bridges.length > 0 && (
            <CollapsibleGroup id="bridges" title="Radio bridges" count={bridges.length}>
              <ul className="devices-list lg-cards">{bridges.map(renderCard)}</ul>
            </CollapsibleGroup>
          )}
          {/* Stakeholder, 2026-09-21: "There should be a joystick
              section. It should go into joysticks." Below the robots and
              bridges a student is usually here for, above "not seen
              recently", and rendered with the same card as everything
              else -- a joystick is a device on this bench like any
              other, not a special case. */}
          {joysticks.length > 0 && (
            <CollapsibleGroup id="joysticks" title="Joysticks" count={joysticks.length}>
              <ul className="devices-list lg-cards">{joysticks.map(renderCard)}</ul>
            </CollapsibleGroup>
          )}
        </>
      )}
      {notSeenRecently.length > 0 && (
        <NotSeenRecentlySection
          devices={notSeenRecently}
          onForget={onForgetDevice}
          // The bridges live among the *present* devices, not among the
          // not-seen ones, so `allocateRadioBridge` has to be handed the
          // list that actually contains relays.
          bridgeCandidates={devices}
          sendable={sendable}
          onRadioConnect={onRadioConnect}
          attempts={radioAttempts}
          onAttempt={onRadioAttempt}
        />
      )}
    </section>
  );
}

/** A device's current (non-stale) usb or mbregistry link, if it has one
 * -- the gate for the front-page lightning Flash trigger (ticket
 * 018-015; widened to `mbregistry` in sprint 018). Both transports'
 * `capabilities.flash` are unconditionally true (`projection.ts`'s own
 * comment), so finding one here is sufficient to know `FlashDialog`'s
 * own `canBeFlashed` gate will pass -- no need to duplicate that check
 * here. */
function currentUsbLink(device: SnapshotDevice): SnapshotLink | undefined {
  return device.links.find((link) => (link.transport === "usb" || link.transport === "mbregistry") && link.state !== "stale");
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
  onRadioConnect,
  onLinkClose,
  onLinkConnect,
  sendable,
  linkNotices,
}: {
  device: SnapshotDevice;
  devices: SnapshotDevice[];
  onRadioConnect: (relayLinkId: string, name: string) => void;
  onLinkClose: (linkId: string) => void;
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
  const status = deviceStatus(device);
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
    <div className="device-card lg-card" id={`device-${device.id}`} data-testid={`device-card-${device.id}`}>
      <div className="device-card-main">
        <div className="device-card-body lg-card__body">
          <div className="device-card-header lg-card__head">
            {/* Stakeholder (2026-09-14): the name itself shows link status
                -- yellow while no link answers, green once one does --
                instead of a "Linked" pill popping in and out. A bridge's
                own card has no link of its own to show. */}
            <h3
              className="device-name lg-name"
              data-linked={isRelay ? undefined : String(linked)}
              data-status={status}
              title={`${device.name}: ${statusWord(status)}`}
              data-testid={`device-name-${device.id}`}
            >
              {nameDisplay(device).text}
            </h3>
            {isCalibration && (
              <span className="device-calibration-badge lg-badge" data-testid="calibration-badge">
                {/* Ticket 018-017: the release version comes from
                    `device.program` (e.g. `calibration-0.20260913.1` ->
                    `0.20260913.1`), never `device.version` -- that's the
                    pxt-nezha-diffdrive library version, not the
                    calibration release. Same fix as `roleDisplay`'s. */}
                {device.program !== null ? `Calibration robot · ${programVersionText(device.program)}` : "Calibration robot"}
              </span>
            )}
          </div>

          <p className="device-role lg-meta" data-testid={`device-role-${device.id}`}>
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
          <ul className="device-connections lg-chips" aria-label={`Connections for ${device.name}`}>
            {/* Stakeholder (2026-09-14): a robot's radio links fold into
                one always-present radio chip, which finds a bridge
                itself; a bridge's own card still lists its own link. */}
            {cardLinks(device)
              .filter((link) => isRelay || !isRadioLink(link))
              .map((link) => (
                <LinkChip
                  key={link.id}
                  device={device}
                  link={link}
                  sendable={sendable}
                  onLinkConnect={onLinkConnect}
                  onLinkClose={onLinkClose}
                  notice={linkNotices.get(link.id)}
                />
              ))}
            {!isRelay && (
              <RadioChip
                device={device}
                devices={devices}
                sendable={sendable}
                onRadioConnect={onRadioConnect}
                onLinkClose={onLinkClose}
                linkNotices={linkNotices}
              />
            )}
          </ul>
        </div>

        {(primary || (usbLink && hasWsStore)) && (
          <div className="device-card-side lg-card__side">
            {primary && (
              <Link
                to={`/d/${primary.id}`}
                className="device-open-button lg-round lg-round--open"
                aria-label={`Open ${device.name}`}
                title={`Open ${device.name}`}
                data-testid={`device-open-${device.id}`}
              >
                <Icon name="arrow-right" size={22} />
              </Link>
            )}
            {usbLink && hasWsStore && (
              // Sprint 023 ticket 005: the front page's own device card
              // is a "permissive" surface (sprint.md's Design Rationale,
              // Decision 2/SUC-001) -- a widening from the pre-023
              // two-button behavior, per the stakeholder's own stated
              // front-page list (relay, robot, joystick, local hex).
              // This is distinct from `AppHeader.tsx`'s device-page
              // Flash button, which narrows to the routed device's own
              // kind (ticket 006).
              <FlashDialog
                link={usbLink}
                name={device.name}
                triggerIcon={<Icon name="bolt" />}
                triggerClassName="device-flash-button lg-round"
                allowedFirmware={ALL_FLASHABLE_FIRMWARE}
                allowLocalHex={true}
              />
            )}
          </div>
        )}
        {/* A card with neither an arrow nor a Flash control offers Forget
            in the arrow's place, so a robot nothing can reach right now
            can still be removed. */}
        {!primary && !usbLink && hasWsStore && (
          <div className="device-card-side lg-card__side">
            <ForgetDeviceDialog
              deviceId={device.id}
              name={device.name}
              triggerIcon={<TrashIcon />}
              triggerClassName="device-open-button lg-round lg-round--forget"
            />
          </div>
        )}
      </div>

      {isRelay && <RelayBridgeStatus relay={device} devices={devices} />}
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

/** One connection chip: the transport icon, with the full
 * `DeviceConnectionRow` in a popover shown on hover or keyboard focus.
 *
 * Stakeholder (2026-09-14): the chip is an on/off toggle -- pressing a
 * link that is on (a session, or connected) closes it; pressing any other
 * opens it; a press mid-connect does nothing. Only the card's arrow goes
 * into the robot. A relay's own chips toggle nothing: a bridge is used
 * from a robot's radio chip ({@link RadioChip}), never opened itself. */
function LinkChip({
  device,
  link,
  sendable,
  onLinkConnect,
  onLinkClose,
  notice,
}: {
  device: SnapshotDevice;
  link: SnapshotLink;
  sendable: boolean;
  onLinkConnect: (linkId: string) => void;
  onLinkClose: (linkId: string) => void;
  notice: LinkNotice | undefined;
}) {
  const state = chipState(link);
  const lgStatus = linkStatus(link, device.kind);
  // Stakeholder (2026-09-13): "reduce this down to just the icons and
  // not the name" -- the chip is the icon alone; the short name ("Radio
  // via vevav") is the popover's title and the accessible label.
  const short = link.via ? `${transportShortName(link.transport)} via ${link.via.relayName}` : transportShortName(link.transport);
  const toggleable = device.kind !== "relay";
  const on = link.session !== undefined || link.state === "connected";
  const verb = link.state === "connecting" ? "Connecting" : on ? "Disconnect" : "Connect";
  const label = toggleable
    ? `${verb} ${device.name} over ${connectionLabel(link)}`
    : `${connectionLabel(link)}: ${linkStateText(link, undefined, device.kind)}`;

  function handleClick(): void {
    if (!toggleable || !sendable || link.state === "connecting") {
      return;
    }
    if (on) {
      onLinkClose(link.id);
    } else {
      onLinkConnect(link.id);
    }
  }

  return (
    <li className="device-chip" data-state={state} data-testid={`device-chip-${link.id}`}>
      <button
        type="button"
        className="device-chip-face lg-chip"
        data-status={lgStatus}
        title={statusTitle(short, lgStatus, link)}
        aria-label={label}
        aria-disabled={!toggleable || !sendable}
        data-testid={`device-chip-toggle-${link.id}`}
        onClick={handleClick}
      >
        <TransportIcon transport={link.transport} size={20} />
      </button>
      <div className="device-chip-popover" role="tooltip">
        <p className="device-chip-popover-title">{short}</p>
        <DeviceConnectionRow device={device} link={link} notice={notice} />
      </div>
    </li>
  );
}

/** How long a radio chip flashes red after a connect that could not
 * happen, before settling back to yellow. */
const RADIO_FLASH_MS = 1200;

/** A radio connect neither connected nor failed after this long is given
 * up on (flashes red) -- well past a bridge's own reset, sync, and
 * identify budget. */
const RADIO_CONNECT_GIVE_UP_MS = 60_000;

/** The radio connect a {@link RadioChip} press started and is waiting on. */
interface PendingRadioConnect {
  childLinkId: string;
  /** The child link's `since` at press time (`null` if it did not exist
   * yet): a `failed` state only counts once the link has moved past it,
   * so an old failure is never mistaken for this attempt's. */
  since: number | null;
  /** The child link's notice at press time: a different one is the
   * host refusing this attempt. */
  notice: LinkNotice | undefined;
}

/**
 * The radio chip every robot card carries (stakeholder, 2026-09-14),
 * whether or not any radio link exists yet:
 *
 * - **yellow** (`idle`): no radio bridge carries this robot. Pressing it
 *   allocates one (`allocateRadioBridge`: a free USB radio bridge first,
 *   then an mbrelay pool) and sends `session-open {relayLinkId, name}`.
 * - **dashed** (`busy`) while that connect is in flight.
 * - **green** (`linked`) once the bridged link is usable. Pressing it
 *   closes that link, back to yellow.
 * - **red flash** (`flash`) when no bridge is free, the host refuses, the
 *   bridge fails, or nothing settles within {@link
 *   RADIO_CONNECT_GIVE_UP_MS} -- then back to yellow, with the reason
 *   left in the popover.
 */
function RadioChip({
  device,
  devices,
  sendable,
  onRadioConnect,
  onLinkClose,
  linkNotices,
}: {
  device: SnapshotDevice;
  devices: SnapshotDevice[];
  sendable: boolean;
  onRadioConnect: (relayLinkId: string, name: string) => void;
  onLinkClose: (linkId: string) => void;
  linkNotices: ReadonlyMap<string, LinkNotice>;
}) {
  const radioLinks = cardLinks(device).filter(isRadioLink);
  const active = radioLinks.find((link) => isLinkUsable(link)) ?? radioLinks.find((link) => isLinkActive(link));
  const [pending, setPending] = useState<PendingRadioConnect | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  function fail(reason: string): void {
    setPending(null);
    setProblem(reason);
    setFlashing(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashing(false), RADIO_FLASH_MS);
  }

  const childLink = pending ? findLink(devices, pending.childLinkId) : undefined;
  const childNotice = pending ? linkNotices.get(pending.childLinkId) : undefined;
  useEffect(() => {
    if (!pending) {
      return;
    }
    if (childLink && isLinkUsable(childLink)) {
      setPending(null);
      return;
    }
    if (childNotice !== undefined && childNotice !== pending.notice) {
      fail(childNotice.text);
      return;
    }
    if (childLink && (childLink.state === "failed" || childLink.state === "unresponsive") && childLink.since !== pending.since) {
      fail(linkStateText(childLink, Date.now(), device.kind));
    }
  }, [pending, childLink, childNotice]);

  useEffect(() => {
    if (!pending) {
      return undefined;
    }
    const timer = setTimeout(() => fail("Couldn't connect: no answer through the radio bridge"), RADIO_CONNECT_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  function handleClick(): void {
    if (!sendable || pending !== null || flashing) {
      return;
    }
    if (active) {
      if (active.state !== "connecting") {
        onLinkClose(active.id);
      }
      return;
    }
    const relayLinkId = allocateRadioBridge(devices);
    if (relayLinkId === undefined) {
      fail("Couldn't connect: no radio bridge is free");
      return;
    }
    const childLinkId = radioChildLinkId(device.name, relayLinkId);
    setProblem(null);
    setPending({ childLinkId, since: findLink(devices, childLinkId)?.since ?? null, notice: linkNotices.get(childLinkId) });
    onRadioConnect(relayLinkId, device.name);
  }

  const state = flashing
    ? "flash"
    : active && isLinkUsable(active)
      ? "linked"
      : pending !== null || active?.state === "connecting"
        ? "busy"
        : active
          ? "failed"
          : "idle";
  const detail = active
    ? linkStateText(active, undefined, device.kind)
    : pending
      ? "Connecting through a radio bridge…"
      : (problem ?? "Not linked · press to connect through a free radio bridge");
  const verb = state === "linked" || state === "failed" ? "Disconnect" : state === "busy" ? "Connecting" : "Connect";
  const lgStatus: Status = flashing
    ? "error"
    : active
      ? linkStatus(active, device.kind)
      : pending === null && allocateRadioBridge(devices) === undefined
        ? "absent"
        : "idle";

  return (
    <li className="device-chip device-chip-radio" data-state={state} data-testid={`device-radio-chip-${device.id}`}>
      <button
        type="button"
        className="device-chip-face lg-chip"
        data-status={lgStatus}
        title={statusTitle("Radio", lgStatus, active)}
        aria-label={`${verb} ${device.name} over radio`}
        aria-disabled={!sendable}
        data-testid={`device-radio-toggle-${device.id}`}
        onClick={handleClick}
      >
        <TransportIcon transport="radio" size={20} />
      </button>
      <div className="device-chip-popover" role="tooltip">
        <p className="device-chip-popover-title">{active?.via ? `Radio via ${active.via.relayName}` : "Radio"}</p>
        <div className="device-connection">
          {active && <span className="device-connection-label">{connectionLabel(active)}</span>}
          <span className="device-connection-state" data-testid={`device-radio-state-${device.id}`}>
            {detail}
          </span>
        </div>
      </div>
    </li>
  );
}

/** One robot's line on a radio bridge card. */
function relayConnectionText(device: SnapshotDevice, link: SnapshotLink): string {
  if (isLinkUsable(link)) {
    return `Connected to ${device.name}`;
  }
  if (link.state === "connecting") {
    return `Connecting to ${device.name}…`;
  }
  return `${device.name} stopped answering`;
}

/**
 * The bottom of a radio bridge's card (stakeholder, 2026-09-14): what the
 * bridge carries right now, replacing the old robot picker -- connections
 * are made from a robot's radio chip, never here.
 *
 * - A directly-attached USB radio bridge carries one robot: "Unconnected"
 *   or "Connected to `<robot>`".
 * - An mbrelay pool is shared with other consoles, so it shows nothing
 *   while this console has no robot on it, and one line per robot this
 *   console has bridged through it otherwise.
 */
function RelayBridgeStatus({ relay, devices }: { relay: SnapshotDevice; devices: SnapshotDevice[] }) {
  const bridgeLinks = cardLinks(relay).filter(
    (link) => link.transport === "usb" || link.transport === "mbrelay" || link.transport === "mbregistry",
  );
  const pool = bridgeLinks.some((link) => link.transport === "mbrelay");
  const connections = bridgeLinks.flatMap((link) => relayConnections(devices, link.id));
  if (pool && connections.length === 0) {
    return null;
  }
  return (
    <ul className="device-relay-connections" data-testid={`relay-connections-${relay.id}`}>
      {connections.length === 0 ? (
        <li className="device-relay-unconnected">Unconnected</li>
      ) : (
        connections.map(({ device, link }) => (
          <li key={link.id} data-state={chipState(link)}>
            {relayConnectionText(device, link)}
          </li>
        ))
      )}
    </ul>
  );
}

function DeviceConnectionRow({
  device,
  link,
  notice,
}: {
  device: SnapshotDevice;
  link: SnapshotLink;
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
      {link.session?.origin === "mcp" && (
        // Sprint 019 ticket 005 (SUC-005): an MCP-opened session shows up
        // here exactly the way a browser-opened one already shows on
        // this same row -- the stakeholder's own original ask for the
        // whole MCP feature ("it shows up in the robot console"), not a
        // gate of any kind. `caller` is the MCP client's own declared
        // `clientInfo.name`; absent only if that client omitted one.
        <span className="device-connection-agent" data-testid={`device-link-agent-${link.id}`}>
          Agent: {link.session.caller ?? "unknown"}
        </span>
      )}
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
    <div className="device-card lg-card device-card-local" id={`link-${link.id}`} data-testid={`unassigned-card-${link.id}`}>
      <div className="device-card-main">
        <div className="device-card-body lg-card__body">
          <div className="device-card-header lg-card__head">
            <h3 className="device-name lg-name" data-status="linked">
              Unknown board
            </h3>
          </div>

          <p className="device-role lg-meta" data-testid={`unassigned-role-${link.id}`}>
            {link.label}
          </p>

          {/* The board is only listed because it is plugged in, so its one
              connection is always live: a green chip that cannot be
              switched off, unlike a robot's. */}
          <ul className="device-connections lg-chips" aria-label="Connection">
            <li className="device-chip" data-state="linked" data-testid={`unassigned-chip-${link.id}`}>
              <span
                className="device-chip-face lg-chip"
                data-status="linked"
                role="img"
                aria-label={`Plugged into this computer: ${link.label}`}
                title={`${transportShortName(link.transport)}: connected`}
              >
                <TransportIcon transport={link.transport} size={20} />
              </span>
            </li>
          </ul>
        </div>

        {/* Nothing to open on a board with no firmware, so the Flash
            control takes the open arrow's place at the top. */}
        <div className="device-card-side lg-card__side">
          <FlashDialog
            link={link}
            name={link.label}
            triggerIcon={<Icon name="bolt" />}
            triggerClassName="device-flash-button lg-round"
            allowedFirmware={ALL_FLASHABLE_FIRMWARE}
            allowLocalHex={true}
          />
        </div>
      </div>
    </div>
  );
}

/** Devices the host still knows about but has no current link for --
 * "not seen recently", filtered from the same `devices[]` list rather
 * than joined from a separate roster (see this module's own doc
 * comment). Rendered only when non-empty. Deliberately not a
 * `react-router` `Link` -- there is no link to navigate to. */
/**
 * "Radio" beside Forget on a not-seen-recently card — try to reach this
 * robot over a radio bridge right now (stakeholder, 2026-09-21: "the
 * radio button in Not seen recently is going to try to make radio
 * contact with that robot, and if it succeeds, then it moves it up to
 * the top").
 *
 * ## Why there is no success path in here
 *
 * Because there does not need to be one, and writing one would be a
 * second source of truth. A device is listed here purely because
 * `cardLinks(device).length === 0` — it has no live link. The moment a
 * radio connect lands, the host's next snapshot gives it one, it stops
 * matching that filter, and it is rendered as an ordinary card up top
 * instead. "Moves it up to the top" is what the existing split already
 * does; this button only has to make the attempt.
 *
 * So this component tracks exactly one thing the snapshot cannot tell
 * it: that an attempt is outstanding, and that it has been outstanding
 * too long. Failure is reported here; success is reported by the card
 * simply disappearing from this section.
 */
function NotSeenRadioButton({
  device,
  bridgeCandidates,
  sendable,
  onRadioConnect,
  attempt,
  onAttempt,
}: {
  device: SnapshotDevice;
  bridgeCandidates: SnapshotDevice[];
  sendable: boolean;
  onRadioConnect: (relayLinkId: string, name: string) => void;
  attempt: { state: "trying" | "failed"; message?: string } | undefined;
  onAttempt: (deviceId: number, attempt: { state: "trying" | "failed"; message?: string } | null) => void;
}) {
  const trying = attempt?.state === "trying";
  const problem = attempt?.state === "failed" ? (attempt.message ?? null) : null;
  const deviceId = device.id;

  // Same give-up budget the robot cards' own radio chip uses, for the
  // same reason: a bridge that never answers must not leave "Trying…"
  // on screen forever. (The calibration panel learned this the hard
  // way on 2026-09-20 — a wait with no end is indistinguishable from a
  // hang.) On success this component is unmounted with the card before
  // the timer matters.
  useEffect(() => {
    if (!trying) return undefined;
    const timer = setTimeout(() => {
      onAttempt(deviceId, { state: "failed", message: "No answer over radio" });
    }, RADIO_CONNECT_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [trying, deviceId, onAttempt]);

  function handleClick(): void {
    if (!sendable || trying) return;
    const relayLinkId = allocateRadioBridge(bridgeCandidates);
    if (relayLinkId === undefined) {
      onAttempt(deviceId, { state: "failed", message: "No radio bridge is free" });
      return;
    }
    onAttempt(deviceId, { state: "trying" });
    onRadioConnect(relayLinkId, device.name);
  }

  return (
    <>
      {/* The same radio symbol the robot cards up top use for their own
          radio chip (`TransportIcon transport="radio"`), not a button
          reading "Radio" -- stakeholder, 2026-09-21. It is the same
          action on the same kind of thing, so it gets the same symbol;
          a word here would read as a different feature.

          Round and chip-shaped like those, but white rather than
          coloured: up there the chip's fill reports a live state, and
          nothing here is live yet. `aria-label` carries what the icon
          says silently, since there is no text to read. */}
      <button
        type="button"
        className="remembered-robot-radio lg-chip"
        data-status={trying ? "idle" : "absent"}
        title={trying ? "Radio: connecting" : "Radio: not reachable now"}
        data-testid={`not-seen-radio-${device.id}`}
        data-state={trying ? "busy" : "idle"}
        aria-label={trying ? `Trying ${device.name} over radio…` : `Try ${device.name} over radio`}
        aria-disabled={!sendable || trying}
        onClick={handleClick}
      >
        <TransportIcon transport="radio" size={20} />
      </button>
      {(trying || problem !== null) && (
        <span className="remembered-robot-problem" role="status" data-testid={`not-seen-radio-problem-${device.id}`}>
          {trying ? "Trying…" : problem}
        </span>
      )}
    </>
  );
}

function NotSeenRecentlySection({
  devices,
  onForget,
  bridgeCandidates,
  sendable,
  onRadioConnect,
  attempts,
  onAttempt,
}: {
  devices: SnapshotDevice[];
  onForget: (deviceId: number) => void;
  bridgeCandidates: SnapshotDevice[];
  sendable: boolean;
  onRadioConnect: (relayLinkId: string, name: string) => void;
  attempts: Record<number, { state: "trying" | "failed"; message?: string }>;
  onAttempt: (deviceId: number, attempt: { state: "trying" | "failed"; message?: string } | null) => void;
}) {
  return (
    <CollapsibleGroup
      id="not-seen"
      title="Not seen recently"
      count={devices.length}
      className="remembered-robots"
      ariaLabel="Devices not seen recently"
      hint={
        <p className="remembered-robots-hint">
          These devices are known to this host but aren&apos;t reachable right now.
        </p>
      }
    >
      <ul className="remembered-robots-list lg-cards">
        {devices.map((device) => (
          <li key={device.id}>
            <div className="remembered-robot-card lg-card" id={`device-${device.id}`} data-testid={`not-seen-device-${device.id}`}>
              <div className="remembered-robot-header lg-card__body">
                <h3 className="remembered-robot-name lg-name" data-status="absent" title={`${device.name}: not reachable now`}>
                  {nameDisplay(device).text}
                </h3>
                {/* Stakeholder, 2026-09-21: "Last seen" belongs under
                    the name, not beside it. The card is a wrapping flex
                    row, so a sibling `<p>` sat on the name's baseline;
                    moving it inside the header (a column) stacks the two
                    without disturbing the actions, which stay on the
                    card's right edge. */}
                <p className="remembered-robot-note lg-meta">Last seen {new Date(device.lastSeen).toLocaleString()}</p>
              </div>
              <div className="remembered-robot-actions">
                <NotSeenRadioButton
                  device={device}
                  bridgeCandidates={bridgeCandidates}
                  sendable={sendable}
                  onRadioConnect={onRadioConnect}
                  attempt={attempts[device.id]}
                  onAttempt={onAttempt}
                />
                <button
                  type="button"
                  className="remembered-robot-forget lg-round lg-round--forget"
                  data-testid={`not-seen-forget-${device.id}`}
                  aria-label={`Forget ${device.name}`}
                  title={`Forget ${device.name}`}
                  onClick={() => onForget(device.id)}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </CollapsibleGroup>
  );
}
