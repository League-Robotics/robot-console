/**
 * mdnsDiscovery.ts — browse `_mbrelay._tcp`, `_mbserial._tcp`, and
 * `_robotlink._tcp`/`_robotlink._udp` on the LAN and expose the current
 * set of discovered services as a typed, observable list.
 *
 * Per `sprint.md`'s Step 3 (`discovery/mdnsDiscovery.ts`'s row) and
 * `docs/design/specification.md` §4.4: a relay advertises itself under
 * `_mbrelay._tcp` (instance name is the relay's own five-letter name,
 * TXT carries `registry=<port>`, the port the registry HTTP endpoint
 * listens on — verified live: instance `torture` at `torture.local.:
 * 8760`, TXT `registry=8761`); a robot reachable directly over its own
 * serial-bridge-shaped service advertises under `_mbserial._tcp`, whose
 * instance name **is** the target robot's five-letter name directly, no
 * further parsing needed. A WiFi-reachable robot additionally
 * advertises itself under `_robotlink._tcp` **and** `_robotlink._udp`
 * simultaneously (live-verified, sprint 010, 2026-09-10: `gopiv` at
 * 192.168.1.218, instance `gopiv robot link`, SRV `gopiv.local.:7654`,
 * TXT `name=gopiv role=robot link=v6 port=7654`) — parsed by TXT
 * `name` (not the instance string) and deduplicated across the two
 * service types into one {@link WifiRobotService} per robot; see that
 * type's doc comment. This module owns only the browse+parse step for
 * all service types — mirroring `devices.ts`'s `DeviceWatcher`
 * `onChange`-style callback shape (`current()`, `onChange()`,
 * `start()`/`stop()`), not a one-shot query, so a caller/UI can react to
 * relays, robots, and WiFi robots appearing/disappearing on the network
 * live.
 *
 * ## Passive, unlike `mbrelayRegistry.ts`
 *
 * Browsing here is **read-only and side-effect-free**: it only listens
 * for mDNS advertisements already being broadcast on the LAN. It never
 * writes anything, never calls the registry HTTP endpoint a discovered
 * relay's `registryPort` points at, and is always safe to call
 * speculatively (start it and forget it). This is a deliberately
 * different property from `mbrelayRegistry.ts` (a future ticket), whose
 * `resolveRobotAddress` calls are a live HTTP request with the
 * write-on-read trap described in `sprint.md` — a future reader must not
 * conflate the two modules' very different "is this safe to call
 * speculatively" properties.
 *
 * ## Injectable backend, no real multicast socket in tests
 *
 * The actual mDNS browse call is provided by an injected
 * {@link MdnsBackend} (default: a lazily-constructed real
 * `bonjour-service` `Bonjour` instance, mirroring `devices.ts`'s
 * `enumerateDaplinkDevices` default and `releases.ts`'s injected
 * `fetch` pattern). `bonjour-service`'s `Bonjour` constructor is what
 * opens a real multicast socket, as a side effect of construction --
 * not the module import itself (the same "import is free, construction
 * is not" property `devices.ts` relies on for `serialport`/`node-hid`).
 * The default backend's `Bonjour` instance is therefore only
 * constructed the first time {@link MdnsDiscovery.start} runs with no
 * backend injected, never at module load time and never when a test
 * supplies its own fake. Tests substitute a fully synthetic fake
 * backend that emits scripted `up`/`down` events.
 *
 * ## No `EndpointListEntry` synthesis here
 *
 * Per `sprint.md`'s Design Rationale, a discovered service is not
 * forced into `EndpointListEntry`'s vocabulary (that shape is reserved
 * for a routable, session-capable thing with a `resourceKey` — a bare
 * discovery has neither). This module returns only its own
 * {@link RelayService}/{@link RobotService}/{@link WifiRobotService}
 * records; wiring a `rememberedRobots`-shaped snapshot list into
 * `wsMessages.ts`/`server.ts`/`WsProvider.tsx` is a later ticket's job.
 * In particular, this module's raw `wifiRobots` list is **not** gated
 * against the roster (that is ticket 002's job) and is never itself
 * exposed on the wire — see this sprint's Design Rationale, "No
 * wire-visible ungated WiFi list."
 */

import Bonjour from "bonjour-service";

/**
 * Minimal shape this module needs from a discovered mDNS service --
 * narrower than `bonjour-service`'s own `Service` class, so a test
 * fixture only needs to implement these four fields rather than a real
 * `Service` (which a real backend's event already structurally
 * satisfies).
 */
