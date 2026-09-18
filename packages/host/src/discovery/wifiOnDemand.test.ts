/**
 * wifiOnDemand.test.ts — ticket 019-002's own suite for the bounded
 * `dns.lookup` + TCP-7654-`HELLO` fallback. Every DNS step is a fake
 * `lookup` (never a real query), and every TCP step is either a fully
 * synthetic fake socket (`FakeSocket`, driving the HELLO-reply
 * scenarios) or a real loopback `net.createServer` on an ephemeral port
 * (the one integration test at the bottom) — mirroring
 * `connect/mbflashClient.test.ts`'s and `link/adapters/tcpStream.test.ts`'s
 * own "a real loopback server, not a mock" precedent for this codebase's
 * TCP clients. No test in this file ever waits out a real-world multi-
 * second timeout: every timeout scenario overrides the relevant bound to
 * a few milliseconds, same idiom as `tcpStream.test.ts`'s own
 * `dnsLookupTimeoutMs: 10` case.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeWifiOnDemand,
  WIFI_ROBOTLINK_PORT,
  type WifiOnDemandIpv4Lookup,
  type WifiOnDemandSocketLike,
} from "./wifiOnDemand.js";

/** Flush pending microtasks so a fake dial/lookup's own promise chain
 * has settled before a test emits data or asserts -- same idiom as
 * `tcpStream.test.ts`'s own `flush()`. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fully synthetic fake socket -- write() always succeeds immediately;
 * `data`/`error`/`close` are driven directly via `emit()`. Mirrors
 * `tcpStream.test.ts`'s own `FakeSocket`. */
class FakeSocket extends EventEmitter implements WifiOnDemandSocketLike {
  writes: string[] = [];
  destroyCalls = 0;

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }

  destroy(): void {
    this.destroyCalls++;
  }
}

const resolveTo = (address: string): WifiOnDemandIpv4Lookup => () => Promise.resolve({ address, family: 4 });

describe("probeWifiOnDemand -- HELLO reply handling (fake socket)", () => {
  it("resolves 'found' once a non-DBG line parses as a banner naming the probed device", async () => {
    const socket = new FakeSocket();
    const promise = probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      dial: () => Promise.resolve(socket),
    });
    await flush();
    // DBG chatter interleaves with real protocol traffic on this
    // transport (scripts/bench/layer1/wifiProbe.ts's own documented
    // bench fact) -- ignored, never treated as the reply.
    socket.emit("data", Buffer.from("DBG:wifi rssi=-40\n"));
    socket.emit("data", Buffer.from("device NEZHA2 robot tigez 1198504156\n"));

    await expect(promise).resolves.toEqual({
      status: "found",
      host: "tigez.local",
      port: WIFI_ROBOTLINK_PORT,
      ip: "127.0.0.1",
    });
    expect(socket.writes).toEqual(["HELLO\n"]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("resolves 'not-found' when the banner names a different device than the one probed", async () => {
    const socket = new FakeSocket();
    const promise = probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      dial: () => Promise.resolve(socket),
    });
    await flush();
    socket.emit("data", Buffer.from("device NEZHA2 robot gopiv 1198504157\n"));

    const result = await promise;
    expect(result).toMatchObject({ status: "not-found" });
    expect((result as { reason: string }).reason).toContain('expected "tigez"');
  });

  it("resolves 'not-found' (never hangs) when nothing ever answers HELLO, bounded by helloTimeoutMs", async () => {
    const socket = new FakeSocket();
    const promise = probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      dial: () => Promise.resolve(socket),
      helloTimeoutMs: 10,
    });
    const result = await promise;
    expect(result).toMatchObject({ status: "not-found" });
    expect((result as { reason: string }).reason).toMatch(/no HELLO reply/);
  });

  it("resolves 'not-found' when the socket closes before any reply arrives", async () => {
    const socket = new FakeSocket();
    const promise = probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      dial: () => Promise.resolve(socket),
      helloTimeoutMs: 5_000,
    });
    await flush();
    socket.emit("close");
    const result = await promise;
    expect(result).toMatchObject({ status: "not-found" });
  });
});

describe("probeWifiOnDemand -- dns.lookup handling", () => {
  it("resolves 'not-found' (never hangs) when dns.lookup never settles, bounded by dnsLookupTimeoutMs", async () => {
    let dialCalls = 0;
    const result = await probeWifiOnDemand("tigez", {
      lookup: () => new Promise<{ address: string; family: number }>(() => undefined),
      dial: () => {
        dialCalls++;
        return Promise.resolve(new FakeSocket());
      },
      dnsLookupTimeoutMs: 10,
    });
    expect(result).toMatchObject({ status: "not-found" });
    expect((result as { reason: string }).reason).toContain("dns.lookup");
    expect(dialCalls).toBe(0);
  });

  it("resolves 'not-found', without ever dialing, when dns.lookup rejects (e.g. no such .local record)", async () => {
    let dialCalls = 0;
    const result = await probeWifiOnDemand("gopiv", {
      lookup: () => Promise.reject(new Error("getaddrinfo ENOTFOUND gopiv.local")),
      dial: () => {
        dialCalls++;
        return Promise.resolve(new FakeSocket());
      },
    });
    expect(result).toMatchObject({ status: "not-found" });
    expect((result as { reason: string }).reason).toContain("ENOTFOUND");
    expect(dialCalls).toBe(0);
  });
});

describe("probeWifiOnDemand -- connect failure", () => {
  it("resolves 'not-found' when the TCP dial itself fails (e.g. connection refused)", async () => {
    const result = await probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      dial: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(result).toMatchObject({ status: "not-found" });
    expect((result as { reason: string }).reason).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------
// Real loopback integration -- the actual default `dial` (real
// net.connect), never a fake, dialing a real server on an ephemeral
// port. `port` is overridden purely so this test can target that port
// without a fake `dial` -- see `WifiOnDemandOptions.port`'s own doc
// comment.
// ---------------------------------------------------------------------

describe("probeWifiOnDemand -- real loopback server (no fake dial)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  function startFakeRobot(bannerLine: string): Promise<{ port: number }> {
    return new Promise((resolve) => {
      const server: Server = createServer((socket) => {
        socket.on("data", (chunk) => {
          if (chunk.toString("utf-8").startsWith("HELLO")) {
            socket.write(`${bannerLine}\n`);
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address && typeof address === "object" && address !== null ? address.port : 0;
        closers.push(() => new Promise((res) => server.close(() => res())));
        resolve({ port });
      });
    });
  }

  it("connects for real, sends HELLO, and reports 'found' from a real banner reply", async () => {
    const { port } = await startFakeRobot("device NEZHA2 robot tigez 1198504156");
    const result = await probeWifiOnDemand("tigez", {
      lookup: resolveTo("127.0.0.1"),
      port,
    });
    expect(result).toEqual({ status: "found", host: "tigez.local", port, ip: "127.0.0.1" });
  });
});
