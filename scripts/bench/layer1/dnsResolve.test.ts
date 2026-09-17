import { describe, expect, it } from "vitest";
import { normalizeHostname, resolveIPv4 } from "./dnsResolve.js";

describe("resolveIPv4", () => {
  it("returns the resolved address and elapsed time on success", async () => {
    let calls = 0;
    const result = await resolveIPv4("gopiv.local", {
      lookup: async (hostname, options) => {
        calls += 1;
        expect(hostname).toBe("gopiv.local");
        expect(options).toEqual({ family: 4 });
        return { address: "192.168.1.193", family: 4 };
      },
      now: (() => {
        let t = 1000;
        return () => (t += 5);
      })(),
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ ip: "192.168.1.193", resolveMs: 5 });
  });

  it("reports the underlying error, never throwing, on a rejected lookup", async () => {
    const result = await resolveIPv4("loki.local", {
      lookup: async () => {
        throw new Error("EAI_AGAIN loki.local");
      },
    });
    expect(result.ip).toBeUndefined();
    expect(result.error).toContain("EAI_AGAIN");
  });

  it("times out rather than waiting forever on a stalled lookup (the ~5s macOS hang)", async () => {
    const result = await resolveIPv4("hodr.local", {
      timeoutMs: 20,
      lookup: () => new Promise(() => {
        // Never resolves -- simulates the real bench's observed multi-second
        // resolver stall so the bound, not the lookup, decides the outcome.
      }),
    });
    expect(result.ip).toBeUndefined();
    expect(result.error).toContain("timed out after 20ms");
    expect(result.resolveMs).toBeGreaterThanOrEqual(20);
  });
});

describe("normalizeHostname", () => {
  it("strips exactly one trailing dot", () => {
    expect(normalizeHostname("torture.local.")).toBe("torture.local");
    expect(normalizeHostname("torture.local")).toBe("torture.local");
  });
});
