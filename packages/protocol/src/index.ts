/**
 * @robot-console/protocol — pure TypeScript, zero-I/O wire protocol logic.
 *
 * Scaffolding placeholder only. Later tickets add:
 *   - naming.ts        (five-letter friendly name from a chip ID)
 *   - radioAddress.ts  (name -> default (channel, group))
 *   - banner.ts        (boot-banner parsing, both dialects)
 *   - v6/codec.ts      (line grammar)
 *   - v6/session.ts    (ack/nack sequencing)
 *
 * This package must never perform I/O and must never import from
 * `vendor/` (reference-only submodules).
 */
export const PROTOCOL_PACKAGE_NAME = "@robot-console/protocol" as const;
