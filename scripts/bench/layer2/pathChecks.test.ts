import { describe, expect, it } from "vitest";
import { resolveOpenPayload, findLinkById, findRadioChildLink, closeSiblingLinks, describeTarget, isRelayTarget, isRelayStatusLine, type SnapshotLike, type SiblingCloseClient } from "./pathChecks.js";

/** Minimal fixture builder -- only the fields these pure helpers read. */
function makeSnapshot(
  devices: Array<{ name: string; links: Array<{ id: string; transport: string; via?: { relayLinkId: string } }> }>,
  unassigned: Array<{ id: string; transport: string }> = [],
): SnapshotLike {
  return {
    devices: devices.map((d) => ({
      id: 1,
      name: d.name,
      kind: "robot",
      role: null,
      program: null,
      version: null,
      owned: true,
      radio: { channel: 0, group: 0, source: "derived" },
      lastSeen: 0,
      lastChecked: null,
      links: d.links.map((l) => ({
        id: l.id,
        transport: l.transport,
        label: "",
        state: "connected",
        reason: null,
        since: 0,
        lastSeen: null,
        nextRetryAt: null,
        ...(l.via ? { via: { ...l.via, relayName: "torture", channel: 1, group: 1, addressSource: "derived" } } : {}),
        capabilities: { open: true, close: true, flash: false, provisionWifi: false },
      })),
    })) as unknown as SnapshotLike["devices"],
    unassigned: unassigned.map((l) => ({
      id: l.id,
      transport: l.transport,
      label: "",
      state: "discovered",
      reason: null,
      since: 0,
      lastSeen: null,
      nextRetryAt: null,
      capabilities: { open: true, close: true, flash: false, provisionWifi: false },
    })) as unknown as SnapshotLike["unassigned"],
  };
}

describe("describeTarget", () => {
  it("describes a direct target", () => {
    expect(describeTarget({ kind: "direct", deviceName: "gopiv", transport: "mbserial", deviceKind: "robot" })).toBe("gopiv via mbserial");
  });
  it("describes a radio target", () => {
    expect(describeTarget({ kind: "radio", deviceName: "gopiv", relayName: "torture" })).toContain("torture");
  });
});

describe("resolveOpenPayload", () => {
  it("direct: returns {linkId} when the device has a link of the requested transport", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] }]);
    expect(resolveOpenPayload(snapshot, { kind: "direct", deviceName: "gopiv", transport: "mbserial", deviceKind: "robot" })).toEqual({ linkId: "mbserial-gopiv" });
  });

  it("direct: undefined when the device exists but has no link of that transport", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] }]);
    expect(resolveOpenPayload(snapshot, { kind: "direct", deviceName: "gopiv", transport: "wifi", deviceKind: "robot" })).toBeUndefined();
  });

  it("direct: undefined when the device is not in the snapshot at all", () => {
    const snapshot = makeSnapshot([]);
    expect(resolveOpenPayload(snapshot, { kind: "direct", deviceName: "gopiv", transport: "usb", deviceKind: "robot" })).toBeUndefined();
  });

  it("radio: returns {relayLinkId, name} from the relay pool's own mbrelay link", () => {
    const snapshot = makeSnapshot([{ name: "torture", links: [{ id: "mbrelay-torture", transport: "mbrelay" }] }]);
    expect(resolveOpenPayload(snapshot, { kind: "radio", deviceName: "gopiv", relayName: "torture" })).toEqual({
      relayLinkId: "mbrelay-torture",
      name: "gopiv",
    });
  });

  it("radio: undefined when the named relay has no mbrelay link", () => {
    const snapshot = makeSnapshot([{ name: "torture", links: [{ id: "usb-torture", transport: "usb" }] }]);
    expect(resolveOpenPayload(snapshot, { kind: "radio", deviceName: "gopiv", relayName: "torture" })).toBeUndefined();
  });
});

describe("findLinkById", () => {
  it("finds a link nested under a device", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] }]);
    expect(findLinkById(snapshot, "mbserial-gopiv")?.transport).toBe("mbserial");
  });

  it("finds a link in unassigned when no device owns it", () => {
    const snapshot = makeSnapshot([], [{ id: "usb-unknown", transport: "usb" }]);
    expect(findLinkById(snapshot, "usb-unknown")?.transport).toBe("usb");
  });

  it("returns undefined for an id present nowhere", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] }]);
    expect(findLinkById(snapshot, "does-not-exist")).toBeUndefined();
  });
});

