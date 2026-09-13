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
  connectionLabel,
  findRelayChild,
  findSweepingCandidateName,
  firmwareDiagnosticDetail,
  firmwareDisabledReason,
  isCalibrationProgram,
  isLinkAnswering,
  isLinkUsable,
  lastCheckedText,
  linkStateText,
  nameDisplay,
  plainFailureReason,
  roleDisplay,
  stripInternalIds,
  sweepRateSuffix,
  LINK_ANSWERED_FRESH_MS,
  STALE_ADVERTISED_GRACE_MS,
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

const OPEN_SESSION = { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null };

/** A session that has genuinely answered recently -- ticket 018-010's
 * own "Linked" criterion. `answeredAt` defaults to `Date.now()` at call
 * time (not a fixed constant) so it stays fresh regardless of when a
 * test happens to run; pass `now`/`answeredAt` explicitly wherever a
 * test needs both pinned to the same fixed clock. */
function answeredSession(answeredAt: number = Date.now()): NonNullable<SnapshotLink["session"]> {
  return { ...OPEN_SESSION, answeredAt };
}

describe("isLinkUsable (extended scope, team-lead 2026-09-13, item A)", () => {
  it("true only when state is 'connected' AND session is defined", () => {
    expect(isLinkUsable(link({ state: "connected", session: OPEN_SESSION }))).toBe(true);
  });

  it("false when session is defined but the link is not connected -- the exact bench bug (unresponsive link, session row kept)", () => {
    expect(isLinkUsable(link({ state: "unresponsive", session: OPEN_SESSION }))).toBe(false);
    expect(isLinkUsable(link({ state: "failed", session: OPEN_SESSION }))).toBe(false);
    expect(isLinkUsable(link({ state: "stale", session: OPEN_SESSION }))).toBe(false);
  });

  it("false when connected but no session is open yet", () => {
    expect(isLinkUsable(link({ state: "connected" }))).toBe(false);
  });

  it("false when neither connected nor a session exists", () => {
    expect(isLinkUsable(link({ state: "connectable" }))).toBe(false);
  });
});

/**
 * `isLinkAnswering` (ticket 018-010): the "Linked"/green-pill criterion
 * -- stricter than `isLinkUsable`, which only checks the transport is
 * open and a session object exists.
 */
describe("isLinkAnswering", () => {
  const now = 1_000_000;

  it("true when connected, session exists, and answeredAt is within the fresh window", () => {
    expect(isLinkAnswering(link({ state: "connected", session: answeredSession(now - 1000) }), now)).toBe(true);
  });

  it("false when not isLinkUsable at all (e.g. not connected)", () => {
    expect(isLinkAnswering(link({ state: "unresponsive", session: answeredSession(now) }), now)).toBe(false);
  });

  // Bench defect (vevov): a bridge that accepts TCP and flips state to
  // "connected" while the robot behind it never once answers HELLO --
  // `session` exists (opened) but has never actually answered anything.
  it("false when connected with a session that has never answered (answeredAt null/absent)", () => {
    expect(isLinkAnswering(link({ state: "connected", session: OPEN_SESSION }), now)).toBe(false);
    expect(isLinkAnswering(link({ state: "connected", session: { ...OPEN_SESSION, answeredAt: null } }), now)).toBe(false);
  });

  it("false once answeredAt has gone stale (beyond LINK_ANSWERED_FRESH_MS)", () => {
    expect(isLinkAnswering(link({ state: "connected", session: answeredSession(now - LINK_ANSWERED_FRESH_MS - 1) }), now)).toBe(false);
  });

  it("true right at the edge of the fresh window", () => {
    expect(isLinkAnswering(link({ state: "connected", session: answeredSession(now - LINK_ANSWERED_FRESH_MS) }), now)).toBe(true);
  });
});

