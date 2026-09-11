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
 */
import { useEffect, useState } from "react";
import type {
  DiscoveredRobotEntry,
  EndpointListEntry,
  RememberedRobotEntry,
} from "@robot-console/host/src/wsMessages.js";
import { nameToRadioAddress } from "@robot-console/protocol";
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

export interface RadioAddress {
  channel: number;
  group: number;
}

function addressStorageKey(name: string): string {
  return `robot-console:relay-address:${name}`;
}

/** Best-effort read of a per-name remembered override, written the
 * last time the student connected with edited values for this name.
 * `null` for "nothing remembered" *and* for any storage failure (a
 * private-browsing quota error, a browser that blocks storage
 * entirely, malformed JSON left by an older build) — never thrown,
 * since the derived default (`nameToRadioAddress`) is always a safe
 * fallback. */
export function readStoredAddress(name: string): RadioAddress | null {
  try {
    const raw = window.localStorage.getItem(addressStorageKey(name));
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Number.isInteger((parsed as RadioAddress).channel) &&
      Number.isInteger((parsed as RadioAddress).group)
    ) {
      return { channel: (parsed as RadioAddress).channel, group: (parsed as RadioAddress).group };
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort write, mirroring {@link readStoredAddress}'s failure
 * handling — a storage error here must never block the Connect click
 * that triggered it. */
export function writeStoredAddress(name: string, address: RadioAddress): void {
  try {
    window.localStorage.setItem(addressStorageKey(name), JSON.stringify(address));
  } catch {
    // Best-effort only -- see this function's doc comment.
  }
}

function parseNumberInput(raw: string): number | null {
  if (raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
  const [channel, setChannel] = useState<number>(0);
  const [group, setGroup] = useState<number>(0);

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

  // Sync the connect bar to the live child's own address whenever it
  // appears or changes -- covers both "this page mounted while already
  // connected" and "the host just confirmed a fresh session-open" with
  // the same logic, so the fields always reflect what the relay is
  // actually tuned to rather than a stale pre-connect edit.
  useEffect(() => {
    if (child) {
      setSelectedName(child.viaRelay.robotName);
      setChannel(child.viaRelay.channel);
      setGroup(child.viaRelay.group);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [child?.viaRelay.robotName, child?.viaRelay.channel, child?.viaRelay.group]);

  const robotOptions = buildRobotOptions(rememberedRobots, discoveredServices.robots);

  function handleSelectName(name: string): void {
    setSelectedName(name);
    if (name === "") {
      return;
    }
    const stored = readStoredAddress(name);
    const address = stored ?? nameToRadioAddress(name);
    setChannel(address.channel);
    setGroup(address.group);
  }

  function handleChannelInput(raw: string): void {
    const value = parseNumberInput(raw);
    if (value !== null) {
      setChannel(value);
    }
  }

  function handleGroupInput(raw: string): void {
    const value = parseNumberInput(raw);
    if (value !== null) {
      setGroup(value);
    }
  }

  function handleConnect(): void {
    if (child) {
      send({ type: "session-close", endpointId: child.endpointId });
    }
    if (selectedName) {
      writeStoredAddress(selectedName, { channel, group });
      send({
        type: "session-open",
        endpointId: endpoint.endpointId,
        robotName: selectedName,
        radio: { channel, group },
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
            <RadioAddressFields channel={channel} group={group} onChannel={handleChannelInput} onGroup={handleGroupInput} />
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
            <RadioAddressFields channel={channel} group={group} onChannel={handleChannelInput} onGroup={handleGroupInput} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
          </div>
          <p className="relay-page-hint">
            Defaults to the address derived from the name. The calibration image listens on 55 / 114. Leave the
            robot unpicked and press Connect to try every remembered/discovered robot in turn.
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

function RadioAddressFields({
  channel,
  group,
  onChannel,
  onGroup,
}: {
  channel: number;
  group: number;
  onChannel: (raw: string) => void;
  onGroup: (raw: string) => void;
}) {
  return (
    <div className="relay-radio-fields">
      <label>
        <span>Channel</span>
        <input
          data-testid="relay-channel"
          type="number"
          value={channel}
          onChange={(event) => onChannel(event.target.value)}
        />
      </label>
      <label>
        <span>Group</span>
        <input
          data-testid="relay-group"
          type="number"
          value={group}
          onChange={(event) => onGroup(event.target.value)}
        />
      </label>
    </div>
  );
}
