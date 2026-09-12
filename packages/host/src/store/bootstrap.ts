/**
 * bootstrap.ts — the one production call site for ticket 003's one-time
 * JSON importers (`importers/knownRobots.ts`, `importers/wifiCredentials.ts`).
 *
 * Ticket 014-010's bench pass found that both importers existed with
 * *zero* call sites anywhere in production code: neither `--dump-store`
 * nor `--watch-store` (`cli.ts`) ever called `importKnownRobots`, and
 * neither did `openStore`/`openStoreDb` — so `known-robots.json`'s
 * existing entries never appeared as `owned = 1` device rows, breaking
 * SUC-005 (`docs/design/architecture.md` §4/§5: "the import runs once at
 * store open on the host"). This module is the fix: a single bootstrap
 * entry point that opens the store and runs both importers against the
 * files in the same state directory, so any caller that wants "the store,
 * with known-robots/wifi-credentials already imported" has exactly one
 * function to call instead of having to remember to wire the importers
 * in themselves.
 *
 * `--dump-store` (`debug/dumpStore.ts`) deliberately does NOT use this —
 * it opens a short-lived *read-only* connection and must never write
 * (creating `console.sqlite`, or importing into it, are both writes).
 * `--watch-store` (`cli.ts`) does use it, since it already opens the
 * store read-write.
 *
 * TODO(rearch-05): call this from the server's real startup path once
 * sprint 015 wires the store into `server.ts`/`deviceRegistry.ts` — out
 * of scope for ticket 014-010, which was told explicitly not to touch
 * those files.
 */
import { openStore, type Store } from "./index.js";
import type { StoreDbOptions } from "./db.js";
import { resolveKnownRobotsFilePath } from "./knownRobots.js";
import { resolveWifiCredentialsFilePath } from "./wifiCredentials.js";
import { importKnownRobots } from "./importers/knownRobots.js";
import { importWifiCredentials } from "./importers/wifiCredentials.js";

/**
 * Opens the store (creating/migrating as needed, exactly like
 * {@link openStore}) and then runs both one-time JSON importers against
 * it: `known-robots.json` and `wifi-credentials.json`, resolved from the
 * same state directory `options`/`ROBOT_CONSOLE_STATE_DIR` resolve to
 * (`options.filePath`, the exact `console.sqlite` path override, is a
 * store-only concern and is deliberately not forwarded to the importer
 * path resolvers — only `stateDir` is, mirroring
 * `resolveWifiCredentialsFilePath`'s own `{ stateDir }`-only forwarding
 * of `knownRobots.ts`'s options).
 *
 * Each importer is guarded by its own `settings` row (see each
 * importer's own doc comment), so calling this more than once against
 * the same store — e.g. a process restart against the same state dir —
 * is a no-op after the first successful import.
 */
export function openStoreWithImports(options: StoreDbOptions = {}): Store {
  const store = openStore(options);
  const env = options.env ?? process.env;
  const pathOptions = options.stateDir !== undefined ? { stateDir: options.stateDir } : {};

  const knownRobotsPath = resolveKnownRobotsFilePath(pathOptions, env);
  const wifiCredentialsPath = resolveWifiCredentialsFilePath(pathOptions, env);

  importKnownRobots(store, knownRobotsPath);
  importWifiCredentials(store, wifiCredentialsPath);

  return store;
}
