import { describe, expect, it, vi } from "vitest";
import { deviceIdToName, nameToRadioAddress } from "@robot-console/protocol";
import { openStoreDb } from "../store/db.js";
import { Store } from "../store/index.js";
import { FakeByteStream } from "../link/__fixtures__/FakeByteStream.js";
import { realScheduler } from "../link/pacing.js";
import { createRelayLeaseRevocation } from "../connect/relayLeaseRevocation.js";
import {
  buildSweepPassCandidates,
  createRelaySweepPassRunner,
  eligibleSweepDevices,
  fastSweepSettingKey,
  isFastSweepEnabled,
  isSweepCandidateBackedOff,
  orderSweepCandidates,
  radioChildLinkId,
  startRelaySweeper,
  sweepBackoffMs,
  SWEEP_BACKOFF_BASE_MS,
  SWEEP_BACKOFF_CAP_MS,
  type RelaySweepPassRunner,
} from "./relaySweeper.js";
import type { ProjectionDeviceRow, ProjectionLinkRow, RadioSightingRow } from "../store/index.js";

// Sprint 016 ticket 003's own suite: a fake relay answering !CG/> ID over
// a directly-opened fake ByteStream (mirrors relayBridger.test.ts's own
// "opens the relay's raw transport directly" harness), plus the pure
// candidate-ordering/backoff functions table-tested with no I/O at all.
// Every timing value below is small and injected via opts -- real
// timers, per relayBridger.test.ts's own established convention (a
// synchronously-answering fake always wins its race against a real,
// much-larger timeout).

function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

function deviceIdFor(seed: number): number {
  // Any id decodes to *some* well-formed five-letter name via
  // deviceIdToName -- self-consistency is all upsertDevice requires
  // (DeviceNameMismatchError guards exactly this), so tests mint ids
  // from small, distinct seeds rather than hunting for "known" names.
  return seed;
}

function seedOwnedRobot(store: Store, id: number, at: number): string {
  const name = deviceIdToName(id);
  store.upsertDevice({ id, name, kind: "robot", at });
  store.setOwned(id, true, at);
  return name;
}

function seedRelay(store: Store, relayId: number, relayLinkId: string, at: number, hidPath: string | null = null): void {
  const relayName = deviceIdToName(relayId);
  store.upsertDevice({ id: relayId, name: relayName, kind: "relay", role: "RADIOBRIDGE", at });
  store.upsertLink({ id: relayLinkId, transport: "usb", address: { path: "/dev/cu.relay", hidPath }, deviceId: relayId, at });
  store.setLinkState({ id: relayLinkId, state: "connectable", at, reason: "relay-identified-idle" });
}

/** A fake relay's own physical port: answers `?`/`!CG` like a real one,
 * and answers `> ID` with a matching `< id ...` reply only for names in
 * `answeringNames` -- looked up by the (channel, group) the most recent
 * `!CG` tuned to (every candidate name resolves to a distinct address via
 * `nameToRadioAddress`, so this recovers "which robot is currently being
 * probed" without the fake needing to parse `> ID` itself). `open()`
 * resolves immediately, like `relayBridger.test.ts`'s own
 * `RelayPlaneByteStream`. Can additionally simulate a relay "parked in
 * the data plane" (silent to `?` until reset) via `startParked`. */
class SweepRelayByteStream extends FakeByteStream {
  cgWriteTimes: number[] = [];
  resetCount = 0;
  private parked: boolean;

  constructor(
    private readonly allNames: readonly string[],
    private readonly answeringNames: ReadonlySet<string>,
    private readonly nowFn: () => number,
    startParked = false,
    /** Ticket 016-007: when set, every `?`/`!CG`/`!CGT` reply advertises
     * this token in a trailing `caps:` field (e.g. `"CGT"`), exactly like
     * the merged upstream firmware (`League-Robotics/microbit-radio-relay#1`)
     * does -- lets a test simulate a relay that has (or has not)
     * feature-detected the non-persisting tune. */
    private readonly capsToken?: string,
  ) {
    super();
    this.parked = startParked;
  }

