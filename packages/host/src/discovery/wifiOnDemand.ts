/**
 * wifiOnDemand.ts — bounded, off-hot-path WiFi link *creation* fallback
 * (ticket 019-002; issue
 * `bench-wifi-robot-discovery-waits-for-announcement.md`).
 *
 * `watchers/mdnsWatcher.ts` only creates a `links(wifi)` row when it
 * receives an mDNS observation (`up`/`onServiceChange`, or its own
 * periodic re-query catching a live re-announce). The WiFi robots'
 * `_robotlink._tcp`/`._udp` responder only ever sends **unsolicited**
 * periodic announcements and never answers a query, so an owned WiFi
 * robot can sit with no `wifi` link at all for however long it takes the
 * next announcement to land — confirmed live and intermittent against
 * `tigez` on 2026-09-17 (two bench runs 15 minutes apart, same robot,
 * one passed Layer 3's WiFi check and one didn't, with no discovery code
 * changed between them).
 *
 * This module is the active counterpart: given a candidate robot name,
 * resolve `<name>.local` IPv4 with a bounded `dns.lookup(host, {family:
 * 4})` (mirrors `link/adapters/tcpStream.ts`'s 018-007 fix and
 * `connect/mbflashClient.ts`'s own copy of it — same shape, third
 * module), then dial {@link WIFI_ROBOTLINK_PORT} and confirm a `HELLO`
 * reply, bounded by its own timeout. {@link probeWifiOnDemand} never
 * throws — every failure (no DNS record, connection refused, timeout, an
 * unparseable or wrongly-named reply) comes back as a `"not-found"`
 * result with a plain-worded reason, mirroring `mbflashClient.ts`'s own
 * "failure is a value" convention — so a caller can fire this off
 * without a `try`/`catch` and without it ever becoming an unhandled
 * rejection.
 *
 * `watchers/mdnsWatcher.ts` is the only production caller (see that
 * module's own "WiFi on-demand fallback" doc section): it calls this,
 * unawaited, once per owned/non-relay device with no live `wifi` link,
 * on its own existing browse-cycle tick plus once immediately at start —
 * never inside anything that blocks the watcher's own synchronous
 * per-tick work (the browser `update()` calls, aging/pruning, the
 * heartbeat). A caller that wants to dial a *known* address instead of
 * resolving one — an already-observed `wifi`/`mbserial` link — should
 * use `tcpStream.ts` directly; this module exists specifically for the
 * "no link/address exists yet at all" case.
 *
 * Bounds mirror `tcpStream.ts`'s own `DEFAULT_DNS_LOOKUP_TIMEOUT_MS`
 * (2s) — the ticket's own acceptance criterion asks for "the existing
 * connect-timeout order of magnitude", and this is the constant that
 * order of magnitude is drawn from, not an independently-invented value.
 * The connect and HELLO-reply waits reuse the same 2s bound for the same
 * reason: all three steps are meant to be quick when the robot is
 * actually there, and this whole probe is retried on `mdnsWatcher.ts`'s
 * own bounded schedule regardless of how any one attempt ends, so there
 * is no benefit to a longer wait here.
 */
import { connect as netConnect, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { parseBanner, type ParsedBanner } from "@robot-console/protocol";
import { withTimeout } from "../lib/withTimeout.js";

/** The well-known `_robotlink._tcp`/`._udp` port every WiFi robot
 * listens on — matches `watchers/mdnsWatcher.ts`'s own observed
 * services and `scripts/bench/layer1/wifiNameLookup.ts`'s identical
 * bench-harness constant. */
export const WIFI_ROBOTLINK_PORT = 7654;

/** Bound on the `dns.lookup(<name>.local, {family: 4})` step. See the
 * module doc comment for why this matches `tcpStream.ts`'s own
 * `DEFAULT_DNS_LOOKUP_TIMEOUT_MS`. */
export const DEFAULT_WIFI_DNS_LOOKUP_TIMEOUT_MS = 2_000;
/** Bound on the TCP connect to the resolved address. */
export const DEFAULT_WIFI_CONNECT_TIMEOUT_MS = 2_000;
/** Bound on waiting for a non-`DBG:` line after `HELLO` is sent. */
export const DEFAULT_WIFI_HELLO_TIMEOUT_MS = 2_000;

/** Injectable `dns.lookup(hostname, {family: 4})` shape — same contract
 * as `tcpStream.ts`'s own (private) `Ipv4Lookup`/`mbflashClient.ts`'s own
 * `MbflashIpv4Lookup`, redeclared here for the same reason those two
 * redeclare rather than share one: a small, self-contained seam, not
 * worth a shared-type dependency. */
export type WifiOnDemandIpv4Lookup = (
  hostname: string,
  options: { family: 4 },
) => Promise<{ address: string; family: number }>;

/** The minimal socket shape this module actually uses — same style as
 * `tcpStream.ts`'s `TcpSocketLike`/`mbflashClient.ts`'s
 * `MbflashSocketLike`, so a test can drive this against a fully
 * synthetic fake or a real loopback `net.createServer`. */
export interface WifiOnDemandSocketLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: () => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  destroy(error?: Error): void;
}

