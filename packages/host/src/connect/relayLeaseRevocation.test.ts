import { describe, expect, it } from "vitest";
import { createRelayLeaseRevocation } from "./relayLeaseRevocation.js";

// Sprint 016 ticket 003's own suite: register/lookup/clear semantics,
// entirely independent of any relay fake or store -- exactly the seam's
// own ticket-scoped acceptance criterion ("verifiable directly against
// the seam's own map, independent of ticket 004's end-to-end takeover
// test").

describe("createRelayLeaseRevocation", () => {
  it("get() returns undefined for a relay nothing has registered", () => {
    const revocation = createRelayLeaseRevocation();
    expect(revocation.get("usb-RELAY")).toBeUndefined();
  });

  it("register() then get() returns the exact same controller", () => {
    const revocation = createRelayLeaseRevocation();
    const controller = new AbortController();

    revocation.register("usb-RELAY", controller);

    expect(revocation.get("usb-RELAY")).toBe(controller);
  });

  it("register() for a different relayLinkId does not disturb another relay's registration", () => {
    const revocation = createRelayLeaseRevocation();
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    revocation.register("usb-RELAY-A", controllerA);
    revocation.register("usb-RELAY-B", controllerB);

    expect(revocation.get("usb-RELAY-A")).toBe(controllerA);
    expect(revocation.get("usb-RELAY-B")).toBe(controllerB);
  });

  it("register() for the same relayLinkId replaces the previous controller", () => {
    const revocation = createRelayLeaseRevocation();
    const first = new AbortController();
    const second = new AbortController();

    revocation.register("usb-RELAY", first);
    revocation.register("usb-RELAY", second);

    expect(revocation.get("usb-RELAY")).toBe(second);
  });

  it("clear() removes the registration, so a later get() returns undefined", () => {
    const revocation = createRelayLeaseRevocation();
    const controller = new AbortController();
    revocation.register("usb-RELAY", controller);

    revocation.clear("usb-RELAY", controller);

    expect(revocation.get("usb-RELAY")).toBeUndefined();
  });

  it("clear() is a no-op when the passed controller is not the one currently registered -- a stale finally() can never clobber a newer registration", () => {
    const revocation = createRelayLeaseRevocation();
    const stale = new AbortController();
    const current = new AbortController();
    revocation.register("usb-RELAY", stale);
    revocation.register("usb-RELAY", current);

    revocation.clear("usb-RELAY", stale);

    expect(revocation.get("usb-RELAY")).toBe(current);
  });

  it("clear() for a relayLinkId with nothing registered is a harmless no-op", () => {
    const revocation = createRelayLeaseRevocation();
    expect(() => revocation.clear("usb-RELAY", new AbortController())).not.toThrow();
    expect(revocation.get("usb-RELAY")).toBeUndefined();
  });
});