  override open(signal: AbortSignal): Promise<void> {
    return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve();
  }

  override write(bytes: string, callback: (err?: Error | null) => void): void {
    super.write(bytes, callback);
    const line = bytes.trim();

    if (this.parked) {
      // Silent to everything except nothing -- a relay stuck in the data
      // plane never answers the command plane at all until reset.
      return;
    }

    const capsSuffix = this.capsToken ? ` caps: ${this.capsToken}` : "";

    if (line === "?") {
      this.emitData(`# channel: 1 group: 1 mode: RAW250 power: 7${capsSuffix}\n`);
      return;
    }
    // Matches both the persisting `!CG <ch> <grp>` and the non-persisting
    // `!CGT <ch> <grp>` (ticket 016-007) -- the merged firmware confirms
    // both with the identical status-line shape.
    const cgMatch = /^!CGT? (\d+) (\d+)$/.exec(line);
    if (cgMatch) {
      this.cgWriteTimes.push(this.nowFn());
      const channel = Number(cgMatch[1]);
      const group = Number(cgMatch[2]);
      this.lastTune = { channel, group };
      this.emitData(`# channel: ${channel} group: ${group} mode: RAW250 power: 7${capsSuffix}\n`);
      return;
    }
    if (line === "> ID") {
      const tune = this.lastTune;
      const name = tune && this.allNames.find((n) => {
        const addr = nameToRadioAddress(n);
        return addr.channel === tune.channel && addr.group === tune.group;
      });
      if (name && this.answeringNames.has(name)) {
        this.emitData(`< id diffdrive ${name} 1.0.10 ${name}\n`);
      }
      // else: silence -- no reply, simulating a non-answering robot.
    }
  }

  private lastTune: { channel: number; group: number } | undefined;

  /** Ticket 016-002's break-reset capability -- see
   * `link/adapters/serialStream.ts`'s own `sendBreak()`. Clears `parked`,
   * mirroring a real relay's DAP reset recovering it back into the
   * command plane. */
  async sendBreak(): Promise<void> {
    this.resetCount++;
    this.parked = false;
  }
}

/** Small, real-time-safe options every integration test below uses: a
 * tiny probe timeout and rate-limit interval, and a short ready-check
 * retry loop -- mirrors `relayBridger.test.ts`'s own `FAST_OPTIONS`. */
const FAST_OPTS = {
  probeTimeoutMs: 30,
  sweepMinIntervalMs: 40,
  readySyncAttempts: 3,
  readySyncRetryMs: 20,
} as const;

function makeRunner(
  store: Store,
  createSerialStream: () => SweepRelayByteStream,
  revocation = createRelayLeaseRevocation(),
  now: () => number = () => Date.now(),
): RelaySweepPassRunner {
  return createRelaySweepPassRunner(
    store,
    { createSerialStream, scheduler: realScheduler, now, revocation },
    FAST_OPTS,
  );
}

// ---------------------------------------------------------------------
// sweepBackoffMs / isSweepCandidateBackedOff -- pure, table-tested
// (ticket's own acceptance criterion: "a concrete backoff, table-tested")
// ---------------------------------------------------------------------

describe("sweepBackoffMs", () => {
  it.each([
    [0, 0],
    [-1, 0],
    [1, SWEEP_BACKOFF_BASE_MS],
    [2, SWEEP_BACKOFF_BASE_MS * 2],
    [3, SWEEP_BACKOFF_BASE_MS * 4],
    [4, SWEEP_BACKOFF_BASE_MS * 8],
  ])("consecutiveFailures=%i -> %ims", (failures, expected) => {
    expect(sweepBackoffMs(failures)).toBe(expected);
  });

  it("caps at SWEEP_BACKOFF_CAP_MS for a long failure streak", () => {
    expect(sweepBackoffMs(10)).toBe(SWEEP_BACKOFF_CAP_MS);
    expect(sweepBackoffMs(100)).toBe(SWEEP_BACKOFF_CAP_MS);
  });
});