export interface MdnsService {
  /** mDNS instance name -- e.g. `torture` for a relay, or the target
   * robot's five-letter name directly for `_mbserial._tcp`. */
  name: string;
  /** Resolved hostname, e.g. `torture.local.`. */
  host: string;
  port: number;
  /** Parsed TXT record key/value pairs (string-valued -- `dns-txt`'s
   * default, non-binary decode). Absent or empty if the service
   * advertised no TXT record. */
  txt?: Record<string, string>;
  /** The instance's fully-qualified mDNS name (e.g.
   * `gopiv robot link._robotlink._tcp.local`) -- the key
   * {@link MdnsBackend.onAnnounce} reports and {@link MdnsBrowser.forget}
   * accepts. Absent from a backend that does not track liveness. */
  fqdn?: string;
}

/** Listener shape for one browse session's `up`/`down` events. */
export type MdnsServiceListener = (service: MdnsService) => void;

/**
 * One live browse session for one service type. Structurally satisfied
 * by `bonjour-service`'s own `Browser` (an `EventEmitter` with `on()`/
 * `stop()`) without any wrapping needed beyond translating its `Service`
 * events -- see {@link createBonjourBackend}.
 */
export interface MdnsBrowser {
  on(event: "up" | "down", listener: MdnsServiceListener): void;
  /** Stop this browse session (no more `up`/`down` events after this
   * returns). Idempotent. */
  stop(): void;
  /** OOP 2026-09-10: drop one instance from this browse session's own
   * memory, emitting `down` for it, so a later announcement of the same
   * instance fires `up` again. `bonjour-service` only ever emits `up`
   * for an instance it has not seen before and never expires one on its
   * own, so without this a robot that went away and came back would be
   * invisible forever. Optional: a backend without it is simply never
   * asked. */
  forget?(fqdn: string): void;
}

/** Options passed to {@link MdnsBackend.find}, mirroring
 * `bonjour-service`'s own `find({ type, protocol })` shape. */
export interface MdnsFindOptions {
  /** Service type without the leading underscore or protocol suffix,
   * e.g. `"mbrelay"` for `_mbrelay._tcp`. */
  type: string;
  /** `"udp"` added for `_robotlink._udp` -- `_mbrelay`/`_mbserial` are
   * `"tcp"`-only. */
  protocol: "tcp" | "udp";
}

/** Injectable mDNS backend seam. Default (real): a lazily-constructed
 * `bonjour-service` `Bonjour` instance. Tests inject a fully synthetic
 * fake that never touches a real multicast socket. */
export interface MdnsBackend {
  find(options: MdnsFindOptions): MdnsBrowser;
  /** OOP 2026-09-10: subscribe to every PTR answer heard on the wire,
   * reported as the instance's fqdn plus the receive time -- the only
   * way to learn that an already-known, announce-only instance is
   * still alive (see {@link MdnsBrowser.forget}). Returns an
   * unsubscribe function. Optional: without it, WiFi records are never
   * aged out. */
  onAnnounce?(listener: (fqdn: string, receivedAt: number) => void): () => void;
  /** Release the backend's own resources (e.g. close its multicast
   * socket). Not called by {@link MdnsDiscovery.stop} -- see that
   * method's doc comment for why. */
  destroy(): void;
}

/** `_mbrelay._tcp`'s service type, per `specification.md` §4.4. */
const RELAY_SERVICE_TYPE = "mbrelay";
/** `_mbserial._tcp`'s service type, per `specification.md` §4.4. */
const ROBOT_SERVICE_TYPE = "mbserial";
/** `_robotlink._tcp`/`_robotlink._udp`'s service type, per
 * `specification.md` §4.4 (corrected) and this sprint's Architecture
 * Step 5 -- live-verified (2026-09-10, `gopiv`) to advertise
 * simultaneously on both `_tcp` and `_udp`. */
const ROBOTLINK_SERVICE_TYPE = "robotlink";

/**
 * Constructs the real `bonjour-service`-backed {@link MdnsBackend}.
 * `bonjour-service`'s `Bonjour` constructor opens a real multicast
 * socket as a side effect, so this is only ever called from
 * {@link MdnsDiscovery.start} when no backend was injected -- never at
 * module load time, never from a test that supplies its own fake.
 */
