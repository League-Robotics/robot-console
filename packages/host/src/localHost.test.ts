import os from "node:os";
import { describe, expect, it } from "vitest";
import { isLocalHostname, isLocalMdnsService, localAddresses, localHostname, normalizeHostCandidate } from "./localHost.js";

describe("normalizeHostCandidate", () => {
  it("lower-cases and strips a trailing dot", () => {
    expect(normalizeHostCandidate("Gala.local.")).toBe("gala");
  });

  it("strips a trailing .local with no trailing dot too", () => {
    expect(normalizeHostCandidate("GALA.LOCAL")).toBe("gala");
  });

  it("leaves a bare short name untouched (besides lower-casing)", () => {
    expect(normalizeHostCandidate("Gala")).toBe("gala");
  });
});

describe("localHostname / isLocalHostname", () => {
  it("localHostname() is os.hostname(), normalized", () => {
    expect(localHostname()).toBe(normalizeHostCandidate(os.hostname()));
  });

  it("isLocalHostname matches this machine's own hostname however it's spelled", () => {
    const hostname = os.hostname();
    expect(isLocalHostname(hostname)).toBe(true);
    expect(isLocalHostname(`${hostname}.local.`)).toBe(true);
    expect(isLocalHostname(hostname.toUpperCase())).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(isLocalHostname("torture")).toBe(false);
  });
});

describe("localAddresses", () => {
  it("always includes loopback", () => {
    const addresses = localAddresses();
    expect(addresses.has("127.0.0.1")).toBe(true);
    expect(addresses.has("::1")).toBe(true);
  });
});

describe("isLocalMdnsService", () => {
  it("true when the service's host matches this machine's own hostname", () => {
    const hostname = os.hostname();
    expect(isLocalMdnsService({ host: `${hostname}.local.` })).toBe(true);
  });

  it("true when one of the service's own addresses is loopback, even when the host label doesn't match", () => {
    expect(isLocalMdnsService({ host: "some-other-label.local", addresses: ["127.0.0.1"] })).toBe(true);
  });

  it("false for a genuinely different machine with no matching address", () => {
    expect(isLocalMdnsService({ host: "torture.local", addresses: ["192.168.1.12"] })).toBe(false);
  });

  it("false when neither host nor addresses is present at all", () => {
    expect(isLocalMdnsService({})).toBe(false);
  });
});
