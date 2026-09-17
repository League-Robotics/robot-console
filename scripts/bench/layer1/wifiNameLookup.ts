/**
 * wifiNameLookup.ts — 018-003 Step 0 hardening: WiFi coverage for a
 * robot whose `_robotlink` mDNS service simply hasn't announced yet
 * during this run's browse window.
 *
 * ## Why this exists (live bench evidence, 018-003)
 *
 * `mdnsBrowse.ts`'s own doc comment already establishes that
 * `_robotlink._tcp`/`_udp` robots only ever emit **unsolicited
 * periodic** announcements (observed live at +23s/+50s in a 75s
 * capture) — `browseServices()` already waits up to
 * `DEFAULT_ROBOTLINK_BROWSE_WINDOW_MS` (65s) for the *first* one to
 * appear, but that only helps once *any* robotlink has shown up; a
 * second live re-run of the full harness still showed `gopiv`'s own
 * `wifi` row missing entirely, purely because that particular robot's
 * next announcement hadn't landed yet within this run's window even
 * though `vevov`'s had (satisfying `sawRobotlink` and ending the browse
 * early). A periodic-announcement service can never be turned into an
 * on-demand one from the harness side — so this module adds a second,
 * independent path to the same evidence: resolve every *known* robot
 * name's own `<name>.local` A record directly (bounded, per
 * `dnsResolve.ts`'s own `DEFAULT_RESOLVE_TIMEOUT_MS`) and dial port 7654
 * directly, exactly the way a browser-discovered endpoint is dialed.
 * `gopiv` (192.168.1.193) and `vevov` (192.168.1.184) both answered
 * `HELLO`/`ID` this way on the live 2026-09-13 bench run even when
 * `gopiv`'s own mDNS announcement never arrived in time.
 *
 * A name found this way is recorded with its own `reason` suffix
 * ("found by name lookup, not announcement") so the report is honest
 * about *how* reachability was established — this is not the same
 * evidence as an actual mDNS announcement, and a reader comparing this
 * harness's report against `dns-sd -B` output should not be confused
 * about why a name appears here without one.
 */

/** Same five-letter micro:bit name shape `layer1/index.ts`'s own mbrelay
 * sweep filters candidate names to (duplicated, not imported, to keep
 * this module usable independent of that file's import graph — it's a
 * one-line regex, not worth a shared-module indirection). */
export const FRIENDLY_NAME_PATTERN = /^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/;

/** The well-known `_robotlink._tcp` port every WiFi robot listens on
 * (matches `wifiProbe.ts`'s own module doc comment and every live bench
 * fact this sprint recorded). */
export const WIFI_ROBOTLINK_PORT = 7654;

/**
 * Every well-formed robot name from `knownNames` that has **not**
 * already been found via a live mDNS announcement (`alreadyAnnounced`)
 * — pure, so the "who still needs a direct name-lookup probe" selection
 * is directly testable without any real DNS/socket I/O. Sorted for
 * deterministic probe order (and deterministic test assertions).
 */
export function namesNeedingWifiLookup(
  knownNames: readonly string[],
  alreadyAnnounced: ReadonlySet<string>,
): string[] {
  const candidates = new Set(knownNames.filter((name) => FRIENDLY_NAME_PATTERN.test(name)));
  return [...candidates].filter((name) => !alreadyAnnounced.has(name)).sort();
}