describe("connectionLabel (moved from FrontPage.tsx, ticket 017-011)", () => {
  it("returns the link's own label when it is not a via-relay link", () => {
    expect(connectionLabel(link({ label: "USB · /dev/cu.usbmodemA" }))).toBe("USB · /dev/cu.usbmodemA");
  });

  it("appends '(via relay <name>)' for a via-relay link", () => {
    const viaLink = link({
      label: "Radio · ch47/grp60",
      via: { relayLinkId: "mbrelay-torture", relayName: "torture", channel: 47, group: 60, addressSource: "derived" },
    });
    expect(connectionLabel(viaLink)).toBe("Radio · ch47/grp60 (via relay torture)");
  });
});

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

  it("renders Linked only once the session has actually answered; Connecting otherwise", () => {
    expect(linkStateText(link({ state: "connected", session: answeredSession(now) }), now)).toBe("Linked");
    expect(linkStateText(link({ state: "connecting" }), now)).toBe("Connecting");
  });

  // Ticket 018-010 bench defect: `vevov`'s mbserial bridge accepted a
  // TCP connection and flipped `state` to "connected" while the robot
  // behind it never once answered HELLO -- the old criterion (`state ===
  // "connected"` alone) still called this "Linked".
  it("renders Connecting (not Linked) for a connected link whose session has never answered", () => {
    expect(linkStateText(link({ state: "connected", session: OPEN_SESSION }), now)).toBe("Connecting");
    expect(linkStateText(link({ state: "connected" }), now)).toBe("Connecting");
  });

  // Ticket 017-010 defect (team-lead walk 017-012, 2026-09-13): `gopiv`'s
  // WiFi row read "Retrying in 0s" forever -- a `failed` link whose
  // `nextRetryAt` had already passed (the reconciler never schedules a
  // second retry once the device has another connected link), which both
  // lied about an active retry and hid `reason` from the student
  // entirely. `failed`/`unresponsive` now always lead with "Couldn't
  // connect: <plain reason>", and the "· retrying in Ns" suffix appears
  // only while `nextRetryAt` is genuinely still in the future.
  it("failed with a past nextRetryAt shows the plain reason and no retry countdown at all (the gopiv bug)", () => {
    const text = linkStateText(
      link({ state: "failed", reason: "LineLink.connect() timed out after 5000ms", nextRetryAt: now - 240_000 }),
      now,
    );
    expect(text).toBe("Couldn't connect: no answer (timed out)");
    expect(text).not.toContain("Retrying");
    expect(text).not.toContain("retrying");
  });

  it("failed with a future nextRetryAt shows the plain reason plus a retrying-in-Ns suffix", () => {
    const text = linkStateText(
      link({ state: "failed", reason: "LineLink.connect() timed out after 5000ms", nextRetryAt: now + 5000 }),
      now,
    );
    expect(text).toBe("Couldn't connect: no answer (timed out) · retrying in 5s");
  });

  it("never shows a 0s or negative countdown -- a nextRetryAt within the current second still rounds up to at least 1s", () => {
    const text = linkStateText(link({ state: "failed", reason: "boom", nextRetryAt: now + 400 }), now);
    expect(text).toContain("retrying in 1s");
    expect(text).not.toContain("0s");
  });

  it("renders Couldn't connect: <reason> when failed with no pending retry", () => {
    expect(linkStateText(link({ state: "failed", reason: "no reply" }), now)).toBe("Couldn't connect: no reply");
  });

  it("renders Couldn't connect (with plain-word reason) for the unresponsive state", () => {
    expect(linkStateText(link({ state: "unresponsive", reason: "HELLO timed out" }), now)).toBe("Couldn't connect: no answer (timed out)");
    expect(linkStateText(link({ state: "unresponsive" }), now)).toBe("Couldn't connect");
  });

  it("maps a missed-STATUS-poll reason to 'stopped answering'", () => {
    expect(linkStateText(link({ state: "unresponsive", reason: "no reply to 3 STATUS polls -- link presumed dead" }), now)).toBe(
      "Couldn't connect: stopped answering",
    );
  });

  it("keeps a banner/serial identity-mismatch reason verbatim (it's already an actionable cable instruction)", () => {
    const reason = "banner identity gopiv disagrees with SWD name zeguz -- serial data corrupted, check the USB cable";
    expect(linkStateText(link({ state: "failed", reason }), now)).toBe(`Couldn't connect: ${reason}`);
  });

  // Ticket 017-010 (team-lead bench evidence, 2026-09-13): `tovez`'s card
  // read "Couldn't connect: connector: link "usb-9906…2820" produced no
  // banner within the identify budget" -- the internal module-name prefix
  // and quoted link id leaked straight through, and "no banner within the
  // identify budget" itself was never translated to plain words.
  it("strips the connector: prefix and quoted link id, and maps no-banner to a plain-word cable/power hint", () => {
    const reason = 'connector: link "usb-9906…2820" produced no banner within the identify budget';
    expect(linkStateText(link({ state: "failed", reason }), now)).toBe(
      "Couldn't connect: the robot didn't answer when we said hello — check the USB cable or that it's powered on",
    );
  });

  it("strips the relayBridger: prefix and quoted candidate id the same way", () => {
    const reason = 'relayBridger: candidate "radio-gopiv-via-mbrelay-torture" produced no banner within the identify budget';
    expect(linkStateText(link({ state: "unresponsive", reason }), now)).toBe(
      "Couldn't connect: the robot didn't answer when we said hello — check the USB cable or that it's powered on",
    );
  });

  it("strips the connector:/link id plumbing from a banner/serial mismatch reason but keeps the cable instruction itself", () => {
    const reason =
      'connector: link "usb-9906…2820" produced a banner whose name "ovz" does not match its own serial 231428700 -- serial data corrupted, check the USB cable';
    const text = linkStateText(link({ state: "failed", reason }), now);
    expect(text).toBe(
      'Couldn\'t connect: produced a banner whose name "ovz" does not match its own serial 231428700 -- serial data corrupted, check the USB cable',
    );
    expect(text).not.toContain("connector:");
    expect(text).not.toContain('link "usb-9906…2820"');
  });

  it("renders Not seen since <date> for a stale link with a long-past lastSeen", () => {
    const lastSeen = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(linkStateText(link({ state: "stale", lastSeen }), now)).toContain("Not seen since");
  });

  // Ticket 018-010 bench defect: the `torture` relay's own row read "Not
  // seen since 9/13/2026, 12:16:31 AM" although it was advertising right
  // now (`state: "stale"`, `last_seen` 0 minutes old) -- the aging
  // watcher marked it stale on its own schedule moments before (or
  // regardless of) a fresh observation of the still-present service.
  it("never renders Not seen since for a stale link whose lastSeen is still fresh (advertised right now)", () => {
    expect(linkStateText(link({ state: "stale", lastSeen: now }), now)).toBe("Not linked");
    expect(linkStateText(link({ state: "stale", lastSeen: now - STALE_ADVERTISED_GRACE_MS }), now)).toBe("Not linked");
  });

  it("renders Not seen since once lastSeen has actually gone beyond the advertised grace window", () => {
    expect(linkStateText(link({ state: "stale", lastSeen: now - STALE_ADVERTISED_GRACE_MS - 1 }), now)).toContain("Not seen since");
  });

  it("renders Not linked for discovered/connectable/closed_by_user", () => {
    expect(linkStateText(link({ state: "discovered" }), now)).toBe("Not linked");
    expect(linkStateText(link({ state: "connectable" }), now)).toBe("Not linked");
    expect(linkStateText(link({ state: "closed_by_user" }), now)).toBe("Not linked");
  });
});

