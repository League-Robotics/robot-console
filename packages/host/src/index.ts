/**
 * @robot-console/host — the privileged half: USB, SWD, mDNS, TCP, UDP,
 * hex fetch, and the Express/ws server bridging it all to the browser.
 *
 * Re-exports the pieces `packages/ui` (and later sprints' host
 * additions) need: the WebSocket message contract and the server entry
 * point.
 *
 * `./deviceRegistry.js` and `./store/knownRobots.js` (sprint 015 ticket
 * 003 retires both) are gone as of this sprint's connector/reconciler/
 * harvester rearchitecture — see `docs/design/architecture.md` §8 and
 * issue `rearch-05-connector-reconciler-harvester-retire-deviceregistry.md`.
 * `./server.js` itself still imports the now-deleted `DeviceRegistry`
 * (a known, accepted break until ticket 005's composition root rewires
 * it — see this ticket's own Description) so re-exporting it here still
 * fails to resolve at runtime until then; that failure is ticket 005's
 * to fix, not this file's.
 */
export * from "./wsMessages.js";
export * from "./server.js";

export const HOST_PACKAGE_NAME = "@robot-console/host" as const;
