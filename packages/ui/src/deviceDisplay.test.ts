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
import type { EndpointListEntry, FirmwareAvailability } from "@robot-console/host/src/wsMessages.js";
import { canBeFlashed, firmwareDiagnosticDetail, firmwareDisabledReason } from "./deviceDisplay";

function device(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-SERIAL-A",
    transport: "usb",
    resourceKey: "usb-SERIAL-A",
    classification: { type: "unknown", role: null, commonName: null, dialect: null, evidence: "none", program: null, version: null },
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

/**
 * `firmwareDiagnosticDetail` (out-of-process, 2026-09-08): the
 * instructor-facing counterpart to `firmwareDisabledReason` -- pins the
 * reported real scenario (a `no-asset` failure naming the missing
 * `MICROBIT.hex`) reaching a renderable string, while confirming the
 * calm student-facing summary from `firmwareDisabledReason` is
 * untouched by this addition.
 */
describe("firmwareDiagnosticDetail", () => {
  const noAsset: FirmwareAvailability = {
    configured: true,
    repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
    tag: "v0.20260909.1",
    available: false,
    reason: "no-asset",
    message: "release v0.20260909.1 is missing MICROBIT.hex",
  };

  it("names the missing asset, repoUrl, and tag for a 'no-asset' failure, leaving the student-facing summary unchanged", () => {
    expect(firmwareDiagnosticDetail(noAsset)).toContain("MICROBIT.hex");
    expect(firmwareDiagnosticDetail(noAsset)).toContain(noAsset.repoUrl);
    expect(firmwareDiagnosticDetail(noAsset)).toContain(noAsset.tag);
    expect(firmwareDisabledReason(noAsset)).toBe(
      "The configured build can't be found — ask your instructor to check the setup.",
    );
  });

  it("is null when there is no message to add (e.g. 'no-releases', which has none in this fixture)", () => {
    const noReleases: FirmwareAvailability = {
      configured: true,
      repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
      tag: "latest",
      available: false,
      reason: "no-releases",
    };
    expect(firmwareDiagnosticDetail(noReleases)).toBeNull();
  });

  it("is null for an available firmware", () => {
    expect(
      firmwareDiagnosticDetail({
        configured: true,
        repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
        tag: "latest",
        available: true,
      }),
    ).toBeNull();
  });

  it("is null for an unconfigured firmware", () => {
    expect(firmwareDiagnosticDetail({ configured: false })).toBeNull();
  });

  it("is null for undefined (not-yet-received status)", () => {
    expect(firmwareDiagnosticDetail(undefined)).toBeNull();
  });

  it("is null for the pre-poll 'not-yet-checked' placeholder, which never ran a real check", () => {
    expect(
      firmwareDiagnosticDetail({
        configured: true,
        repoUrl: "https://github.com/League-Robotics/pxt-nezha-diffdrive",
        tag: "latest",
        available: false,
        reason: "not-yet-checked",
      }),
    ).toBeNull();
  });
});