describe("findRadioChildLink", () => {
  it("finds the radio child link by via.relayLinkId, not by reconstructing the id string", () => {
    const snapshot = makeSnapshot([
      {
        name: "gopiv",
        links: [{ id: "radio-gopiv-via-mbrelay-torture", transport: "radio", via: { relayLinkId: "mbrelay-torture" } }],
      },
    ]);
    const link = findRadioChildLink(snapshot, "gopiv", "mbrelay-torture");
    expect(link?.id).toBe("radio-gopiv-via-mbrelay-torture");
  });

  it("undefined when the device has a radio link via a different relay", () => {
    const snapshot = makeSnapshot([
      { name: "gopiv", links: [{ id: "radio-x", transport: "radio", via: { relayLinkId: "some-other-relay" } }] },
    ]);
    expect(findRadioChildLink(snapshot, "gopiv", "mbrelay-torture")).toBeUndefined();
  });

  it("undefined before the child link has ever been created", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [] }]);
    expect(findRadioChildLink(snapshot, "gopiv", "mbrelay-torture")).toBeUndefined();
  });
});

// 018-007 Step 0: closes every other currently-connected link on a
// device before a radio/wifi check, so a reply can only ever have come
// from the path under test -- see closeSiblingLinks's own doc comment.
describe("closeSiblingLinks", () => {
  function fakeClient(snapshot: SnapshotLike): { client: SiblingCloseClient; closed: string[] } {
    const closed: string[] = [];
    return {
      client: {
        snapshot,
        sessionClose: (linkId: string) => {
          closed.push(linkId);
        },
      },
      closed,
    };
  }

  it("closes every other connected link, keeping the one named", () => {
    const snapshot = makeSnapshot([
      {
        name: "gopiv",
        links: [
          { id: "mbserial-gopiv", transport: "mbserial" },
          { id: "radio-gopiv-via-torture", transport: "radio" },
        ],
      },
    ]);
    const { client, closed } = fakeClient(snapshot);
    expect(closeSiblingLinks(client, "gopiv", "radio-gopiv-via-torture")).toEqual(["mbserial-gopiv"]);
    expect(closed).toEqual(["mbserial-gopiv"]);
  });

  it("closes every connected link when keepLinkId is undefined (radio target: the child link doesn't exist yet)", () => {
    const snapshot = makeSnapshot([{ name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] }]);
    const { client, closed } = fakeClient(snapshot);
    expect(closeSiblingLinks(client, "gopiv", undefined)).toEqual(["mbserial-gopiv"]);
    expect(closed).toEqual(["mbserial-gopiv"]);
  });

  it("returns [] when no snapshot has arrived yet", () => {
    const client: SiblingCloseClient = { snapshot: undefined, sessionClose: () => undefined };
    expect(closeSiblingLinks(client, "gopiv", undefined)).toEqual([]);
  });

  it("returns [] when the device is absent from the snapshot", () => {
    const { client } = fakeClient(makeSnapshot([]));
    expect(closeSiblingLinks(client, "gopiv", undefined)).toEqual([]);
  });

  it("never touches a different device's links (e.g. the relay pool's own connectivity link)", () => {
    const snapshot = makeSnapshot([
      { name: "gopiv", links: [{ id: "mbserial-gopiv", transport: "mbserial" }] },
      { name: "torture", links: [{ id: "mbrelay-torture", transport: "mbrelay" }] },
    ]);
    const { client, closed } = fakeClient(snapshot);
    closeSiblingLinks(client, "gopiv", undefined);
    expect(closed).toEqual(["mbserial-gopiv"]);
  });
});

// 018-004: a relay has no `ID` verb -- see pathChecks.ts's own doc
// comment, "Relays have no ID verb".
describe("isRelayTarget", () => {
  it("true for a direct target whose deviceKind is relay", () => {
    expect(isRelayTarget({ kind: "direct", deviceName: "vitut", transport: "usb", deviceKind: "relay" })).toBe(true);
  });

  it("false for a direct target whose deviceKind is robot", () => {
    expect(isRelayTarget({ kind: "direct", deviceName: "gopiv", transport: "usb", deviceKind: "robot" })).toBe(false);
  });

  it("false for a radio target -- its deviceName is always the robot reached through the relay, never the relay itself", () => {
    expect(isRelayTarget({ kind: "radio", deviceName: "gopiv", relayName: "torture" })).toBe(false);
  });
});

describe("isRelayStatusLine", () => {
  it("matches a relay's own '?' status reply", () => {
    expect(isRelayStatusLine("# channel: 0 group: 10 mode: RAW250 power: 7")).toBe(true);
  });

  it("matches case-insensitively and with surrounding whitespace", () => {
    expect(isRelayStatusLine("  # CHANNEL: 5 group: 2  ")).toBe(true);
  });

  it("does not match an id reply, a HELLO banner, or an unrelated line", () => {
    expect(isRelayStatusLine("id gopiv NEZHA2 v1.2.3")).toBe(false);
    expect(isRelayStatusLine("DEVICE:RADIOBRIDGE:relay:vitut:2198604104")).toBe(false);
  });
});
