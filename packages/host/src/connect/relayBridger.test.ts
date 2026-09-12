import { describe, expect, it } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store, type ProjectionDeviceRow, type RadioSightingRow } from "../store/index.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler } from "../link/pacing.js";
import type { LinkRow } from "./connector.js";
import {
  buildDefaultFailoverCandidates,
  chooseResetMethod,
  createRelayBridger,
  orderDefaultFailoverCandidateNames,
  resolveDefaultFailoverAddress,
  toBridgeRequest,
  type BridgeRequest,
} from "./relayBridger.js";
import { nameToRadioAddress } from "@robot-console/protocol";

// Sprint 016 ticket 002's own suite. The headline acceptance criterion
// (a per-candidate reset fixing the Linux default-failover bug) is
// proven against a fake relay carrying its own "am I in the data plane"
// state across fresh stream instances -- exactly what a real relay's
// physical firmware state does across this module's own per-candidate
// stream lifecycle (module doc comment's "Lease lifecycle" section).
// No real serial/TCP/HID I/O anywhere in this file.

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

const ROBOT_BANNER = "device NEZHA2 robot vevov 1198504156";
const ROBOT_SERIAL = 1198504156;
const NOW = 1_000_000;

/** Shared "physical relay" state across every fresh `RelayPlaneByteStream`
 * a candidate attempt opens -- mirrors a real relay board's own firmware
 * state persisting across this module's per-candidate stream open/close
 * lifecycle. */
class RelayPlaneState {
  inDataPlane = false;
  resetCount = 0;
  reset(): void {
    this.resetCount++;
    this.inDataPlane = false;
  }
}

/** A `FakeByteStream` standing in for a relay's own physical port,
 * carrying `RelayPlaneState` across instances. Answers the command-plane
 * preamble exactly like `connector.test.ts`'s own `RelayByteStream` while
 * in the command plane; once `!GO` is confirmed it enters the (shared)
 * data plane and goes **silent** to every further command-plane write —
 * simulating exactly the stuck-relay Linux bug this ticket fixes. `open()`
 * resolves immediately (unlike the base fixture's manual
 * `resolveOpen()`) so a multi-candidate test needs no manual open/flush
 * choreography across real-timer waits. */
class RelayPlaneByteStream extends FakeByteStream {
  constructor(
    private readonly state: RelayPlaneState,
    private readonly robotAnswers: boolean,
  ) {
    super();
  }

  override open(signal: AbortSignal): Promise<void> {
    return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve();
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    const line = bytes.trim();

    if (this.state.inDataPlane) {
      if (line.startsWith("HELLO") && this.robotAnswers) {
        this.emitData(`${ROBOT_BANNER}\n`);
      }
      // Silence otherwise -- stuck data plane / a robot that never
      // answers, exactly what this ticket's headline test needs.
      return;
    }

    if (line === "?") {
      this.emitData("# channel: 1 group: 1 mode: RAW250 power: 7\n");
    } else if (line === "!ECHO OFF") {
      this.emitData("# echo: OFF\n");
    } else if (line === "!MODE RAW250") {
      this.emitData("# mode: RAW250\n");
    } else if (/^!CG \d+ \d+$/.test(line)) {
      const match = /^!CG (\d+) (\d+)$/.exec(line);
      this.emitData(`# channel: ${match?.[1]} group: ${match?.[2]} mode: RAW250 power: 7\n`);
    } else if (line === "!P 7") {
      this.emitData("# channel: 47 group: 60 mode: RAW250 power: 7\n");
    } else if (line === "!GO") {
      this.state.inDataPlane = true;
      this.emitData("# entering data plane\n");
    }
  }

  /** Ticket 016-002's break-reset capability -- see
   * `link/adapters/serialStream.ts`'s own `sendBreak()`. */
  async sendBreak(): Promise<void> {
    this.state.reset();
  }
}

/** Small, real-time-safe options for every integration test below: short
 * sync retry loop (this ticket's own `buildRelayPreamble` extension) and
 * a short identify budget, so a "never answers" scenario fails in
 * milliseconds, not `RelayCommandPlane.ts`'s own real 8s/4s defaults. */
const FAST_OPTIONS = {
  identifySchedule: [0],
  identifyBudgetMs: 200,
  syncRetryMs: 20,
  syncAttempts: 5,
} as const;

