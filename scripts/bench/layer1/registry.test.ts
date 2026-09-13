import { describe, expect, it } from "vitest";
import { parseRegistryResponse, resolveRadioAddress } from "./registry.js";

describe("parseRegistryResponse", () => {
  it("parses a real captured registry response (vevov, 2026-09-13 bench)", () => {
    expect(
      parseRegistryResponse({ channel: 37, derived: true, group: 43, name: "vevov", source: "derived", updated: 1789274357.327 }),
    ).toEqual({ channel: 37, group: 43, source: "derived" });
  });

  it("returns undefined for a body missing channel/group", () => {
    expect(parseRegistryResponse({ source: "derived" })).toBeUndefined();
  });

  it("returns undefined for a non-object body", () => {
    expect(parseRegistryResponse("not json")).toBeUndefined();
    expect(parseRegistryResponse(null)).toBeUndefined();
  });
});

describe("resolveRadioAddress", () => {
  it("resolves via the injected fetch, hitting the exact documented route", async () => {
    let calledUrl: string | undefined;
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({ channel: 47, group: 60, source: "derived" }),
      } as Response;
    }) as typeof fetch;

    const result = await resolveRadioAddress("torture.local", 8761, "gopiv", { fetchFn: fakeFetch });
    expect(calledUrl).toBe("http://torture.local:8761/names/gopiv");
    expect(result).toEqual({ channel: 47, group: 60, source: "derived" });
  });

  it("returns undefined, never throwing, on a non-OK response", async () => {
    const fakeFetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await resolveRadioAddress("torture.local", 8761, "ghost", { fetchFn: fakeFetch });
    expect(result).toBeUndefined();
  });

  it("returns undefined, never throwing, when fetch itself rejects", async () => {
    const fakeFetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    const result = await resolveRadioAddress("torture.local", 8761, "ghost", { fetchFn: fakeFetch });
    expect(result).toBeUndefined();
  });
});
