/**
 * @robot-console/host — the privileged half: USB, SWD, mDNS, TCP, UDP,
 * hex fetch, and the Express/ws server bridging it all to the browser.
 *
 * Re-exports the pieces `packages/ui` (and any other host-external
 * caller) need: the WebSocket message contract (`wsMessages.ts`), the
 * thin server entry point (`server.ts`), and the composition root
 * (`runtime.ts`) `cli.ts` composes them through — sprint 015's
 * connector/reconciler/harvester rearchitecture (`docs/design/
 * architecture.md` §6/§8) replaces the retired `deviceRegistry.ts` with
 * these three.
 */
export * from "./wsMessages.js";
export * from "./server.js";
export * from "./runtime.js";

export const HOST_PACKAGE_NAME = "@robot-console/host" as const;
