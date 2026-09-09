/**
 * UnknownDevicePage.tsx — `/d/:endpointId` for the `unknown`
 * classification (SUC-002, SUC-003, SUC-004), including
 * `DevicePage`'s `default` dispatch arm for any classification `type`
 * this client doesn't recognize -- the mechanism that makes a future
 * fourth device type purely additive on the wire (see
 * `wsMessages.ts`'s module doc comment).
 *
 * This is the page that gets real exercise on the current bench: every
 * attached micro:bit classifies as `unknown` today (no board announces
 * after a flash -- `flash-succeeds-but-board-never-announces.md`), so
 * this is where a student actually goes to recover a device.
 *
 * A thin wrapper (ticket 012-002): header, the endpoint's own
 * `sessionError` note, the shared `FlashDialog` (which decides for
 * itself, via `canBeFlashed`, whether it offers a "Flash" trigger at
 * all), and `DeviceConsole`. This page owns no flash logic of its own
 * -- the release/local-hex flows, progress rendering, and post-flash
 * navigation all live in `../components/FlashControls.tsx`, run inside
 * the popup modal `../components/FlashDialog.tsx` owns (out-of-process
 * work, 2026-09-08), shared with the front-page card and the app
 * header's Flash entry.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { FlashDialog } from "../components/FlashDialog";
import { DeviceConsole } from "../components/DeviceConsole";
import "./UnknownDevicePage.css";

export interface UnknownDevicePageProps {
  endpoint: EndpointListEntry;
}

export function UnknownDevicePage({ endpoint }: UnknownDevicePageProps) {
  return (
    <section className="unknown-device-page" aria-label="Unknown device">
      <h2>{endpoint.name ?? endpoint.endpointId}</h2>

      {endpoint.sessionError && <p className="device-note">Link attempt: {endpoint.sessionError}</p>}

      <FlashDialog endpoint={endpoint} />

      <DeviceConsole device={endpoint} />
    </section>
  );
}
