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
 * handed an endpoint whose `transport` is one of sprint 8's relay-
 * mediated values -- the two are independent claims (a page could pass
 * the source scan yet still crash or render blank for a value the scan
 * has no way to exercise). The second describe block below closes that
 * gap: it mounts the real `RobotPage` (via `WsProvider`/`FakeSocket`,
 * mirroring `RobotPage.test.tsx`'s own harness) against a
 * `transport: "relay-radio"` endpoint fixture -- exactly the shape
 * `RelayPage.tsx` hands it for a robot reached through a relay -- and
 * asserts the same controls a USB fixture would produce actually
 * appear, with **zero changes to `RobotPage.tsx` or any component it
 * mounts**. `sprint.md`'s Success Criteria calls this out by name: "the
 * same `RobotPage.transportBlind.test.ts` source-scan technique...now
 * also exercised against a relay-transport endpoint fixture."
 *
 * **Sprint 10 ticket 005 addition**: the same gap, closed again for
 * `transport: "wifi"` -- a WiFi-reachable robot's endpoint (`endpointId:
 * "wifi-<name>"`, a `wifi: { host, port }` block, no `usb` block, once
 * identified) is, per this sprint's Architecture, meant to render on
 * `RobotPage` exactly like any other transport once a session is open
 * and the banner identifies it as a robot -- `DevicePage.tsx`'s
 * dispatch and `RobotPage` itself are both transport-blind, so nothing
 * new needs writing, only proving. The third describe block below
 * mirrors the relay-radio one immediately above it (same fixture shape,
 * same harness, same assertions), against a `transport: "wifi"` fixture
 * instead -- again with **zero changes to `RobotPage.tsx` or any file in
 * `FILES_UNDER_TEST`**.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import robotPageSource from "./RobotPage.tsx?raw";
import driveControlsSource from "../components/DriveControls.tsx?raw";
import commandStripSource from "../components/CommandStrip.tsx?raw";
import sequencingIndicatorSource from "../components/SequencingIndicator.tsx?raw";
import statusPanelSource from "../components/StatusPanel.tsx?raw";
import functionsPanelSource from "../components/FunctionsPanel.tsx?raw";
import chartsPanelSource from "../components/ChartsPanel.tsx?raw";
import pathTracePanelSource from "../components/PathTracePanel.tsx?raw";
import distanceCalibrationWizardSource from "../components/DistanceCalibrationWizard.tsx?raw";
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
  // Sprint 011 ticket 003: the distance-calibration wizard and its
  // shared report parser are held to the same property -- both read
  // only `device.functions`/`useEndpointLog`/`useWsActions`, never a
  // transport/link type or `endpoint.transport`.
  "components/DistanceCalibrationWizard.tsx": distanceCalibrationWizardSource,
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
      expect(source).not.toMatch(/endpoint\.transport|device\.transport/);
    });
  }
});

/** A robot reached through a relay -- exactly the endpoint shape
 * `RelayPage.tsx` synthesizes and hands to `RobotPage` (`viaRelay` set,
 * no `usb` block, `transport: "relay-radio"`). Mirrors
 * `RelayPage.test.tsx`'s own `childFixture` and `RobotPage.test.tsx`'s
 * `robotFixture` shapes, combined -- this file does not import either
 * (both are test-local to their own files), since duplicating a small
 * fixture object is cheaper here than adding a shared-test-fixture
 * module for exactly one caller. */
function relayTransportRobotFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "usb-RELAY-A-via-vevav",
    transport: "relay-radio",
    resourceKey: "usb-RELAY-A",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "vevav",
    role: "NEZHA2",
    sessionOpen: true,
    viaRelay: { relayEndpointId: "usb-RELAY-A", robotName: "vevav", channel: 55, group: 114 },
    ...overrides,
  };
}

/** A robot reached directly over WiFi -- exactly the endpoint shape
 * ticket 003 synthesizes once such an endpoint has identified (`wifi`
 * set, no `usb` block, `transport: "wifi"`). Mirrors
 * `relayTransportRobotFixture` above; this file does not import a
 * shared fixture module for the same one-caller-each reason that
 * function's own doc comment gives. */
function wifiTransportRobotFixture(overrides: Partial<EndpointListEntry> = {}): EndpointListEntry {
  return {
    endpointId: "wifi-gopiv",
    transport: "wifi",
    resourceKey: "wifi-gopiv",
    classification: { type: "robot", role: "NEZHA2", commonName: "robot", dialect: "space", evidence: "role", program: null, version: null },
    name: "gopiv",
    role: "NEZHA2",
    sessionOpen: true,
    wifi: { host: "192.168.1.42", port: 8765 },
    ...overrides,
  };
}

describe("RobotPage renders correctly for a relay-transport endpoint (sprint 8 ticket 005)", () => {
  // Companion to the source scan above: proves RobotPage actually
  // renders its usual controls for a relay-mediated endpoint too, not
  // just that its source contains no relay-specific branch -- with zero
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

  it("renders the usual robot controls (estop, drive, console) for a relay-radio-transport endpoint", () => {
    const endpoint = relayTransportRobotFixture();
    let socket: FakeSocket | null = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(WsProvider, {
          url: "ws://test/",
          socketFactory: () => (socket = new FakeSocket()),
          children: createElement(RobotPage, { endpoint }),
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

describe("RobotPage renders correctly for a wifi-transport endpoint (sprint 10 ticket 005)", () => {
  // Companion to the source scan above, mirroring the relay-transport
  // describe block immediately above this one: proves RobotPage renders
  // its usual controls for a WiFi-reached endpoint too, with zero
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

  it("renders the usual robot controls (estop, drive, console) for a wifi-transport endpoint", () => {
    const endpoint = wifiTransportRobotFixture();
    let socket: FakeSocket | null = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(WsProvider, {
          url: "ws://test/",
          socketFactory: () => (socket = new FakeSocket()),
          children: createElement(RobotPage, { endpoint }),
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