/**
 * `stripInternalIds`/`plainFailureReason` (ticket 018-010): exported so
 * `RelayConnectControls.tsx` shares the exact same cleaning/wording
 * `linkStateText` above already used internally, instead of showing a
 * relay card's `reason`/bridging-error text raw. Every transport x
 * failure-reason combination named in the issue's own "Expected"
 * section is covered here directly (not only indirectly through
 * `linkStateText`), since `RelayConnectControls`'s own "Connection to
 * `<name>` lost" text calls `plainFailureReason` directly rather than
 * going through `linkStateText`.
 */
describe("plainFailureReason (transport-aware failure advice, ticket 018-010)", () => {
  it("gives USB-specific cable/power advice for a no-banner failure on a usb link", () => {
    expect(plainFailureReason("connector: link \"usb-1\" produced no banner within the identify budget", "usb")).toBe(
      "the robot didn't answer when we said hello — check the USB cable or that it's powered on",
    );
  });

  it("gives mbserial-specific bridge/farm advice for the same failure shape on an mbserial link", () => {
    expect(plainFailureReason('connector: link "mbserial-1" produced no banner within the identify budget', "mbserial")).toBe(
      "the bridge answered but the robot didn't — is the robot plugged into the farm and powered?",
    );
  });

  it("gives WiFi-specific network advice for the same failure shape on a wifi link", () => {
    expect(plainFailureReason('connector: link "wifi-1" produced no banner within the identify budget', "wifi")).toBe(
      "no answer from the robot over WiFi — is it on the network?",
    );
  });

  it("gives radio/relay-specific range advice for the same failure shape on radio/mbrelay links", () => {
    expect(
      plainFailureReason('relayBridger: candidate "radio-tigez-via-mbrelay-torture" produced no banner within the identify budget', "radio"),
    ).toBe("no radio reply — is the robot on and in range?");
    expect(
      plainFailureReason('relayBridger: candidate "mbrelay-tigez-via-mbrelay-torture" produced no banner within the identify budget', "mbrelay"),
    ).toBe("no radio reply — is the robot on and in range?");
  });

  // Ticket 018-010's own bench evidence: the quoted candidate id can
  // name a *different* robot than the one the link legitimately belongs
  // to -- must be stripped outright, never surfaced, regardless of
  // which name it happens to contain.
  it("strips a candidate id even when it names a different robot than the link's own device", () => {
    const reason = 'relayBridger: candidate "radio-tigez-via-mbrelay-torture" produced no banner within the identify budget';
    const text = plainFailureReason(reason, "radio");
    expect(text).not.toContain("tigez");
    expect(text).not.toContain("radio-tigez-via-mbrelay-torture");
  });

  it("keeps 018-008's own bridge-contention text verbatim, regardless of transport", () => {
    expect(plainFailureReason("another app is connected to this bridge", "mbserial")).toBe(
      "another app is connected to this bridge",
    );
    expect(plainFailureReason("another app is connected to this bridge", "wifi")).toBe(
      "another app is connected to this bridge",
    );
  });

  it("recognizes a USB port-lock error and gives port-lock advice, only for usb", () => {
    expect(plainFailureReason("Error: Opening /dev/tty.usbmodem1234: Resource busy", "usb")).toBe("another app has this board open");
    expect(plainFailureReason("Error: Opening COM3: Access denied, EBUSY", "usb")).toBe("another app has this board open");
  });

  // Bench evidence: a relay card read "Connection to <name> lost: Error:
  // No such file or directory..." verbatim -- a raw Node error with no
  // recognizable shape must still fall back to plain per-transport
  // advice, never be shown as-is.
  it("falls back to per-transport no-answer advice for an unrecognized raw system error", () => {
    expect(plainFailureReason("Error: No such file or directory, open '/dev/tty.usbmodem-relay-1'", "radio")).toBe(
      "no radio reply — is the robot on and in range?",
    );
    expect(plainFailureReason("Error: connect ECONNREFUSED 192.168.1.50:7654", "wifi")).toBe(
      "no answer from the robot over WiFi — is it on the network?",
    );
  });

  it("keeps a banner/serial identity-mismatch reason verbatim regardless of transport", () => {
    const reason = "banner identity gopiv disagrees with SWD name zeguz -- serial data corrupted, check the USB cable";
    expect(plainFailureReason(reason, "usb")).toBe(reason);
  });

  it("maps a missed-STATUS-poll reason to 'stopped answering' regardless of transport", () => {
    expect(plainFailureReason("no reply to 3 STATUS polls -- link presumed dead", "wifi")).toBe("stopped answering");
  });

  it("shows an unrecognized, already-plain reason verbatim", () => {
    expect(plainFailureReason("no reply", "radio")).toBe("no reply");
  });
});

