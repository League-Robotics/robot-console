/**
 * Migration 0003 — `devices.common_name` (sprint 018 ticket 016).
 *
 * Stakeholder intent (2026-09-13, verbatim): "For robots, when you show
 * the announcement, show the common name, the role, and the version
 * number all on the same line." The banner already carries this value
 * (`packages/protocol/src/banner.ts` `parseBanner` -> `commonName`, e.g.
 * `device NEZHA2 robot vevov 1198504156` -> `"robot"`), but the store
 * never persisted it -- this column is that missing piece, alongside
 * the existing `role` column it is always written with (see
 * `connect/connector.ts` and `connect/relayBridger.ts`'s banner-identify
 * write sites, both updated in the same ticket to pass it through
 * `Store.upsertDevice`).
 *
 * `NULL` by default and on every pre-migration row (a device never
 * identified since this ticket shipped has simply not announced a
 * common name yet -- `packages/ui/src/deviceDisplay.ts`'s `roleDisplay`
 * omits any unknown part of the identity line rather than showing a
 * placeholder).
 */
export const MIGRATION_0003_DEVICE_COMMON_NAME = `
ALTER TABLE devices ADD COLUMN common_name TEXT;
`;
