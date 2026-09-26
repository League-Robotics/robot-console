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
  cardLinks,
  connectionLabel,
  currentRelayChild,
  findRelayChild,
  findSweepingCandidateName,
  firmwareDiagnosticDetail,
  firmwareDisabledReason,
  firmwareSourceText,
  hiddenLinkCount,
  isCalibrationProgram,
  isLinkAnswering,
  isLinkUsable,
  lastCheckedText,
  linkStateText,
  nameDisplay,
  plainFailureReason,
  programVersionText,
  relativeTimeText,
  releaseDisplayName,
  repoShortName,
  roleDisplay,
  stripInternalIds,
  sweepRateSuffix,
  LINK_ANSWERED_FRESH_MS,
  RELAY_CHILD_RECENT_MS,
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
    commonName: null,
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

  it("roleDisplay returns the announced role, whatever the device's kind", () => {
    expect(roleDisplay(device({ role: "NEZHA2" }))).toBe("NEZHA2");
    expect(roleDisplay(device({ kind: "relay", role: "RADIOBRIDGE" }))).toBe("RADIOBRIDGE");
  });

  it("018-010 item 3: a robot with no announced role falls back to a plain 'Role unknown'", () => {
    expect(roleDisplay(device({ kind: "robot", role: null }))).toBe("Role unknown");
  });

  it("018-016/018-017: a robot with commonName, role, and a program all known joins them with ' · ', using the program's own release version (not device.version)", () => {
    expect(
      roleDisplay(
        device({ commonName: "robot", role: "NEZHA2", program: "calibration-0.20260913.1", version: "1.20260912.8" }),
      ),
    ).toBe("robot · NEZHA2 · 0.20260913.1");
  });

  it("018-016: a robot with no program yet omits the third part, joining just commonName and role", () => {
    expect(roleDisplay(device({ commonName: "robot", role: "NEZHA2", program: null }))).toBe("robot · NEZHA2");
  });

  it("018-016/018-017: a robot with no commonName omits it, joining just role and the program's release version", () => {
    expect(roleDisplay(device({ commonName: null, role: "NEZHA2", program: "calibration-0.20260913.1" }))).toBe(
      "NEZHA2 · 0.20260913.1",
    );
  });

  it("018-016: a robot with only commonName known shows just that", () => {
    expect(roleDisplay(device({ commonName: "robot", role: null, program: null }))).toBe("robot");
  });

  it("018-016: a robot with nothing known at all (commonName, role, program all null) falls back to 'Role unknown'", () => {
    expect(roleDisplay(device({ commonName: null, role: null, program: null }))).toBe("Role unknown");
  });

  // 018-017: stakeholder-found defect the same day as 018-016 -- the
  // card was showing `device.version` (the pxt-nezha-diffdrive library
  // version, e.g. "1.20260912.8") as "the" version. It must never
  // appear in the identity line at all any more, regardless of what it
  // is set to -- only the program-derived release version does.
  it("018-017: device.version never appears in the identity line, even when it differs from the program's release version", () => {
    expect(
      roleDisplay(
        device({ commonName: "robot", role: "NEZHA2", program: "calibration-0.20260913.1", version: "9.9.9" }),
      ),
    ).toBe("robot · NEZHA2 · 0.20260913.1");
  });

  it("018-017: a non-calibration program string is shown unchanged (no parsing assumed) as the third part", () => {
    expect(roleDisplay(device({ commonName: "robot", role: "NEZHA2", program: "diffdrive" }))).toBe(
      "robot · NEZHA2 · diffdrive",
    );
  });

  it("018-016: relays are unaffected by commonName -- role text is unchanged even when commonName is set", () => {
    expect(roleDisplay(device({ kind: "relay", role: "RADIOBRIDGE", commonName: "relay" }))).toBe("RADIOBRIDGE");
  });

  it("018-010 item 3: a relay with no announced role is labeled by its links' own transport -- mbrelay host", () => {
    expect(
      roleDisplay(device({ kind: "relay", role: null, links: [link({ id: "mbrelay-torture", transport: "mbrelay" })] })),
    ).toBe("mbrelay host");
  });

  it("018-010 item 3: ... or mbserial host, for a serial-bridge farm host", () => {
    expect(
      roleDisplay(device({ kind: "relay", role: null, links: [link({ id: "mbserial-gopiv", transport: "mbserial" })] })),
    ).toBe("mbserial host");
  });

  it("018-010 item 3: a relay with no announced role and no mbrelay/mbserial link falls back to 'Role unknown' too", () => {
    expect(roleDisplay(device({ kind: "relay", role: null, links: [link({ id: "usb-SERIAL-A", transport: "usb" })] }))).toBe(
      "Role unknown",
    );
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

  // Ticket 018-010 bench defect: `vevav`'s own front-page card row read
  // the robot-shaped "check the USB cable or that it's powered on" for a
  // relay's own no-answer link. `kind` (the owning device's own kind,
  // threaded from `FrontPage.tsx`'s `DeviceConnectionRow`/`AppHeader.tsx`)
  // picks relay-shaped wording instead when passed "relay", and defaults
  // to "robot" wording (every test above, which never passes it) when
  // omitted.
  it("gives relay-shaped advice when kind is 'relay', leaving every other call site's default untouched", () => {
    const reason = 'connector: link "usb-1" produced no banner within the identify budget';
    expect(linkStateText(link({ state: "failed", reason }), now, "relay")).toBe(
      "Couldn't connect: the relay didn't answer when we said hello — it may be parked in the data plane; unplug and replug it to reset",
    );
    expect(linkStateText(link({ state: "failed", reason }), now, "robot")).toBe(
      "Couldn't connect: the robot didn't answer when we said hello — check the USB cable or that it's powered on",
    );
    expect(linkStateText(link({ state: "failed", reason }), now)).toBe(
      "Couldn't connect: the robot didn't answer when we said hello — check the USB cable or that it's powered on",
    );
  });

  /**
   * Sprint 018 ticket 008 (SUC-005/SUC-006): end-to-end verification of
   * the lock-reason text ticket 003's `mbregistryStream.ts#open()`
   * already produces (`formatLockedMessage`) all the way through this
   * shared `linkStateText`/front-page pipeline -- no new UI component,
   * since `stripInternalIds`/`plainFailureReason` don't recognize (and so
   * don't mangle) any of these "in use..." shapes; they pass through
   * verbatim, exactly as an unrecognized-but-clean reason already does
   * for any other transport's failure message.
   */
  it("renders a locked-device reason with the holder's label, verbatim", () => {
    expect(linkStateText(link({ state: "failed", reason: "in use by alice-laptop" }), now)).toBe(
      "Couldn't connect: in use by alice-laptop",
    );
  });

  it("renders the plain 'in use' reason with no label -- no undefined/null substring leaks in", () => {
    const text = linkStateText(link({ state: "failed", reason: "in use" }), now);
    expect(text).toBe("Couldn't connect: in use");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  it("renders the stale-lock hint verbatim, including the mbregistry unlock --force command", () => {
    const reason =
      "in use by alice-laptop -- stale; run `mbregistry unlock --force zeguz` on alice-laptop.local";
    const text = linkStateText(link({ state: "unresponsive", reason }), now);
    expect(text).toBe(`Couldn't connect: ${reason}`);
    expect(text).toContain("mbregistry unlock --force zeguz");
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

  it("keeps 018-008's own bridge-contention text verbatim for bridges, and says 'robot over Wi-Fi' for a wifi link", () => {
    expect(plainFailureReason("another app is connected to this bridge", "mbserial")).toBe(
      "another app is connected to this bridge",
    );
    expect(plainFailureReason("another app is connected to this bridge", "wifi")).toBe(
      "another connection is already open to this robot over Wi-Fi",
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

  // Ticket 018-010 bench defect: `vevav`, a RADIOBRIDGE relay plugged in
  // over USB, showed the robot-shaped "check the USB cable or that it's
  // powered on" advice for its own no-answer USB failure. `kind` (a
  // device's own kind, not the link's transport) picks relay-shaped
  // advice instead, for both a no-banner failure and an unrecognized raw
  // system error, and regardless of whether the relay's own link is
  // usb or mbrelay -- and defaults to "robot" wording when omitted, so
  // every pre-existing call site above is unaffected.
  it("gives relay-shaped 'parked in the data plane' advice for a relay device's own no-answer link, regardless of transport", () => {
    const relayAdvice = "the relay didn't answer when we said hello — it may be parked in the data plane; unplug and replug it to reset";
    expect(
      plainFailureReason('connector: link "usb-1" produced no banner within the identify budget', "usb", "relay"),
    ).toBe(relayAdvice);
    expect(
      plainFailureReason("Error: No such file or directory, open '/dev/cu.usbmodem-vevav'", "usb", "relay"),
    ).toBe(relayAdvice);
    expect(
      plainFailureReason('connector: link "mbrelay-1" produced no banner within the identify budget', "mbrelay", "relay"),
    ).toBe(relayAdvice);
    expect(plainFailureReason('connector: link "usb-1" produced no banner within the identify budget', "usb", "robot")).not.toBe(
      relayAdvice,
    );
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
    checkedAt: 1000,
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
      checkedAt: 1000,
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
        checkedAt: 1000,
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
        checkedAt: null,
        reason: "not-yet-checked",
      }),
    ).toBeNull();
  });
});

describe("018-017: repoShortName / releaseDisplayName / relativeTimeText / firmwareSourceText", () => {
  it("repoShortName returns a GitHub repo URL's final path segment", () => {
    expect(repoShortName("https://github.com/League-Robotics/nezha-robot-template")).toBe("nezha-robot-template");
    expect(repoShortName("https://github.com/League-Robotics/microbit-radio-relay")).toBe("microbit-radio-relay");
  });

  it("repoShortName tolerates a trailing slash", () => {
    expect(repoShortName("https://github.com/League-Robotics/nezha-robot-template/")).toBe("nezha-robot-template");
  });

  it("releaseDisplayName joins the repo's short name and tag", () => {
    expect(
      releaseDisplayName({
        configured: true,
        repoUrl: "https://github.com/League-Robotics/nezha-robot-template",
        tag: "v0.20260913.1",
        available: true,
        checkedAt: 1000,
      }),
    ).toBe("nezha-robot-template v0.20260913.1");
  });

  it("releaseDisplayName is null when nothing is configured, or the status is undefined", () => {
    expect(releaseDisplayName({ configured: false })).toBeNull();
    expect(releaseDisplayName(undefined)).toBeNull();
  });

  it("relativeTimeText reads 'just now' for anything under 45 seconds old", () => {
    expect(relativeTimeText(1_000_000 - 10_000, 1_000_000)).toBe("just now");
  });

  it("relativeTimeText reads minutes, then hours, then falls back to a locale string past a day", () => {
    const now = 1_000_000_000;
    expect(relativeTimeText(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTimeText(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTimeText(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
    expect(relativeTimeText(now - 25 * 60 * 60_000, now)).toBe(new Date(now - 25 * 60 * 60_000).toLocaleString());
  });

  it("firmwareSourceText returns the release page link, tag, and 'checked ...' text for a configured release", () => {
    const now = 1_000_000;
    const info = firmwareSourceText(
      {
        configured: true,
        repoUrl: "https://github.com/League-Robotics/nezha-robot-template",
        tag: "v0.20260913.1",
        available: true,
        checkedAt: now - 5 * 60_000,
      },
      now,
    );
    expect(info).toEqual({
      href: "https://github.com/League-Robotics/nezha-robot-template/releases/tag/v0.20260913.1",
      repoName: "nezha-robot-template",
      tag: "v0.20260913.1",
      checkedText: "checked 5 minutes ago",
    });
  });

  it("firmwareSourceText is null when nothing is configured, or the status is undefined", () => {
    expect(firmwareSourceText({ configured: false })).toBeNull();
    expect(firmwareSourceText(undefined)).toBeNull();
  });

  it("firmwareSourceText says 'checked: never' when checkedAt is null (configured but never polled)", () => {
    expect(
      firmwareSourceText({
        configured: true,
        repoUrl: "https://github.com/League-Robotics/nezha-robot-template",
        tag: "latest",
        available: false,
        checkedAt: null,
        reason: "not-yet-checked",
      }),
    ).toEqual({
      href: "https://github.com/League-Robotics/nezha-robot-template/releases/tag/latest",
      repoName: "nezha-robot-template",
      tag: "latest",
      checkedText: "checked: never",
    });
  });
});

describe("018-017: programVersionText", () => {
  it("extracts the release version from a calibration-prefixed program string", () => {
    expect(programVersionText("calibration-0.20260913.1")).toBe("0.20260913.1");
  });

  it("returns a non-calibration program string unchanged (no parsing assumed)", () => {
    expect(programVersionText("diffdrive")).toBe("diffdrive");
    expect(programVersionText("some-other-build")).toBe("some-other-build");
  });

  it("returns an already-bare version string unchanged (no leading word-hyphen to strip)", () => {
    expect(programVersionText("0.20260913.1")).toBe("0.20260913.1");
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

/**
 * `currentRelayChild` (ticket 018-010): `findRelayChild`'s own match,
 * additionally required to still be "current" -- see that function's
 * own doc comment for the bench defects this fixes (`torture`'s card
 * reading "Connection to gopiv lost: ttl-expired", `vitut`'s reading a
 * bare "Connection to tigez lost", both for a bridge that had genuinely
 * ended long before this host process ever started).
 */
describe("currentRelayChild", () => {
  const now = 1_000_000;

  it("returns the same match as findRelayChild when it is genuinely live (answering)", () => {
    const answering = device({ id: 5, name: "vevov", links: [viaLink({ state: "connected", session: answeredSession(now) })] });
    expect(currentRelayChild([answering], RELAY_LINK_ID, now)?.device.name).toBe("vevov");
  });

  it("returns undefined for a stale match -- old bridge history, never resurrected", () => {
    const staleChild = device({
      id: 5,
      name: "gopiv",
      links: [viaLink({ state: "stale", reason: "ttl-expired", since: now - 10 * 60_000 })],
    });
    expect(currentRelayChild([staleChild], RELAY_LINK_ID, now)).toBeUndefined();
  });

  it("returns undefined for a failed/unresponsive match with no session that dropped longer ago than RELAY_CHILD_RECENT_MS", () => {
    const longAgo = device({
      id: 6,
      name: "tigez",
      links: [viaLink({ state: "unresponsive", reason: "no reply", since: now - RELAY_CHILD_RECENT_MS - 1 })],
    });
    expect(currentRelayChild([longAgo], RELAY_LINK_ID, now)).toBeUndefined();
  });

  it("still returns a failed/unresponsive match with no session that dropped recently", () => {
    const recent = device({
      id: 6,
      name: "tigez",
      links: [viaLink({ state: "unresponsive", reason: "no reply", since: now - 1000 })],
    });
    expect(currentRelayChild([recent], RELAY_LINK_ID, now)?.device.name).toBe("tigez");
  });

  it("never expires a match that still carries a live session, however old its since", () => {
    const oldButSessioned = device({
      id: 6,
      name: "tigez",
      links: [viaLink({ state: "unresponsive", reason: "no reply", since: now - 10 * RELAY_CHILD_RECENT_MS, session: OPEN_SESSION })],
    });
    expect(currentRelayChild([oldButSessioned], RELAY_LINK_ID, now)?.device.name).toBe("tigez");
  });

  it("returns undefined when findRelayChild itself finds nothing", () => {
    expect(currentRelayChild([device({ id: 5, links: [link()] })], RELAY_LINK_ID, now)).toBeUndefined();
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

/**
 * `cardLinks`/`hiddenLinkCount` (ticket 018-010): the device-card link
 * filter for the bench defect where every card was cluttered with aged
 * rows -- `vevov`/`gopiv`/`tovez`/`tigez` each showing one or more
 * `Not seen since …` rows from hours or days ago, and `tovez` showing a
 * USB row for a port a different device (`vitut`) now physically holds.
 */
describe("cardLinks / hiddenLinkCount", () => {
  it("keeps a usable, connecting, discovered, connectable, failed, unresponsive, or closed_by_user link", () => {
    const kept: SnapshotLink["state"][] = ["connectable", "discovered", "connecting", "connected", "failed", "unresponsive", "closed_by_user"];
    const d = device({ links: kept.map((state, i) => link({ id: `link-${i}`, state })) });
    expect(cardLinks(d)).toHaveLength(kept.length);
    expect(hiddenLinkCount(d)).toBe(0);
  });

  it("hides a stale link entirely -- never rendered as a row, regardless of its own lastSeen/reason text", () => {
    const d = device({
      links: [
        link({ id: "usb-live", state: "connectable" }),
        link({ id: "radio-aged", state: "stale", reason: "ttl-expired", lastSeen: 0 }),
      ],
    });
    const kept = cardLinks(d);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe("usb-live");
    expect(hiddenLinkCount(d)).toBe(1);
  });

  // The `tovez` bench defect: a USB link whose physical path a different
  // device (`vitut`) now holds. `usbWatcher.ts`'s `handleRemoved` marks
  // the departed board's own link `stale` immediately (event-driven, not
  // TTL-based) the instant it is unplugged -- so this is exactly the
  // same `stale` filter above, not a separate path-collision check.
  it("hides an old device's own USB link once its path has been taken over by a different device (state: stale)", () => {
    const tovez = device({
      name: "tovez",
      links: [link({ id: "usb-old-serial", state: "stale", transport: "usb", label: "USB · /dev/cu.usbmodem2121102" })],
    });
    expect(cardLinks(tovez)).toHaveLength(0);
    expect(hiddenLinkCount(tovez)).toBe(1);
  });

  // 027-002: the mbregistry analog of the `tovez` USB path-collision
  // defect above -- `gone-mbregistry-board-link-is-reattributed-to-the-
  // next-board-on-its-port.md`. Before the connector-side identify guard
  // (connect/connector.ts) was widened to cover `mbregistry`, a UID-keyed
  // link whose board had gone away and stayed `stale` could be re-homed
  // onto whatever board a fresh banner reported, making it look like a
  // second, live link on the WRONG device's card. With the guard now
  // refusing that banner outright (a link failure, not a write), the
  // link never comes back off `stale`, so it is still filtered out of
  // `cardLinks()` here for the wrong device -- confirming the "two icons
  // on one card" symptom does not recur. `cardLinks` itself needed no
  // code change for this; the fix is upstream in the connector.
  it("hides a gone board's own mbregistry link once its UID's port has been taken over by a different board (state: stale) -- confirms no re-homed row survives onto the wrong device's card", () => {
    const zugit = device({
      name: "zugit",
      links: [
        link({
          id: "mbregistry-ZUGIT-UID",
          transport: "mbregistry",
          state: "stale",
          label: "mbregistry · ZUGIT-UID",
        }),
      ],
    });
    expect(cardLinks(zugit)).toHaveLength(0);
    expect(hiddenLinkCount(zugit)).toBe(1);
  });

  // 027-003: mbtools' own fast `not_found` response for a UID that isn't
  // attached is classified by `connect/connector.ts`'s `attempt()` as
  // `state: "stale"` (not `recordFailure`'s `"failed"`) -- see
  // `isMbregistryNotFound`'s own doc comment there. This is the same
  // `cardLinks()` filter as the 027-002 case above; the fix is entirely
  // upstream in the connector's failure classification, not here.
  it("hides an mbregistry link classified stale from a not_found identify failure -- confirms the connector's not_found-to-stale reclassification actually keeps the link off the card", () => {
    const gone = device({
      name: "gone",
      links: [
        link({
          id: "mbregistry-GONE-UID",
          transport: "mbregistry",
          state: "stale",
          reason: "GONE-UID is not attached (last seen on /dev/ttyUSB3)",
          label: "mbregistry · GONE-UID",
        }),
      ],
    });
    expect(cardLinks(gone)).toHaveLength(0);
    expect(hiddenLinkCount(gone)).toBe(1);
  });

  it("hiddenLinkCount is 0 when nothing was hidden", () => {
    expect(hiddenLinkCount(device({ links: [link({ state: "connectable" })] }))).toBe(0);
  });

  it("counts more than one hidden link", () => {
    const d = device({
      links: [
        link({ id: "a", state: "stale" }),
        link({ id: "b", state: "stale" }),
        link({ id: "c", state: "connectable" }),
      ],
    });
    expect(hiddenLinkCount(d)).toBe(2);
    expect(cardLinks(d)).toHaveLength(1);
  });
});