describe("isSweepCandidateBackedOff", () => {
  it("never backed off with a zero fail count, regardless of timing", () => {
    expect(isSweepCandidateBackedOff(0, 0, 1_000_000)).toBe(false);
  });

  it("never backed off when it has never been attempted (lastAttemptAt undefined)", () => {
    expect(isSweepCandidateBackedOff(5, undefined, 1_000_000)).toBe(false);
  });

  it("is backed off immediately after a failure, before its own backoff window elapses", () => {
    const lastAttemptAt = 1000;
    expect(isSweepCandidateBackedOff(1, lastAttemptAt, lastAttemptAt + 1)).toBe(true);
  });

  it("is no longer backed off once its own window has fully elapsed", () => {
    const lastAttemptAt = 1000;
    expect(isSweepCandidateBackedOff(1, lastAttemptAt, lastAttemptAt + SWEEP_BACKOFF_BASE_MS + 1)).toBe(false);
  });

  it("a name that fails repeatedly is backed off for longer than one that failed once -- 'probed less often'", () => {
    const lastAttemptAt = 1000;
    const oneFailureWindow = sweepBackoffMs(1);
    const fourFailuresWindow = sweepBackoffMs(4);
    expect(fourFailuresWindow).toBeGreaterThan(oneFailureWindow);
    // Just past the one-failure name's own window: it is eligible again,
    // but the four-failure name is not.
    const at = lastAttemptAt + oneFailureWindow + 1;
    expect(isSweepCandidateBackedOff(1, lastAttemptAt, at)).toBe(false);
    expect(isSweepCandidateBackedOff(4, lastAttemptAt, at)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// eligibleSweepDevices / orderSweepCandidates / buildSweepPassCandidates
// -- pure, store-shape-in/store-shape-out
// ---------------------------------------------------------------------

function deviceRow(partial: Partial<ProjectionDeviceRow> & { id: number; name: string }): ProjectionDeviceRow {
  return {
    kind: "robot",
    role: null,
    commonName: null,
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

function linkRow(partial: Partial<ProjectionLinkRow> & { id: string }): ProjectionLinkRow {
  return {
    deviceId: null,
    transport: "radio",
    address: null,
    state: "discovered",
    stateReason: null,
    stateSince: 0,
    lastSeen: null,
    nextRetryAt: null,
    failCount: 0,
    userClosed: false,
    ...partial,
  };
}

describe("eligibleSweepDevices", () => {
  it("excludes a device with a connected usb/wifi/mbserial link", () => {
    const devices = [deviceRow({ id: 1, name: "aaaaa" }), deviceRow({ id: 2, name: "bbbbb" })];
    const links = [linkRow({ id: "usb-x", transport: "usb", deviceId: 1, state: "connected" })];
    expect(eligibleSweepDevices(devices, links).map((d) => d.id)).toEqual([2]);
  });

  it("does not exclude a device whose only connected link is itself a radio link", () => {
    const devices = [deviceRow({ id: 1, name: "aaaaa" })];
    const links = [linkRow({ id: "radio-x", transport: "radio", deviceId: 1, state: "connected" })];
    expect(eligibleSweepDevices(devices, links).map((d) => d.id)).toEqual([1]);
  });

  it("excludes unowned robots and relay-kind devices", () => {
    const devices = [
      deviceRow({ id: 1, name: "aaaaa", owned: false }),
      deviceRow({ id: 2, name: "bbbbb", kind: "relay" }),
      deviceRow({ id: 3, name: "ccccc" }),
    ];
    expect(eligibleSweepDevices(devices, []).map((d) => d.id)).toEqual([3]);
  });
});

describe("orderSweepCandidates", () => {
  it("orders oldest radio sighting first", () => {
    const devices = [
      deviceRow({ id: 1, name: "aaaaa" }),
      deviceRow({ id: 2, name: "bbbbb" }),
      deviceRow({ id: 3, name: "ccccc" }),
    ];
    const sightings: RadioSightingRow[] = [
      { deviceId: 1, at: 500 },
      { deviceId: 2, at: 100 },
    ];
    // 2 has the oldest sighting; 3 has never been sighted at all, so it
    // sorts first (longest overdue); 1's sighting is the most recent.
    expect(orderSweepCandidates(devices, sightings).map((d) => d.id)).toEqual([3, 2, 1]);
  });
});

describe("buildSweepPassCandidates", () => {
  it("filters out a name still inside its own backoff window", () => {
    const devices = [deviceRow({ id: 1, name: "aaaaa" }), deviceRow({ id: 2, name: "bbbbb" })];
    const linkId = radioChildLinkId("aaaaa", "usb-RELAY");
    const links = [linkRow({ id: linkId, deviceId: 1, failCount: 3, lastSeen: 1000 })];
    const at = 1000 + sweepBackoffMs(3) - 1; // still inside the window
    const result = buildSweepPassCandidates(devices, links, [], "usb-RELAY", at);
    expect(result.map((d) => d.id)).toEqual([2]);
  });

  it("includes a name once its backoff window has elapsed", () => {
    const devices = [deviceRow({ id: 1, name: "aaaaa" })];
    const linkId = radioChildLinkId("aaaaa", "usb-RELAY");
    const links = [linkRow({ id: linkId, deviceId: 1, failCount: 1, lastSeen: 1000 })];
    const at = 1000 + sweepBackoffMs(1) + 1;
    expect(buildSweepPassCandidates(devices, links, [], "usb-RELAY", at).map((d) => d.id)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------
// fastSweepSettingKey / isFastSweepEnabled -- the off-by-default seam
// ---------------------------------------------------------------------

describe("isFastSweepEnabled", () => {
  it("defaults off when ticket 007 has never written the setting", () => {
    const store = freshStore();
    expect(isFastSweepEnabled(store, "usb-RELAY")).toBe(false);
    store.close();
  });

  it("reads true only once set to the literal '1' under fastSweepSettingKey", () => {
    const store = freshStore();
    store.setSetting(fastSweepSettingKey("usb-RELAY"), "1");
    expect(isFastSweepEnabled(store, "usb-RELAY")).toBe(true);
    expect(isFastSweepEnabled(store, "usb-OTHER")).toBe(false);
    store.close();
  });
});

// ---------------------------------------------------------------------
// createRelaySweepPassRunner().runOnePass -- integration against a fake
// relay's own directly-opened ByteStream
// ---------------------------------------------------------------------

describe("createRelaySweepPassRunner().runOnePass", () => {
  it("after one pass: sightings has one row per candidate; answering names get a connectable radio link; non-answering names show fail_count = 1; never sends !GO or HELLO", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const answeringId = 100001;
    const silentId = 100002;
    const answeringName = seedOwnedRobot(store, answeringId, 1);
    const silentName = seedOwnedRobot(store, silentId, 1);

    const stream = new SweepRelayByteStream([answeringName, silentName], new Set([answeringName]), () => Date.now());
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    const sightings = store.snapshotRows().sessions; // sanity: no session ever opened by a sweep
    expect(sightings).toEqual([]);

    const linksById = new Map(store.snapshotRows().links.map((l) => [l.id, l] as const));
    const answeringLink = linksById.get(radioChildLinkId(answeringName, relayLinkId));
    const silentLink = linksById.get(radioChildLinkId(silentName, relayLinkId));
    expect(answeringLink?.state).toBe("connectable");
    expect(Number(answeringLink?.fail_count)).toBe(0);
    expect(Number(silentLink?.fail_count)).toBe(1);
    expect(silentLink?.state).not.toBe("connectable");

    expect(stream.writes.map((w) => w.bytes.trim())).not.toContain("!GO");
    expect(stream.writes.some((w) => w.bytes.trim().startsWith("HELLO"))).toBe(false);

    store.close();
  });

  it("records a successful radio sighting for the answering candidate, readable via Store.radioSightings()", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const answeringId = 100001;
    const silentId = 100002;
    const answeringName = seedOwnedRobot(store, answeringId, 1);
    const silentName = seedOwnedRobot(store, silentId, 1);

    const stream = new SweepRelayByteStream([answeringName, silentName], new Set([answeringName]), () => Date.now());
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    // Store.radioSightings() only ever surfaces successful (ok=1) radio
    // sightings (its own doc comment) -- exactly one entry, for the
    // candidate that actually answered `> ID`.
    const radioSightings = store.radioSightings();
    expect(radioSightings.map((s) => s.deviceId)).toEqual([answeringId]);

    store.close();
  });

  // -------------------------------------------------------------------
  // Sprint 016 ticket 006: registry-aware radio address resolution
  // considered this call site too, but this module's own candidate
  // resolution (`resolveDefaultFailoverAddress`, `connect/relayBridger.ts`)
  // is registry-free *by construction* -- it substitutes
  // `noRegistryResolve` for `radioOverride.ts`'s injectable
  // `resolveRegistry` seam, so no `registry` argument this module could
  // ever supply would reach `mbrelayRegistry.ts`'s real HTTP call.
  // Threading a live registry location into this call site is therefore
  // not just unnecessary but impossible without first relaxing
  // `resolveDefaultFailoverAddress`'s own hardcoded no-registry contract
  // -- which would break ticket 003's own acceptance criterion ("the
  // sweeper still must never issue a registry GET during a probe pass",
  // rearch-10) and `connect/relayBridger.test.ts`'s own already-passing
  // "registry-free by construction" suite for the *same* function. These
  // two tests are this ticket's own regression guard for that finding at
  // this specific call site (`connect/relayBridger.test.ts` already pins
  // it for `resolveDefaultFailoverAddress` itself).
  // -------------------------------------------------------------------
  it("never issues a registry GET during a probe pass, across multiple candidates (sprint 016 ticket 006 regression guard)", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const firstName = seedOwnedRobot(store, 100001, 1);
    const secondName = seedOwnedRobot(store, 100002, 1);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const stream = new SweepRelayByteStream([firstName, secondName], new Set([firstName, secondName]), () => Date.now());
      const runner = makeRunner(store, () => stream);

      await runner.runOnePass(relayLinkId, new AbortController());

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      store.close();
    }
  });

  it("a stored radio override for a sweep candidate wins outright -- the sweep tunes to it, never to a registry (sprint 016 ticket 006)", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const overriddenId = 100001;
    const overriddenName = seedOwnedRobot(store, overriddenId, 1);
    const derived = nameToRadioAddress(overriddenName);
    const overrideChannel = derived.channel === 25 ? 27 : 25;
    const overrideGroup = derived.group === 1 ? 2 : 1;
    store.setRadioOverride(overriddenId, overrideChannel, overrideGroup);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const stream = new SweepRelayByteStream([overriddenName], new Set(), () => Date.now());
      const runner = makeRunner(store, () => stream);

      await runner.runOnePass(relayLinkId, new AbortController());

      expect(fetchSpy).not.toHaveBeenCalled();
      const link = store.snapshotRows().links.find((l) => l.id === radioChildLinkId(overriddenName, relayLinkId));
      expect(JSON.parse(link!.address as string)).toEqual({ relayLinkId, channel: overrideChannel, group: overrideGroup });
    } finally {
      fetchSpy.mockRestore();
      store.close();
    }
  });

  it("never leases nor opens the transport when the relay is not idle/connectable (acquireRelayLease refuses)", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    store.acquireRelayLease(relayLinkId, "session:someone-else", 1);

    let opened = false;
    const stream = new SweepRelayByteStream([], new Set(), () => Date.now());
    const originalOpen = stream.open.bind(stream);
    stream.open = (signal: AbortSignal) => {
      opened = true;
      return originalOpen(signal);
    };
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(opened).toBe(false);
    // The other owner's lease is untouched.
    expect(store.reconcilerRows().relayLeases.find((l) => l.relayLinkId === relayLinkId)?.owner).toBe("session:someone-else");
    store.close();
  });

  it("with the default rate limit, no two !CG writes to the relay land closer together than sweepMinIntervalMs", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const names = [seedOwnedRobot(store, 100001, 1), seedOwnedRobot(store, 100002, 1), seedOwnedRobot(store, 100003, 1)];

    const stream = new SweepRelayByteStream(names, new Set(names), () => Date.now());
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(stream.cgWriteTimes.length).toBe(3);
    for (let i = 1; i < stream.cgWriteTimes.length; i++) {
      const gap = stream.cgWriteTimes[i]! - stream.cgWriteTimes[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(FAST_OPTS.sweepMinIntervalMs - 5);
    }
  }, 10_000);

  it("a relay parked in the data plane on lease acquisition gets exactly one reset before sweeping resumes", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now(), true);
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(stream.resetCount).toBe(1);
    const link = store.snapshotRows().links.find((l) => l.id === radioChildLinkId(name, relayLinkId));
    expect(link?.state).toBe("connectable");
    store.close();
  });

  it("registers its AbortController with the revocation seam for the duration of the pass and deregisters it on release", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const revocation = createRelayLeaseRevocation();
    let registeredDuringPass: AbortController | undefined;
    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now());
    const originalWrite = stream.write.bind(stream);
    stream.write = (bytes, callback) => {
      if (registeredDuringPass === undefined) {
        registeredDuringPass = revocation.get(relayLinkId);
      }
      originalWrite(bytes, callback);
    };
    const runner = createRelaySweepPassRunner(
      store,
      { createSerialStream: () => stream, scheduler: realScheduler, now: () => Date.now(), revocation },
      FAST_OPTS,
    );

    const passController = new AbortController();
    await runner.runOnePass(relayLinkId, passController);

    expect(registeredDuringPass).toBe(passController);
    expect(revocation.get(relayLinkId)).toBeUndefined();
    store.close();
  });

  it("stops probing further candidates once the pass's AbortController fires, and deregisters/releases the lease", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const names = [seedOwnedRobot(store, 100001, 1), seedOwnedRobot(store, 100002, 1), seedOwnedRobot(store, 100003, 1)];

    const revocation = createRelayLeaseRevocation();
    const stream = new SweepRelayByteStream(names, new Set(names), () => Date.now());
    const runner = createRelaySweepPassRunner(
      store,
      { createSerialStream: () => stream, scheduler: realScheduler, now: () => Date.now(), revocation },
      { ...FAST_OPTS, sweepMinIntervalMs: 5000 }, // long enough that the abort below reliably lands mid rate-limit wait, regardless of how long the first candidate's own CG/ID exchange took
    );

    const passController = new AbortController();
    const passPromise = runner.runOnePass(relayLinkId, passController);
    // Abort well after the first candidate's own CG/ID probe should have
    // finished (a handful of paced writes, each ~10ms), but far short of
    // the second candidate's own 5s-away rate-limited turn.
    await new Promise((resolve) => setTimeout(resolve, 300));
    passController.abort(new Error("takeover"));
    await passPromise;

    expect(stream.cgWriteTimes.length).toBe(1);
    expect(revocation.get(relayLinkId)).toBeUndefined();
    expect(store.reconcilerRows().relayLeases.find((l) => l.relayLinkId === relayLinkId)).toBeUndefined();
    store.close();
  }, 10_000);
});

