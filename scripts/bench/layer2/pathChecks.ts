/**
 * pathChecks.ts — per-path `session-open` -> `send-command ID` (or, for
 * a relay-kind direct target, `?` -- 018-004, see below) -> assert
 * `line` reply -> `session-close` round trip against a real host, for
 * every path Layer 1 marked reachable (sprint 018 ticket 002).
 *
 * The link-lookup helpers below are pure functions over a narrow,
 * structural slice of `@robot-console/host`'s `Snapshot` shape, so they
 * are directly unit-testable against small fixtures; {@link checkPath}
 * itself drives a real {@link BenchWsClient} and is exercised only by
 * the live bench run (same split Layer 1's own `index.ts` orchestration
 * vs. its pure probe/classifier modules uses).
 *
 * ## Relays have no `ID` verb (018-004)
 *
 * A relay's own `!HELP` lists `HELLO` and `?`, never `ID` -- live bench
 * evidence (`vitut` via `usb`): `checkPath` used to send `ID` to every
 * target regardless of the underlying device's own `kind`, so a
 * usb-attached relay connected fine (Layer 1/the host's own identify
 * already speak `HELLO` universally) but then failed here waiting for
 * an `"id "` reply that a relay's command plane never sends. A
 * `"direct"` target now carries the device's own `deviceKind` (threaded
 * through from `index.ts`'s own Layer 1 report read) so this module can
 * probe a relay with `?` instead, and match its `# channel: ...` status
 * reply rather than `"id "`.
 *
 * `?`, not a second `HELLO`, on purpose: this module's own live-bench
 * verification (2026-09-13) found a relay does not reliably repeat its
 * full `DEVICE:RADIOBRIDGE:...` banner on a second `HELLO` sent *after*
 * the link is already `connected` (the connector's own identify already
 * consumed and answered the first one to reach that state at all --
 * `robot-wire-protocol-facts` memory: "Links' identify() consumes the
 * HELLO banner itself; it never reaches line listeners") -- `?` is a
 * live status query the relay's command plane always answers regardless
 * of session history, matching `layer1/usbProbe.ts`'s own already-proven
 * "banner via HELLO, then confirm via `?`" sequence for the exact same
 * hardware. A `"radio"` target's own `deviceName` is always a robot
 * reached *through* a relay, never a relay itself, so that variant
 * carries no `deviceKind` at all.
 */
import type { Snapshot, SnapshotDevice, SnapshotLink } from "@robot-console/host";
import type { BenchWsClient } from "./wsClient.js";
import type { Layer2Check } from "./types.js";

/** A Layer 2 check target: either a device's own direct link
 * (`usb`/`mbserial`/`wifi`), or a robot reached over radio through a
 * named relay pool -- the two `session-open` shapes the wire contract
 * defines (`wsMessages.ts`'s own `SessionOpenMessage` doc comment).
 * `deviceKind` on the `"direct"` variant is the Layer 1 report's own
 * `devices[].kind` string (`"robot"` | `"relay"` | ...) for this
 * target's device -- see this module's own doc comment, "Relays have
 * no ID verb". */
export type Layer2Target =
  | { kind: "direct"; deviceName: string; transport: "usb" | "mbserial" | "wifi"; deviceKind: string }
  | { kind: "radio"; deviceName: string; relayName: string };

/** Whether `target` names a relay -- see this module's own doc comment,
 * "Relays have no ID verb". Only a `"direct"` target can ever be one; a
 * `"radio"` target's `deviceName` is always the robot reached through
 * the relay, never the relay itself. */
export function isRelayTarget(target: Layer2Target): boolean {
  return target.kind === "direct" && target.deviceKind === "relay";
}

/** A relay's `?` status reply, verbatim -- live-observed shape (this
 * ticket's own bench evidence): `# channel: 0 group: 10 mode: RAW250
 * power: 7`. Matched case-insensitively against the raw `line` rx text,
 * same convention as the `"id "` match below. */
export function isRelayStatusLine(line: string): boolean {
  return /^#\s*channel:/i.test(line.trim());
}

