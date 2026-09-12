/**
 * RelayPage.tsx — `/d/:endpointId` for a `relay`-classified endpoint
 * (SUC-003, SUC-004, SUC-005, SUC-006).
 *
 * Rewritten out-of-process (2026-09-09) now that the host actually
 * tunes a relay and publishes a child endpoint for it: on
 * `session-open { endpointId: <relay>, robotName, radio }` the host
 * tunes the relay's radio and, once the robot answers (or times out),
 * publishes a new `EndpointListEntry` with `endpointId =
 * "<relayEndpointId>-via-<robotName>"`, `transport: "relay-radio"`, and
 * `viaRelay: { relayEndpointId, robotName, channel, group }`
 * (`wsMessages.ts`, frozen elsewhere). While that child exists the
 * relay's own session is closed (the radio link owns the port), so
 * this page's two top-level branches (connect bar vs. connected layout,
 * including `RobotPage` mounting for the child) are driven entirely by
 * whether such a child is present in `useEndpoints()` — never by the
 * relay's own `sessionOpen` alone, which may legitimately be `false` in
 * either branch. Within the child-present branch, "Connected to `<name>`"
 * additionally requires `child.sessionOpen === true` (sprint 013
 * follow-up, 013-004, see below) — a dropped radio link does not delete
 * the child, so the child's own session state still matters.
 *
 * ## Sprint 8 ticket 005 additions
 *
 * Layered onto the OOP shell above, completing this ticket's contract:
 *
 * - **Dropdown sourcing**: the robot `<select>` lists
 *   `useRememberedRobots()`'s roster **plus** any name currently visible
 *   in `useDiscoveredServices().robots` (a live `_mbserial._tcp`
 *   snapshot) — a name present only in discovery is marked `(on the
 *   network)` in its option text so a student can tell "seen before"
 *   apart from "seen live this session" without either becoming a
 *   second, separate control. Rendering or opening this dropdown never
 *   sends anything over the socket — both lists are passive mirrors of
 *   snapshots the host already pushed (`sprint.md`'s Solution: "never a
 *   speculative registry lookup just to populate the list").
 * - **Connect with no pick = default failover**: with the dropdown's
 *   placeholder still selected, Connect sends exactly `{ type:
 *   "session-open", endpointId, autoRobot: true }` — no `robotName`, no
 *   `radio` — which `server.ts` routes to
 *   `deviceRegistry.ts#requestOpen(endpointId, {})`, the same
 *   default-failover candidate list (`buildDefaultFailoverCandidates`)
 *   ticket 004 already implements. An explicit pick still sends
 *   `robotName` (+ the editable `radio` override) exactly as before.
 * - **`AddressSourceChip`** (ticket 006) is mounted above `RobotPage` —
 *   never inside it, preserving `RobotPage`'s transport-blindness — fed
 *   from the child endpoint's own `addressSource`/`viaRelay`/
 *   `failoverTrail`/`transport` fields. `registryWasConsidered` is
 *   derived from whether any `_mbrelay._tcp` service is currently
 *   discovered at all (`discoveredServices.relays.length > 0`), per that
 *   component's own neutral/warning rule.
 * - **In-flight/failed bridging visibility** (SUC-005, sprint 13 ticket
 *   004): driven directly by the host's own `endpoint.relayBridge` field
 *   (set/cleared by `deviceRegistry.ts`'s `openRobotViaRelay` across its
 *   reset/boot-delay/handshake sequence) -- no local state and no log
 *   scanning. `relayBridge?.state === "connecting"` renders a transient
 *   `role="status"` line, "Connecting to `<name>`…" for a named pick or
 *   "Trying remembered robots…" for a no-pick default-failover attempt
 *   with no candidate name yet. `relayBridge?.state === "failed"` renders
 *   `relayBridge.error` visibly instead of silently reverting to a bare
 *   connect bar. Both clear the moment the child endpoint appears
 *   (success) or a fresh attempt starts, since `openRobotViaRelay` clears
 *   `relayBridge` itself at that point (sprint 013 `sprint.md`
 *   Architecture) -- this replaces the sprint 8 `autoConnecting`/
 *   `autoConnectLogBaseline` mechanism that used to infer the failure
 *   case from a host-origin line landing in
 *   `useEndpointLog(endpoint.endpointId)`; that log-scanning approach is
 *   gone from this page entirely.
 *
 * **Connected**: a status line, a "Disconnect" button
 * (`session-close` on the child), the same connect bar (prefilled to
 * the current name/address) so switching robots is just "pick a
 * different name, press Connect" — which sends `session-close` for the
 * current child *then* `session-open` for the new one, in that order,
 * from one `handleConnect` (never a single "retarget" message — see
 * `sprint.md`'s Design Rationale, "Switching robots is close-session →
 * new `LinkSpec` → open-session"). `RobotPage` is mounted for the child
 * endpoint completely unmodified — no relay-aware prop, per
 * `RobotPage.tsx`'s transport-blindness contract
 * (`RobotPage.transportBlind.test.ts`). The relay's own `DeviceConsole`
 * is not rendered here (its session is closed while a child owns the
 * port) — a one-line note says it returns after Disconnect.
 *
 * **"Connected to `<name>`" requires an open session, not just a child
 * endpoint (sprint 013 follow-up, 013-003/013-004, 2026-09-11):** the
 * synthesized child is not deleted when its radio link drops --
 * `deviceRegistry.ts#handleLinkError` leaves it listed with
 * `sessionOpen: false` and `sessionError` set; only a deliberate
 * Disconnect/`requestClose`, or the WiFi auto-switch, removes it. So the
 * status line above reads "Connected to `<name>` via `<relay>` on
 * channel X, group Y" only when `child.sessionOpen === true`; when the
 * child exists with `sessionOpen === false`, this page instead renders
 * "Connection to `<name>` lost" (plus `child.sessionError` when
 * present, `data-testid="relay-lost"`) as a `.relay-page-alert` line in
 * its place -- the connect bar and Disconnect stay available in that
 * state (the connected layout, including `RobotPage` for the child,
 * stays mounted throughout, driven by the child's existence, not its
 * session state) so the student can retry or clean up.
 *
 * ## Sprint 015 ticket 006: per-connect channel/group inputs removed
 *
 * Per `rearch-08-radio-address-overrides-in-host-db.md`'s default
 * (confirmed by the stakeholder, `sprint.md`'s Open Question 2): this
 * page no longer has its own editable channel/group fields, and
 * `session-open` no longer carries a `radio` override -- a robot's
 * radio address is now a device-level property, set once via the
 * device page's "Set Radio" dialog (`RadioAddressDialog`, which now
 * sends `set-radio-override` to the host DB instead of writing
 * `localStorage`) and resolved host-side (`override -> registry ->
 * derived`, `radioOverride.ts`). `readStoredAddress`/`writeStoredAddress`
 * (this module's own former per-name `localStorage` cache, also used by
 * `ConfigurationPage`/`RadioAddressDialog`) are gone entirely -- see
 * ticket 006's acceptance criterion that `grep -rn "localStorage"
 * packages/ui/src` shows no key holding a channel or group value.
 */
