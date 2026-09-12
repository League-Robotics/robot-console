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
 * Rationale entry) is gone: `handleConnect` below sends exactly
 * `{ type: "session-open", relayLinkId, name }` whether or not a child
 * is already bridged -- `connect/reconciler.ts`'s `planUserOpen` is what
 * turns that single request into a close-old + open-new pair, executed
 * as one job, host-side. This page never sequences two messages of its
 * own for a switch. The no-pick "default failover" request
 * (`autoRobot: true`) has no replacement in the new wire contract
 * either (`wsMessages.ts`'s own `SessionOpenMessage` doc comment) -- a
 * name must be picked before Connect is enabled.
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
 * **"Connected to `<name>`" requires the child's link to actually be
 * `connected`, not just present** (mirrors sprint 013's own follow-up):
 * the child device is not removed from `devices[]` when its radio link
 * drops (`links.state` moves to `failed`/`unresponsive` instead;
 * `harvester`/watchers age it out separately) -- only a deliberate
 * Disconnect removes the bridge. So the status line reads "Connected to
 * `<name>` …" only when `child.link.state === "connected"`; otherwise
 * this page renders "Connection to `<name>` lost" (plus `child.link
 * .reason` when present, `data-testid="relay-lost"`) in its place -- the
 * connect bar and Disconnect stay available in that state (the
 * connected layout, including `RobotPage` for the child, stays mounted
 * throughout, driven by the child's existence, not its link's state) so
 * the student can retry or clean up.
 */
import { useEffect, useState } from "react";
import type { SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import { AddressSourceChip } from "../components/AddressSourceChip";
import { DeviceConsole } from "../components/DeviceConsole";
import { RobotPage } from "./RobotPage";
import { useDevices, useRelays, useSendable, useWsActions } from "../ws/WsProvider";
import { findRelayChild, findSweepingCandidateName } from "../deviceDisplay";
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
  const relayInfo = relayLinkId ? relays.find((candidate) => candidate.linkId === relayLinkId) : undefined;
  const bridging = relayInfo?.bridging;
  const lease = relayInfo?.lease ?? null;

  const child = relayLinkId ? findRelayChild(devices, relayLinkId) : undefined;
  // Sprint 016 ticket 004: "idle · sweeping <name>" while the sweep
  // lease is held and no child is bridged -- see `deviceDisplay.ts`'s
  // own `findSweepingCandidateName` doc comment for why this is
  // inferred client-side rather than carried as a new wire field.
  const sweepingName = relayLinkId && lease === "sweep" ? findSweepingCandidateName(devices, relayLinkId, Date.now()) : undefined;

  const [selectedName, setSelectedName] = useState<string>("");

  // Sync the connect bar to the live child's own name whenever it
  // appears or changes -- covers both "this page mounted while already
  // connected" and "the host just confirmed a fresh session-open" with
  // the same logic.
  useEffect(() => {
    if (child) {
      setSelectedName(child.device.name);
    }
  }, [child?.device.name]);

  const robotOptions = devices
    .filter((candidate) => candidate.kind === "robot")
    .map((candidate) => candidate.name)
    .sort((a, b) => a.localeCompare(b));

  // Ticket 011 (carried from 009's send-gating sweep): `useSendable()`
  // (socket open, snapshot not stale) gates Connect/Switch the same way
  // every other send-capable control in the app now does -- the relay
  // link's own `session`-independent state (it never has a `session`
  // itself) meant this button was the one place send-gating had not
  // yet reached.
  function handleConnect(): void {
    if (!relayLinkId || !selectedName || !sendable) {
      return;
    }
    // Exactly one message -- see this module's own doc comment. The
    // reconciler (ticket 002's `planUserOpen`) treats this as a
    // close-old-child + open-new-child job when a child already exists,
    // never a client-sequenced session-close then session-open.
    send({ type: "session-open", relayLinkId, name: selectedName });
  }

  function handleDisconnect(): void {
    if (!child) {
      return;
    }
    send({ type: "session-close", linkId: child.link.id });
  }

  const connectDisabled = selectedName === "" || relayLinkId === undefined || !sendable;
  const relayName = device.name;

  return (
    <section className={`relay-page${child ? " relay-page-connected" : ""}`} aria-label="Relay device">
      <h2>{relayName}</h2>

      {child ? (
        <>
          {child.link.state === "connected" ? (
            <p className="relay-connected-status" data-testid="relay-connected">
              Connected to {child.device.name} via {relayName}
              {child.link.via ? ` on channel ${child.link.via.channel}, group ${child.link.via.group}` : ""}
            </p>
          ) : (
            <p className="relay-page-alert" role="alert" data-testid="relay-lost">
              Connection to {child.device.name} lost{child.link.reason ? `: ${child.link.reason}` : ""}
            </p>
          )}

          <div className="relay-connect-bar">
            <RobotSelect options={robotOptions} value={selectedName} onChange={setSelectedName} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Switch
            </button>
            <button type="button" data-testid="relay-disconnect" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
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
          <div className="relay-connect-bar">
            <RobotSelect options={robotOptions} value={selectedName} onChange={setSelectedName} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
          </div>
          <p className="relay-page-hint">
            Uses the picked robot's radio address as configured on its device page (Set Radio), or the name-derived
            default if none is set.
          </p>

          {bridging?.state === "connecting" && (
            <p className="relay-autoconnecting-status" role="status" data-testid="relay-autoconnecting">
              {bridging.robotName ? `Connecting to ${bridging.robotName}…` : "Connecting…"}
            </p>
          )}
          {bridging?.state === "failed" && (
            <p className="relay-page-alert" role="alert" data-testid="relay-bridge-failed">
              {bridging.error ?? `Could not reach ${bridging.robotName ?? "the robot"}`}
            </p>
          )}
          {!bridging && (
            <p className="relay-idle-status" role="status" data-testid="relay-idle">
              {lease === "sweep" ? `idle · sweeping${sweepingName ? ` ${sweepingName}` : ""}` : "idle"}
            </p>
          )}

          {relayLink && <DeviceConsole link={relayLink} name={relayName} />}
        </>
      )}
    </section>
  );
}

/** The robot-name picker, shared by both the not-connected and
 * connected connect bars -- every `kind: "robot"` device's name, host
 * order sorted (no separate "remembered vs. discovered" distinction any
 * more; that whole roster/discovery side-list pair is retired along
 * with `EndpointsMessage`, see `wsMessages.ts`'s module doc comment).
 * Empty-roster case renders a disabled placeholder option plus a hint
 * rather than an empty, silently unusable `<select>`. */
export function RobotSelect({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (name: string) => void;
}) {
  const empty = options.length === 0;
  return (
    <label className="relay-robot-picker">
      <span>Robot</span>
      <select
        data-testid="relay-robot-select"
        value={value}
        disabled={empty}
        onChange={(event) => onChange(event.target.value)}
      >
        {empty ? (
          <option value="" disabled>
            No robots known yet — connect one over USB once
          </option>
        ) : (
          <>
            <option value="">Choose a robot…</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
