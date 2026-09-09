/**
 * RelayPage.tsx — `/d/:endpointId` for a `relay`-classified endpoint
 * (SUC-006).
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
 * this page's two states are driven entirely by whether such a child is
 * present in `useEndpoints()` — never by the relay's own `sessionOpen`
 * alone, which may legitimately be `false` in either state.
 *
 * **Not connected**: a connect bar — a robot-name `<select>` sourced
 * from `useRememberedRobots()`, plus editable `channel`/`group` number
 * inputs prefilled from `@robot-console/protocol`'s
 * `nameToRadioAddress(name)` whenever the selection changes (or from a
 * per-name override remembered in `localStorage`, written the moment
 * the student actually connects with edited values — see
 * `addressStorageKey`). The radio fields are editable, not derived-only
 * display, because today's calibration robot image listens on a fixed
 * channel 55 / group 114 rather than its name-derived address. Below
 * the connect bar, the relay's own `DeviceConsole` (unchanged) so
 * `!HELP` etc. still work against the relay itself.
 *
 * **Connected**: a status line, a "Disconnect" button
 * (`session-close` on the child), the same connect bar (prefilled to
 * the current name/address) so switching robots is just "pick a
 * different name, press Connect" — which sends `session-close` for the
 * current child *then* `session-open` for the new one, in that order,
 * from one `handleConnect`. `RobotPage` is mounted for the child
 * endpoint completely unmodified — no relay-aware prop, per
 * `RobotPage.tsx`'s transport-blindness contract
 * (`RobotPage.transportBlind.test.ts`). The relay's own `DeviceConsole`
 * is not rendered here (its session is closed while a child owns the
 * port) — a one-line note says it returns after Disconnect.
 */
import { useEffect, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { nameToRadioAddress } from "@robot-console/protocol";
import { DeviceConsole } from "../components/DeviceConsole";
import { RobotPage } from "./RobotPage";
import { useEndpoints, useRememberedRobots, useWsActions } from "../ws/WsProvider";
import "./RelayPage.css";

export interface RelayPageProps {
  endpoint: EndpointListEntry;
}

type ChildEndpoint = EndpointListEntry & { viaRelay: NonNullable<EndpointListEntry["viaRelay"]> };

interface RadioAddress {
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
function readStoredAddress(name: string): RadioAddress | null {
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
function writeStoredAddress(name: string, address: RadioAddress): void {
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

export function RelayPage({ endpoint }: RelayPageProps) {
  const endpoints = useEndpoints();
  const rememberedRobots = useRememberedRobots();
  const { send } = useWsActions();

  const child = endpoints.find(
    (candidate): candidate is ChildEndpoint => candidate.viaRelay?.relayEndpointId === endpoint.endpointId,
  );

  const [selectedName, setSelectedName] = useState<string>("");
  const [channel, setChannel] = useState<number>(0);
  const [group, setGroup] = useState<number>(0);

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

  const robotNames = [...rememberedRobots].map((robot) => robot.name).sort((a, b) => a.localeCompare(b));

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
    if (!selectedName) {
      return;
    }
    writeStoredAddress(selectedName, { channel, group });
    if (child) {
      send({ type: "session-close", endpointId: child.endpointId });
    }
    send({
      type: "session-open",
      endpointId: endpoint.endpointId,
      robotName: selectedName,
      radio: { channel, group },
    });
  }

  function handleDisconnect(): void {
    if (!child) {
      return;
    }
    send({ type: "session-close", endpointId: child.endpointId });
  }

  const connectDisabled = !selectedName || (!endpoint.sessionOpen && !child);
  const relayName = endpoint.name ?? endpoint.endpointId;

  return (
    <section className={`relay-page${child ? " relay-page-connected" : ""}`} aria-label="Relay device">
      <h2>{relayName}</h2>

      {child ? (
        <>
          {child.sessionError && (
            <p className="relay-page-alert" role="alert">
              {child.sessionError}
            </p>
          )}
          <p className="relay-connected-status" data-testid="relay-connected">
            Connected to {child.viaRelay.robotName} via {relayName} on channel {child.viaRelay.channel}, group{" "}
            {child.viaRelay.group}
          </p>

          <div className="relay-connect-bar">
            <RobotSelect names={robotNames} value={selectedName} onChange={handleSelectName} />
            <RadioAddressFields channel={channel} group={group} onChannel={handleChannelInput} onGroup={handleGroupInput} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
            <button type="button" data-testid="relay-disconnect" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
          <p className="relay-page-hint">The relay's own console returns after Disconnect.</p>

          <RobotPage endpoint={child} />
        </>
      ) : (
        <>
          <div className="relay-connect-bar">
            <RobotSelect names={robotNames} value={selectedName} onChange={handleSelectName} />
            <RadioAddressFields channel={channel} group={group} onChannel={handleChannelInput} onGroup={handleGroupInput} />
            <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
              Connect
            </button>
          </div>
          <p className="relay-page-hint">
            Defaults to the address derived from the name. The calibration image listens on 55 / 114.
          </p>

          <DeviceConsole device={endpoint} />
        </>
      )}
    </section>
  );
}

/** The robot-name picker, shared by both the not-connected and
 * connected connect bars. Empty-roster case renders a disabled
 * placeholder option plus a hint rather than an empty, silently
 * unusable `<select>` -- mirrors this module's own doc comment on
 * never rendering a control that looks live but goes nowhere. */
function RobotSelect({
  names,
  value,
  onChange,
}: {
  names: string[];
  value: string;
  onChange: (name: string) => void;
}) {
  const empty = names.length === 0;
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
            {names.map((name) => (
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