// ---------------------------------------------------------------------
// Ticket 016-007: capability detection (non-persisting `!CGT` tune),
// fast sweep interval -- against a fake relay whose `?`/status reply
// does (or does not) advertise `caps: CGT`
// (`League-Robotics/microbit-radio-relay#1`, merged upstream).
// ---------------------------------------------------------------------

describe("createRelaySweepPassRunner().runOnePass -- capability detection (ticket 016-007)", () => {
  it("against a relay advertising caps: CGT: records the fast-sweep setting and tunes with !CGT, never the persisting !CG", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now(), false, "CGT");
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(isFastSweepEnabled(store, relayLinkId)).toBe(true);
    const writes = stream.writes.map((w) => w.bytes.trim());
    expect(writes.some((w) => w.startsWith("!CGT "))).toBe(true);
    expect(writes.some((w) => /^!CG \d/.test(w))).toBe(false);
    store.close();
  });

  it("against a relay with no capability token: stays on the persisting !CG, and explicitly records the flag off", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now());
    const runner = makeRunner(store, () => stream);

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(isFastSweepEnabled(store, relayLinkId)).toBe(false);
    expect(store.getSetting(fastSweepSettingKey(relayLinkId))).toBe("0");
    const writes = stream.writes.map((w) => w.bytes.trim());
    expect(writes.some((w) => /^!CG \d/.test(w))).toBe(true);
    expect(writes.some((w) => w.startsWith("!CGT "))).toBe(false);
    store.close();
  });

  it("re-detects fresh on every lease acquisition -- a relay that stops advertising the capability falls back to !CG on the very next pass", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    // First pass: capability advertised.
    const fastStream = new SweepRelayByteStream([name], new Set([name]), () => Date.now(), false, "CGT");
    await makeRunner(store, () => fastStream).runOnePass(relayLinkId, new AbortController());
    expect(isFastSweepEnabled(store, relayLinkId)).toBe(true);

    // Second (later) lease acquisition against the same relayLinkId, now
    // answering with no capability token at all (e.g. swapped for older
    // firmware) -- the flag must flip back off, not remain stale "on".
    const slowStream = new SweepRelayByteStream([name], new Set([name]), () => Date.now());
    await makeRunner(store, () => slowStream).runOnePass(relayLinkId, new AbortController());

    expect(isFastSweepEnabled(store, relayLinkId)).toBe(false);
    const writes = slowStream.writes.map((w) => w.bytes.trim());
    expect(writes.some((w) => /^!CG \d/.test(w))).toBe(true);
    expect(writes.some((w) => w.startsWith("!CGT "))).toBe(false);
    store.close();
  });

  it("with the capability detected, successive tune writes are spaced by the fast interval, not the (much larger) default", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const names = [seedOwnedRobot(store, 100001, 1), seedOwnedRobot(store, 100002, 1), seedOwnedRobot(store, 100003, 1)];

    const stream = new SweepRelayByteStream(names, new Set(names), () => Date.now(), false, "CGT");
    const runner = createRelaySweepPassRunner(
      store,
      { createSerialStream: () => stream, scheduler: realScheduler, now: () => Date.now(), revocation: createRelayLeaseRevocation() },
      { ...FAST_OPTS, sweepMinIntervalMs: 5000, fastSweepIntervalMs: 20 },
    );

    await runner.runOnePass(relayLinkId, new AbortController());

    expect(stream.cgWriteTimes.length).toBe(3);
    for (let i = 1; i < stream.cgWriteTimes.length; i++) {
      const gap = stream.cgWriteTimes[i]! - stream.cgWriteTimes[i - 1]!;
      // Comfortably bounded by the fast interval, nowhere near the 5s
      // slow default -- proves the fast path (not the persisting one) is
      // what actually governs pacing once the capability is detected.
      expect(gap).toBeLessThan(1000);
    }
  }, 10_000);
});

