// @vitest-environment jsdom
/**
 * RobotPage.transportBlind.test.ts — checks the transport-blindness
 * property `sprint.md`'s Architecture Overview requires as a *checked*
 * property, not just review discipline (ticket 005): "Nothing under
 * `RobotPage` may import or reference `UsbSerialLink`, the literal
 * string `"usb"`, or `endpoint.transport`." Sprint 7's "same page, no
 * rewrite" claim for a relay-connected robot depends on this holding,
 * so it is enforced here with a source scan rather than left to review
 * alone.
 *
 * Scoped to `RobotPage.tsx` and the components it mounts that ticket
 * 005/006 introduced or still mount (`DriveControls`, `CommandStrip`,
 * `SequencingIndicator`) -- `DeviceConsole` predates this ticket and is
 * shared with every other per-device page, so it is out of this
 * ticket's scope to re-certify, though it happens to already satisfy
 * the same property. Sprint 006's separate status-request panel and
 * Get/Set panel are retired this ticket (deleted outright, superseded
 * by `CommandStrip` + the unified console) and dropped from this list;
 * `CommandStrip.tsx` (new) is added so the scan actually certifies the
 * new file, not just continues passing on a stale list.
 *
 * **Out-of-process, 2026-09-10**: `EstopControl.tsx` is deleted (STOP/
 * E-STOP moved into `DriveControls`'s own pad) and dropped from this
 * list -- the file no longer exists, so scanning its source is no
 * longer possible or meaningful; `DriveControls.tsx`'s entry already
 * certifies the merged-in STOP/E-STOP markup.
 *
 * Each file's source is pulled in via Vite's `?raw` import suffix
 * (typed by `vite/client`, already this package's one ambient `types`
 * entry -- see `tsconfig.json`) rather than `node:fs`, so this test
 * needs no Node-specific type dependency in a package that otherwise
 * targets the browser only.
 *
 * **Sprint 8 ticket 005 addition**: the static source scan above proves
 * nothing relay-specific was *written* into these files, but says
 * nothing about whether `RobotPage` actually *renders* correctly when
 * handed a link whose `transport` is one of sprint 8's relay-mediated
 * values -- the two are independent claims (a page could pass the
 * source scan yet still crash or render blank for a value the scan has
 * no way to exercise). The second describe block below closes that
 * gap: it mounts the real `RobotPage` (via `WsProvider`/`FakeSocket`,
 * mirroring `RobotPage.test.tsx`'s own harness) against a
 * `transport: "radio"` link fixture -- exactly the shape `RelayPage.tsx`
 * hands it for a robot reached through a relay -- and asserts the same
 * controls a USB fixture would produce actually appear, with **zero
 * changes to `RobotPage.tsx` or any component it mounts**. `sprint.md`'s
 * Success Criteria calls this out by name: "the same
 * `RobotPage.transportBlind.test.ts` source-scan technique...now also
 * exercised against a relay-transport endpoint fixture."
 *
 * **Sprint 10 ticket 005 addition**: the same gap, closed again for
 * `transport: "wifi"` -- a WiFi-reachable robot's link is, per this
 * sprint's Architecture, meant to render on `RobotPage` exactly like any
 * other transport once a session is open -- `DevicePage.tsx`'s dispatch
 * and `RobotPage` itself are both transport-blind, so nothing new needs
 * writing, only proving. The third describe block below mirrors the
 * relay-radio one immediately above it (same fixture shape, same
 * harness, same assertions), against a `transport: "wifi"` fixture
 * instead -- again with **zero changes to `RobotPage.tsx` or any file in
 * `FILES_UNDER_TEST`**.
 *
 * **Sprint 015 ticket 009**: migrated to the `Snapshot` contract --
 * `RobotPage` now takes `{ device, link }` (a `SnapshotDevice`/
 * `SnapshotLink` pair) instead of the retired `{ endpoint:
 * EndpointListEntry }`, so the two render-based describe blocks below
 * build `SnapshotDevice`/`SnapshotLink` fixtures instead. The source-scan
 * list and its own three assertions per file are otherwise unchanged.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotDevice, SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import robotPageSource from "./RobotPage.tsx?raw";
import driveControlsSource from "../components/DriveControls.tsx?raw";
import commandStripSource from "../components/CommandStrip.tsx?raw";
import sequencingIndicatorSource from "../components/SequencingIndicator.tsx?raw";
import statusPanelSource from "../components/StatusPanel.tsx?raw";
import functionsPanelSource from "../components/FunctionsPanel.tsx?raw";
import chartsPanelSource from "../components/ChartsPanel.tsx?raw";
import pathTracePanelSource from "../components/PathTracePanel.tsx?raw";
import newCalibrationPanelSource from "../components/NewCalibrationPanel.tsx?raw";
import calibrationHelpSource from "../components/CalibrationHelp.tsx?raw";
import calibrationRunSource from "../lib/calibrationRun.ts?raw";
import calibrationReportSource from "../components/CalibrationReport.ts?raw";
import { RobotPage } from "./RobotPage";
import { WsProvider } from "../ws/WsProvider";
import { FakeSocket } from "../testing/FakeSocket";

// This file is deliberately kept as plain `.ts`, not `.tsx` -- per this
// module's own doc comment, its identity is "the source-scan file",
// and every element tree the render-based describe block below needs is
// built with `createElement` rather than JSX for exactly that reason
// (esbuild's `.ts` loader does not parse JSX; renaming to `.tsx` was
// considered and rejected so this file's name -- and the ticket's own
// reference to it by that exact name -- stays stable).

const FILES_UNDER_TEST: Record<string, string> = {
  "pages/RobotPage.tsx": robotPageSource,
  "components/DriveControls.tsx": driveControlsSource,
  "components/CommandStrip.tsx": commandStripSource,
  "components/SequencingIndicator.tsx": sequencingIndicatorSource,
  // OOP 2026-09-09: the two panels added today are held to the same
  // property -- the robot page is ONE screen for USB, radio-via-relay,
  // and (later) WiFi, so nothing it mounts may know which it is on.
  "components/StatusPanel.tsx": statusPanelSource,
  "components/FunctionsPanel.tsx": functionsPanelSource,
  // Sprint 9 ticket 004: ChartsPanel replaces the stubbed placeholder
  // and is held to the same property -- it reads only
  // `useTelemetry`/`useTelemetryHeader`, never a transport/link type.
  "components/ChartsPanel.tsx": chartsPanelSource,
  // Sprint 9 ticket 005: PathTracePanel is held to the same property --
  // it reads only `useTelemetry`/`useTelemetryHeader`/`useWsActions`,
  // never a transport/link type.
  "components/PathTracePanel.tsx": pathTracePanelSource,
  // 2026-09-19: the two calibration wizards this list used to name were
  // replaced by one guided panel (`NewCalibrationPanel`), its help
  // dialog, and the run derivation they both used, now in `lib`. The
  // property carries over unchanged -- the panel reads only
  // `useLinkLog`/`useWsActions`/`isLinkUsable`, never a transport or a
  // link type, which is what lets a calibration run over a relay or
  // Wi-Fi exactly as it does over USB.
  "components/NewCalibrationPanel.tsx": newCalibrationPanelSource,
  "components/CalibrationHelp.tsx": calibrationHelpSource,
  "lib/calibrationRun.ts": calibrationRunSource,
  "components/CalibrationReport.ts": calibrationReportSource,
};

/** Matches a quoted `"usb"` literal (either quote style), not merely
 * any occurrence of the substring "usb" -- a doc comment mentioning USB
 * as a concept must not itself trip the scan it is describing. */
