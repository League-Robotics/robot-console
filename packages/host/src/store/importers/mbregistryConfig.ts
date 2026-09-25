/**
 * mbregistryConfig.ts — bootstrap-time importer: resolves
 * `ROBOT_CONSOLE_MBREGISTRY_SHARE_BOARDS` into the `mbregistry
 * .shareBoards` `settings` row (sprint 018 ticket 008), mirroring
 * `./firmwareConfig.ts`'s own env-var-to-`settings` pattern exactly --
 * the established convention for a host-only toggle in this codebase
 * (there is no settings UI yet; see `config.ts`'s own doc comment on
 * {@link "../../config.js".getMbregistryShareBoards}).
 *
 * Like `importFirmwareConfig` (and unlike `./knownRobots.ts`/
 * `./wifiCredentials.ts`), this is *not* guarded by a one-time
 * `settings` row: it re-resolves and overwrites the `settings` row on
 * every bootstrap only when the environment variable is present and
 * non-blank, so a present env var always takes effect on the next
 * restart. When the variable is absent or blank, the existing
 * `settings` row (if any) is left untouched -- this is what makes the
 * setting "persist across a restart" (ticket 008's acceptance
 * criterion) rather than reverting to the default the moment the
 * environment variable that originally set it is no longer supplied.
 */
import { MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, TRUTHY_SETTING_VALUES } from "../../config.js";
import type { Store } from "../index.js";

/** The `ROBOT_CONSOLE_*` environment variable that configures this
 * setting, following `cli.ts`'s existing `ROBOT_CONSOLE_PORT`/
 * `./firmwareConfig.ts`'s `ROBOT_CONSOLE_*_FIRMWARE` naming
 * convention. Accepts the same case-insensitive truthy tokens
 * ({@link TRUTHY_SETTING_VALUES}, `config.ts`); anything else is
 * stored as `"false"`. */
export const MBREGISTRY_SHARE_BOARDS_ENV_VAR = "ROBOT_CONSOLE_MBREGISTRY_SHARE_BOARDS";

export interface ImportMbregistryConfigOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves `ROBOT_CONSOLE_MBREGISTRY_SHARE_BOARDS` and, when present and
 * non-blank, writes its normalized `"true"`/`"false"` value into the
 * `mbregistry.shareBoards` `settings` row. Returns whether a value was
 * written this call (`false` when the env var was absent/blank -- the
 * existing row, if any, was left untouched, per this module's own doc
 * comment). Never throws.
 */
export function importMbregistryConfig(store: Store, options: ImportMbregistryConfigOptions = {}): boolean {
  const env = options.env ?? process.env;
  const raw = env[MBREGISTRY_SHARE_BOARDS_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) {
    return false;
  }
  const normalized = TRUTHY_SETTING_VALUES.has(raw.trim().toLowerCase());
  store.setSetting(MBREGISTRY_SHAREBOARDS_SETTINGS_KEY, String(normalized));
  return true;
}