// ---------------------------------------------------------------------
// startRelaySweeper -- the scan/loop wiring itself
// ---------------------------------------------------------------------

describe("startRelaySweeper", () => {
  it("finds an idle usb relay and sweeps it, without needing a manual runOnePass call", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now());
    const handle = startRelaySweeper(
      store,
      { createSerialStream: () => stream, scheduler: realScheduler, now: () => Date.now(), revocation: createRelayLeaseRevocation() },
      { ...FAST_OPTS, scanIntervalMs: 10, quietPeriodMs: 50 },
    );

    // Poll the store until the sweep has recorded the candidate, rather
    // than a fixed sleep -- bounded by a generous ceiling.
    const deadline = Date.now() + 5000;
    let link: { state?: unknown } | undefined;
    while (Date.now() < deadline) {
      link = store.snapshotRows().links.find((l) => l.id === radioChildLinkId(name, relayLinkId));
      if (link?.state === "connectable") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(link?.state).toBe("connectable");
    // Ticket 016-008: await stop() so the sweeper's in-flight loop
    // (its finally cleanup, its own heartbeat) has fully settled before
    // the store closes underneath it -- see relaySweeper.ts's own
    // RelaySweeperHandle.stop doc comment for the "database is not
    // open" unhandled-rejection flake this fixes at the root.
    await handle.stop();
    store.close();
  }, 10_000);

  it("after a takeover ends (the relay returns to idle) and a quiet period elapses, the sweeper re-acquires the lease and resumes probing -- ticket 016-004's own AC, verified via further !CG/> ID traffic", async () => {
    const store = freshStore();
    const relayLinkId = "usb-RELAY";
    seedRelay(store, 900001, relayLinkId, 1);
    const name = seedOwnedRobot(store, 100001, 1);

    const stream = new SweepRelayByteStream([name], new Set([name]), () => Date.now());
    const handle = startRelaySweeper(
      store,
      { createSerialStream: () => stream, scheduler: realScheduler, now: () => Date.now(), revocation: createRelayLeaseRevocation() },
      { ...FAST_OPTS, scanIntervalMs: 10, quietPeriodMs: 50 },
    );

    // Wait for the sweep's first !CG write -- proves it started sweeping
    // at all.
    const deadline1 = Date.now() + 5000;
    while (Date.now() < deadline1 && stream.cgWriteTimes.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(stream.cgWriteTimes.length).toBeGreaterThanOrEqual(1);

    // Simulate a takeover: the relay becomes actively bridged (no longer
    // an idle usb link) -- scanOnce() must notice on its next tick and
    // stop this relay's own sweep loop, exactly like a real
    // session-open bridging through it (ticket 001's own idle-state
    // rule: only a `connectable` usb relay link is ever swept).
    store.setLinkState({ id: relayLinkId, state: "connected", at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const writesWhileBridged = stream.cgWriteTimes.length;
    // No further writes accrue while the relay is not idle.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stream.cgWriteTimes.length).toBe(writesWhileBridged);

    // Disconnect: the relay returns to idle.
    store.setLinkState({ id: relayLinkId, state: "connectable", at: Date.now() });

    // After a quiet period, the sweeper resumes -- further !CG/> ID
    // traffic against the very same fake relay.
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2 && stream.cgWriteTimes.length <= writesWhileBridged) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(stream.cgWriteTimes.length).toBeGreaterThan(writesWhileBridged);

    await handle.stop();
    store.close();
  }, 10_000);

  it("stop() is idempotent, stops the scan tick, and its returned promise resolves", async () => {
    const store = freshStore();
    const handle = startRelaySweeper(
      store,
      { revocation: createRelayLeaseRevocation() },
      { scanIntervalMs: 50_000 },
    );
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
    store.close();
  });
});