const QUOTED_USB_LITERAL = /(['"`])usb\1/;

describe("RobotPage transport-blindness", () => {
  for (const [label, source] of Object.entries(FILES_UNDER_TEST)) {
    it(`${label} does not reference UsbSerialLink`, () => {
      expect(source).not.toMatch(/UsbSerialLink/);
    });

    it(`${label} does not reference the literal string "usb"`, () => {
      expect(source).not.toMatch(QUOTED_USB_LITERAL);
    });

    it(`${label} does not reference endpoint.transport`, () => {
      expect(source).not.toMatch(/endpoint\.transport|device\.transport|link\.transport/);
    });
  }
});

const LINK_ID = "usb-RELAY-A-via-vevav";

function baseLink(overrides: Partial<SnapshotLink> = {}): SnapshotLink {
  return {
    id: LINK_ID,
    transport: "usb",
    label: "USB",
    state: "connected",
    reason: null,
    since: 0,
    lastSeen: 0,
    nextRetryAt: null,
    capabilities: { open: false, close: true, flash: true, provisionWifi: true },
    session: { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null },
    ...overrides,
  };
}

function baseDevice(link: SnapshotLink, overrides: Partial<Omit<SnapshotDevice, "links">> = {}): SnapshotDevice {
  return {
    id: 1,
    name: "vevav",
    kind: "robot",
    role: "NEZHA2",
    commonName: null,
    program: null,
    version: null,
    owned: true,
    radio: { channel: 55, group: 114, source: "derived" },
    lastSeen: 0,
    lastChecked: null,
    links: [link],
    ...overrides,
  };
}

/** A robot reached through a relay -- exactly the link shape
 * `RelayPage.tsx` finds via `findRelayChild` and hands to `RobotPage`
 * (`transport: "radio"`, `via` naming the bridging relay). */
function relayTransportLink(): SnapshotLink {
  return baseLink({
    transport: "radio",
    label: "Radio · ch55/grp114",
    via: { relayLinkId: "usb-RELAY-A", relayName: "RELAY-A", channel: 55, group: 114, addressSource: "derived" },
  });
}

/** A robot reached directly over WiFi -- exactly the link shape ticket
 * 003 synthesizes once such a link has identified (`transport: "wifi"`). */
function wifiTransportLink(): SnapshotLink {
  return baseLink({ id: "wifi-gopiv", transport: "wifi", label: "WiFi · 192.168.1.42:8765" });
}

describe("RobotPage renders correctly for a relay-transport link (sprint 8 ticket 005)", () => {
  // Companion to the source scan above: proves RobotPage actually
  // renders its usual controls for a relay-mediated link too, not just
  // that its source contains no relay-specific branch -- with zero
  // changes to RobotPage.tsx or any component it mounts (this describe
  // block only adds a fixture and assertions, on the unmodified
  // `RobotPage` import above).
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it("renders the usual robot controls (estop, drive, console) for a relay-radio-transport link", () => {
    const link = relayTransportLink();
    const device = baseDevice(link);
    let socket: FakeSocket | null = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(WsProvider, {
          url: "ws://test/",
          socketFactory: () => (socket = new FakeSocket()),
          children: createElement(RobotPage, { device, link, onActiveTargetChange: () => {} }),
        }),
      );
    });
    act(() => {
      socket!.emitOpen();
    });

    expect(container.querySelector('[data-testid="estop-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drive-forward"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(container.textContent).toContain("vevav");
  });
});

describe("RobotPage renders correctly for a wifi-transport link (sprint 10 ticket 005)", () => {
  // Companion to the source scan above, mirroring the relay-transport
  // describe block immediately above this one: proves RobotPage renders
  // its usual controls for a WiFi-reached link too, with zero changes
  // to RobotPage.tsx or any component it mounts (this describe block
  // only adds a fixture and assertions, on the unmodified `RobotPage`
  // import above).
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it("renders the usual robot controls (estop, drive, console) for a wifi-transport link", () => {
    const link = wifiTransportLink();
    const device = baseDevice(link, { name: "gopiv" });
    let socket: FakeSocket | null = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(WsProvider, {
          url: "ws://test/",
          socketFactory: () => (socket = new FakeSocket()),
          children: createElement(RobotPage, { device, link, onActiveTargetChange: () => {} }),
        }),
      );
    });
    act(() => {
      socket!.emitOpen();
    });

    expect(container.querySelector('[data-testid="estop-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drive-forward"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Console"]')).not.toBeNull();
    expect(container.textContent).toContain("gopiv");
  });
});
