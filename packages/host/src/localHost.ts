/**
 * localHost.ts — "is this mDNS observation actually this machine
 * talking to itself?" (ticket 018-010: the stakeholder's own Mac,
 * hostname `gala`, minted itself a front-page relay card reading "No
 * role announced" — some locally-running process was advertising an
 * `_mbrelay._tcp`/`_mbserial._tcp` service whose SRV target resolved
 * back to `gala`'s own machine). "You're going to plug something in,
 * and it's going to show up in the list. You don't need to identify the
 * host" — the stakeholder's own framing: a card is for a physical relay
 * or robot on the bench, never for the host process itself.
 *
 * Two independent signals, either sufficient on its own:
 *
 * - The service's resolved SRV hostname ({@link MdnsService.host}, e.g.
 *   `gala.local.`) names this machine's own hostname
 *   (`os.hostname()`) once both sides are normalized (see
 *   {@link normalizeHostCandidate}).
 * - The service's own resolved address(es) ({@link
 *   MdnsService.addresses}) are loopback, or one of this machine's own
 *   interface addresses (`os.networkInterfaces()`) — covers a service
 *   resolved by IP alone, or a hostname that does not textually match
 *   (a renamed interface, a `.local` alias, etc.).
 *
 * Used two places: `watchers/mdnsWatcher.ts`'s `handleMbrelay`/
 * `handleMbserial` (never mint/observe a device or link for a
 * self-advertisement in the first place) and
 * `store/repair/removeLocalHostDeviceRows.ts` (a one-time cleanup for a
 * `devices` row a *previous*, unfiltered run already minted — the
 * stakeholder's own real database already carries one, and nothing
 * short of a repair removes a row that already exists).
 */
import os from "node:os";

/** Lower-cases `raw`, then strips a trailing `.` (mDNS FQDNs are
 * dot-terminated, e.g. `gala.local.`) and a trailing `.local` (or
 * `.local.`, handled by the first strip running first) — so
 * `"gala.local."`, `"gala.local"`, and `"gala"` all normalize to the
 * same `"gala"`, matched against `os.hostname()` normalized the same
 * way (macOS's own `os.hostname()` is observed to return the bare
 * short name, e.g. `"gala"`, but this also tolerates a platform whose
 * `os.hostname()` includes the domain). */
export function normalizeHostCandidate(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
  }
  if (value.endsWith(".local")) {
    value = value.slice(0, -".local".length);
  }
  return value;
}

/** This machine's own hostname, normalized ({@link
 * normalizeHostCandidate}) — `os.hostname()`'s result, so this reflects
 * whatever the current process's own machine is actually called, never
 * a hardcoded stand-in for the stakeholder's own `gala`. */
export function localHostname(): string {
  return normalizeHostCandidate(os.hostname());
}

/** Is `name` (an mDNS instance name, or any other candidate host label)
 * this machine's own hostname, once both sides are normalized? */
export function isLocalHostname(name: string): boolean {
  return normalizeHostCandidate(name) === localHostname();
}

/** Every address this machine itself answers on right now: loopback
 * (`127.0.0.1`, `::1`, and the `localhost` label some resolvers hand
 * back verbatim) plus every address `os.networkInterfaces()` reports
 * for a real interface — read fresh on every call rather than cached,
 * since this module has no lifecycle of its own to invalidate a cache
 * on (a laptop's interfaces change constantly: DHCP renewal, Wi-Fi
 * roam, a USB-Ethernet dongle unplugged). */
export function localAddresses(): ReadonlySet<string> {
  const addresses = new Set<string>(["127.0.0.1", "::1", "localhost"]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      addresses.add(entry.address);
    }
  }
  return addresses;
}

/** Minimal shape this module needs from a discovered mDNS service —
 * narrower than `discovery/mdnsDiscovery.ts`'s own `MdnsService`, so a
 * test fixture only needs these two fields. */
export interface LocalHostCheckable {
  host?: string;
  addresses?: readonly string[];
}

/** Does `service` describe this very machine — its own hostname, or one
 * of its own addresses — rather than a separate physical relay or
 * robot on the network? See this module's own doc comment for the two
 * signals checked. */
export function isLocalMdnsService(service: LocalHostCheckable): boolean {
  if (service.host !== undefined && isLocalHostname(service.host)) {
    return true;
  }
  if (service.addresses !== undefined) {
    const local = localAddresses();
    if (service.addresses.some((address) => local.has(address))) {
      return true;
    }
  }
  return false;
}