describe("stripInternalIds", () => {
  it("removes a connector:/relayBridger: prefix and any quoted link/candidate id", () => {
    expect(stripInternalIds('connector: link "usb-9906…2820" produced no banner within the identify budget')).toBe(
      "produced no banner within the identify budget",
    );
    expect(stripInternalIds('relayBridger: candidate "radio-gopiv-via-mbrelay-torture" produced no banner within the identify budget')).toBe(
      "produced no banner within the identify budget",
    );
  });

  it("leaves an already-plain reason untouched", () => {
    expect(stripInternalIds("another app is connected to this bridge")).toBe("another app is connected to this bridge");
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

  // Ticket 018-010 bench evidence (`torture` relay card naming the wrong
  // robot): two different devices can each carry their own qualifying
  // via-linked link to the same relay at once (one bridged long ago and
  // now stale/failed, one bridged more recently and also now failed).
  // The freshest (`since`) one must win, not whichever happens to come
  // first in `devices[]`.
  it("picks the freshest (newest since) qualifying link when more than one device qualifies", () => {
    const older = device({ id: 5, name: "gopiv", links: [viaLink({ id: "radio-gopiv-via-usb-relay-1", state: "failed", since: 100 })] });
    const newer = device({ id: 6, name: "tigez", links: [viaLink({ id: "radio-tigez-via-usb-relay-1", state: "failed", since: 200 })] });
    // Order in `devices[]` deliberately puts the stale one first --
    // the old "first match wins" rule would have picked `gopiv`.
    expect(findRelayChild([older, newer], RELAY_LINK_ID)?.device.name).toBe("tigez");
    expect(findRelayChild([newer, older], RELAY_LINK_ID)?.device.name).toBe("tigez");
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