function createBonjourBackend(): MdnsBackend {
  const bonjour = new Bonjour();
  return {
    find(options: MdnsFindOptions): MdnsBrowser {
      const browser = bonjour.find({ type: options.type, protocol: options.protocol });
      return {
        on(event: "up" | "down", listener: MdnsServiceListener): void {
          browser.on(event, (service) => {
            listener({
              name: service.name,
              host: service.host,
              port: service.port,
              ...(service.txt !== undefined ? { txt: service.txt as Record<string, string> } : {}),
              fqdn: service.fqdn,
            });
          });
        },
        stop(): void {
          browser.stop();
        },
        forget(fqdn: string): void {
          // `Browser.removeService` is a real, public method of
          // bonjour-service's Browser (it emits `down` and drops the
          // instance from its list) that its `.d.ts` simply does not
          // declare.
          (browser as unknown as { removeService(fqdn: string): void }).removeService(fqdn);
        },
      };
    },
    onAnnounce(listener: (fqdn: string, receivedAt: number) => void): () => void {
      // The multicast-dns instance every Browser listens on -- private
      // in the typings, but the one place raw response packets (and so
      // re-announcements of already-known instances) can be observed.
      const mdns = (bonjour as unknown as { server: { mdns: NodeJS.EventEmitter } }).server.mdns;
      const handler = (packet: { answers?: DnsRecord[]; additionals?: DnsRecord[] }): void => {
        const receivedAt = Date.now();
        for (const record of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
          if (record.type === "PTR" && typeof record.data === "string" && (record.ttl ?? 0) > 0) {
            listener(record.data, receivedAt);
          }
        }
      };
      mdns.on("response", handler);
      return () => {
        mdns.removeListener("response", handler);
      };
    },
    destroy(): void {
      bonjour.destroy();
    },
  };
}

/** The slice of a multicast-dns resource record {@link createBonjourBackend}'s
 * announce listener reads. */
interface DnsRecord {
  type: string;
  data?: unknown;
  ttl?: number;
}

/**
 * A discovered `_mbrelay._tcp` service, parsed per `specification.md`
 * §4.4. `registryPort` is the registry HTTP endpoint's port, read from
 * the TXT record's `registry=<port>` field -- `undefined` (never a
 * thrown error, never a guessed default) when that field is absent or
 * unparseable.
 */
export interface RelayService {
  instanceName: string;
  host: string;
  port: number;
  registryPort: number | undefined;
}

/**
 * A discovered `_mbserial._tcp` service. `instanceName` **is** the
 * target robot's five-letter name directly, per `specification.md`
 * §4.4 -- no further lookup or transformation.
 */
export interface RobotService {
  instanceName: string;
  host: string;
  port: number;
}

/**
 * A discovered `_robotlink._tcp`/`_robotlink._udp` service, parsed per
 * `specification.md` §4.4 (corrected) and this sprint's Architecture
 * Step 5. Unlike {@link RelayService}/{@link RobotService}, `name` is
 * read from the TXT record's `name` field, **not** the mDNS instance
 * string -- live-verified (2026-09-10, `gopiv`) instance strings are a
 * human-readable label ("gopiv robot link"), while TXT `name` is the
 * robot's actual five-letter name ("gopiv"). `role`/`link` are carried
 * through as opaque TXT strings, undefined when the TXT record omits
 * them -- never thrown, never guessed, mirroring
 * {@link parseRegistryPort}'s discipline. `host`/`port` come from the
 * resolved SRV record, same as {@link RelayService}/{@link RobotService}.
 */
export interface WifiRobotService {
  name: string;
  host: string;
  port: number;
  role: string | undefined;
  link: string | undefined;
}

/** Current discovered-service snapshot, split by service type. */
export interface MdnsDiscoverySnapshot {
  relays: readonly RelayService[];
  robots: readonly RobotService[];
  wifiRobots: readonly WifiRobotService[];
}

export type MdnsDiscoveryListener = (current: MdnsDiscoverySnapshot) => void;

export interface MdnsDiscoveryOptions {
  /** Injectable mDNS backend. Defaults to a lazily-constructed real
   * `bonjour-service` backend. Tests/callers substitute a fully
   * synthetic fake so no real multicast socket is ever opened. */
  backend?: MdnsBackend;
  /** OOP 2026-09-10: how long a WiFi robot may go without a heard
   * announcement before its record is dropped (and forgotten in the
   * browser -- see {@link MdnsBrowser.forget}). The robots announce
   * every 60 s with a 120 s PTR TTL, so the default,
   * {@link DEFAULT_WIFI_STALE_AFTER_MS}, tolerates one missed
   * announcement plus slack. `0` disables aging entirely. */
  staleAfterMs?: number;
  /** OOP 2026-09-10: how often the staleness sweep runs. Default
   * {@link DEFAULT_WIFI_SWEEP_INTERVAL_MS}. */
  sweepIntervalMs?: number;
}

export const DEFAULT_WIFI_STALE_AFTER_MS = 150_000;
export const DEFAULT_WIFI_SWEEP_INTERVAL_MS = 30_000;

