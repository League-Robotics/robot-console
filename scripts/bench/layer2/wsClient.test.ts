import { describe, expect, it } from "vitest";
import { fingerprintSnapshot, waitForSettle, type SettleDriver } from "./wsClient.js";
import type { Snapshot } from "@robot-console/host";

/** Minimal snapshot builder -- only the fields {@link fingerprintSnapshot}
 * / {@link waitForSettle} ever read. */
function snap(links: Array<{ device: string; transport: string; id: string; state: string }>): Snapshot {
  const byDevice = new Map<string, Array<{ id: string; transport: string; state: string }>>();
  for (const l of links) {
    const existing = byDevice.get(l.device) ?? [];
    existing.push({ id: l.id, transport: l.transport, state: l.state });
    byDevice.set(l.device, existing);
  }
  return {
    type: "snapshot",
    seq: 1,
    at: Date.now(),
    devices: [...byDevice.entries()].map(([name, deviceLinks]) => ({
      id: 1,
      name,
      kind: "robot",
      role: null,
      program: null,
      version: null,
      owned: true,
      radio: { channel: 0, group: 0, source: "derived" },
      lastSeen: 0,
      lastChecked: null,
      links: deviceLinks.map((l) => ({ ...l, label: "", reason: null, since: 0, lastSeen: null, nextRetryAt: null, capabilities: { open: true, close: true, flash: false, provisionWifi: false } })),
    })),
    unassigned: [],
    relays: [],
    firmware: { relay: { configured: false }, robot: { configured: false } },
    wifi: { ssid: null, source: null },
    tasks: [],
  } as unknown as Snapshot;
}

describe("fingerprintSnapshot", () => {
  it("is stable across snapshots whose links are unchanged", () => {
    const a = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    const b = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    expect(fingerprintSnapshot(a)).toBe(fingerprintSnapshot(b));
  });

  it("changes when a link's state changes", () => {
    const a = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connecting" }]);
    const b = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    expect(fingerprintSnapshot(a)).not.toBe(fingerprintSnapshot(b));
  });

  it("is order-independent across devices", () => {
    const a = snap([
      { device: "gopiv", transport: "mbserial", id: "l1", state: "connected" },
      { device: "vevov", transport: "mbserial", id: "l2", state: "connected" },
    ]);
    const b = snap([
      { device: "vevov", transport: "mbserial", id: "l2", state: "connected" },
      { device: "gopiv", transport: "mbserial", id: "l1", state: "connected" },
    ]);
    expect(fingerprintSnapshot(a)).toBe(fingerprintSnapshot(b));
  });
});

/** A scripted {@link SettleDriver}: `nextSnapshot` resolves after
 * `arrivalMs` (never before, and only if `arrivalMs <= timeoutMs`, just
 * like the real socket-backed one) with the next entry in `script`, or
 * hangs past the timeout (mirroring "no snapshot arrived in time") once
 * the script is exhausted. */
function scriptedDriver(script: Array<{ arrivalMs: number; snapshot: Snapshot }>): SettleDriver {
  let cursor = 0;
  let current: Snapshot | undefined = script[0]?.snapshot;
  return {
    get snapshot() {
      return current;
    },
    async nextSnapshot(timeoutMs: number): Promise<Snapshot | undefined> {
      const entry = script[cursor];
      if (entry === undefined || entry.arrivalMs > timeoutMs) {
        // Simulate genuinely waiting out the timeout before giving up.
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5)));
        return undefined;
      }
      cursor += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(entry.arrivalMs, 5)));
      current = entry.snapshot;
      return entry.snapshot;
    },
  };
}

describe("waitForSettle", () => {
  it("settles once the fingerprint stops changing for stableForMs, bounded well under boundedMs", async () => {
    const connecting = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connecting" }]);
    const connected = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    const driver = scriptedDriver([
      { arrivalMs: 1, snapshot: connecting },
      { arrivalMs: 1, snapshot: connected },
      // no more changes after this -- should settle stableForMs after the last one
    ]);
    const result = await waitForSettle(driver, { stableForMs: 20, boundedMs: 2000 });
    expect(result.settled).toBe(true);
    expect(result.finalSnapshot).toBe(connected);
    expect(result.elapsedMs).toBeLessThan(2000);
  });

  it("treats total silence (no snapshot ever arrives) as settled once stableForMs has passed", async () => {
    const initial = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    const driver: SettleDriver = {
      snapshot: initial,
      nextSnapshot: async (timeoutMs) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5)));
        return undefined;
      },
    };
    const result = await waitForSettle(driver, { stableForMs: 15, boundedMs: 2000 });
    expect(result.settled).toBe(true);
    expect(result.finalSnapshot).toBe(initial);
  });

  it("reports settled: false when the fingerprint keeps changing right up to the bound", async () => {
    let toggle = false;
    const driver: SettleDriver = {
      get snapshot(): Snapshot | undefined {
        return undefined;
      },
      nextSnapshot: async (timeoutMs) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5)));
        toggle = !toggle;
        return snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: toggle ? "connecting" : "connected" }]);
      },
    };
    const result = await waitForSettle(driver, { stableForMs: 30, boundedMs: 60 });
    expect(result.settled).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(60);
  });

  it("never returns undefined finalSnapshot when the driver already had one at call time", async () => {
    const initial = snap([{ device: "gopiv", transport: "mbserial", id: "l1", state: "connected" }]);
    const driver: SettleDriver = {
      snapshot: initial,
      nextSnapshot: async (timeoutMs) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5)));
        return undefined;
      },
    };
    const result = await waitForSettle(driver, { stableForMs: 10, boundedMs: 500 });
    expect(result.finalSnapshot).toBe(initial);
  });
});
