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
 */
import type { SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import { AddressSourceChip } from "../components/AddressSourceChip";
import { DeviceConsole } from "../components/DeviceConsole";
import { RelayConnectControls } from "../components/RelayConnectControls";
import { RobotPage } from "./RobotPage";
import { useDevices, useRelays, useSendable, useWsActions } from "../ws/WsProvider";
import { currentRelayChild, isLinkUsable, nameDisplay, roleDisplay } from "../deviceDisplay";
import "./RelayPage.css";

export interface RelayPageProps {
  device: SnapshotDevice;
}

/** A `(channel, group)` pair -- kept here (rather than moved wholesale
 * into `@robot-console/protocol`) only because `ConfigurationPage.tsx`
 * still imports this exact shape as a type; no runtime logic of this
 * module's own depends on it any more. */
export interface RadioAddress {
  channel: number;
  group: number;
}

export function RelayPage({ device }: RelayPageProps) {
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

          <RobotPage device={child.device} link={child.link} />
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
          {relayLink && isLinkUsable(relayLink) && <DeviceConsole link={relayLink} name={relayName} />}
        </>
      )}
    </section>
  );
}
