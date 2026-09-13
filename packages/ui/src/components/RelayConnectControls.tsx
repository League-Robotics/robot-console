/**
 * RelayConnectControls.tsx — the relay device's robot picker +
 * Connect/Switch/Disconnect + status text (ticket 017-007;
 * `docs/reviews/2026-09-11/04-ui.md` §4, "Relay-bridge status copy" and
 * "Relay Connect/Disconnect/Switch wiring"), shared by both the front
 * page's relay quick-connect card (`FrontPage.tsx`'s former
 * `RelayQuickConnect`) and `RelayPage.tsx`'s own connect bar, which each
 * kept an independent, near-identical copy before this ticket.
 *
 * ## Two variants, one status/connect derivation
 *
 * `variant="card"` reproduces `FrontPage.tsx`'s former markup/classes/
 * per-relay `data-testid`s exactly (several relay cards can be on
 * screen at once, so every id is suffixed with `relay.id`); `variant=
 * "page"` reproduces `RelayPage.tsx`'s own markup/classes/static
 * `data-testid`s (exactly one relay per page, so no suffix) and appends
 * "via `<relay name>`" to the connected line, matching that page's own
 * pre-extraction copy. Both variants share one status derivation
 * ({@link relayStatusText}) and one selection/connect/disconnect
 * implementation -- only the DOM shape and status copy's "via" clause
 * differ, matching each call site's own pre-existing, deliberately
 * different presentation exactly (a pure extraction, not a redesign).
 *
 * The connected/not-connected layouts' surrounding chrome (hint
 * paragraphs, `AddressSourceChip`, `RobotPage`, the relay's own
 * `DeviceConsole`) stays owned by each page, rendered around this
 * component -- only the picker/buttons/status text moved.
 */
