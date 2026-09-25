import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openStoreDb } from "../store/db.js";
import { Store, type ProjectionDeviceRow, type RadioSightingRow } from "../store/index.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler } from "../link/pacing.js";
import { tcpStream, type TcpSocketLike } from "../link/adapters/tcpStream.js";
import { createRelayLeaseRevocation } from "./relayLeaseRevocation.js";
import { createRelaySweepPassRunner, radioChildLinkId } from "../watchers/relaySweeper.js";
import type { LinkRow } from "./connector.js";
import {
  buildDefaultFailoverCandidates,
  chooseResetMethod,
  createRelayBridger,
  mbregistryResetSequence,
  orderDefaultFailoverCandidateNames,
  resolveDefaultFailoverAddress,
  toBridgeRequest,
  type BridgeRequest,
} from "./relayBridger.js";
import { deviceIdToName, nameToRadioAddress } from "@robot-console/protocol";

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

  it("always chooses the mbregistry reset method for an mbregistry-transport relay, hidPath or not (sprint 018 ticket 007)", () => {
    expect(chooseResetMethod(null, "mbregistry")).toBe("mbregistry");
    expect(chooseResetMethod("/dev/hidraw3", "mbregistry")).toBe("mbregistry");
  });
});

describe("mbregistryResetSequence", () => {
  it("throws a descriptive error when the stream has no sendBreak()", async () => {
    const plainStream = new FakeByteStream();
    await expect(mbregistryResetSequence(plainStream, new AbortController().signal)).rejects.toThrow(/no sendBreak/);
  });

  // Ticket 018-011 finding 4: the headline fix -- a relay already
  // answering its command plane gets no BREAK at all.
  it("sends no BREAK at all when the relay already answers its command plane (finding 4's own fix)", async () => {
    const state = new RelayPlaneState();
    const stream = new RelayPlaneByteStream(state, true);

    await mbregistryResetSequence(stream, new AbortController().signal, realScheduler);

    expect(state.resetCount).toBe(0);
  });

  it("falls back to BREAK when the relay does not answer (parked mid a prior session)", async () => {
    const state = new RelayPlaneState();
    state.inDataPlane = true; // Simulates a relay stuck past !GO from a prior attempt.
    const stream = new RelayPlaneByteStream(state, true);

    await mbregistryResetSequence(stream, new AbortController().signal, realScheduler);

    expect(state.resetCount).toBe(1);
    expect(state.inDataPlane).toBe(false); // sendBreak() resets it back to the command plane.
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

// ---------------------------------------------------------------------
// TCP (mbrelay) reset via disconnect+reconnect -- sprint 016 ticket 005.
// Reuses the real `tcpStream.ts` adapter (not a bare fake ByteStream)
// so `TCP_NODELAY` is actually exercised, driving it against a fake
// `TcpSocketLike` (mirrors `tcpStream.test.ts`'s own `FakeSocket`
// fixture) rather than a real socket -- no real network anywhere in
// this file. The pool's own "am I in the data plane" state is modeled
// exactly like `RelayPlaneState` above, except reset happens
// automatically on every fresh connection (this fixture's own
// constructor) rather than via an explicit `sendBreak()`/HID call --
// `performReset`'s own "reconnect" branch is a deliberate no-op because
// a fresh per-candidate TCP connection already *is* the reset (module
// doc comment's "Reset method selection" section; a break cannot be
// sent over TCP, specification.md §6).
// ---------------------------------------------------------------------

/** A fake `TcpSocketLike` standing in for an mbrelay pool's own TCP
 * port, carrying `RelayPlaneState` across fresh instances the same way
 * `RelayPlaneByteStream` does for a usb relay's serial port -- except
 * here every *new instance* (i.e. every fresh connect, one per
 * candidate attempt) resets the shared state itself, modeling a real
 * mbrelay pool's own firmware returning to the command plane on a new
 * TCP connection (there is no explicit reset call for this transport at
 * all -- see this block's own header comment). */
class FakeMbrelayPoolSocket extends EventEmitter implements TcpSocketLike {
  readonly noDelayCalls: boolean[] = [];
  destroyCalls = 0;

  constructor(
    private readonly state: RelayPlaneState,
    private readonly robotAnswers: boolean,
  ) {
    super();
    this.state.reset();
    // Fires after this constructor's caller has finished registering
    // `once("connect", ...)` (tcpStream.ts's own `open()`), mirroring a
    // real TCP handshake completing shortly after `net.connect()`.
    queueMicrotask(() => this.emit("connect"));
  }

  write(data: string, callback?: (err?: Error | null) => void): boolean {
    callback?.(null);
    const line = data.trim();

    if (this.state.inDataPlane) {
      if (line.startsWith("HELLO") && this.robotAnswers) {
        this.emit("data", Buffer.from(`${ROBOT_BANNER}\n`));
      }
      // Silence otherwise -- same stuck-data-plane simulation as
      // RelayPlaneByteStream.
      return true;
    }

    if (line === "?") {
      this.emit("data", Buffer.from("# channel: 1 group: 1 mode: RAW250 power: 7\n"));
    } else if (line === "!ECHO OFF") {
      this.emit("data", Buffer.from("# echo: OFF\n"));
    } else if (line === "!MODE RAW250") {
      this.emit("data", Buffer.from("# mode: RAW250\n"));
    } else if (/^!CG \d+ \d+$/.test(line)) {
      const match = /^!CG (\d+) (\d+)$/.exec(line);
      this.emit("data", Buffer.from(`# channel: ${match?.[1]} group: ${match?.[2]} mode: RAW250 power: 7\n`));
    } else if (line === "!P 7") {
      this.emit("data", Buffer.from("# channel: 47 group: 60 mode: RAW250 power: 7\n"));
    } else if (line === "!GO") {
      this.state.inDataPlane = true;
      this.emit("data", Buffer.from("# entering data plane\n"));
    }
    return true;
  }

  setNoDelay(noDelay = true): void {
    this.noDelayCalls.push(noDelay);
  }

  destroy(): void {
    this.destroyCalls++;
    this.emit("close");
  }
}

describe("createRelayBridger().bridge() -- TCP (mbrelay) reset via disconnect+reconnect (ticket 016-005)", () => {
  it("candidate 1's robot never replies; candidate 2 succeeds only because a fresh TCP connection reset the pool -- never a serial break", async () => {
    const store = freshStore();
    const relayLinkId = "mbrelay-torture";
    store.upsertLink({ id: relayLinkId, transport: "mbrelay", address: { host: "torture.local", port: 8760 }, at: 1 });

    const state = new RelayPlaneState();
    const robotAnswersByAttempt = [false, true];
    let attemptIndex = 0;
    const sockets: FakeMbrelayPoolSocket[] = [];
    const createTcpStream = (host: string, port: number) =>
      tcpStream(host, port, {
        createSocket: () => {
          const socket = new FakeMbrelayPoolSocket(state, robotAnswersByAttempt[attemptIndex] ?? false);
          sockets.push(socket);
          attemptIndex++;
          return socket;
        },
      });

    const bridger = createRelayBridger(store, { createTcpStream, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);

    const request: BridgeRequest = {
      relayLinkId,
      candidates: [
        { childLinkId: "mbrelay-cand1-via-relay", channel: 47, group: 60 },
        { childLinkId: "mbrelay-cand2-via-relay", channel: 49, group: 61 },
      ],
    };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.linkId).toBe("mbrelay-cand2-via-relay");
    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(session.transport).toBe("mbrelay");

    // One fresh TCP connection per candidate -- disconnect+reconnect,
    // not a break -- and TCP_NODELAY set immediately on each one
    // (tcpStream.ts's own contract; there is no `sendBreak()` anywhere
    // on a TcpSocketLike at all, so this is the only reset mechanism
    // available for this transport).
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      expect(socket.noDelayCalls).toEqual([true]);
    }
    expect(state.resetCount).toBe(2);

    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
    store.close();
  }, 10_000);
});

// ---------------------------------------------------------------------
// mbregistry-backed relay reset -- sprint 018 ticket 007. Reuses
// `RelayPlaneByteStream` (it already implements `sendBreak()` for the
// legacy usb/break tests above) as the fake `mbregistryStream` session --
// this ticket's own reset primitive is the same `sendBreak()` call, just
// dispatched to a different physical stream, so the same fixture proves
// both the reset-happens-before-every-candidate behavior and the
// one-lock-for-the-whole-attempt behavior below.
// ---------------------------------------------------------------------

function seedMbregistryRelay(store: Store, relayLinkId: string, endpoint: unknown = null, uid = "RELAY-UID"): void {
  store.upsertLink({ id: relayLinkId, transport: "mbregistry", address: { endpoint, uid }, at: 1 });
}

describe("createRelayBridger().bridge() -- mbregistry-backed relay reset (sprint 018 ticket 007)", () => {
  // Ticket 018-011 finding 4: `mbregistryResetSequence` now tries `sync()`
  // before ever sending BREAK -- candidate 1 opens a *fresh, healthy*
  // relay (never used before in this test), so its own reset step sends
  // no BREAK at all; only candidate 2, which inherits the shared `state`
  // left stuck past `!GO` by candidate 1's own failed attempt, actually
  // needs (and gets) the BREAK fallback. Retitled/re-asserted from the
  // pre-011 version, which asserted an unconditional BREAK before every
  // candidate regardless of whether one was needed.
  it("candidate 1 answers !GO but its robot never replies; candidate 2 succeeds only because the relay was reset first, via sendBreak() over mbregistryStream -- candidate 1's own reset step sent no BREAK, since the relay was already healthy", async () => {
    const store = freshStore();
    const relayLinkId = "mbregistry-RELAY";
    seedMbregistryRelay(store, relayLinkId);

    const state = new RelayPlaneState();
    const robotAnswersByAttempt = [false, true];
    let attemptIndex = 0;
    const createMbregistryCalls: Array<{ kind: string }> = [];
    const createMbregistryStream = (_address: unknown, kind: "relay"): RelayPlaneByteStream => {
      createMbregistryCalls.push({ kind });
      const stream = new RelayPlaneByteStream(state, robotAnswersByAttempt[attemptIndex] ?? false);
      attemptIndex++;
      return stream;
    };

    const bridger = createRelayBridger(
      store,
      { createMbregistryStream, scheduler: realScheduler, now: () => NOW },
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
    expect(session.transport).toBe("radio"); // a local (endpoint: null) mbregistry relay replaces the usb/radio path
    // Finding 4's own fix: a reset is only sent to a candidate whose own
    // sync() check found the relay NOT already answering -- candidate 1's
    // fresh, healthy relay needed none; only candidate 2 (left stuck past
    // !GO by candidate 1's own failed attempt) did.
    expect(state.resetCount).toBe(1);
    // Exactly one `createMbregistryStream` call per candidate attempt --
    // the same stream/session is reused for both the reset and the data
    // plane, never a second one for the reset step.
    expect(createMbregistryCalls).toHaveLength(2);
    expect(createMbregistryCalls.every((c) => c.kind === "relay")).toBe(true);

    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
    store.close();
  }, 10_000);

  it("a single-candidate mbregistry bridge opens exactly one mbregistry stream for the whole attempt -- no second lock for the reset step, and no BREAK when the relay is already healthy (finding 4)", async () => {
    const store = freshStore();
    const relayLinkId = "mbregistry-RELAY-SINGLE";
    seedMbregistryRelay(store, relayLinkId);

    let createMbregistryCalls = 0;
    let sendBreakCalls = 0;
    const createMbregistryStream = (): RelayPlaneByteStream => {
      createMbregistryCalls++;
      const stream = new RelayPlaneByteStream(new RelayPlaneState(), true);
      const original = stream.sendBreak.bind(stream);
      stream.sendBreak = async () => {
        sendBreakCalls++;
        return original();
      };
      return stream;
    };

    const bridger = createRelayBridger(store, { createMbregistryStream, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);
    const request: BridgeRequest = { relayLinkId, candidates: [{ childLinkId: "radio-a-via-relay", channel: 47, group: 60 }] };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(session.transport).toBe("radio");
    // Finding 4: this candidate's own relay is fresh/healthy (never used
    // before in this test) -- its sync() check succeeds, so no BREAK is
    // ever sent to it.
    expect(sendBreakCalls).toBe(0);
    // The headline AC (unchanged by finding 4): no second mbregistry
    // connection/lock opened for the reset step -- one call covers
    // reset-check + data for the attempt.
    expect(createMbregistryCalls).toBe(1);
    store.close();
  }, 10_000);

  it("an mbregistry relay with a remote endpoint bridges its child as mbrelay-transport, mirroring the mbrelay/TCP discovery path it replaces", async () => {
    const store = freshStore();
    const relayLinkId = "mbregistry-RELAY-REMOTE";
    seedMbregistryRelay(store, relayLinkId, { host: "10.0.0.9", port: 5000 }, "REMOTE-UID");

    const createMbregistryStream = (): RelayPlaneByteStream => new RelayPlaneByteStream(new RelayPlaneState(), true);
    const bridger = createRelayBridger(store, { createMbregistryStream, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);
    const request: BridgeRequest = { relayLinkId, candidates: [{ childLinkId: "mbrelay-a-via-relay", channel: 47, group: 60 }] };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(session.transport).toBe("mbrelay");
    store.close();
  }, 10_000);
});

describe("createRelayBridger().bridge() -- relay identified via ticket 017-005's synthetic negative id", () => {
  it("bridges through an mbrelay pool whose own devices row has a negative id (non-grammar mDNS name, e.g. 'torture') exactly like any other relay", async () => {
    const store = freshStore();
    const relayLinkId = "mbrelay-torture";
    // Mirrors what `mdnsWatcher.ts`'s `createRelayDeviceIfAbsent` writes
    // for a relay whose mDNS instance name isn't a well-formed
    // five-letter name (ticket 017-005): a `kind='relay'` devices row
    // with a negative id, and the `mbrelay` link pointed at it via
    // `deviceId` -- unlike the sibling "TCP (mbrelay) reset" test above
    // (ticket 016-005), which never seeds a devices row for the relay at
    // all. `createRelayBridger.bridge()` never reads the relay's own
    // devices row (only its `links` row, via `relayLinkTransport` --
    // see `relayBridger.ts`), so this only proves the negative id causes
    // no foreign-key or lookup failure anywhere in the bridge path, not
    // that the bridger newly depends on it.
    const relayDeviceId = -123456789;
    store.upsertDevice({ id: relayDeviceId, name: "torture", kind: "relay", at: 1 });
    store.upsertLink({ id: relayLinkId, transport: "mbrelay", address: { host: "torture.local", port: 8760 }, deviceId: relayDeviceId, at: 1 });

    const state = new RelayPlaneState();
    const createTcpStream = (host: string, port: number) =>
      tcpStream(host, port, {
        createSocket: () => new FakeMbrelayPoolSocket(state, true),
      });

    const bridger = createRelayBridger(store, { createTcpStream, scheduler: realScheduler, now: () => NOW }, FAST_OPTIONS);

    const request: BridgeRequest = {
      relayLinkId,
      candidates: [{ childLinkId: "mbrelay-vevov-via-relay", channel: 47, group: 60 }],
    };

    const session = await bridger.bridge(request, new AbortController().signal);

    expect(session.linkId).toBe("mbrelay-vevov-via-relay");
    expect(session.deviceId).toBe(ROBOT_SERIAL);
    expect(session.transport).toBe("mbrelay");

    // The relay's own (negative-id) devices row is untouched by the
    // bridge -- only the child robot's row was written.
    const devices = store.snapshotRows().devices;
    expect(devices.find((d) => d.id === relayDeviceId)).toMatchObject({ name: "torture", kind: "relay" });
    expect(devices.find((d) => d.id === ROBOT_SERIAL)).toBeDefined();

    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
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
  it("rejects immediately, recording a link failure, when a different owner already holds the relay's lease (also: ticket 016-004's own 'no revocation seam configured' regression guard -- this bridger is never given one, so a sweep-owned lease fails exactly as before that ticket)", async () => {
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

// ---------------------------------------------------------------------
// Sweep takeover (ticket 016-004; SUC-004; UC-016's <= 1.5s handback
// target). A single "physical relay" fixture -- shared, mutable state
// across every fresh stream instance, whichever module opens it -- is
// used by BOTH `watchers/relaySweeper.ts` (its own `!CG`/`> ID` probe)
// and this module (the full preamble through `!GO`/`HELLO`), since this
// is the one test in the suite where both genuinely contend over the
// same relay, not two independently-scripted fakes.
// ---------------------------------------------------------------------

class SharedRelayState {
  inDataPlane = false;
  resetCount = 0;
  lastTune: { channel: number; group: number } | undefined;
  reset(): void {
    this.resetCount++;
    this.inDataPlane = false;
  }
}

/** Answers the sweeper's command-plane-only probe and this module's own
 * full preamble against one shared {@link SharedRelayState} -- `ids`
 * names every device this fixture can answer `> ID`/`HELLO` for (by
 * recomputing `nameToRadioAddress(deviceIdToName(id))` and matching it
 * against whichever `(channel, group)` the most recent `!CG` tuned to,
 * exactly `relaySweeper.test.ts`'s own `SweepRelayByteStream` convention,
 * extended with the bridger's own `!P 7`/`!GO`/`HELLO` steps). */
class SharedPhysicalRelayByteStream extends FakeByteStream {
  constructor(
    private readonly state: SharedRelayState,
    private readonly ids: readonly number[],
  ) {
    super();
  }

  override open(signal: AbortSignal): Promise<void> {
    return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve();
  }

  private idForTune(tune: { channel: number; group: number } | undefined): number | undefined {
    if (!tune) {
      return undefined;
    }
    return this.ids.find((id) => {
      const addr = nameToRadioAddress(deviceIdToName(id));
      return addr.channel === tune.channel && addr.group === tune.group;
    });
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    const line = bytes.trim();

    if (this.state.inDataPlane) {
      if (line.startsWith("HELLO")) {
        const id = this.idForTune(this.state.lastTune);
        if (id !== undefined) {
          this.emitData(`device NEZHA2 robot ${deviceIdToName(id)} ${id}\n`);
        }
      }
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
      const channel = Number(match?.[1]);
      const group = Number(match?.[2]);
      this.state.lastTune = { channel, group };
      this.emitData(`# channel: ${channel} group: ${group} mode: RAW250 power: 7\n`);
    } else if (line === "!P 7") {
      this.emitData("# channel: 47 group: 60 mode: RAW250 power: 7\n");
    } else if (line === "!GO") {
      this.state.inDataPlane = true;
      this.emitData("# entering data plane\n");
    } else if (line === "> ID") {
      const id = this.idForTune(this.state.lastTune);
      if (id !== undefined) {
        const name = deviceIdToName(id);
        this.emitData(`< id diffdrive ${name} 1.0.10 ${name}\n`);
      }
    }
  }

  /** Ticket 016-002's break-reset capability. */
  async sendBreak(): Promise<void> {
    this.state.reset();
  }
}

function seedOwnedRobot(store: Store, id: number, at: number): string {
  const name = deviceIdToName(id);
  store.upsertDevice({ id, name, kind: "robot", at });
  store.setOwned(id, true, at);
  return name;
}

/** Poll `predicate` until it's true, or throw after `timeoutMs`. Used
 * instead of a fixed sleep so this suite never races a real-timer
 * fake's own response speed. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, pollMs = 15): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!predicate()) {
    throw new Error("waitFor: timed out");
  }
}

describe("createRelayBridger().bridge() -- sweep takeover (ticket 016-004, SUC-004, UC-016)", () => {
  it("a takeover request during an in-flight sweep pass releases the sweep lease within 600ms of the abort, makes no further sweep writes, and the bridge itself proceeds within 1.5s", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, relayLinkId);
    const idA = 100001;
    const idB = 100002;
    seedOwnedRobot(store, idA, 1);
    seedOwnedRobot(store, idB, 1);

    const state = new SharedRelayState();
    const ids = [idA, idB];

    let sweepStream: SharedPhysicalRelayByteStream | undefined;
    const sweepCreateSerialStream = (): SharedPhysicalRelayByteStream => {
      sweepStream = new SharedPhysicalRelayByteStream(state, ids);
      return sweepStream;
    };

    const revocation = createRelayLeaseRevocation();
    // A long rate-limit interval -- comfortably longer than this test's
    // own 1.5s/600ms budgets -- so once the first candidate is sighted,
    // the sweep pass is reliably still sitting in its own (abortable)
    // rate-limited wait for the second when the takeover below lands:
    // exactly "during an in-flight probe" (this ticket's own AC wording),
    // not racing a pass that might otherwise have already exhausted its
    // short candidate queue on its own.
    const passRunner = createRelaySweepPassRunner(
      store,
      { createSerialStream: sweepCreateSerialStream, scheduler: realScheduler, now: () => Date.now(), revocation },
      { sweepMinIntervalMs: 4000, probeTimeoutMs: 200, readySyncAttempts: 5, readySyncRetryMs: 20 },
    );

    const passController = new AbortController();
    let passReleasedAt: number | undefined;
    const passPromise = passRunner.runOnePass(relayLinkId, passController).then(() => {
      passReleasedAt = Date.now();
    });

    // Wait until the sweep has sighted (recorded a links(radio) row for)
    // one of the two candidates, and is now waiting out its own long
    // rate-limit gap before the other.
    await waitFor(() => store.snapshotRows().links.some((l) => l.transport === "radio"));
    const sightedLinkId = store.snapshotRows().links.find((l) => l.transport === "radio")!.id as string;
    const targetId = radioChildLinkId(deviceIdToName(idA), relayLinkId) === sightedLinkId ? idA : idB;
    const targetName = deviceIdToName(targetId);
    expect(sightedLinkId).toBe(radioChildLinkId(targetName, relayLinkId));

    const sightedRow = store.snapshotRows().links.find((l) => l.id === sightedLinkId)!;
    const sightedAddress = JSON.parse(sightedRow.address as string) as { relayLinkId: string; channel: number; group: number };
    const linkRow: LinkRow = { id: sightedLinkId, transport: "radio", address: sightedAddress };

    const bridger = createRelayBridger(
      store,
      { createSerialStream: () => new SharedPhysicalRelayByteStream(state, ids), scheduler: realScheduler, now: () => Date.now(), revocation },
      { ...FAST_OPTIONS, takeoverMaxWaitMs: 1000, takeoverPollMs: 10 },
    );

    const sweepWritesBeforeTakeover = sweepStream!.writes.length;
    const takeoverRequestedAt = Date.now();

    const session = await bridger.bridge(toBridgeRequest(linkRow), new AbortController().signal);
    const bridgeDoneAt = Date.now();

    await passPromise;

    expect(session.linkId).toBe(sightedLinkId);
    expect(session.deviceId).toBe(targetId);

    // AC: end-to-end timing -- takeover request to the bridge proceeding
    // (session lease acquired, candidate identified) is <= 1.5s.
    expect(bridgeDoneAt - takeoverRequestedAt).toBeLessThanOrEqual(1500);
    // AC: the sweep releases its lease within 600ms of the abort (the
    // abort itself happens synchronously, inside bridge()'s own takeover
    // step, essentially at takeoverRequestedAt).
    expect(passReleasedAt).toBeDefined();
    expect(passReleasedAt! - takeoverRequestedAt).toBeLessThanOrEqual(600);
    // AC: no further sweep writes to the relay once the sweep's own pass
    // released -- its own stream instance never wrote again afterward.
    expect(sweepStream!.writes.length).toBeGreaterThanOrEqual(sweepWritesBeforeTakeover);
    const finalSweepWriteCount = sweepStream!.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sweepStream!.writes.length).toBe(finalSweepWriteCount);

    // AC: a robot the sweep had already sighted uses that sighted
    // channel/group for the takeover bridge, not a re-derived default --
    // toBridgeRequest carries the sighted link's own address verbatim,
    // and the fixture only ever answers `> ID`/`HELLO` when the tuned
    // (channel, group) matches -- a wrong (re-derived-but-different)
    // address would have failed to identify at all.
    expect({ channel: sightedAddress.channel, group: sightedAddress.group }).toEqual(nameToRadioAddress(targetName));

    // No lease left behind either way.
    const leaseRows = store.reconcilerRows().relayLeases;
    expect(leaseRows.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();

    store.close();
  }, 10_000);
});
