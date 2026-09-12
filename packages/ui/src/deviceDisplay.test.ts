/**
 * deviceDisplay.test.ts — unit tests for the presentational/gating
 * helpers in `deviceDisplay.ts`.
 *
 * `canBeFlashed` (sprint 015 ticket 007): now a direct read of
 * `SnapshotLink.capabilities.flash`, the host-computed capability
 * (`projection.ts`: true for any `usb` link) that replaces the old
 * UI-side `role === null` guess -- see `deviceDisplay.ts`'s own doc
 * comment for why flashability moved from device to link.
 */
import { describe, expect, it } from "vitest";
import type { FirmwareAvailability, SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { canBeFlashed, firmwareDiagnosticDetail, firmwareDisabledReason, isCalibrationProgram, nameDisplay, roleDisplay } from "./deviceDisplay";

function link(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: "usb-SERIAL-A",
    transport: "usb",
    label: "USB · /dev/cu.usbmodemA",
    state: "connectable",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: true, close: false, flash: true, provisionWifi: false },
    ...overrides,
  };
}

function device(overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "zeguz",
    kind: "robot",
    role: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 1, group: 1, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [link()],
    ...overrides,
  };
}

describe("canBeFlashed", () => {
  it("is true for a usb link with capabilities.flash true, regardless of the owning device's role", () => {
    expect(canBeFlashed(link({ capabilities: { open: true, close: false, flash: true, provisionWifi: false } }))).toBe(true);
  });

  it("is false for a link with capabilities.flash false (e.g. a non-usb transport)", () => {
    expect(canBeFlashed(link({ transport: "wifi", capabilities: { open: true, close: false, flash: false, provisionWifi: false } }))).toBe(
      false,
    );
  });
});

describe("nameDisplay / roleDisplay", () => {
  it("nameDisplay always returns the device's resolved name, unflagged", () => {
    expect(nameDisplay(device({ name: "tigez" }))).toEqual({ text: "tigez", flagged: false });
  });

  it("roleDisplay returns the announced role, or a calm placeholder when none has been announced", () => {
    expect(roleDisplay(device({ role: "NEZHA2" }))).toBe("NEZHA2");
    expect(roleDisplay(device({ role: null }))).toBe("No role announced");
  });
});

describe("isCalibrationProgram", () => {
  it("is true only for a program name prefixed calibration-", () => {
    expect(isCalibrationProgram("calibration-0.20260907.2")).toBe(true);
    expect(isCalibrationProgram("diffdrive")).toBe(false);
    expect(isCalibrationProgram(null)).toBe(false);
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
