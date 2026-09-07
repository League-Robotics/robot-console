/**
 * @robot-console/host — the privileged half: USB, SWD, mDNS, TCP, UDP,
 * hex fetch, and the Express/ws server bridging it all to the browser.
 *
 * Re-exports the pieces `packages/ui` (and later sprints' host
 * additions) need: the WebSocket message contract, the server entry
 * point, and the device registry that composes `devices.ts`/
 * `swdName.ts`/`UsbSerialLink` for it.
 */
export * from "./wsMessages.js";
export * from "./server.js";
export * from "./deviceRegistry.js";

export const HOST_PACKAGE_NAME = "@robot-console/host" as const;
