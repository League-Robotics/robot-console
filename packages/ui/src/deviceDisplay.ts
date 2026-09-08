/**
 * deviceDisplay.ts — presentational helpers for rendering an
 * `EndpointListEntry`, shared across the front page and every
 * per-device page.
 *
 * Ticket 008 extracts these from `DevicesTab.tsx` (sprint 1's flat
 * Devices tab) as that file is retired: its rendering logic is fully
 * redistributed by this sprint (`FrontPage.tsx`, ticket 007; the
 * per-device pages, this ticket), so nothing depends on the component
 * itself any more, but `nameDisplay`/`roleDisplay` were already shared
 * with `FrontPage.tsx` and the flash-gating helpers are needed fresh by
 * `UnknownDevicePage.tsx` -- this module is the one place both land
 * instead of either being duplicated or `DevicesTab.tsx` being kept
 * alive as a component-less grab bag.
 */
import type {
  EndpointListEntry,
  FirmwareAvailability,
  FirmwareKind,
  FlashPhase,
} from "@robot-console/host/src/wsMessages.js";

/** Exported so `FrontPage.tsx` and `UnknownDevicePage.tsx` can reuse
 * this rendering rule verbatim rather than re-deriving it. */
export function nameDisplay(device: EndpointListEntry): { text: string; flagged: boolean } {
  if (device.name) {
    return { text: device.name, flagged: false };
  }
  if (device.nameError) {
    return { text: "Unnamed device", flagged: true };
  }
  // Detected but naming hasn't resolved (or failed) yet -- an ordinary,
  // momentary state, never shown as an error.
  return { text: "Naming…", flagged: false };
}

/** Exported for the same reason as {@link nameDisplay} above. */
export function roleDisplay(device: EndpointListEntry): string {
  if (device.role) {
    return device.role;
  }
  if (device.sessionError) {
    // No banner reply ever arrived -- per UC-001's error flow, shown as
    // unresponsive rather than assigned a role.
    return "Unresponsive";
  }
  // The common, unalarming case: a board running its own code (or not
  // yet linked) that simply hasn't announced a role. Not an error, not
  // a spinner.
  return "No role announced";
}

/** Whether a device has been auto-probed and failed to identify --
 * exactly the state UC-001's error flow leaves it in (a `HELLO` reply
 * never arrived), and the only state that gets a recovery path (the
 * flash controls on `UnknownDevicePage`). Per the sprint architecture:
 * `role === null && sessionError !== undefined` only -- never an
 * unprobed device (no `sessionError`, no `role`) and never one that
 * identified successfully (`role` set). */
export function isFailedIdentify(device: EndpointListEntry): boolean {
  return device.role === null && device.sessionError !== undefined;
}

/** Turn one firmware's live availability into either `null` (button
 * enabled) or a short, student-facing explanation of why it isn't --
 * never a hardcoded flag, always derived from the live
 * `firmwareStatus` the server polls and pushes (see `WsProvider`'s
 * `firmwareStatus` doc comment). Phrased as what the student should do
 * next -- not an engineer-facing error code. */
export function firmwareDisabledReason(availability: FirmwareAvailability | undefined): string | null {
  if (!availability || !availability.configured) {
    return "Not set up for this classroom yet — ask your instructor.";
  }
  if (availability.available) {
    return null;
  }
  switch (availability.reason) {
    case "not-yet-checked":
      // Poll hasn't completed yet -- must read as "still loading", not
      // "broken" or "permanently unavailable".
      return "Checking whether this firmware is available…";
    case "no-releases":
      return "No build has been published yet — ask your instructor when one's ready.";
    case "tag-not-found":
    case "no-asset":
      return "The configured build can't be found — ask your instructor to check the setup.";
    case "network":
      return "Couldn't check for firmware just now — try again in a moment.";
    default:
      return "This firmware isn't available right now.";
  }
}

/** Student-facing label for a configured release firmware kind. */
export const FIRMWARE_LABEL: Record<FirmwareKind, string> = {
  relay: "relay",
  robot: "robot",
};

/** Student-facing label for one stage of an in-flight flash. */
export const PHASE_LABEL: Record<FlashPhase, string> = {
  fetching: "downloading",
  verifying: "verifying",
  erasing: "erasing",
  writing: "writing",
  resetting: "resetting",
  reidentifying: "waiting for the board to come back",
};
