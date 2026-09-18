/**
 * discovery/consoleAdvertiser.ts — self-advertise this host over mDNS so
 * an agent or browser on the LAN can find the live console at whatever
 * port it actually bound to (sprint 021 ticket 002). Companion to
 * `server.ts`'s own `DEFAULT_HOST` widening to `0.0.0.0`: binding wider
 * is only useful if a caller elsewhere on the network has some way to
 * learn *where* — this module is that "where", reusing the same
 * mDNS machinery `discovery/mdnsDiscovery.ts` already browses with,
 * rather than inventing a second, parallel discovery mechanism.
 *
 * ## What this host advertises, and why it is unambiguous
 *
 * `_robotconsole._tcp`, instance name `os.hostname()`. Deliberately not
 * a separately-chosen display string, a per-run label, or anything a
 * caller of {@link startConsoleAdvertiser} gets to override: a bench
 * finding the day before this ticket (see sprint.md) found one physical
 * board presenting three *different* identity strings depending on
 * which advertisement you read — `_mbserial._tcp` gave `tovez-2`,
 * `_robotlink._tcp` gave `tovez robot link`, and the wire `HELLO` reply
 * (the only one of the three that actually comes from the chip) gave
 * `device NEZHA2 robot tovez`. That divergence cost real debugging time
 * and briefly looked like a prompt injection. The lesson applied here:
 * this host's own advertised name is tied to a single value nothing else
 * in this process could disagree with or restate differently —
 * `os.hostname()`, the same signal `localHost.ts`'s own `localHostname()`
 * already treats as this machine's authoritative identity, and the one
 * name any mDNS resolver on the LAN can already turn back into an
 * address (`<hostname>.local`) with no further parsing or lookup. A
 * future reader asking "what does this `_robotconsole._tcp` instance
 * name mean" has exactly one answer, not three.
 *
 * ## Injectable backend, no real multicast socket in tests
 *
 * Mirrors `mdnsDiscovery.ts`'s own `MdnsBackend`/`createBonjourBackend`
 * "import is free, construction is not" convention: `bonjour-service`'s
 * `Bonjour` constructor is what opens a real multicast socket, so
 * {@link createBonjourAdvertiserBackend} is only ever called from
 * {@link startConsoleAdvertiser}'s own default, when no backend is
 * injected — never at module load time, never from a test, which always
 * supplies a fully synthetic fake instead.
 */
import Bonjour from "bonjour-service";
import os from "node:os";

/** `_robotconsole._tcp`'s service type — the leading underscore and
 * `._tcp` suffix are added by the backend itself (mirroring
 * `mdnsDiscovery.ts`'s own `RELAY_SERVICE_TYPE`/`ROBOT_SERVICE_TYPE`
 * constants, which are likewise bare, underscore-free strings handed to
 * `bonjour-service`). See the module doc comment's "What this host
 * advertises" section for why this is the one, deliberately chosen
 * name. */
export const CONSOLE_SERVICE_TYPE = "robotconsole";

/** Config {@link ConsoleAdvertiserBackend.publish} is called with —
 * matches `bonjour-service`'s own `Bonjour#publish(opts)` shape closely
 * enough that the real backend needs no adaptation beyond wrapping its
 * returned `Service` (see {@link createBonjourAdvertiserBackend}). */
export interface PublishConfig {
  readonly name: string;
  readonly type: string;
  readonly protocol: "tcp";
  readonly port: number;
}

/** One published mDNS service — the handle {@link
 * ConsoleAdvertiserBackend.publish} returns. `unpublish()` withdraws
 * exactly this advertisement (a real backend sends the mDNS "goodbye"
 * packet — TTL 0 — for this service's own records). Named `unpublish`
 * rather than `stop` deliberately, so it never reads as a synonym for
 * {@link ConsoleAdvertiser.stop} — that method stops this whole
 * advertising *session* (unpublish the service, then release the
 * backend's own socket), not just one service. */
export interface PublishedConsoleService {
  unpublish(): void;
}

/** Injectable mDNS advertising backend. Default (real): a
 * lazily-constructed `bonjour-service` `Bonjour` instance — see the
 * module doc comment. Tests inject a fully synthetic fake that never
 * touches a real multicast socket, mirroring `mdnsDiscovery.ts`'s own
 * `MdnsBackend` test fakes. */
export interface ConsoleAdvertiserBackend {
  publish(config: PublishConfig): PublishedConsoleService;
  /** Release the backend's own resources (its multicast socket). */
  destroy(): void;
}

export interface ConsoleAdvertiserOptions {
  /** The port to advertise. The *actual* bound port
   * (`RunningServer.port`, once `server.ts`'s own `listen()` has
   * resolved) — not a requested one that may differ, e.g. an ephemeral
   * `0` request. */
  readonly port: number;
  /** Injectable backend. Defaults to a lazily-constructed real
   * `bonjour-service` backend ({@link createBonjourAdvertiserBackend})
   * — see the module doc comment. */
  readonly backend?: ConsoleAdvertiserBackend;
}

export interface ConsoleAdvertiser {
  /** Withdraw the advertisement (mDNS "goodbye") and release the
   * backend's own resources. Idempotent — a second call is a no-op, so
   * `cli.ts`'s shutdown path can call this unconditionally without
   * tracking whether it already ran. */
  stop(): void;
}

/** The real default {@link ConsoleAdvertiserOptions.backend}: a
 * lazily-constructed `bonjour-service` `Bonjour` instance, wrapping its
 * `publish()`'s returned `Service`'s own `stop()` (a real un-publish —
 * see `bonjour-service`'s `Registry#teardown`) as {@link
 * PublishedConsoleService.unpublish}. Exported for the same reason
 * `mdnsDiscovery.ts` exports `createBonjourBackend`: a real caller
 * assembling its own backend by hand has one real constructor to reuse
 * rather than duplicate — {@link startConsoleAdvertiser}'s own default
 * is the only current caller. */
export function createBonjourAdvertiserBackend(): ConsoleAdvertiserBackend {
  const bonjour = new Bonjour();
  return {
    publish(config: PublishConfig): PublishedConsoleService {
      const service = bonjour.publish({
        name: config.name,
        type: config.type,
        protocol: config.protocol,
        port: config.port,
      });
      return {
        unpublish(): void {
          service.stop();
        },
      };
    },
    destroy(): void {
      bonjour.destroy();
    },
  };
}

/**
 * Advertise this host over mDNS at `options.port` — see the module doc
 * comment. Publishes immediately (synchronously constructs the backend,
 * if none was injected, and calls `publish`); returns a `stop()` that
 * withdraws the advertisement and releases the backend, safe to call
 * more than once (only the first call does anything).
 */
export function startConsoleAdvertiser(options: ConsoleAdvertiserOptions): ConsoleAdvertiser {
  const backend = options.backend ?? createBonjourAdvertiserBackend();
  const service = backend.publish({
    name: os.hostname(),
    type: CONSOLE_SERVICE_TYPE,
    protocol: "tcp",
    port: options.port,
  });

  let stopped = false;
  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      service.unpublish();
      backend.destroy();
    },
  };
}
