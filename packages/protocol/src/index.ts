/**
 * @robot-console/protocol — pure TypeScript, zero-I/O wire protocol logic.
 *
 * This package must never perform I/O and must never import from
 * `vendor/` (reference-only submodules) outside of test fixtures.
 */

export * from "./naming.js";
export * from "./radioAddress.js";
export * from "./banner.js";
export * from "./v6/codec.js";
export * from "./v6/session.js";

/** Workspace-linkage marker from ticket 001; ticket 009 removes it. */
export const PROTOCOL_PACKAGE_NAME = "@robot-console/protocol" as const;