export function describeTarget(target: Layer2Target): string {
  return target.kind === "direct" ? `${target.deviceName} via ${target.transport}` : `${target.deviceName} via radio through relay "${target.relayName}"`;
}

/** Narrow, structural view of a `Snapshot` these helpers need --
 * exactly `devices`/`unassigned`, never the full 30-field type, so a
 * unit test fixture only needs these two arrays. */
export type SnapshotLike = Pick<Snapshot, "devices" | "unassigned">;

export type OpenPayload = { linkId: string } | { relayLinkId: string; name: string };

/**
 * Resolve the `session-open` payload for `target` against `snapshot`.
 * For a `"direct"` target, the device must already have a link of the
 * requested transport. For a `"radio"` target, `relayName`'s own
 * device must have an `"mbrelay"` link (its pool connectivity link) --
 * the radio child link itself does not need to exist yet (a `session-
 * open {relayLinkId, name}` is exactly what the reconciler uses to
 * create/reuse it — architecture.md §8 rule 6). `undefined` when the
 * snapshot has nothing to open yet (not identified, not discovered, or
 * the relay itself absent).
 */
export function resolveOpenPayload(snapshot: SnapshotLike, target: Layer2Target): OpenPayload | undefined {
  if (target.kind === "direct") {
    const device = snapshot.devices.find((d) => d.name === target.deviceName);
    const link = device?.links.find((l) => l.transport === target.transport);
    return link ? { linkId: link.id } : undefined;
  }
  const relayDevice = snapshot.devices.find((d) => d.name === target.relayName);
  const relayLink = relayDevice?.links.find((l) => l.transport === "mbrelay");
  return relayLink ? { relayLinkId: relayLink.id, name: target.deviceName } : undefined;
}

/** Find a link by its opaque id, across every device plus
 * `unassigned` -- never parses the id itself (architecture.md §9:
 * "Link ids are opaque. The UI never parses them."). */
export function findLinkById(snapshot: SnapshotLike, linkId: string): SnapshotLink | undefined {
  for (const device of snapshot.devices) {
    const link = device.links.find((l) => l.id === linkId);
    if (link) {
      return link;
    }
  }
  return snapshot.unassigned.find((l) => l.id === linkId);
}

/**
 * For a `"radio"` target, the child link the reconciler creates in
 * response to `session-open {relayLinkId, name}` is looked up by its
 * own `via.relayLinkId` match on `deviceName`'s device, never by
 * reconstructing the id string ourselves (that string is a host
 * implementation detail this harness must not depend on, even though
 * `server.ts`'s own source names a fixed shape for it today).
 */
export function findRadioChildLink(snapshot: SnapshotLike, deviceName: string, relayLinkId: string): SnapshotLink | undefined {
  const device = snapshot.devices.find((d) => d.name === deviceName);
  return device?.links.find((l) => l.transport === "radio" && l.via?.relayLinkId === relayLinkId);
}

/** The device (row) this target's watched link belongs to, if any --
 * used only to read `kind`/`role` for the truthfulness assertions'
 * device list, not by {@link checkPath} itself. */
export function findDevice(snapshot: SnapshotLike, name: string): SnapshotDevice | undefined {
  return snapshot.devices.find((d) => d.name === name);
}

export interface CheckPathOptions {
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_REPLY_TIMEOUT_MS = 5_000;

export function skippedCheck(reason: string): Layer2Check {
  return { status: "skipped", reason, timings: {}, replies: {}, notices: [] };
}

function failCheck(reason: string, partial: Partial<Layer2Check> = {}): Layer2Check {
  return { status: "fail", reason, timings: {}, replies: {}, notices: [], ...partial };
}

/**
 * Run one path's full round trip: `session-open` -> wait for
 * `state: "connected"` with a session (bounded
 * {@link DEFAULT_CONNECT_TIMEOUT_MS}) -> `send-command {verb: "ID"}` ->
 * wait for a matching `line` rx (bounded {@link DEFAULT_REPLY_TIMEOUT_MS})
 * -> `session-close`. On any failure, the link's own `state`/`reason`
 * plus every notice seen for it are carried verbatim into the result --
 * this harness records the defect faithfully, it never retries or
 * works around it (per the ticket's own instruction).
 */
export async function checkPath(client: BenchWsClient, target: Layer2Target, options: CheckPathOptions = {}): Promise<Layer2Check> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

