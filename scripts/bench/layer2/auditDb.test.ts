import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_TTL_MS,
  findDuplicateNameFindings,
  findRelayAsRobotFindings,
  findUsbPathMismatchFindings,
  findWouldBeHiddenRadioLinkFindings,
  runAuditChecks,
  type AuditDeviceRow,
  type AuditLinkRow,
} from "./auditDb.js";

const device = (over: Partial<AuditDeviceRow> = {}): AuditDeviceRow => ({
  id: 1,
  name: "gopiv",
  kind: "robot",
  role: "NEZHA2",
  last_seen: 1_000,
  ...over,
});

const link = (over: Partial<AuditLinkRow> = {}): AuditLinkRow => ({
  id: "link-1",
  device_id: 1,
  transport: "mbserial",
  address: "{}",
  state: "connected",
  state_reason: null,
  state_since: 1_000,
  last_seen: 1_000,
  ...over,
});

describe("findDuplicateNameFindings (real-row duplicate-device audit)", () => {
  it("passes clean when every name has exactly one row", () => {
    expect(findDuplicateNameFindings([device({ id: 1, name: "gopiv" }), device({ id: 2, name: "vevov" })])).toEqual([]);
  });

  it("flags the live 018-002/017-010-style defect and names the actual duplicate ids", () => {
    const findings = findDuplicateNameFindings([
      device({ id: 1461, name: "gopiv" }),
      device({ id: 2175407711, name: "gopiv" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe("one-row-per-name");
    expect(findings[0]?.detail).toContain("1461");
    expect(findings[0]?.detail).toContain("2175407711");
  });
});

describe("findRelayAsRobotFindings (real-row relay-as-robot audit)", () => {
  it("flags the live vevav-style defect: kind robot, role a relay banner", () => {
    const findings = findRelayAsRobotFindings([device({ id: 7, name: "vevav", kind: "robot", role: "RADIOBRIDGE" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.device).toBe("vevav");
    expect(findings[0]?.detail).toContain("RADIOBRIDGE");
  });

  it("passes when kind relay matches a relay role", () => {
    expect(findRelayAsRobotFindings([device({ kind: "relay", role: "RADIOBRIDGE" })])).toEqual([]);
  });

  it("passes when role is null (nothing to contradict at the DB-row level)", () => {
    expect(findRelayAsRobotFindings([device({ kind: "robot", role: null })])).toEqual([]);
  });
});

describe("findWouldBeHiddenRadioLinkFindings", () => {
  it("passes clean for a fresh, healthy radio link with a live relay", () => {
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", state: "connected", last_seen: 9_000 }),
      link({
        id: "radio-vevov-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1", channel: 37, group: 43 }),
        last_seen: 9_500,
      }),
    ];
    expect(findWouldBeHiddenRadioLinkFindings([device({ id: 1, name: "vevov" })], links, 10_000, 180_000)).toEqual([]);
  });

  it("flags a radio link whose relay link no longer exists", () => {
    const links: AuditLinkRow[] = [
      link({
        id: "radio-vevov-via-ghost",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-does-not-exist", channel: 37, group: 43 }),
        last_seen: 9_500,
      }),
    ];
    const findings = findWouldBeHiddenRadioLinkFindings([device({ id: 1, name: "vevov" })], links, 10_000, 180_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("no longer exists");
  });

  it("flags a radio link whose relay link itself is stale", () => {
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", state: "stale", last_seen: 1_000 }),
      link({
        id: "radio-vevov-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1", channel: 37, group: 43 }),
        last_seen: 9_500,
      }),
    ];
    const findings = findWouldBeHiddenRadioLinkFindings([device({ id: 1, name: "vevov" })], links, 10_000, 180_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("stale");
  });

  it("flags a radio link whose own last activity is older than the TTL -- the live '~14h ago' defect shape", () => {
    const fourteenHoursMs = 14 * 60 * 60 * 1000;
    const now = 20 * 60 * 60 * 1000;
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", state: "connected", last_seen: now - 60_000 }),
      link({
        id: "radio-gopiv-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1", channel: 47, group: 60 }),
        last_seen: now - fourteenHoursMs,
      }),
    ];
    const findings = findWouldBeHiddenRadioLinkFindings([device({ id: 1, name: "gopiv" })], links, now, DEFAULT_AUDIT_TTL_MS);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("would be hidden");
  });

  it("ignores non-radio/mbrelay transports entirely", () => {
    const links: AuditLinkRow[] = [link({ id: "usb-1", transport: "usb", last_seen: 0 })];
    expect(findWouldBeHiddenRadioLinkFindings([device()], links, 999_999_999, 180_000)).toEqual([]);
  });
});