import { useEffect, useState } from "react";
import type { SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import { findRelayChild, findSweepingCandidateName, sweepRateSuffix } from "../deviceDisplay";
import { RobotSelect } from "./RobotSelect";
import "./RelayConnectControls.css";

export type RelayConnectVariant = "card" | "page";

export type RelayStatusKind = "connected" | "lost" | "connecting" | "failed" | "idle";

export interface RelayStatus {
  kind: RelayStatusKind;
  text: string;
}

/** The relay-specific context {@link relayStatusText} needs, separate
 * from the bridged child (if any) -- named `relay` to match this
 * ticket's own `relayStatusText(relay, child)` shape. */
export interface RelayStatusContext {
  relayInfo: SnapshotRelay | undefined;
  devices: readonly SnapshotDevice[];
  relayLinkId: string | undefined;
  /** When present, the connected-child line reads "Connected to `<name>`
   * via `<relayName>` ..." (`RelayPage.tsx`'s own pre-extraction copy);
   * omitted, it reads plain "Connected to `<name>` ..." (`FrontPage.tsx`'s
   * own pre-extraction copy, since the relay's own name is already the
   * card's heading). */
  relayName?: string;
  /** Injectable for tests; defaults to `Date.now()`, matching both
   * pre-extraction call sites (which read the current time directly at
   * render time for the sweeping-candidate freshness check). */
  now?: number;
}

/** The single source of the relay connect controls' status copy
 * strings -- every case `FrontPage.tsx`'s former `RelayQuickConnect` and
 * `RelayPage.tsx`'s own inline branches each spelled out independently
 * before this ticket. */
export function relayStatusText(
  relay: RelayStatusContext,
  child: { device: SnapshotDevice; link: SnapshotLink } | undefined,
): RelayStatus {
  const { relayInfo, devices, relayLinkId, relayName, now = Date.now() } = relay;
  const bridging = relayInfo?.bridging;
  const lease = relayInfo?.lease ?? null;

  if (child && child.link.state === "connected") {
    const viaRelay = relayName ? ` via ${relayName}` : "";
    const viaChannel = child.link.via ? ` on channel ${child.link.via.channel}, group ${child.link.via.group}` : "";
    return { kind: "connected", text: `Connected to ${child.device.name}${viaRelay}${viaChannel}` };
  }
  if (child) {
    return { kind: "lost", text: `Connection to ${child.device.name} lost${child.link.reason ? `: ${child.link.reason}` : ""}` };
  }
  if (bridging?.state === "connecting") {
    return { kind: "connecting", text: bridging.robotName ? `Connecting to ${bridging.robotName}…` : "Connecting…" };
  }
  if (bridging?.state === "failed") {
    return { kind: "failed", text: bridging.error ?? `Could not reach ${bridging.robotName ?? "the robot"}` };
  }
  const sweepingName = relayLinkId && lease === "sweep" ? findSweepingCandidateName(devices, relayLinkId, now) : undefined;
  return {
    kind: "idle",
    text: lease === "sweep" ? `idle · sweeping${sweepingName ? ` ${sweepingName}` : ""}${sweepRateSuffix(relayInfo)}` : "idle",
  };
}

export interface RelayConnectControlsProps {
  variant: RelayConnectVariant;
  relay: SnapshotDevice;
  devices: SnapshotDevice[];
  relays: SnapshotRelay[];
  robotOptions: string[];
  onConnect: (relayLinkId: string, name: string) => void;
  onDisconnect: (linkId: string) => void;
  /** Ticket 011 (carried from 009's send-gating sweep): gates the
   * Connect/Switch button -- taken as a plain prop rather than calling
   * `useSendable()` here directly, so this component stays usable
   * without a `WsProvider` in the tree (matching both pre-extraction
   * call sites). */
  sendable: boolean;
}

export function RelayConnectControls({
  variant,
  relay,
  devices,
  relays,
  robotOptions,
  onConnect,
  onDisconnect,
  sendable,
}: RelayConnectControlsProps) {
  const relayLinkId = relay.links[0]?.id;
  const relayInfo = relayLinkId ? relays.find((r) => r.linkId === relayLinkId) : undefined;
  const child = relayLinkId ? findRelayChild(devices, relayLinkId) : undefined;
  const status = relayStatusText({ relayInfo, devices, relayLinkId, ...(variant === "page" ? { relayName: relay.name } : {}) }, child);

  const [selectedName, setSelectedName] = useState<string>(child?.device.name ?? "");
  useEffect(() => {
    if (child) {
      setSelectedName(child.device.name);
    }
  }, [child?.device.name]);

  // De-duplicated defensively (ticket 017-010, bench defect "the same
  // robot appears twice", 2026-09-13) -- the `"card"` variant below
  // renders its own inline `<select>` rather than reusing `RobotSelect`
  // (which de-dupes on its own, see that component's own doc comment),
  // so this variant needs the same defense independently.
  const uniqueRobotOptions = Array.from(new Set(robotOptions));

  const connectDisabled = selectedName === "" || relayLinkId === undefined || !sendable;
  function handleConnect(): void {
    if (connectDisabled || !relayLinkId) {
      return;
    }
    onConnect(relayLinkId, selectedName);
  }

  if (variant === "card") {
    const idSuffix = relay.id;
    return (
      <div className="device-relay-connect" data-testid={`relay-quick-connect-${idSuffix}`}>
        {status.kind === "connected" && <p className="device-relay-connected">{status.text}</p>}
        {status.kind === "lost" && (
          <p className="device-relay-failed" data-testid={`relay-quick-lost-${idSuffix}`}>
            {status.text}
          </p>
        )}
        {status.kind === "connecting" && (
          <p className="device-relay-connecting" data-testid={`relay-quick-connecting-${idSuffix}`}>
            {status.text}
          </p>
        )}
        {status.kind === "failed" && (
          <p className="device-relay-failed" data-testid={`relay-quick-failed-${idSuffix}`}>
            {status.text}
          </p>
        )}
        {status.kind === "idle" && (
          <p className="device-relay-idle" role="status" data-testid={`relay-quick-idle-${idSuffix}`}>
            {status.text}
          </p>
        )}
        <div className="device-relay-connect-row">
          <select
            data-testid={`relay-quick-connect-select-${idSuffix}`}
            value={selectedName}
            disabled={uniqueRobotOptions.length === 0}
            onChange={(event) => setSelectedName(event.target.value)}
          >
            <option value="">{uniqueRobotOptions.length === 0 ? "No robots known yet" : "Choose a robot…"}</option>
            {uniqueRobotOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button type="button" className="device-relay-connect-button" disabled={connectDisabled} onClick={handleConnect}>
            {child ? "Switch" : "Connect"}
          </button>
          {child && (
            <button type="button" className="device-relay-disconnect-button" onClick={() => onDisconnect(child.link.id)}>
              Disconnect
            </button>
          )}
        </div>
      </div>
    );
  }

  const connectRow = (
    <div className="relay-connect-bar">
      <RobotSelect options={robotOptions} value={selectedName} onChange={setSelectedName} />
      <button type="button" data-testid="relay-connect" disabled={connectDisabled} onClick={handleConnect}>
        {child ? "Switch" : "Connect"}
      </button>
      {child && (
        <button type="button" data-testid="relay-disconnect" onClick={() => onDisconnect(child.link.id)}>
          Disconnect
        </button>
      )}
    </div>
  );

  const statusParagraph =
    status.kind === "connected" ? (
      <p className="relay-connected-status" data-testid="relay-connected">
        {status.text}
      </p>
    ) : status.kind === "lost" ? (
      <p className="relay-page-alert" role="alert" data-testid="relay-lost">
        {status.text}
      </p>
    ) : status.kind === "connecting" ? (
      <p className="relay-autoconnecting-status" role="status" data-testid="relay-autoconnecting">
        {status.text}
      </p>
    ) : status.kind === "failed" ? (
      <p className="relay-page-alert" role="alert" data-testid="relay-bridge-failed">
        {status.text}
      </p>
    ) : (
      <p className="relay-idle-status" role="status" data-testid="relay-idle">
        {status.text}
      </p>
    );

  // `RelayPage.tsx`'s own pre-extraction order: the connected layout
  // shows its status line above the connect bar; the not-connected
  // layout shows the connect bar above its (bridging/idle) status line.
  // See this module's own doc comment.
  return child ? (
    <>
      {statusParagraph}
      {connectRow}
    </>
  ) : (
    <>
      {connectRow}
      {statusParagraph}
    </>
  );
}