  const openSnapshot = client.snapshot;
  if (openSnapshot === undefined) {
    return failCheck("no snapshot received from the host yet");
  }
  const openPayload = resolveOpenPayload(openSnapshot, target);
  if (openPayload === undefined) {
    return failCheck(`no link found in the snapshot for ${describeTarget(target)}`);
  }

  const startedAt = Date.now();
  client.sessionOpen(openPayload);

  let watchLinkId: string | undefined = "linkId" in openPayload ? openPayload.linkId : undefined;
  const connectedSnapshot = await client.waitForSnapshot((snapshot) => {
    if (watchLinkId === undefined) {
      // Radio target: the child link only exists once the reconciler
      // has created/reused it in response to the session-open above.
      const relayLinkId = (openPayload as { relayLinkId: string }).relayLinkId;
      const child = findRadioChildLink(snapshot, target.deviceName, relayLinkId);
      if (child === undefined) {
        return false;
      }
      watchLinkId = child.id;
    }
    const link = findLinkById(snapshot, watchLinkId);
    return link !== undefined && link.state === "connected" && link.session !== undefined;
  }, connectTimeoutMs);

  const toConnectedMs = Date.now() - startedAt;

  if (connectedSnapshot === undefined || watchLinkId === undefined) {
    const lastKnownLinkId = watchLinkId ?? ("linkId" in openPayload ? openPayload.linkId : undefined);
    const lastKnown = lastKnownLinkId !== undefined ? findLinkById(client.snapshot ?? openSnapshot, lastKnownLinkId) : undefined;
    const notices = lastKnownLinkId !== undefined ? client.noticesFor(lastKnownLinkId).map((n) => n.text) : [];
    return {
      status: "fail",
      reason:
        lastKnown !== undefined
          ? `never reached state "connected" with a session within ${connectTimeoutMs}ms -- last seen state "${lastKnown.state}"${lastKnown.reason ? ` (${lastKnown.reason})` : ""}`
          : `never reached state "connected" with a session within ${connectTimeoutMs}ms -- link never appeared in any snapshot`,
      timings: { toConnectedMs },
      replies: {},
      notices,
    };
  }

  const linkId = watchLinkId;
  // 018-004: a relay has no `ID` verb (`!HELP` lists `HELLO` and `?`,
  // not `ID`) -- probe it with `?` instead and match its own `# channel:
  // ...` status reply rather than an `"id "` reply. See this module's
  // own doc comment, "Relays have no ID verb", for why `?` and not a
  // second `HELLO`.
  const relay = isRelayTarget(target);
  const probeVerb = relay ? "?" : "ID";
  const matchesReply = relay ? isRelayStatusLine : (line: string) => line.trim().toLowerCase().startsWith("id ");
  const expectedDescription = relay ? '"# channel:" (relay status reply)' : '"id "';

  client.sendCommand(linkId, probeVerb);
  const replyStartedAt = Date.now();
  const replyLine = await client.waitForLine(linkId, matchesReply, replyTimeoutMs);
  const toReplyMs = Date.now() - replyStartedAt;
  const notices = client.noticesFor(linkId).map((n) => n.text);

  client.sessionClose(linkId);

  if (replyLine === undefined) {
    const link = findLinkById(connectedSnapshot, linkId);
    return {
      status: "fail",
      reason: `connected, but no "line" rx matching ${expectedDescription} within ${replyTimeoutMs}ms of send-command ${probeVerb}${link ? ` -- link state "${link.state}"${link.reason ? ` (${link.reason})` : ""}` : ""}`,
      timings: { toConnectedMs, toReplyMs },
      replies: {},
      notices,
    };
  }

  return {
    status: "pass",
    reason: `session-open -> connected -> send-command ${probeVerb} -> matching line rx -> session-close (reply: ${replyLine})`,
    timings: { toConnectedMs, toReplyMs },
    replies: { line: replyLine },
    notices,
  };
}