// ---------------------------------------------------------------------
// chooseResetMethod -- pure, AC "a serial-only relay uses the break
// path in tests; one with a hidPath uses HID reset"
// ---------------------------------------------------------------------

describe("chooseResetMethod", () => {
  it("chooses hid when the usb relay's own link carries a hidPath", () => {
    expect(chooseResetMethod("/dev/hidraw3", "usb")).toBe("hid");
  });

  it("chooses break when the usb relay has no hidPath", () => {
    expect(chooseResetMethod(null, "usb")).toBe("break");
  });

  it("always chooses reconnect for an mbrelay (TCP) relay, hidPath or not", () => {
    expect(chooseResetMethod(null, "mbrelay")).toBe("reconnect");
    expect(chooseResetMethod("/dev/hidraw3", "mbrelay")).toBe("reconnect");
  });
});

// ---------------------------------------------------------------------
// orderDefaultFailoverCandidateNames -- pure candidate ordering
// ---------------------------------------------------------------------

function deviceRow(partial: Partial<ProjectionDeviceRow> & { id: number; name: string }): ProjectionDeviceRow {
  return {
    kind: "robot",
    role: null,
    program: null,
    version: null,
    radioChannel: null,
    radioGroup: null,
    radioSource: null,
    owned: true,
    lastSeen: 0,
    ...partial,
  };
}

describe("orderDefaultFailoverCandidateNames", () => {
  it("orders radio-sighted robots first, most-recent sighting first", () => {
    const devices = [
      deviceRow({ id: 1, name: "aaaaa", lastSeen: 500 }),
      deviceRow({ id: 2, name: "bbbbb", lastSeen: 500 }),
      deviceRow({ id: 3, name: "ccccc", lastSeen: 900 }),
    ];
    const sightings: RadioSightingRow[] = [
      { deviceId: 1, at: 100 },
      { deviceId: 2, at: 300 },
    ];
    // 2 sighted more recently than 1; 3 has no sighting at all -- goes
    // last regardless of its own higher last_seen.
    expect(orderDefaultFailoverCandidateNames(devices, sightings).map((c) => c.name)).toEqual(["bbbbb", "aaaaa", "ccccc"]);
  });

  it("orders unsighted robots by last_seen, most recent first", () => {
    const devices = [
      deviceRow({ id: 1, name: "aaaaa", lastSeen: 100 }),
      deviceRow({ id: 2, name: "bbbbb", lastSeen: 300 }),
    ];
    expect(orderDefaultFailoverCandidateNames(devices, []).map((c) => c.name)).toEqual(["bbbbb", "aaaaa"]);
  });

  it("excludes unowned robots and relay-kind devices", () => {
    const devices = [
      deviceRow({ id: 1, name: "aaaaa", owned: false, lastSeen: 900 }),
      deviceRow({ id: 2, name: "bbbbb", kind: "relay", lastSeen: 800 }),
      deviceRow({ id: 3, name: "ccccc", lastSeen: 100 }),
    ];
    expect(orderDefaultFailoverCandidateNames(devices, []).map((c) => c.name)).toEqual(["ccccc"]);
  });
});

// ---------------------------------------------------------------------
// resolveDefaultFailoverAddress -- registry-free by construction (no
// `registry` parameter exists on this function's own signature at all)
// ---------------------------------------------------------------------

describe("resolveDefaultFailoverAddress", () => {
  it("a stored override wins outright", async () => {
    const resolved = await resolveDefaultFailoverAddress("vevov", {
      radioChannel: 11,
      radioGroup: 22,
      radioSource: "override",
    });
    expect(resolved).toEqual({ channel: 11, group: 22 });
  });

  it("falls through to the name-derived default with no registry involved -- this function accepts no registry location at all", async () => {
    const resolved = await resolveDefaultFailoverAddress("vevov", {
      radioChannel: null,
      radioGroup: null,
      radioSource: null,
    });
    expect(resolved).toEqual(nameToRadioAddress("vevov"));
  });
});

// ---------------------------------------------------------------------
// buildDefaultFailoverCandidates -- ordering + resolution + id minting
// ---------------------------------------------------------------------

