/**
 * RelayPage.tsx — `/d/:linkId` for a `kind: "relay"` device (sprint 015
 * ticket 008; SUC-003, SUC-004, SUC-005, SUC-006, SUC-009; issue
 * `rearch-07-ui-renders-snapshot-drops-client-policy.md`).
 *
 * ## Rewritten against `relays[]`/`links[]` in the snapshot -- no more
 * `-via-` id parsing
 *
 * The pre-rearch version scanned `useEndpoints()` for a synthesized
 * `"<relayEndpointId>-via-<robotName>"` id to find the relay's current
 * child. Under the `Snapshot` contract the host already does that
 * grouping: a bridged robot is an ordinary `SnapshotDevice` somewhere in
 * `devices[]` whose own radio link carries `via.relayLinkId` naming this
 * relay's connectivity link (`device.links[0]`) -- `findRelayChild`
 * below is a plain `Array.find` over that, not id parsing. `relays[]`
 * (`SnapshotRelay`, keyed by the same `relayLinkId`) carries the two
 * states that have no other representation -- `bridging` ("connecting"/
 * "failed", server-side ephemeral state, `server.ts`'s own overlay) and
 * `lease` (`"sweep"|"session"|null`, sprint 016's sweeper concept
 * landing early on the wire per this sprint's own scope).
 *
 * ## Connect/Switch sends exactly one message (ticket 002, SUC-009)
 *
 * The old two-step "send session-close for the current child, then
 * session-open for the new one" (`sprint.md`'s own retired Design
 * Rationale entry) is gone: the `onConnect` callback handed to
 * `RelayConnectControls` below sends exactly `{ type: "session-open",
 * relayLinkId, name }` whether or not a child is already bridged --
 * `connect/reconciler.ts`'s `planUserOpen` is what turns that single
 * request into a close-old + open-new pair, executed as one job,
 * host-side. This page never sequences two messages of its own for a
 * switch. The no-pick "default failover" request (`autoRobot: true`)
 * has no replacement in the new wire contract either (`wsMessages.ts`'s
 * own `SessionOpenMessage` doc comment) -- a name must be picked before
 * Connect is enabled.
 *
 * ## Ticket 017-007: connect bar + status text shared with `FrontPage.tsx`
 *
 * The picker, Connect/Switch/Disconnect buttons, and every status-copy
 * branch described below (idle/sweeping/connecting/failed/connected/
 * lost) now live in one place, `components/RelayConnectControls.tsx`
 * (`relayStatusText` its single source of the copy strings), rendered
 * here with `variant="page"` -- this page kept its own former markup/
 * classes/`data-testid`s exactly (that component's own doc comment).
 * `FrontPage.tsx`'s relay quick-connect card mounts the same component
 * with `variant="card"`. `RobotSelect` (the name picker itself) moved
 * out of this file into its own module, `components/RobotSelect.tsx`,
 * for the same reason -- this page no longer doubles as the module a
 * shared UI piece is imported from.
 *
 * ## `lease` rendering (sprint 015 ticket 008's own scope item, extended
 * by sprint 016 ticket 004)
 *
 * While no child is bridged: `lease === "sweep"` renders "idle ·
 * sweeping `<name>`" when a candidate the sweep is plausibly still
 * probing can be inferred (`deviceDisplay.ts`'s own
 * `findSweepingCandidateName`), else plain "idle · sweeping"; `lease
 * === null` (or `"session"`, which in practice never coincides with "no
 * child found" -- a session lease implies an open session somewhere)
 * renders plain "idle". Both only when there is no in-flight `bridging`
 * to show instead. `findRelayChild` itself now lives in
 * `deviceDisplay.ts`, shared with `FrontPage.tsx`'s own relay card --
 * ticket 004's own fix guards it against a sweep-only sighting (state
 * `"connectable"`/`"discovered"`) being mistaken for a live child (see
 * that function's own doc comment).
 *
 * Ticket 016-007 appends a "(fast)"/"(slow)" suffix to the "sweeping"
 * label (`deviceDisplay.ts`'s own `sweepRateSuffix`, driven by
 * `SnapshotRelay.sweep`) once the sweeper has feature-detected whether
 * this relay advertises rearch-12's non-persisting `!CGT` tune -- absent
 * until a lease-acquisition sync has completed against this relay at
 * least once, so a fresh relay still renders the pre-ticket-007 label
 * unchanged.
 *
 * ## `AddressSourceChip` reads `child.device.radio.source`
 *
 * The retired `addressSource`/`failoverTrail` fields (reconstructed
 * client-side from a per-attempt registry lookup and abandoned-
 * candidate trail) are gone; the connected child's own already-resolved
 * `radio` field (`SnapshotDevice.radio`, `override -> registry ->
 * derived`, `radioOverride.ts`) is the single source of truth this page
 * hands the shared chip -- see `AddressSourceChip.tsx`'s own doc
 * comment for why that component itself no longer distinguishes a
 * warning case.
 *
 * **Connected**: a status line, a "Disconnect" button (`session-close`
 * on the child's own link), the same connect bar (prefilled to the
 * current child's name) so switching robots is just "pick a different
 * name, press Switch" -- one `session-open`, never a "retarget" message
 * of its own and never a client-sequenced close-then-open (see above).
 * `RobotPage` is mounted for the child device completely unmodified --
 * no relay-aware prop, per `RobotPage.tsx`'s transport-blindness
 * contract. The relay's own `DeviceConsole` is not rendered here (no
 * console makes sense for a link with no session while a child owns the
 * port) -- a one-line note says it returns after Disconnect.
 *
 * **"Connected to `<name>`" requires the child's link to actually have
 * answered, not just be present** (mirrors sprint 013's own follow-up;
 * tightened by ticket 018-010 from "state === connected" to
 * `isLinkAnswering` -- see `RelayConnectControls.tsx`'s own doc comment,
 * "a link that is merely TCP-connected but has never actually answered
 * anything is never 'Connected to `<name>`'"): the child device is not
 * removed from `devices[]` when its radio link drops (`links.state`
 * moves to `failed`/`unresponsive` instead; `harvester`/watchers age it
 * out separately) -- only a deliberate Disconnect removes the bridge. So
 * the status line reads "Connected to `<name>` …" only once answering,
 * "Connecting to `<name>`…" while a session exists but has not yet
 * answered (or the link is still `connecting`), and "Connection to
 * `<name>` lost" (plus a plain-word `reason` when present,
 * `data-testid="relay-lost"`) once neither -- the connect bar stays
 * mounted throughout (the connected layout, including `RobotPage` for
 * the child, stays driven by the child's existence, not its link's
 * state), but **Disconnect** now shows only while a bridge session
 * genuinely exists (`RelayConnectControls.tsx`'s own `hasBridgeSession`
 * -- ticket 018-010's fix for the bench defect where Switch/Disconnect
 * showed "as if bridging" for a link that was never actually bridged);
 * a `lost` child with no session left offers Connect, not Disconnect,
 * to retry.
 *
 * ## Sprint 022 ticket 006: this is the one page where the active
 * console target can genuinely diverge from the routed link
 *
 * `DevicePage.tsx`'s own `useLink(linkId)`/`useDeviceForLink(linkId)`
 * resolve to *this relay's own* link/device no matter what this page
 * renders -- the URL never changes when a bridge comes up or drops,
 * because Connect/Disconnect are `session-open`/`session-close`
 * messages, not navigations. But when `child` (below) is truthy, this
 * page renders `<RobotPage device={child.device} link={child.link} />`
 * -- a completely different device's page -- for its main content. Left
 * alone, `DevicePage`'s dock/popup would keep showing the *relay's* own
 * console the whole time a robot is bridged through it, which is
 * exactly backwards from what a student looking at the screen would
 * expect: they are looking at the bridged robot's status/drive/
 * calibration UI, not the relay's.
 *
 * Asked directly about this exact case (sprint 022, 2026-09-20 -- his
 * brief covered front-page navigation and switching between two routed
 * devices explicitly, but not relay bridging, which `sprint.md`'s
 * Design Rationale had flagged as an open question until then), the
 * stakeholder confirmed the console must follow "whatever device I'm
 * showing on the main screen" -- i.e. the bridged child, not the relay
 * the URL names. That is a settled decision now, not a leaning; do not
 * re-open it without a fresh stakeholder conversation.
 *
 * So this page reports its own "active console target" via
 * `onActiveTargetChange`: the bridged child's `link`/`device.name`
 * while `child` is truthy, and the relay's own `relayLink`/`relayName`
 * once it reverts to `undefined` (Disconnect, or the bridge dropping on
 * its own) -- both transitions fire with **no route change at all**,
 * which is exactly why this can't be handled by `DevicePage` alone
 * re-deriving from `useParams()`. `child` itself (from
 * `currentRelayChild`, `deviceDisplay.ts`) is a brand-new object literal
 * on every render of this page (see `findRelayChild`'s own `{ device,
 * link }` allocation) -- the effect below keys off `activeLink`/
 * `activeName`, values extracted from `child` up front, rather than
 * `child` itself, so it only re-fires on an actual identity/value
 * change, not on every unrelated re-render this page gets from
 * `useDevices()`/`useRelays()` returning a new array reference for some
 * *other* device's change elsewhere in the same snapshot.
 */