describe("findUsbPathMismatchFindings", () => {
  it("passes clean when the reason's USB path matches the relay's current address", () => {
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", address: JSON.stringify({ path: "/dev/cu.usbmodem2121402" }) }),
      link({
        id: "radio-vevov-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1" }),
        state_reason: "connector: link \"usb-9906E2E782\" produced no banner (path /dev/cu.usbmodem2121402)",
      }),
    ];
    expect(findUsbPathMismatchFindings([device({ id: 1, name: "vevov" })], links)).toEqual([]);
  });

  it("flags the live stale-radio-link defect shape: state_reason names a USB path the relay no longer uses", () => {
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", address: JSON.stringify({ path: "/dev/cu.usbmodem2121999" }) }),
      link({
        id: "radio-gopiv-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1" }),
        state_reason: "connector: link failed via /dev/cu.usbmodem2121402",
      }),
    ];
    const findings = findUsbPathMismatchFindings([device({ id: 1, name: "gopiv" })], links);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.device).toBe("gopiv");
    expect(findings[0]?.detail).toContain("2121402");
    expect(findings[0]?.detail).toContain("2121999");
  });

  it("is silent when state_reason names no USB identifier at all", () => {
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", transport: "usb", address: JSON.stringify({ path: "/dev/cu.usbmodem2121999" }) }),
      link({
        id: "radio-gopiv-via-relay1",
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1" }),
        state_reason: "timed out waiting for a reply",
      }),
    ];
    expect(findUsbPathMismatchFindings([device()], links)).toEqual([]);
  });
});

describe("runAuditChecks", () => {
  it("reproduces the full live screenshot-defect shape in one pass: duplicate rows + relay-as-robot + stale radio link", () => {
    const now = 20 * 60 * 60 * 1000;
    const fourteenHoursMs = 14 * 60 * 60 * 1000;
    const devices: AuditDeviceRow[] = [
      device({ id: 1461, name: "gopiv", kind: "robot", role: "NEZHA2" }),
      device({ id: 2175407711, name: "gopiv", kind: "robot", role: "NEZHA2" }),
      device({ id: 7, name: "vevav", kind: "robot", role: null }),
    ];
    const links: AuditLinkRow[] = [
      link({ id: "usb-relay1", device_id: 7, transport: "usb", state: "connected", last_seen: now - 60_000, address: JSON.stringify({ path: "/dev/cu.usbmodem2121402" }) }),
      link({
        id: "radio-gopiv-via-relay1",
        device_id: 1461,
        transport: "radio",
        address: JSON.stringify({ relayLinkId: "usb-relay1", channel: 47, group: 60 }),
        last_seen: now - fourteenHoursMs,
        state_reason: "connector: link failed via /dev/cu.usbmodem2e78ghost",
      }),
    ];
    const findings = runAuditChecks(devices, links, { nowMs: now, ttlMs: DEFAULT_AUDIT_TTL_MS });
    const checks = findings.map((f) => f.check).sort();
    expect(checks).toEqual(["one-row-per-name", "usb-path-mismatch", "would-be-hidden-radio-link"]);
  });
});
