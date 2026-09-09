/**
 * mdnsDiscovery.ts — browse `_mbrelay._tcp` and `_mbserial._tcp` on the
 * LAN and expose the current set of discovered services as a typed,
 * observable list.
 *
 * Per `sprint.md`'s Step 3 (`discovery/mdnsDiscovery.ts`'s row) and
 * `docs/design/specification.md` §4.4: a relay advertises itself under
 * `_mbrelay._tcp` (instance name is the relay's own five-letter name,
 * TXT carries `registry=<port>`, the port the registry HTTP endpoint
 * listens on — verified live: instance `torture` at `torture.local.:
 * 8760`, TXT `registry=8761`); a robot reachable directly over its own
 * serial-bridge-shaped service advertises under `_mbserial._tcp`, whose
 * instance name **is** the target robot's five-letter name directly, no
 * further parsing needed. This module owns only the browse+parse step
 * for both service types — mirroring `devices.ts`'s `DeviceWatcher`
 * `onChange`-style callback shape (`current()`, `onChange()`,
 * `start()`/`stop()`), not a one-shot query, so a caller/UI can react to
 * relays and robots appearing/disappearing on the network live.
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
 * {@link RelayService}/{@link RobotService} records; wiring a
 * `rememberedRobots`-shaped snapshot list into `wsMessages.ts`/
 * `server.ts`/`WsProvider.tsx` is a later ticket's job.
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
}

/** Options passed to {@link MdnsBackend.find}, mirroring
 * `bonjour-service`'s own `find({ type, protocol })` shape. */
export interface MdnsFindOptions {
  /** Service type without the leading underscore or protocol suffix,
   * e.g. `"mbrelay"` for `_mbrelay._tcp`. */
  type: string;
  protocol: "tcp";
}

/** Injectable mDNS backend seam. Default (real): a lazily-constructed
 * `bonjour-service` `Bonjour` instance. Tests inject a fully synthetic
 * fake that never touches a real multicast socket. */
export interface MdnsBackend {
  find(options: MdnsFindOptions): MdnsBrowser;
  /** Release the backend's own resources (e.g. close its multicast
   * socket). Not called by {@link MdnsDiscovery.stop} -- see that
   * method's doc comment for why. */
  destroy(): void;
}

/** `_mbrelay._tcp`'s service type, per `specification.md` §4.4. */
const RELAY_SERVICE_TYPE = "mbrelay";
/** `_mbserial._tcp`'s service type, per `specification.md` §4.4. */
const ROBOT_SERVICE_TYPE = "mbserial";

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
            });
          });
        },
        stop(): void {
          browser.stop();
        },
      };
    },
    destroy(): void {
      bonjour.destroy();
    },
  };
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

/** Current discovered-service snapshot, split by service type. */
export interface MdnsDiscoverySnapshot {
  relays: readonly RelayService[];
  robots: readonly RobotService[];
}

export type MdnsDiscoveryListener = (current: MdnsDiscoverySnapshot) => void;

export interface MdnsDiscoveryOptions {
  /** Injectable mDNS backend. Defaults to a lazily-constructed real
   * `bonjour-service` backend. Tests/callers substitute a fully
   * synthetic fake so no real multicast socket is ever opened. */
  backend?: MdnsBackend;
}

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
 * Live browse session over both `_mbrelay._tcp` and `_mbserial._tcp`:
 * subscribes to an injected {@link MdnsBackend}'s `up`/`down` events for
 * each service type and exposes the current, live-updating set of
 * parsed {@link RelayService}/{@link RobotService} records. Deliberately
 * mirrors `devices.ts`'s `DeviceWatcher` shape (`current()`,
 * `onChange()`, `start()`/`stop()`) even though the underlying mechanism
 * here is push-based mDNS events rather than `DeviceWatcher`'s
 * poll-and-diff -- so callers compose this the same way they already
 * compose `DeviceWatcher`/`FirmwareAvailabilityCache`.
 *
 * Keyed by each service's mDNS instance name (`RelayService.instanceName`
 * / `RobotService.instanceName`) within its own service type -- a `down`
 * event for a name removes exactly that entry from the corresponding
 * list on the next `current()` read.
 */
export class MdnsDiscovery {
  private readonly injectedBackend: MdnsBackend | undefined;
  private backend: MdnsBackend | undefined;
  private relayBrowser: MdnsBrowser | undefined;
  private robotBrowser: MdnsBrowser | undefined;
  private readonly relays = new Map<string, RelayService>();
  private readonly robots = new Map<string, RobotService>();
  private readonly listeners = new Set<MdnsDiscoveryListener>();

  constructor(options: MdnsDiscoveryOptions = {}) {
    this.injectedBackend = options.backend;
  }

  /** Discovered services as of the most recent `up`/`down` event
   * (empty lists before {@link start} has produced any events yet). */
  current(): MdnsDiscoverySnapshot {
    return { relays: [...this.relays.values()], robots: [...this.robots.values()] };
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
    if (this.relayBrowser !== undefined || this.robotBrowser !== undefined) {
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
    this.relayBrowser = undefined;
    this.robotBrowser = undefined;
  }

  private notify(): void {
    const snapshot = this.current();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