/**
 * Parse a raw TXT `registry` field into a port number. Never throws:
 * an absent field, a non-digit string, or an out-of-range value all
 * come back as `undefined` rather than a thrown error or a guessed
 * default port -- per this module's acceptance criteria.
 */
function parseRegistryPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function parseRelayService(service: MdnsService): RelayService {
  return {
    instanceName: service.name,
    host: service.host,
    port: service.port,
    registryPort: parseRegistryPort(service.txt?.registry),
  };
}

function parseRobotService(service: MdnsService): RobotService {
  return {
    instanceName: service.name,
    host: service.host,
    port: service.port,
  };
}

/**
 * The TXT record's `name` field is this service's dedup/lookup key --
 * per {@link WifiRobotService}'s doc comment, never the mDNS instance
 * string. Falls back to the instance name only if TXT is absent
 * entirely, so a malformed advertisement is still tracked under some
 * key rather than silently dropped.
 */
function wifiRobotKey(service: MdnsService): string {
  return service.txt?.name ?? service.name;
}

function parseWifiRobotService(service: MdnsService): WifiRobotService {
  return {
    name: wifiRobotKey(service),
    host: service.host,
    port: service.port,
    role: service.txt?.role,
    link: service.txt?.link,
  };
}

/**
 * Live browse session over `_mbrelay._tcp`, `_mbserial._tcp`, and
 * `_robotlink._tcp`/`_robotlink._udp`: subscribes to an injected
 * {@link MdnsBackend}'s `up`/`down` events for each service type and
 * exposes the current, live-updating set of parsed
 * {@link RelayService}/{@link RobotService}/{@link WifiRobotService}
 * records. Deliberately mirrors `devices.ts`'s `DeviceWatcher` shape
 * (`current()`,
 * `onChange()`, `start()`/`stop()`) even though the underlying mechanism
 * here is push-based mDNS events rather than `DeviceWatcher`'s
 * poll-and-diff -- so callers compose this the same way they already
 * compose `DeviceWatcher`/`FirmwareAvailabilityCache`.
 *
 * Relays/robots are keyed by each service's mDNS instance name
 * (`RelayService.instanceName` / `RobotService.instanceName`) within its
 * own service type -- a `down` event for a name removes exactly that
 * entry from the corresponding list on the next `current()` read.
 * WiFi robots are keyed instead by {@link wifiRobotKey} (the TXT
 * record's `name` field, not the instance string) *across* both
 * `_robotlink._tcp` and `_robotlink._udp` -- a robot advertising on
 * both simultaneously (the live-verified norm) collapses into one
 * entry, and a `down` event on either service type removes it.
 */
export class MdnsDiscovery {
  private readonly injectedBackend: MdnsBackend | undefined;
  private backend: MdnsBackend | undefined;
  private relayBrowser: MdnsBrowser | undefined;
  private robotBrowser: MdnsBrowser | undefined;
  private robotlinkTcpBrowser: MdnsBrowser | undefined;
  private robotlinkUdpBrowser: MdnsBrowser | undefined;
  private readonly relays = new Map<string, RelayService>();
  private readonly robots = new Map<string, RobotService>();
  /** Keyed by {@link wifiRobotKey} (TXT `name`), not mDNS instance name
   * or service type -- so a robot advertising on both `_robotlink._tcp`
   * and `_robotlink._udp` simultaneously (the live-verified norm)
   * collapses into exactly one entry. */
  private readonly wifiRobots = new Map<string, WifiRobotService>();
  private readonly listeners = new Set<MdnsDiscoveryListener>();
  /** OOP 2026-09-10: liveness bookkeeping per WiFi instance fqdn (one
   * per service type the robot advertises on) -- see
   * {@link MdnsDiscoveryOptions.staleAfterMs}. */
  private readonly wifiLiveness = new Map<string, { browser: MdnsBrowser; key: string; lastSeen: number }>();
  private readonly staleAfterMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeAnnounce: (() => void) | undefined;

  constructor(options: MdnsDiscoveryOptions = {}) {
    this.injectedBackend = options.backend;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_WIFI_STALE_AFTER_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_WIFI_SWEEP_INTERVAL_MS;
  }

  /** OOP 2026-09-10: drop every WiFi instance not heard from within
   * {@link staleAfterMs}. Forgetting it in its browser emits `down`,
   * which {@link start}'s handler turns into the snapshot change; a
   * backend without `forget` gets the same snapshot change directly. */
  private sweepStaleWifiRobots(): void {
    const now = Date.now();
    for (const [fqdn, record] of [...this.wifiLiveness]) {
      if (now - record.lastSeen <= this.staleAfterMs) {
        continue;
      }
      this.wifiLiveness.delete(fqdn);
      if (record.browser.forget) {
        record.browser.forget(fqdn);
      } else if (this.wifiRobots.delete(record.key)) {
        this.notify();
      }
    }
  }