import { useEffect, useState } from "react";
import type {
  DiscoveredRobotEntry,
  EndpointListEntry,
  RememberedRobotEntry,
} from "@robot-console/host/src/wsMessages.js";
import { AddressSourceChip } from "../components/AddressSourceChip";
import { DeviceConsole } from "../components/DeviceConsole";
import { RobotPage } from "./RobotPage";
import {
  useDiscoveredServices,
  useEndpoints,
  useRememberedRobots,
  useWsActions,
} from "../ws/WsProvider";
import "./RelayPage.css";

export interface RelayPageProps {
  endpoint: EndpointListEntry;
}

type ChildEndpoint = EndpointListEntry & { viaRelay: NonNullable<EndpointListEntry["viaRelay"]> };

/** A `(channel, group)` pair -- kept here (rather than moved wholesale
 * into `@robot-console/protocol`) only because `ConfigurationPage.tsx`
 * still imports this exact shape as a type; no runtime logic of this
 * module's own depends on it any more (ticket 006 removed this page's
 * own editable channel/group fields -- see the module doc comment's
 * "per-connect channel/group inputs removed" section). */
export interface RadioAddress {
  channel: number;
  group: number;
}

/** One dropdown entry: a bare name string, plus whether it came only
 * from live mDNS discovery (never the sprint 5 roster) -- see
 * `RobotSelect`'s own doc comment for how that distinction is rendered.
 * No address is attached to either kind -- resolving one is deferred
 * entirely to connect time, per this module's own doc comment. */
