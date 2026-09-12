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
import type { FirmwareAvailability, SnapshotDevice, SnapshotLink, SnapshotRelay } from "@robot-console/host/src/wsMessages.js";
import {
  canBeFlashed,
  findRelayChild,
  findSweepingCandidateName,
  firmwareDiagnosticDetail,
  firmwareDisabledReason,
  isCalibrationProgram,
  lastCheckedText,
  linkStateText,
  nameDisplay,
  roleDisplay,
  sweepRateSuffix,
  SWEEP_LABEL_FRESH_MS,
} from "./deviceDisplay";

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

function device(overrides: Partial<Omit<SnapshotDevice, "links">> & { links?: SnapshotLink[] } = {}): SnapshotDevice {
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

/**
 * `linkStateText` (ticket 017-007): moved here from `FrontPage.tsx`'s
 * own former local `linkStatusText` -- these cases moved with it,
 * rather than being kept twice.
 */
describe("linkStateText", () => {
  const now = 1_000_000;

  it("renders Linked/Connecting for the live states", () => {
    expect(linkStateText(link({ state: "connected" }), now)).toBe("Linked");
    expect(linkStateText(link({ state: "connecting" }), now)).toBe("Connecting");
  });

  it("renders Retrying in Ns when failed with a pending retry", () => {
    expect(linkStateText(link({ state: "failed", nextRetryAt: now + 5000, reason: "timeout" }), now)).toBe("Retrying in 5s");
  });

  it("renders Unreachable: <reason> when failed with no pending retry", () => {
    expect(linkStateText(link({ state: "failed", reason: "no reply" }), now)).toBe("Unreachable: no reply");
  });

  it("renders Unresponsive (with reason) for the unresponsive state", () => {
    expect(linkStateText(link({ state: "unresponsive", reason: "HELLO timed out" }), now)).toBe("Unreachable: HELLO timed out");
    expect(linkStateText(link({ state: "unresponsive" }), now)).toBe("Unresponsive");
  });

  it("renders Not seen since <date> for a stale link with a lastSeen", () => {
    const lastSeen = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(linkStateText(link({ state: "stale", lastSeen }), now)).toContain("Not seen since");
  });

  it("renders Not linked for discovered/connectable/closed_by_user", () => {
    expect(linkStateText(link({ state: "discovered" }), now)).toBe("Not linked");
    expect(linkStateText(link({ state: "connectable" }), now)).toBe("Not linked");
    expect(linkStateText(link({ state: "closed_by_user" }), now)).toBe("Not linked");
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

/**
 * `findRelayChild`/`findSweepingCandidateName`/`lastCheckedText` (sprint
 * 016 ticket 004): moved here from `RelayPage.tsx`/`FrontPage.tsx`'s own
 * previously-duplicated copies, and fixed to guard against a sweep-only
 * sighting being mistaken for a live child.
 */
const RELAY_LINK_ID = "usb-relay-1";

function viaLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return link({
    id: "radio-x-via-usb-relay-1",
    transport: "radio",
    state: "connected",
    via: { relayLinkId: RELAY_LINK_ID, relayName: "rly01", channel: 41, group: 3, addressSource: "derived" },
    ...overrides,
  });
}

describe("findRelayChild", () => {
  it("finds a device whose link is actually connected via the relay", () => {
    const child = device({ id: 5, name: "vevov", links: [viaLink({ state: "connected" })] });
    expect(findRelayChild([child], RELAY_LINK_ID)?.device.name).toBe("vevov");
  });

  it("still finds a device whose bridge has dropped (failed/unresponsive) -- a real former child, not a sweep-only sighting", () => {
    const failed = device({ id: 5, name: "vevov", links: [viaLink({ state: "failed", reason: "no reply" })] });
    expect(findRelayChild([failed], RELAY_LINK_ID)?.device.name).toBe("vevov");
    const unresponsive = device({ id: 6, name: "gopiv", links: [viaLink({ id: "radio-y-via-usb-relay-1", state: "unresponsive" })] });
    expect(findRelayChild([unresponsive], RELAY_LINK_ID)?.device.name).toBe("gopiv");
  });

  it("does NOT count a sweep-only sighting (state connectable or discovered) as a live child", () => {
    const sweptOnly = device({ id: 5, name: "vevov", links: [viaLink({ state: "connectable" })] });
    expect(findRelayChild([sweptOnly], RELAY_LINK_ID)).toBeUndefined();
    const neverAnswered = device({ id: 6, name: "gopiv", links: [viaLink({ id: "radio-y-via-usb-relay-1", state: "discovered" })] });
    expect(findRelayChild([neverAnswered], RELAY_LINK_ID)).toBeUndefined();
  });

  it("returns undefined when no device has a via link to this relay", () => {
    expect(findRelayChild([device({ id: 5, links: [link()] })], RELAY_LINK_ID)).toBeUndefined();
  });
});

describe("findSweepingCandidateName", () => {
  const now = 1_000_000;

  it("names the most recently lastChecked device with a via link to this relay", () => {
    const older = device({ id: 5, name: "aaaaa", lastChecked: now - 1000, links: [viaLink({ state: "connectable" })] });
    const newer = device({
      id: 6,
      name: "bbbbb",
      lastChecked: now - 100,
      links: [viaLink({ id: "radio-y-via-usb-relay-1", state: "discovered" })],
    });
    expect(findSweepingCandidateName([older, newer], RELAY_LINK_ID, now)).toBe("bbbbb");
  });

  it("ignores a device whose last check has gone stale (beyond SWEEP_LABEL_FRESH_MS)", () => {
    const stale = device({
      id: 5,
      name: "aaaaa",
      lastChecked: now - SWEEP_LABEL_FRESH_MS - 1,
      links: [viaLink({ state: "connectable" })],
    });
    expect(findSweepingCandidateName([stale], RELAY_LINK_ID, now)).toBeUndefined();
  });

  it("ignores a device with no via link to this relay, even if recently checked", () => {
    const other = device({ id: 5, name: "aaaaa", lastChecked: now, links: [link()] });
    expect(findSweepingCandidateName([other], RELAY_LINK_ID, now)).toBeUndefined();
  });

  it("returns undefined when a device has never been checked at all", () => {
    const neverChecked = device({ id: 5, name: "aaaaa", lastChecked: null, links: [viaLink()] });
    expect(findSweepingCandidateName([neverChecked], RELAY_LINK_ID, now)).toBeUndefined();
  });
});

describe("lastCheckedText", () => {
  it("renders 'Last checked <time>' for a via link with a lastChecked timestamp", () => {
    const at = Date.UTC(2026, 8, 12, 10, 0, 0);
    const d = device({ lastChecked: at });
    const text = lastCheckedText(d, viaLink());
    expect(text).toContain("Last checked");
    expect(text).toContain(new Date(at).toLocaleString());
  });

  it("is undefined for a non-via link", () => {
    expect(lastCheckedText(device({ lastChecked: 100 }), link())).toBeUndefined();
  });

  it("is undefined when the device has never been checked", () => {
    expect(lastCheckedText(device({ lastChecked: null }), viaLink())).toBeUndefined();
  });
});

describe("sweepRateSuffix (ticket 016-007)", () => {
  const base: SnapshotRelay = { linkId: RELAY_LINK_ID, lease: "sweep" };

  it("renders ' (fast)' when sweep.rate is fast", () => {
    expect(sweepRateSuffix({ ...base, sweep: { rate: "fast" } })).toBe(" (fast)");
  });

  it("renders ' (slow)' when sweep.rate is slow", () => {
    expect(sweepRateSuffix({ ...base, sweep: { rate: "slow" } })).toBe(" (slow)");
  });

  it("is empty when sweep is null (no lease-acquisition sync has completed yet)", () => {
    expect(sweepRateSuffix({ ...base, sweep: null })).toBe("");
  });

  it("is empty when sweep is absent entirely (a pre-016-007 snapshot)", () => {
    expect(sweepRateSuffix(base)).toBe("");
  });

  it("is empty when relay itself is undefined (no relays[] entry at all)", () => {
    expect(sweepRateSuffix(undefined)).toBe("");
  });
});