export interface WifiOnDemandOptions {
  /** Defaults to {@link DEFAULT_WIFI_DNS_LOOKUP_TIMEOUT_MS}. */
  dnsLookupTimeoutMs?: number;
  /** Defaults to {@link DEFAULT_WIFI_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Defaults to {@link DEFAULT_WIFI_HELLO_TIMEOUT_MS}. */
  helloTimeoutMs?: number;
  /** The port to dial once `<name>.local` resolves. Defaults to
   * {@link WIFI_ROBOTLINK_PORT} -- overridable purely so this module's own
   * test suite can point a real loopback `net.createServer` (an ephemeral
   * port) at this function without a fake `dial`, mirroring
   * `mbflashClient.test.ts`'s "a real loopback server, not a mock"
   * precedent. Production code never has a reason to override this. */
  port?: number;
  /** Injectable `dns.lookup`. Defaults to `node:dns/promises`'s own. */
  lookup?: WifiOnDemandIpv4Lookup;
  /** Injectable dial. Defaults to a real `net.connect`, bounded by
   * `connectTimeoutMs`. Tests substitute a fake, or a real loopback
   * `net.createServer` (this module's own suite's actual choice, mirroring
   * `mbflashClient.test.ts`'s precedent). */
  dial?: (host: string, port: number) => Promise<WifiOnDemandSocketLike>;
}

export type WifiOnDemandResult =
  | { status: "found"; host: string; port: number; ip: string }
  | { status: "not-found"; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `^DBG:/i` — `DBG:wifi ...` (and any other `DBG:`-prefixed) chatter
 * interleaves with real protocol lines on this transport, exactly as
 * `scripts/bench/layer1/wifiProbe.ts`'s own `isDebugLine` documents;
 * never a banner, always ignorable. */
function isDebugLine(line: string): boolean {
  return /^DBG:/i.test(line);
}

/** Connects to `host:port`, bounded by `connectTimeoutMs`. The socket is
 * destroyed before this rejects on any failure (connect error or
 * timeout), never left half-open for the caller to clean up — same
 * discipline as `mbflashClient.ts`'s own `defaultDial`. */
function defaultDial(host: string, port: number, connectTimeoutMs: number): Promise<WifiOnDemandSocketLike> {
  const socket: Socket = netConnect({ host, port });
  return withTimeout(
    new Promise<WifiOnDemandSocketLike>((resolve, reject) => {
      let settled = false;
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        resolve(socket as unknown as WifiOnDemandSocketLike);
      });
      socket.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    }),
    connectTimeoutMs,
    `wifiOnDemand connect ${host}:${port}`,
  ).catch((error: unknown) => {
    socket.destroy();
    throw error;
  });
}

/**
 * Reads lines from `socket` until one that both isn't `DBG:`-prefixed and
 * parses as a banner arrives, or `timeoutMs` elapses, or the socket
 * errors/closes first. Resolves the parsed banner, or `undefined` for
 * every other outcome — never rejects, so a caller never needs its own
 * `try`/`catch` around this.
 */
function waitForBanner(socket: WifiOnDemandSocketLike, timeoutMs: number): Promise<ParsedBanner | undefined> {
  return withTimeout(
    new Promise<ParsedBanner | undefined>((resolve) => {
      let buffer = "";
      let settled = false;
      const finish = (value: ParsedBanner | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        for (;;) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) {
            return;
          }
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (isDebugLine(line)) {
            continue;
          }
          finish(parseBanner(line) ?? undefined);
          return;
        }
      });
      socket.on("error", () => finish(undefined));
      socket.on("close", () => finish(undefined));
    }),
    timeoutMs,
    "wifiOnDemand HELLO reply",
  ).catch(() => {
    // A `TimeoutError` from the race above means "no reply in time" --
    // treated identically to an explicit `undefined` result, never
    // rethrown (this function's own "never rejects" contract).
    return undefined;
  });
}

/**
 * Resolve `<name>.local` IPv4, bounded, and confirm a `HELLO` reply on
 * {@link WIFI_ROBOTLINK_PORT} — see the module doc comment. Never
 * throws: every failure comes back as `{ status: "not-found", reason }`.
 * On success, the returned `host`/`port`/`ip` are exactly the shape
 * `watchers/mdnsWatcher.ts`'s own `tcpAddress()` produces for an
 * mDNS-observed link, so the caller can upsert the `wifi` link row the
 * same way either path found it.
 */
export async function probeWifiOnDemand(name: string, options: WifiOnDemandOptions = {}): Promise<WifiOnDemandResult> {
  const dnsLookupTimeoutMs = options.dnsLookupTimeoutMs ?? DEFAULT_WIFI_DNS_LOOKUP_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_WIFI_CONNECT_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_WIFI_HELLO_TIMEOUT_MS;
  const port = options.port ?? WIFI_ROBOTLINK_PORT;
  const lookup = options.lookup ?? dnsLookup;
  const dial = options.dial ?? ((host, dialPort) => defaultDial(host, dialPort, connectTimeoutMs));
  const host = `${name}.local`;

  let ip: string;
  try {
    const resolved = await withTimeout(lookup(host, { family: 4 }), dnsLookupTimeoutMs, `wifiOnDemand dns.lookup(${host})`);
    ip = resolved.address;
  } catch (error) {
    return { status: "not-found", reason: `dns.lookup(${host}) failed: ${errorMessage(error)}` };
  }

  let socket: WifiOnDemandSocketLike | undefined;
  try {
    socket = await dial(ip, port);
    await new Promise<void>((resolve, reject) => {
      socket?.write("HELLO\n", (err) => (err ? reject(err) : resolve()));
    });
    const banner = await waitForBanner(socket, helloTimeoutMs);
    if (banner === undefined) {
      return {
        status: "not-found",
        reason: `no HELLO reply from ${ip}:${port} within ${helloTimeoutMs}ms`,
      };
    }
    if (banner.name !== name) {
      return { status: "not-found", reason: `banner named "${banner.name}", expected "${name}"` };
    }
    return { status: "found", host, port, ip };
  } catch (error) {
    return { status: "not-found", reason: `connect ${ip}:${port} failed: ${errorMessage(error)}` };
  } finally {
    socket?.destroy();
  }
}