  /** Discovered services as of the most recent `up`/`down` event
   * (empty lists before {@link start} has produced any events yet). */
  current(): MdnsDiscoverySnapshot {
    return {
      relays: [...this.relays.values()],
      robots: [...this.robots.values()],
      wifiRobots: [...this.wifiRobots.values()],
    };
  }

  /** Subscribe to change events, fired with the full current snapshot
   * after every `up`/`down` event that actually changes it. Returns an
   * unsubscribe function. */
  onChange(listener: MdnsDiscoveryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Begin browsing both service types. Idempotent -- a second call
   * while already started (before a matching {@link stop}) is a no-op.
   */
  start(): void {
    if (
      this.relayBrowser !== undefined ||
      this.robotBrowser !== undefined ||
      this.robotlinkTcpBrowser !== undefined ||
      this.robotlinkUdpBrowser !== undefined
    ) {
      return;
    }
    if (this.backend === undefined) {
      this.backend = this.injectedBackend ?? createBonjourBackend();
    }
    const backend = this.backend;

    this.relayBrowser = backend.find({ type: RELAY_SERVICE_TYPE, protocol: "tcp" });
    this.relayBrowser.on("up", (service) => {
      this.relays.set(service.name, parseRelayService(service));
      this.notify();
    });
    this.relayBrowser.on("down", (service) => {
      this.relays.delete(service.name);
      this.notify();
    });

    this.robotBrowser = backend.find({ type: ROBOT_SERVICE_TYPE, protocol: "tcp" });
    this.robotBrowser.on("up", (service) => {
      this.robots.set(service.name, parseRobotService(service));
      this.notify();
    });
    this.robotBrowser.on("down", (service) => {
      this.robots.delete(service.name);
      this.notify();
    });

    const onWifiRobotUp = (browser: MdnsBrowser) => (service: MdnsService): void => {
      const key = wifiRobotKey(service);
      this.wifiRobots.set(key, parseWifiRobotService(service));
      this.wifiLiveness.set(service.fqdn ?? service.name, { browser, key, lastSeen: Date.now() });
      this.notify();
    };
    const onWifiRobotDown = (service: MdnsService): void => {
      this.wifiRobots.delete(wifiRobotKey(service));
      this.wifiLiveness.delete(service.fqdn ?? service.name);
      this.notify();
    };

    const tcp = backend.find({ type: ROBOTLINK_SERVICE_TYPE, protocol: "tcp" });
    this.robotlinkTcpBrowser = tcp;
    tcp.on("up", onWifiRobotUp(tcp));
    tcp.on("down", onWifiRobotDown);

    const udp = backend.find({ type: ROBOTLINK_SERVICE_TYPE, protocol: "udp" });
    this.robotlinkUdpBrowser = udp;
    udp.on("up", onWifiRobotUp(udp));
    udp.on("down", onWifiRobotDown);

    // OOP 2026-09-10: age out WiFi robots that stop announcing -- see
    // MdnsDiscoveryOptions.staleAfterMs.
    this.unsubscribeAnnounce = backend.onAnnounce?.((fqdn, receivedAt) => {
      const record = this.wifiLiveness.get(fqdn);
      if (record) {
        record.lastSeen = receivedAt;
      }
    });
    if (this.staleAfterMs > 0 && this.sweepIntervalMs > 0) {
      const timer = setInterval(() => this.sweepStaleWifiRobots(), this.sweepIntervalMs);
      timer.unref?.();
      this.sweepTimer = timer;
    }
  }

  /**
   * Stop both browse sessions -- no more `up`/`down` events after this
   * returns. Does **not** call the backend's own `destroy()` (which
   * would close its underlying multicast socket): the backend may be
   * injected and shared, and re-{@link start}ing after `stop()` must
   * work without reconstructing it. No-op if not started.
   */
  stop(): void {
    this.relayBrowser?.stop();
    this.robotBrowser?.stop();
    this.robotlinkTcpBrowser?.stop();
    this.robotlinkUdpBrowser?.stop();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.unsubscribeAnnounce?.();
    this.unsubscribeAnnounce = undefined;
    this.wifiLiveness.clear();
    this.relayBrowser = undefined;
    this.robotBrowser = undefined;
    this.robotlinkTcpBrowser = undefined;
    this.robotlinkUdpBrowser = undefined;
  }

  private notify(): void {
    const snapshot = this.current();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