import { useEffect } from "react";
import type { SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import type { ActiveConsoleTarget } from "./DevicePage";
import { AddressSourceChip } from "../components/AddressSourceChip";
import { ConsolePane } from "../components/ConsolePane";
import { RelayConnectControls } from "../components/RelayConnectControls";
import { RobotPage } from "./RobotPage";
import { useDevices, useRelays, useSendable, useWsActions } from "../ws/WsProvider";
import { currentRelayChild, isLinkUsable, nameDisplay, roleDisplay } from "../deviceDisplay";
import "./RelayPage.css";

export interface RelayPageProps {
  device: SnapshotDevice;
  /** Sprint 022 ticket 006: see this module's own doc comment, "this is
   * the one page where the active console target can genuinely diverge
   * from the routed link," for the full mechanism. */
  onActiveTargetChange: (target: ActiveConsoleTarget) => void;
}

/** A `(channel, group)` pair -- kept here (rather than moved wholesale
 * into `@robot-console/protocol`) only because `ConfigurationPage.tsx`
 * still imports this exact shape as a type; no runtime logic of this
 * module's own depends on it any more. */
export interface RadioAddress {
  channel: number;
  group: number;
}

/** A stable, referentially-unchanging no-op for the nested `RobotPage`'s
 * required `onActiveTargetChange` prop when a bridged child is rendered
 * -- see the doc comment at that call site, below, for why this page's
 * own effect (not `RobotPage`'s) is the sole source of truth for the
 * bridged-child target. Declared at module scope, not with `useCallback`
 * inside the component, since it closes over nothing and there is no
 * reason to reallocate it every render. */
const NOOP_ACTIVE_TARGET_CHANGE: (target: ActiveConsoleTarget) => void = () => {};

export function RelayPage({ device, onActiveTargetChange }: RelayPageProps) {
  const devices = useDevices();
  const relays = useRelays();
  const sendable = useSendable();
  const { send } = useWsActions();

  const relayLink = device.links[0];
  const relayLinkId = relayLink?.id;

  // Still needed here (in addition to `RelayConnectControls`' own
  // identical derivation) to pick this page's own layout -- connected
  // vs. not -- and to gate `AddressSourceChip`/`RobotPage`/the relay's
  // own `DeviceConsole` accordingly. `currentRelayChild` (ticket 018-010,
  // not the bare `findRelayChild`) so this page's own mount decision
  // never disagrees with `RelayConnectControls`' status text about
  // whether an old, long-dropped bridge still counts as "the" child --
  // see that function's own doc comment. Still a cheap, pure call; not
  // the kind of duplicated business-rule or user-facing copy this
  // ticket's extraction targets.
  const child = relayLinkId ? currentRelayChild(devices, relayLinkId) : undefined;

  const robotOptions = devices
    .filter((candidate) => candidate.kind === "robot")
    .map((candidate) => candidate.name)
    .sort((a, b) => a.localeCompare(b));

  const relayName = nameDisplay(device).text;

  // Sprint 022 ticket 006: report the active console target -- see this
  // module's own doc comment, "this is the one page where the active
  // console target can genuinely diverge from the routed link," for the
  // full reasoning. This page owns *both* branches directly (rather
  // than, say, delegating the bridged half to the nested `RobotPage`'s
  // own generic "report my own link/name" effect) so the whole
  // bridging/unbridging mechanism is exercised by this file's own test
  // suite without needing the real `RobotPage` -- `sprint.md`'s
  // Architecture §Step 4 diagram draws exactly one
  // `onActiveTargetChange` arrow out of `RelayPage`, not one that
  // sometimes really originates one level down.
  //
  // `activeLink`/`activeName` are extracted ahead of the effect so its
  // dependency array holds the actual underlying values -- a stable
  // `SnapshotLink` reference, a primitive string -- rather than `child`
  // itself, which is a fresh object literal on every render regardless
  // of any real change (`currentRelayChild`/`findRelayChild` in
  // `deviceDisplay.ts`).
  const activeLink = child ? child.link : relayLink;
  const activeName = child ? child.device.name : relayName;
  useEffect(() => {
    if (activeLink) {
      onActiveTargetChange({ link: activeLink, name: activeName });
    }
    // `activeLink` undefined only if this relay device somehow has no
    // link of its own at all -- shouldn't occur in practice (DevicePage
    // only ever dispatches here once its own routed `link` resolved
    // non-null), but if it ever does, there is nothing meaningful to
    // report and the previously-reported target (if any) simply stands.
  }, [activeLink, activeName, onActiveTargetChange]);

  return (
    <section className={`relay-page${child ? " relay-page-connected" : ""}`} aria-label="Relay device">
      <h2>{relayName}</h2>
      {/* 018-010 item 3: a relay device is a host, not "No role
          announced" -- `roleDisplay` names what it is by its links'
          own transport (mbrelay/mbserial host) when no banner role has
          been announced, or keeps a USB relay's own announced role
          (RADIOBRIDGE/RADIORELAY) unchanged. */}
      <p className="relay-page-role" data-testid="relay-page-role">
        {roleDisplay(device)}
      </p>

      <RelayConnectControls
        variant="page"
        relay={device}
        devices={devices}
        relays={relays}
        robotOptions={robotOptions}
        // Exactly one message -- see this module's own doc comment. The
        // reconciler (ticket 002's `planUserOpen`) treats this as a
        // close-old-child + open-new-child job when a child already
        // exists, never a client-sequenced session-close then
        // session-open.
        onConnect={(linkId, name) => send({ type: "session-open", relayLinkId: linkId, name })}
        onDisconnect={(linkId) => send({ type: "session-close", linkId })}
        // Ticket 011 (carried from 009's send-gating sweep): gates
        // Connect/Switch the same way every other send-capable control
        // in the app now does -- the relay link's own `session`-
        // independent state (it never has a `session` itself) meant
        // this button was the one place send-gating had not yet
        // reached.
        sendable={sendable}
      />

      {child ? (
        <>
          <p className="relay-page-hint">The relay's own console returns after Disconnect.</p>

          {/* Mounted above RobotPage, never inside it -- RobotPage's own
           * transport-blindness contract forbids a relay-aware prop
           * reaching it. Reads the child device's own already-resolved
           * radio field directly -- see this module's own doc comment. */}
          <AddressSourceChip radio={child.device.radio} />

          {/* `onActiveTargetChange` is deliberately NOT threaded through
              here: `RelayPage` itself already reports this exact same
              `{ link: child.link, name: child.device.name }` target via
              its own effect above, before this render happens. Handing
              this nested `RobotPage` the live callback too would just
              double-report the identical value on every one of its own
              re-renders for no benefit, and would make this page's own
              bridging behavior depend on `RobotPage`'s internals rather
              than being fully owned (and testable) here. A stable
              module-level no-op satisfies `RobotPageProps`' required
              prop without any of that. */}
          <RobotPage device={child.device} link={child.link} onActiveTargetChange={NOOP_ACTIVE_TARGET_CHANGE} />
        </>
      ) : (
        <>
          <p className="relay-page-hint">
            Uses the picked robot's radio address as configured on its device page (Set Radio), or the name-derived
            default if none is set.
          </p>

          {/* Extended scope (team-lead, 2026-09-13), item D: an idle
              relay's own console/sequencing-state banner was meaningless
              noise ("No link open to torture — open a link before
              sending." / "No session — sequencing state…") -- this
              relay's own state (idle / sweeping / bridging), already
              rendered by RelayConnectControls above, is the only thing
              worth showing while there is no session on this link. The
              console only mounts once the relay's own connectivity link
              is actually usable (a student opened a raw console on the
              relay itself, a rare direct case distinct from bridging to
              a robot child). */}
          {relayLink && isLinkUsable(relayLink) && <ConsolePane link={relayLink} name={relayName} />}
        </>
      )}
    </section>
  );
}
