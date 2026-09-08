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
 * 005/006 introduced (`DriveControls`, `StatusPanel`, `GetSetPanel`,
 * `SequencingIndicator`, `EstopControl`) -- `DeviceConsole` predates
 * this ticket and is shared with every other per-device page, so it is
 * out of this ticket's scope to re-certify, though it happens to
 * already satisfy the same property.
 *
 * Each file's source is pulled in via Vite's `?raw` import suffix
 * (typed by `vite/client`, already this package's one ambient `types`
 * entry -- see `tsconfig.json`) rather than `node:fs`, so this test
 * needs no Node-specific type dependency in a package that otherwise
 * targets the browser only.
 */
import { describe, expect, it } from "vitest";
import robotPageSource from "./RobotPage.tsx?raw";
import driveControlsSource from "../components/DriveControls.tsx?raw";
import statusPanelSource from "../components/StatusPanel.tsx?raw";
import getSetPanelSource from "../components/GetSetPanel.tsx?raw";
import sequencingIndicatorSource from "../components/SequencingIndicator.tsx?raw";
import estopControlSource from "../components/EstopControl.tsx?raw";

const FILES_UNDER_TEST: Record<string, string> = {
  "pages/RobotPage.tsx": robotPageSource,
  "components/DriveControls.tsx": driveControlsSource,
  "components/StatusPanel.tsx": statusPanelSource,
  "components/GetSetPanel.tsx": getSetPanelSource,
  "components/SequencingIndicator.tsx": sequencingIndicatorSource,
  "components/EstopControl.tsx": estopControlSource,
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