describe("buildDefaultFailoverCandidates", () => {
  it("builds an ordered candidate list with minted childLinkIds and resolved addresses", async () => {
    const devices = [
      deviceRow({ id: 1, name: "tovez", lastSeen: 100, radioChannel: 5, radioGroup: 6, radioSource: "override" }),
      deviceRow({ id: 2, name: "vevov", lastSeen: 200 }),
    ];
    const sightings: RadioSightingRow[] = [{ deviceId: 2, at: 50 }];

    const request = await buildDefaultFailoverCandidates("usb-RELAY", "radio", devices, sightings);

    expect(request.relayLinkId).toBe("usb-RELAY");
    expect(request.candidates).toEqual([
      { childLinkId: "radio-vevov-via-usb-RELAY", ...nameToRadioAddress("vevov") },
      { childLinkId: "radio-tovez-via-usb-RELAY", channel: 5, group: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------
// toBridgeRequest -- the named, single-candidate case
// ---------------------------------------------------------------------

describe("toBridgeRequest", () => {
  it("wraps an existing radio child link into a single-candidate request", () => {
    const link: LinkRow = { id: "radio-vevov-via-relay", transport: "radio", address: { relayLinkId: "usb-RELAY", channel: 47, group: 60 } };
    expect(toBridgeRequest(link)).toEqual({
      relayLinkId: "usb-RELAY",
      candidates: [{ childLinkId: "radio-vevov-via-relay", channel: 47, group: 60 }],
    });
  });
});

// ---------------------------------------------------------------------
// bridge() integration -- fake relay-with-plane-state, real scheduler
// (see connector.test.ts's own note on why: a synchronously-scripted
// reply must always win its race against a real, much-larger timeout).
// ---------------------------------------------------------------------

function seedRelay(store: Store, relayLinkId: string, hidPath: string | null = null): void {
  store.upsertLink({ id: relayLinkId, transport: "usb", address: { path: "/dev/cu.relay", hidPath }, at: 1 });
}

describe("createRelayBridger().bridge() -- per-candidate reset (headline acceptance criterion)", () => {
  it("candidate 1 answers !GO but its robot never replies; candidate 2 succeeds only because the relay was reset first", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, relayLinkId);

    const state = new RelayPlaneState();
    const robotAnswersByAttempt = [false, true];
    let attemptIndex = 0;
    const streams: RelayPlaneByteStream[] = [];
    const createSerialStream = (): RelayPlaneByteStream => {
      const stream = new RelayPlaneByteStream(state, robotAnswersByAttempt[attemptIndex] ?? false);
      streams.push(stream);
      attemptIndex++;
      return stream;
    };

    const bridger = createRelayBridger(
      store,
      { createSerialStream, scheduler: realScheduler, now: () => NOW },
      FAST_OPTIONS,
    );

    const request: BridgeRequest = {
      relayLinkId,
      candidates: [
        { childLinkId: "radio-cand1-via-relay", channel: 47, group: 60 },
        { childLinkId: "radio-cand2-via-relay", channel: 49, group: 61 },
      ],
    };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.linkId).toBe("radio-cand2-via-relay");
    expect(session.deviceId).toBe(ROBOT_SERIAL);
    // A reset ran before EVERY candidate, including the first -- not
    // just once before the loop (sprint.md's own SUC-002 wording).
    expect(state.resetCount).toBe(2);

    // Lease released on success -- no relay_leases row left behind.
    expect(store.snapshotRows().sessions.find((s) => s.link_id === "radio-cand1-via-relay")).toBeUndefined();
    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
    store.close();
  }, 10_000);

  it("the identical fixture WITHOUT a reset between candidates fails -- the Linux-bug regression guard", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, relayLinkId);

    const state = new RelayPlaneState();
    const robotAnswersByAttempt = [false, true];
    let attemptIndex = 0;
    const createSerialStream = (): RelayPlaneByteStream => {
      const stream = new RelayPlaneByteStream(state, robotAnswersByAttempt[attemptIndex] ?? false);
      attemptIndex++;
      return stream;
    };

    const bridger = createRelayBridger(
      store,
      { createSerialStream, scheduler: realScheduler, now: () => NOW },
      { ...FAST_OPTIONS, resetBetweenCandidates: false },
    );

    const request: BridgeRequest = {
      relayLinkId,
      candidates: [
        { childLinkId: "radio-cand1-via-relay", channel: 47, group: 60 },
        { childLinkId: "radio-cand2-via-relay", channel: 49, group: 61 },
      ],
    };

    await expect(bridger.bridge(request, new AbortController().signal)).rejects.toThrow(/no candidate identified/);
    // Never reset -- proving the fixture's own failure is caused by the
    // missing reset, not some other difference from the passing test.
    expect(state.resetCount).toBe(0);

    // Lease released on total failure too -- never leaked.
    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
    store.close();
  }, 10_000);
});

describe("createRelayBridger().bridge() -- reset method selection (integration)", () => {
  it("a relay with a hidPath resets over HID, never sending a serial break", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY-HID";
    seedRelay(store, relayLinkId, "/dev/hidraw3");

    const state = new RelayPlaneState();
    let sendBreakCalls = 0;
    const createSerialStream = (): RelayPlaneByteStream => {
      const stream = new RelayPlaneByteStream(state, true);
      const original = stream.sendBreak.bind(stream);
      stream.sendBreak = async () => {
        sendBreakCalls++;
        return original();
      };
      return stream;
    };
    const hidResetCalls: string[] = [];
    const hidReset = async (hidPath: string): Promise<void> => {
      hidResetCalls.push(hidPath);
      state.reset();
    };

    const bridger = createRelayBridger(store, { createSerialStream, hidReset, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);
    const request: BridgeRequest = { relayLinkId, candidates: [{ childLinkId: "radio-a-via-relay", channel: 47, group: 60 }] };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(hidResetCalls).toEqual(["/dev/hidraw3"]);
    expect(sendBreakCalls).toBe(0);
    store.close();
  }, 10_000);

  it("a relay with no hidPath resets over a serial break, never calling the HID reset", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY-SERIAL";
    seedRelay(store, relayLinkId, null);

    const state = new RelayPlaneState();
    let sendBreakCalls = 0;
    const createSerialStream = (): RelayPlaneByteStream => {
      const stream = new RelayPlaneByteStream(state, true);
      const original = stream.sendBreak.bind(stream);
      stream.sendBreak = async () => {
        sendBreakCalls++;
        return original();
      };
      return stream;
    };
    let hidResetCalls = 0;
    const hidReset = async (): Promise<void> => {
      hidResetCalls++;
    };

    const bridger = createRelayBridger(store, { createSerialStream, hidReset, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);
    const request: BridgeRequest = { relayLinkId, candidates: [{ childLinkId: "radio-a-via-relay", channel: 47, group: 60 }] };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(sendBreakCalls).toBe(1);
    expect(hidResetCalls).toBe(0);
    store.close();
  }, 10_000);
});

describe("createRelayBridger().bridge() -- named bridge regression (AC: still works exactly as before this ticket)", () => {
  it("bridges a single named radio child through the full RelayCommandPlane preamble, exactly like connector.ts's own radio case", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY-SERIAL";
    seedRelay(store, relayLinkId, null);

    const state = new RelayPlaneState();
    const createSerialStream = (): RelayPlaneByteStream => new RelayPlaneByteStream(state, true);

    const bridger = createRelayBridger(store, { createSerialStream, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);

    const link: LinkRow = { id: "radio-vevov-via-relay", transport: "radio", address: { relayLinkId, channel: 47, group: 60 } };
    const session = await bridger.bridge(toBridgeRequest(link), new AbortController().signal);

    expect(session.linkId).toBe("radio-vevov-via-relay");
    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(store.snapshotRows().links.find((l) => l.id === link.id)?.state).toBe("connected");
    expect(store.snapshotRows().sessions.find((s) => s.link_id === link.id)).toBeDefined();
    store.close();
  }, 10_000);
});

describe("createRelayBridger().bridge() -- relay_leases acquire/release", () => {
  it("rejects immediately, recording a link failure, when a different owner already holds the relay's lease", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY-SERIAL";
    seedRelay(store, relayLinkId, null);
    store.acquireRelayLease(relayLinkId, "sweep", NOW);

    const bridger = createRelayBridger(store, { scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);
    const link: LinkRow = { id: "radio-vevov-via-relay", transport: "radio", address: { relayLinkId, channel: 47, group: 60 } };
    store.upsertLink({ id: link.id, transport: "radio", address: link.address, at: 1 });

    await expect(bridger.bridge(toBridgeRequest(link), new AbortController().signal)).rejects.toThrow(/could not acquire relay_leases/);

    const failed = store.snapshotRows().links.find((l) => l.id === link.id);
    expect(failed?.state).toBe("failed");
    // The sweep's own lease is untouched -- this bridge attempt never
    // acquired it, so it must not release someone else's lease either.
    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)?.owner).toBe("sweep");
    store.close();
  });
});
