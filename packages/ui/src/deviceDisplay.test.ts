/**
 * deviceDisplay.test.ts — unit tests for the presentational/gating
 * helpers in `deviceDisplay.ts`.
 *
 * `canBeFlashed` (ticket 012-001): a truth table across all four
 * `(role, sessionError)` combinations, pinning the fix for the bug
 * where a silent, unflashed board (`role: null`, `sessionError:
 * undefined`) got no flash controls because the old flash-gating
 * predicate required `sessionError` to be set.
 */
import { describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { canBeFlashed } from "./deviceDisplay";

function device(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none" },
    name: "zeguz",
    role: null,
    sessionOpen: false,
    usb: { serialNumber: "SERIAL-A-FULL", displaySerial: "0002", port: "/dev/cu.usbmodemA" },
    ...overrides,
  };
}

describe("canBeFlashed", () => {
  it("is true for role: null, sessionError: undefined -- the silent, unflashed board case (the reported bug)", () => {
    expect(canBeFlashed(device({ role: null }))).toBe(true);
  });

  it("is true for role: null, sessionError set -- the failed-identify case", () => {
    expect(canBeFlashed(device({ role: null, sessionError: "HELLO reply timed out after 2000ms" }))).toBe(true);
  });

  it("is false for an identified device with role set, sessionError: undefined", () => {
    expect(canBeFlashed(device({ role: "RADIORELAY" }))).toBe(false);
  });

  it("is false for role set even if sessionError is (unusually) also set", () => {
    expect(canBeFlashed(device({ role: "NEZHA2", sessionError: "stray error" }))).toBe(false);
  });
});
