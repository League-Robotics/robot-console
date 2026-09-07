/**
 * @robot-console/host — the privileged half: USB, SWD, mDNS, TCP, UDP,
 * hex fetch, and the Express/ws server bridging it all to the browser.
 *
 * Scaffolding placeholder only. Later tickets add:
 *   - devices.ts   (DAPLink USB enumeration)
 *   - swdName.ts   (SWD-based five-letter naming)
 *   - link/        (UsbSerialLink and friends)
 *   - server.ts    (Express + ws bridge to the UI)
 *
 * The import below only proves the npm-workspaces link to
 * `@robot-console/protocol` resolves and type-checks; it is not
 * protocol/device logic.
 */
import { PROTOCOL_PACKAGE_NAME } from "@robot-console/protocol";

export const HOST_PACKAGE_NAME = "@robot-console/host" as const;
export const LINKED_PROTOCOL_PACKAGE_NAME = PROTOCOL_PACKAGE_NAME;