export interface RobotOption {
  name: string;
  discoveredOnly: boolean;
}

/** Merge the roster (`useRememberedRobots()`) with any name currently
 * visible in `useDiscoveredServices().robots` into one deduplicated,
 * sorted option list -- a name in both sources counts as roster (not
 * discovered-only), since it is exactly as known as any other
 * remembered name. Pure and synchronous: no lookup of any kind, per
 * this module's own doc comment ("never a speculative registry
 * lookup"). */
export function buildRobotOptions(
  rememberedRobots: RememberedRobotEntry[],
  discoveredRobots: DiscoveredRobotEntry[],
): RobotOption[] {
  const discoveredOnlyByName = new Map<string, boolean>();
  for (const robot of rememberedRobots) {
    discoveredOnlyByName.set(robot.name, false);
  }
  for (const robot of discoveredRobots) {
    if (!discoveredOnlyByName.has(robot.instanceName)) {
      discoveredOnlyByName.set(robot.instanceName, true);
    }
  }
  return [...discoveredOnlyByName.entries()]
    .map(([name, discoveredOnly]) => ({ name, discoveredOnly }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function RelayPage({ endpoint }: RelayPageProps) {
  const endpoints = useEndpoints();
  const rememberedRobots = useRememberedRobots();
  const discoveredServices = useDiscoveredServices();
  const { send } = useWsActions();

  const child = endpoints.find(
    (candidate): candidate is ChildEndpoint => candidate.viaRelay?.relayEndpointId === endpoint.endpointId,
  );

  const [selectedName, setSelectedName] = useState<string>("");

  // Sprint 13 ticket 004: `relayBridge` covers the two states that have
  // no other representation -- "connecting" and "failed" -- both of
  // which can occur only while no child exists yet (`openRobotViaRelay`
  // clears `relayBridge` the moment the child is synthesized). Looked up
  // from the live `endpoints` snapshot (`useEndpoints()`) by id, exactly
  // like `child` above, rather than off the `endpoint` prop directly --
  // the prop is normally kept fresh by the router-level parent
  // (`DevicePage.tsx`) re-deriving it from the same snapshot on every
  // render, but reading it via `endpoints` here makes this page reactive
  // to a `relayBridge` transition on its own, without depending on that
  // parent behavior. The `child`-present branch below never reads this;
  // it stays driven purely by the child's own existence, exactly as
  // before this ticket.
  const liveEndpoint = endpoints.find((candidate) => candidate.endpointId === endpoint.endpointId) ?? endpoint;
  const bridge = child ? undefined : liveEndpoint.relayBridge;

  // Sync the connect bar to the live child's own name whenever it
  // appears or changes -- covers both "this page mounted while already
  // connected" and "the host just confirmed a fresh session-open" with
  // the same logic. Ticket 006: no longer syncs channel/group -- this
  // page has no editable address fields of its own any more (see the
  // module doc comment); `child.viaRelay.channel`/`group` are still read
  // directly (not through local state) by the connected status line
  // below.
  useEffect(() => {
    if (child) {
      setSelectedName(child.viaRelay.robotName);
    }
  }, [child?.viaRelay.robotName]);

  const robotOptions = buildRobotOptions(rememberedRobots, discoveredServices.robots);

  function handleSelectName(name: string): void {
    setSelectedName(name);
  }

  function handleConnect(): void {
    if (child) {
      send({ type: "session-close", endpointId: child.endpointId });
    }
    if (selectedName) {
      // Ticket 006: no `radio` override sent here any more -- the
      // robot's radio address is resolved host-side from a device-level
      // override (set via `RadioAddressDialog`'s `set-radio-override`),
      // the mbrelay registry, or the name-derived default, in that order
      // (`radioOverride.ts`'s `override -> registry -> derived`).
      send({
        type: "session-open",
        endpointId: endpoint.endpointId,
        robotName: selectedName,
      });
      return;
    }
    // No pick: sprint 8 ticket 004's default-failover candidate list,
    // requested over the wire by `autoRobot: true` with no `robotName`
    // and no `radio` -- see this module's own doc comment. The host
    // reports the resulting "connecting" state back via
    // `endpoint.relayBridge`, not any local state set here.
    send({ type: "session-open", endpointId: endpoint.endpointId, autoRobot: true });
  }

  function handleDisconnect(): void {
    if (!child) {
      return;
    }
    send({ type: "session-close", endpointId: child.endpointId });
  }

  const connectDisabled = !endpoint.sessionOpen && !child;
  const relayName = endpoint.name ?? endpoint.endpointId;
  const registryWasConsidered = discoveredServices.relays.length > 0;

  return (
    <section className={`relay-page${child ? " relay-page-connected" : ""}`} aria-label="Relay device">
      <h2>{relayName}</h2>

      {child ? (
        <>
          {child.sessionOpen && child.sessionError && (
            <p className="relay-page-alert" role="alert">
              {child.sessionError}
            </p>
          )}
          {child.sessionOpen ? (
            <p className="relay-connected-status" data-testid="relay-connected">
              Connected to {child.viaRelay.robotName} via {relayName} on channel {child.viaRelay.channel}, group{" "}
              {child.viaRelay.group}
            </p>
          ) : (
            <p className="relay-page-alert" role="alert" data-testid="relay-lost">
              Connection to {child.viaRelay.robotName} lost{child.sessionError ? `: ${child.sessionError}` : ""}
            </p>
          )}

          <div className="relay-connect-bar">
            <RobotSelect options={robotOptions} value={selectedName} onChange={handleSelectName} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
            <button type="button" data-testid="relay-disconnect" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
          <p className="relay-page-hint">The relay's own console returns after Disconnect.</p>

          {/* AddressSourceChip (ticket 006) mounts above RobotPage, never
           * inside it -- RobotPage's own transport-blindness contract
           * forbids a relay-aware prop reaching it. `addressSource`/
           * `failoverTrail` are only conditionally spread (rather than
           * passed as `child.addressSource`/`child.failoverTrail`
           * directly) because `exactOptionalPropertyTypes` forbids an
           * optional prop receiving an explicit `undefined` -- the key
           * must be entirely absent when the endpoint has none, exactly
           * as `wsMessages.ts`'s own present-only-when-relevant fields
           * are handled elsewhere in this codebase. */}
          <AddressSourceChip
            {...(child.addressSource !== undefined ? { addressSource: child.addressSource } : {})}
            viaRelay={child.viaRelay}
            transport={child.transport}
            registryWasConsidered={registryWasConsidered}
            {...(child.failoverTrail !== undefined ? { failoverTrail: child.failoverTrail } : {})}
          />

          <RobotPage endpoint={child} />
        </>
      ) : (
        <>
          <div className="relay-connect-bar">
            <RobotSelect options={robotOptions} value={selectedName} onChange={handleSelectName} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
          </div>
          <p className="relay-page-hint">
            Uses the picked robot's radio address as configured on its device page (Set Radio), or the name-derived
            default if none is set. Leave the robot unpicked and press Connect to try every remembered/discovered
            robot in turn.
          </p>
          {bridge?.state === "connecting" && (
            <p className="relay-autoconnecting-status" role="status" data-testid="relay-autoconnecting">
              {bridge.robotName ? `Connecting to ${bridge.robotName}…` : "Trying remembered robots…"}
            </p>
          )}
          {bridge?.state === "failed" && (
            <p className="relay-page-alert" role="alert" data-testid="relay-bridge-failed">
              {bridge.error}
            </p>
          )}

          <DeviceConsole device={endpoint} />
        </>
      )}
    </section>
  );
}

/** The robot-name picker, shared by both the not-connected and
 * connected connect bars. Empty-roster-and-discovery case renders a
 * disabled placeholder option plus a hint rather than an empty,
 * silently unusable `<select>` -- mirrors this module's own doc comment
 * on never rendering a control that looks live but goes nowhere. A
 * discovered-only name (`discoveredOnly: true` -- seen live over mDNS
 * this session, never remembered from a prior USB connection) is
 * marked `(on the network)` in its own option text so a student can
 * tell the two sources apart without a second control. */
export function RobotSelect({
  options,
  value,
  onChange,
}: {
  options: RobotOption[];
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
            No robots remembered yet — connect one over USB once
          </option>
        ) : (
          <>
            <option value="">Choose a robot…</option>
            {options.map(({ name, discoveredOnly }) => (
              <option key={name} value={name}>
                {discoveredOnly ? `${name} (on the network)` : name}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}

