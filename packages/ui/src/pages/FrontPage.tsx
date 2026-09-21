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
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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

  // Stakeholder (2026-09-13): "pay attention to things that are
  // connected or disconnected ... put it in a list of things we've seen
  // before, but don't put it on my list of things that are available."
  // A device is listed as available only when it has at least one link
  // that is not `stale` (`cardLinks`); a device whose every link has
  // aged out (unplugged, powered off, no longer advertised) goes to
  // "Not seen recently" instead of a card full of hidden connections.
  const presentBeforeHold = devices.filter((device) => cardLinks(device).length > 0);
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
  // Stakeholder, 2026-09-21: "they shouldn't move up to the top as soon
  // as you click the radio button. You should try to make contact
  // first... if it connects and goes green, then you put it in the top
  // section. If you can't connect to it? Leave it down below."
  //
  // Clicking sends `session-open`, and the host answers with a link in
  // `connecting` almost immediately. `cardLinks` counts that, so the
  // card leapt to the Robots section on the click rather than on the
  // contact -- announcing a robot as present before anything had
  // answered, and leaving it stranded up there if nothing ever did.
  //
  // So a device with an attempt outstanding is HELD in this section
  // until one of its links is genuinely usable (`isLinkUsable`: state
  // `connected` AND a live session). That is the same test the radio
  // chip up top uses to call itself linked, so "moves up" and "goes
  // green" become the same event rather than two guesses about it.
  // Both `trying` AND `failed` hold the card here. A failed attempt
  // usually leaves a link behind -- `connecting`, then `failed` -- and
  // `cardLinks` counts those, so without this the card would float up
  // to Robots the moment the attempt gave up: the exact opposite of
  // "if you can't connect to it? Leave it down below." Only a genuinely
  // usable link releases the hold.
  const heldDown = new Set(
    devices
      .filter((device) => radioAttempts[device.id] !== undefined && !device.links.some(isLinkUsable))
      .map((device) => device.id),
  );
  const present = presentBeforeHold.filter((device) => !heldDown.has(device.id));
  const presentNames = new Set(present.map((device) => device.name));
  const notSeenRecently = devices.filter(
    (device) => (cardLinks(device).length === 0 || heldDown.has(device.id)) && !presentNames.has(device.name),
  );
  return (
    <>
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
  const robots = devices.filter((device) => device.kind !== "relay");
  const bridges = devices.filter((device) => device.kind === "relay");
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
            {/* Stakeholder (2026-09-14): the name itself shows link status
                -- yellow while no link answers, green once one does --
                instead of a "Linked" pill popping in and out. A bridge's
                own card has no link of its own to show. */}
            <h3
              className={isRelay ? "device-name" : "device-name device-name-link"}
              data-linked={isRelay ? undefined : String(linked)}
              title={isRelay ? undefined : linked ? "Linked" : "Not linked"}
              data-testid={`device-name-${device.id}`}
            >
              {nameDisplay(device).text}
            </h3>
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
        className="device-chip-face"
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

  return (
    <li className="device-chip device-chip-radio" data-state={state} data-testid={`device-radio-chip-${device.id}`}>
      <button
        type="button"
        className="device-chip-face"
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
  const bridgeLinks = cardLinks(relay).filter((link) => link.transport === "usb" || link.transport === "mbrelay");
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
        className="remembered-robot-radio"
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
                {/* Stakeholder, 2026-09-21: "Last seen" belongs under
                    the name, not beside it. The card is a wrapping flex
                    row, so a sibling `<p>` sat on the name's baseline;
                    moving it inside the header (a column) stacks the two
                    without disturbing the actions, which stay on the
                    card's right edge. */}
                <p className="remembered-robot-note">Last seen {new Date(device.lastSeen).toLocaleString()}</p>
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
                  className="remembered-robot-forget"
                  data-testid={`not-seen-forget-${device.id}`}
                  onClick={() => onForget(device.id)}
                >
                  Forget
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
