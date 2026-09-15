import { afterEach, describe, expect, it, vi } from "vitest";
import { DAPLink } from "./vendor/dapjs/index.js";
import {
  defaultResolveVolumePath,
  extractV2Hex,
  findMatchingVolume,
  flash,
  flashViaDapLink,
  flashViaMsd,
  isUniversalHex,
  isValidIntelHexText,
  listVolumeNames,
  parseDetailsTxt,
  resetViaDapLink,
} from "./flash.js";
import type { VolumeCandidate } from "./flash.js";
import type { FlashPhase } from "./flash.js";
import type { DaplinkDevice } from "./devices.js";

/** Fast, deterministic stand-ins for `flash()`'s MSD settle/remount-poll
 * options (sprint 017 ticket 004) -- a fake, manually-advanced clock
 * paired with a `delay` that advances it immediately, so a 10s poll
 * budget resolves in real microseconds rather than making this suite
 * slow. Tests that care about the settle/poll sequence itself build
 * their own variant inline; every other MSD-path test spreads this in so
 * the new timing is a no-op as far as wall-clock time is concerned. */
function fakeClock(): { now: () => number; delay: (ms: number) => Promise<void> } {
  let elapsed = 0;
  return {
    now: () => elapsed,
    delay: async (ms: number) => {
      elapsed += ms;
    },
  };
}

// Per the ticket's Testing section: no micro:bit running cooperating
// firmware (or any board at all) is available this sprint, and no board
// can be flashed. `isUniversalHex`/`extractV2Hex`/`isValidIntelHexText`
// are pure data transformation and are tested thoroughly here against
// synthetic fixtures -- this is the part that is genuinely proven.
//
// `flashViaDapLink`'s own describe block below stays narrow -- factory-seam
// wiring/error-propagation only, mirroring `swdName.test.ts`'s explicit
// "not unit-tested against a mock beyond the seam itself" precedent for
// its own `CortexMFactory` injection point. `flash()`'s describe block
// goes further, using a duck-typed fake satisfying the small slice of
// `DAPLink`'s surface this module actually calls (`connect`, `on`, `off`,
// `flash`, `disconnect`) to exercise this module's OWN orchestration
// logic (extraction order, pre-erase validation, phase-callback
// sequencing, fallback trigger condition). That fake is a stand-in for
// "a collaborator satisfying the shape this code calls", never a claim
// that it faithfully reproduces `dapjs`'s or real hardware's behavior --
// end-to-end SWD/MSD correctness against a real board is deferred
// hardware verification per this sprint's known gap (see `sprint.md`).

/** Minimal Intel-hex record builder: `:` + byteCount + address +
 * recordType + data + checksum, assembled positionally so the resulting
 * string has the exact character offsets `flash.ts`'s parser reads
 * (record type at chars [7,9), block ID at chars [9,13) for a `0x0A`
 * block-start record). Checksums are never validated by this module's
 * parser, so an arbitrary placeholder is used throughout. */
function hexLine(byteCount: string, address: string, recordType: string, data: string): string {
  return `:${byteCount}${address}${recordType}${data}00`;
}

function blockStartLine(blockId: string): string {
  // 4-byte block-start data field: 2-byte block ID + 2 arbitrary bytes.
  return hexLine("04", "0000", "0A", `${blockId}0000`);
}

const V1_DATA_LINE = hexLine("10", "0000", "00", "11".repeat(16));
const V2_DATA_LINE_1 = hexLine("10", "0000", "00", "22".repeat(16));
const V2_DATA_LINE_2 = hexLine("10", "0010", "00", "33".repeat(16));
const EOF_LINE = ":00000001FF";

/** A synthetic universal hex: a v1 block (block-start, one data line, its
 * own local EOF) followed by a v2 block (block-start, two data lines,
 * its own local EOF) -- the same nested-EOF shape real universal hex
 * files use. */
const UNIVERSAL_HEX_FIXTURE = [
  blockStartLine("9900"),
  V1_DATA_LINE,
  EOF_LINE,
  blockStartLine("9903"),
  V2_DATA_LINE_1,
  V2_DATA_LINE_2,
  EOF_LINE,
].join("\n");

const PLAIN_INTEL_HEX_FIXTURE = [
  hexLine("10", "0000", "00", "AA".repeat(16)),
  hexLine("10", "0010", "00", "BB".repeat(16)),
  EOF_LINE,
].join("\n");

describe("isUniversalHex", () => {
  it("recognizes a universal hex by its block-start marker", () => {
    expect(isUniversalHex(UNIVERSAL_HEX_FIXTURE)).toBe(true);
  });

  it("does not misidentify a plain Intel hex as universal", () => {
    expect(isUniversalHex(PLAIN_INTEL_HEX_FIXTURE)).toBe(false);
  });
});

describe("extractV2Hex", () => {
  it("keeps only the v2 block's lines, discarding v1 and block-start records", () => {
    const extracted = extractV2Hex(UNIVERSAL_HEX_FIXTURE);
    const lines = extracted.trimEnd().split("\n");

    expect(lines).toEqual([V2_DATA_LINE_1, V2_DATA_LINE_2, EOF_LINE]);
    expect(extracted).not.toContain(V1_DATA_LINE);
    expect(extracted).not.toContain("9900");
  });

  it("produces output ending with a valid EOF record", () => {
    const extracted = extractV2Hex(UNIVERSAL_HEX_FIXTURE);
    const lines = extracted.trimEnd().split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBe(EOF_LINE);
  });

  it("appends an EOF record if the extracted v2 block did not already end with one", () => {
    const noEofFixture = [blockStartLine("9903"), V2_DATA_LINE_1].join("\n");
    const extracted = extractV2Hex(noEofFixture);
    const lines = extracted.trimEnd().split("\n");
    expect(lines).toEqual([V2_DATA_LINE_1, EOF_LINE]);
  });

  it("returns non-universal (plain Intel hex) input unchanged", () => {
    expect(extractV2Hex(PLAIN_INTEL_HEX_FIXTURE)).toBe(PLAIN_INTEL_HEX_FIXTURE);
  });
});

describe("isValidIntelHexText", () => {
  it("accepts a well-formed hex with an EOF record", () => {
    expect(isValidIntelHexText(PLAIN_INTEL_HEX_FIXTURE)).toEqual({ valid: true });
  });

  it("rejects an empty string", () => {
    expect(isValidIntelHexText("")).toMatchObject({ valid: false });
  });

  it("rejects a hex with no EOF record", () => {
    const result = isValidIntelHexText(hexLine("10", "0000", "00", "AA".repeat(16)));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/end-of-file/i);
  });

  it("rejects a line that does not start with ':'", () => {
    const result = isValidIntelHexText(`not-a-hex-line\n${EOF_LINE}`);
    expect(result.valid).toBe(false);
  });
});

function device(overrides: Partial<DaplinkDevice> = {}): DaplinkDevice {
  return {
    serialNumber: "9906360200052820aba2e384f40cfd6c000000006e052820",
    displaySerial: "aba2e384f40cfd6c",
    availability: "full",
    hid: { path: "IOHIDDevice@fake" },
    ...overrides,
  };
}

// Real `DETAILS.TXT` content captured from an attached micro:bit --
// its `Unique ID` is verified (against that same board's USB enumeration)
// to be character-for-character identical to `DaplinkDevice.serialNumber`.
const REAL_SERIAL_NUMBER = "99063602000528202e78ea8f7143163f000000006e052820";
const REAL_DETAILS_TXT = `# DAPLink Firmware - see https://daplink.io
Build ID: v0257-gc782a5ba (gcc)
Unique ID: ${REAL_SERIAL_NUMBER}
HIC ID: 6e052820
Auto Reset: 1
Automation allowed: 0
Overflow detection: 0
Incompatible image detection: 1
Page erasing: 0
Daplink Mode: Interface
Interface Version: 0257
Bootloader Version: 0257
Git SHA: c782a5ba907377658bc28aa8d132a0fa44543687
Local Mods: 0
USB Interfaces: MSD, CDC, HID, WebUSB
Bootloader CRC: 0x725bea7d
Interface CRC: 0xe561f1de
Remount count: 0
URL: https://microbit.org/device/?id=9906&v=0257
`;

describe("parseDetailsTxt", () => {
  it("parses real DETAILS.TXT content into a key/value map, ignoring the # comment line", () => {
    const details = parseDetailsTxt(REAL_DETAILS_TXT);

    expect(details["Unique ID"]).toBe(REAL_SERIAL_NUMBER);
    expect(details["Build ID"]).toBe("v0257-gc782a5ba (gcc)");
    expect(details["HIC ID"]).toBe("6e052820");
    // Keys containing spaces parse correctly (split on the *first* colon).
    expect(details["Daplink Mode"]).toBe("Interface");
    expect(details["USB Interfaces"]).toBe("MSD, CDC, HID, WebUSB");
    // The leading `#` comment line contributes no entry at all.
    expect(Object.keys(details)).not.toContain("# DAPLink Firmware - see https://daplink.io");
  });

  it("ignores blank lines and lines with no colon", () => {
    const details = parseDetailsTxt("\n\nnot a details line\nKey: value\n");
    expect(details).toEqual({ Key: "value" });
  });

  it("returns an empty map for empty text", () => {
    expect(parseDetailsTxt("")).toEqual({});
  });
});

describe("findMatchingVolume", () => {
  function candidate(volumePath: string, uniqueId: string | undefined): VolumeCandidate {
    return {
      volumePath,
      details: uniqueId === undefined ? {} : { "Unique ID": uniqueId },
    };
  }

  it("returns the one candidate whose Unique ID matches the serial number", () => {
    const result = findMatchingVolume(
      [candidate("/Volumes/MICROBIT", REAL_SERIAL_NUMBER)],
      REAL_SERIAL_NUMBER,
    );
    expect(result).toBe("/Volumes/MICROBIT");
  });

  it("returns undefined when no candidate's Unique ID matches", () => {
    const result = findMatchingVolume(
      [candidate("/Volumes/MICROBIT", "some-other-unique-id")],
      REAL_SERIAL_NUMBER,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when there are no candidates at all", () => {
    expect(findMatchingVolume([], REAL_SERIAL_NUMBER)).toBeUndefined();
  });

  it("with several candidates, returns only the one that actually matches -- not the first one found", () => {
    const result = findMatchingVolume(
      [
        candidate("/Volumes/MICROBIT", "not-this-one"),
        candidate("/Volumes/MICROBIT 1", REAL_SERIAL_NUMBER),
        candidate("/Volumes/MICROBIT 2", "not-this-one-either"),
      ],
      REAL_SERIAL_NUMBER,
    );
    expect(result).toBe("/Volumes/MICROBIT 1");
  });

  it("skips a candidate with no Unique ID field at all", () => {
    const result = findMatchingVolume(
      [candidate("/Volumes/MICROBIT", undefined)],
      REAL_SERIAL_NUMBER,
    );
    expect(result).toBeUndefined();
  });
});

describe("listVolumeNames", () => {
  // Sprint 017 ticket 004: darwin-only `readdir("/Volumes")` generalized
  // to a `platform`-branching enumeration, still plain `fs`/injectable
  // `readdir` (no external process, per `sprint.md`'s Design Rationale).
  // Real hardware verification remains macOS-only this sprint (see the
  // ticket's own Implementation notes); linux and win32 here are
  // unit-tested against a fake `fs` exclusively.

  describe("darwin", () => {
    it("enumerates /Volumes, returning only MICROBIT*-prefixed entries as full paths", async () => {
      const readdirFn = vi.fn(async (dirPath: string) => {
        expect(dirPath).toBe("/Volumes");
        return ["Macintosh HD", "MICROBIT", "MICROBIT 1"];
      });

      const result = await listVolumeNames("darwin", { readdir: readdirFn });

      expect(result).toEqual(["/Volumes/MICROBIT", "/Volumes/MICROBIT 1"]);
    });

    it("logs and returns an empty array, rather than throwing, when /Volumes cannot be listed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await listVolumeNames("darwin", {
        readdir: async () => {
          throw new Error("mock: EACCES /Volumes");
        },
      });

      expect(result).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES /Volumes"));
      warn.mockRestore();
    });
  });

  describe("linux", () => {
    it("enumerates /media/<user>, /run/media/<user>, and /mnt, merging MICROBIT* entries from each", async () => {
      const readdirFn = vi.fn(async (dirPath: string) => {
        if (dirPath === "/media/pi") return ["MICROBIT"];
        if (dirPath === "/run/media/pi") return ["MICROBIT 1"];
        if (dirPath === "/mnt") return ["usb-drive", "MICROBIT 2"];
        throw new Error(`unexpected directory: ${dirPath}`);
      });

      const result = await listVolumeNames("linux", { readdir: readdirFn, username: () => "pi" });

      expect(result).toEqual(["/media/pi/MICROBIT", "/run/media/pi/MICROBIT 1", "/mnt/MICROBIT 2"]);
    });

    it("substitutes <user> from the injected username override", async () => {
      const readdirFn = vi.fn(async (dirPath: string) => {
        expect(dirPath.includes("student1") || dirPath === "/mnt").toBe(true);
        return [];
      });

      await listVolumeNames("linux", { readdir: readdirFn, username: () => "student1" });

      expect(readdirFn).toHaveBeenCalledWith("/media/student1");
      expect(readdirFn).toHaveBeenCalledWith("/run/media/student1");
    });

    it("logs and continues to the remaining candidate directories when one cannot be listed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const readdirFn = vi.fn(async (dirPath: string) => {
        if (dirPath === "/media/pi") {
          throw new Error("mock: ENOENT /media/pi");
        }
        if (dirPath === "/run/media/pi") return ["MICROBIT"];
        if (dirPath === "/mnt") return [];
        throw new Error(`unexpected directory: ${dirPath}`);
      });

      const result = await listVolumeNames("linux", { readdir: readdirFn, username: () => "pi" });

      expect(result).toEqual(["/run/media/pi/MICROBIT"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("/media/pi"));
      warn.mockRestore();
    });
  });

  describe("win32", () => {
    it("probes drive letters A: through Z: via the injected fs, returning only those that exist", async () => {
      const readdirFn = vi.fn(async (dirPath: string) => {
        if (dirPath === "D:/" || dirPath === "E:/") return [];
        throw new Error("mock: drive not present");
      });

      const result = await listVolumeNames("win32", { readdir: readdirFn });

      expect(result).toEqual(["D:/", "E:/"]);
    });

    it("does not treat an absent drive letter as an enumeration failure worth logging", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const readdirFn = vi.fn(async () => {
        throw new Error("mock: drive not present");
      });

      const result = await listVolumeNames("win32", { readdir: readdirFn });

      expect(result).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe("defaultResolveVolumePath", () => {
  it("returns undefined when no MICROBIT* volumes are mounted at all", async () => {
    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => [],
      readTextFile: vi.fn(),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the volume listing itself fails, mirroring the readdir try/catch", async () => {
    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => {
        throw new Error("mock: ENOENT /Volumes");
      },
      readTextFile: vi.fn(),
    });
    expect(result).toBeUndefined();
  });

  it("resolves the single mounted candidate when its Unique ID matches", async () => {
    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => ["/Volumes/MICROBIT"],
      readTextFile: async (filePath) => {
        expect(filePath).toBe("/Volumes/MICROBIT/DETAILS.TXT");
        return REAL_DETAILS_TXT;
      },
    });
    expect(result).toBe("/Volumes/MICROBIT");
  });

  it("returns undefined when the single mounted candidate's Unique ID does not match", async () => {
    const result = await defaultResolveVolumePath(device({ serialNumber: "not-the-real-serial" }), {
      listVolumeNames: async () => ["/Volumes/MICROBIT"],
      readTextFile: async () => REAL_DETAILS_TXT,
    });
    expect(result).toBeUndefined();
  });

  it("with several mounted candidates, returns the one whose Unique ID matches -- not just the first found", async () => {
    const otherSerial = "9906360200052820ffffffffffffffff000000006e052820";
    const readTextFile = async (filePath: string) => {
      if (filePath === "/Volumes/MICROBIT/DETAILS.TXT") {
        return REAL_DETAILS_TXT.replace(REAL_SERIAL_NUMBER, otherSerial);
      }
      if (filePath === "/Volumes/MICROBIT 1/DETAILS.TXT") {
        return REAL_DETAILS_TXT;
      }
      throw new Error(`unexpected path: ${filePath}`);
    };

    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => ["/Volumes/MICROBIT", "/Volumes/MICROBIT 1"],
      readTextFile,
    });
    expect(result).toBe("/Volumes/MICROBIT 1");
  });

  it("skips a candidate volume whose DETAILS.TXT is missing or unreadable, rather than failing resolution", async () => {
    const readTextFile = async (filePath: string) => {
      if (filePath === "/Volumes/MICROBIT/DETAILS.TXT") {
        throw new Error("mock: ENOENT DETAILS.TXT");
      }
      if (filePath === "/Volumes/MICROBIT 1/DETAILS.TXT") {
        return REAL_DETAILS_TXT;
      }
      throw new Error(`unexpected path: ${filePath}`);
    };

    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => ["/Volumes/MICROBIT", "/Volumes/MICROBIT 1"],
      readTextFile,
    });
    expect(result).toBe("/Volumes/MICROBIT 1");
  });

  it("by default, enumerates via the platform-aware listVolumeNames rather than a hard-coded darwin-only path", async () => {
    // Regression coverage for the ticket 004 rewiring: `defaultResolveVolumePath`
    // no longer hard-codes `readdir("/Volumes")` itself -- its real default
    // now delegates to `listVolumeNames(os.platform())`. This is exercised
    // indirectly here by confirming the *injected* `listVolumeNames` is what's
    // consulted (already covered above); `listVolumeNames`'s own describe
    // block above covers the per-platform enumeration directly.
    const readTextFile = vi.fn(async () => REAL_DETAILS_TXT);
    const result = await defaultResolveVolumePath(device({ serialNumber: REAL_SERIAL_NUMBER }), {
      listVolumeNames: async () => ["/Volumes/MICROBIT"],
      readTextFile,
    });
    expect(result).toBe("/Volumes/MICROBIT");
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(readTextFile).toHaveBeenCalledWith("/Volumes/MICROBIT/DETAILS.TXT");
  });
});

describe("flashViaDapLink", () => {
  // Seam-level only, per this ticket's explicit precedent (see this
  // file's top doc comment) -- mirrors `swdName.test.ts`'s own
  // `CortexMFactory` coverage exactly.

  it("reports a classified failure without calling the factory when no HID path is available", async () => {
    const createDapLink = vi.fn();
    const result = await flashViaDapLink(device({ hid: {} }), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
    });
    expect(result).toEqual({
      status: "error",
      method: "swd",
      reason: "no-hid-path",
      error: expect.any(String),
    });
    expect(createDapLink).not.toHaveBeenCalled();
  });

  it("never throws, and reports attach-failed, when the DAPLink factory throws", async () => {
    const boom = new Error("mock: CMSIS-DAP open failed");
    const result = await flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => {
        throw boom;
      },
    });
    expect(result).toEqual({
      status: "error",
      method: "swd",
      reason: "attach-failed",
      error: boom.message,
    });
  });

  it("classifies a permission-flavored error message distinctly from a generic attach failure", async () => {
    const result = await flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => {
        throw new Error("EACCES: permission denied opening HID device");
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "permission" });
  });

  it("never rejects the returned promise even when the factory throws synchronously", async () => {
    await expect(
      flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
        createDapLink: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ status: "error" });
  });

  it("resolves ok on a successful flash, and detaches its progress listener via .off during cleanup", async () => {
    // Ticket 014-001: this used to be a regression test for a real bug
    // (sprint 003 ticket 005's bench session) -- the npm `dapjs`
    // package's actual runtime `DAPLink` (as opposed to its `.d.ts`,
    // which claims a Node `events.EventEmitter`) had no `.off` alias,
    // only `on`/`removeListener`/`emit`. Calling `.off` in this
    // function's cleanup `finally` block threw, and a throw from
    // `finally` replaces whatever the `try` block already returned --
    // so a flash that had genuinely succeeded on the board came back as
    // an uncaught rejection instead of `{ status: "ok" }`.
    //
    // `dapjs` is now vendored (`./vendor/dapjs/`) and compiled against
    // Node's real `events.EventEmitter`, which does implement `.off` --
    // see that directory's README.md. `createFakeDapLink`'s `off` now
    // mirrors that real, fixed shape, so this asserts the happy path
    // stays `{ status: "ok" }` and that `.off` was actually called
    // (proving `flashViaDapLink` no longer avoids it).
    const dapLink = createFakeDapLink();
    const result = await flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => dapLink,
    });
    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(dapLink.offCalls).toEqual([DAPLink.EVENT_PROGRESS]);
  });

  // Sprint 017 ticket 003: every dapjs call is now bound by
  // `lib/withTimeout.ts`'s `withTimeout` -- these two cases are this
  // ticket's own acceptance criterion ("Fake dapjs that never resolves
  // flash() -> timeout failure within the configured budget, HID handle
  // closed") plus the analogous case for `daplink.connect()` itself.

  it("returns a typed timeout failure and disconnects the HID handle best-effort when daplink.flash() never resolves within the configured budget", async () => {
    const disconnect = vi.fn(async () => {});
    const dapLink = createFakeDapLink({
      flash: () => new Promise<void>(() => {}),
      disconnect,
    });

    const result = await flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => dapLink,
      flashIdleTimeoutMs: 15,
    });

    expect(result).toMatchObject({ status: "error", method: "swd", reason: "timeout" });
    expect((result as { error: string }).error).toBe("daplink.flash() made no progress for 15 ms");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  // Real-hardware finding (Ubuntu 24.04, micro:bit v2 over hidraw): a
  // full flash takes ~86 s. The bound on daplink.flash() is therefore an
  // inactivity watchdog on progress events plus a 5-minute ceiling, not
  // a 30 s total -- these drive the real defaults with fake timers.
  describe("progress watchdog (default bounds, fake timers)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A fake whose flash() emits progress every `everyMs` for
     * `forMs` (forever if omitted), then resolves -- or, with `hang`,
     * never settles after its last event. */
    function slowDapLink(opts: { everyMs: number; forMs?: number; hang?: boolean; disconnect?: () => Promise<void> }) {
      const dapLink = createFakeDapLink({
        flash: async () => {
          for (let elapsed = 0; opts.forMs === undefined || elapsed < opts.forMs; elapsed += opts.everyMs) {
            await new Promise((resolve) => setTimeout(resolve, opts.everyMs));
            dapLink.emitProgress();
          }
          if (opts.hang) {
            await new Promise<void>(() => {});
          }
        },
        ...(opts.disconnect ? { disconnect: opts.disconnect } : {}),
      });
      return dapLink;
    }

    function track<T>(promise: Promise<T>): { settled: () => boolean } {
      let settled = false;
      void promise.then(() => (settled = true));
      return { settled: () => settled };
    }

    it("succeeds for a slow flash that reports progress every 5 s for 90 s", async () => {
      vi.useFakeTimers();
      const phases: FlashPhase[] = [];
      const dapLink = slowDapLink({ everyMs: 5_000, forMs: 90_000 });

      const pending = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, (phase) => phases.push(phase), {
        createDapLink: () => dapLink,
      });
      await vi.advanceTimersByTimeAsync(90_000);

      await expect(pending).resolves.toEqual({ status: "ok", method: "swd" });
      expect(phases[0]).toBe("erasing");
      expect(phases.filter((phase) => phase === "writing")).toHaveLength(18);
      expect(phases.at(-1)).toBe("resetting");
    });

    it("times out with the no-progress message when flash() reports nothing for 30 s", async () => {
      vi.useFakeTimers();
      const disconnect = vi.fn(async () => {});
      const dapLink = createFakeDapLink({ flash: () => new Promise<void>(() => {}), disconnect });

      const pending = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, { createDapLink: () => dapLink });
      const tracked = track(pending);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(tracked.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({
        status: "error",
        method: "swd",
        reason: "timeout",
        error: "daplink.flash() made no progress for 30 s",
      });
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(dapLink.offCalls).toEqual([DAPLink.EVENT_PROGRESS]);
    });

    it("restarts the no-progress window on every progress event, timing out 30 s after the last one", async () => {
      vi.useFakeTimers();
      const disconnect = vi.fn(async () => {});
      const dapLink = slowDapLink({ everyMs: 5_000, forMs: 60_000, hang: true, disconnect });

      const pending = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, { createDapLink: () => dapLink });
      const tracked = track(pending);
      await vi.advanceTimersByTimeAsync(89_999);
      expect(tracked.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ reason: "timeout", error: "daplink.flash() made no progress for 30 s" });
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it("hits the 300 s ceiling for a flash that keeps reporting progress but never finishes, and still disconnects", async () => {
      vi.useFakeTimers();
      const disconnect = vi.fn(async () => {});
      const dapLink = slowDapLink({ everyMs: 5_000, disconnect });

      const pending = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, { createDapLink: () => dapLink });
      const tracked = track(pending);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(tracked.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({
        status: "error",
        method: "swd",
        reason: "timeout",
        error: "daplink.flash() exceeded 300 s",
      });
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it("honours flashTimeoutMs and flashIdleTimeoutMs overrides", async () => {
      vi.useFakeTimers();
      const idle = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
        createDapLink: () => createFakeDapLink({ flash: () => new Promise<void>(() => {}) }),
        flashIdleTimeoutMs: 2_000,
      });
      const ceiling = flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
        createDapLink: () => slowDapLink({ everyMs: 1_000 }),
        flashTimeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(idle).resolves.toMatchObject({ error: "daplink.flash() made no progress for 2 s" });
      await expect(ceiling).resolves.toMatchObject({ error: "daplink.flash() exceeded 10 s" });
    });
  });

  it("returns a typed timeout failure and disconnects the HID handle best-effort when daplink.connect() never resolves within the configured budget", async () => {
    const disconnect = vi.fn(async () => {});
    const dapLink = createFakeDapLink({
      connect: () => new Promise<void>(() => {}),
      disconnect,
    });

    const result = await flashViaDapLink(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => dapLink,
      connectTimeoutMs: 15,
    });

    expect(result).toMatchObject({ status: "error", method: "swd", reason: "timeout" });
    expect((result as { error: string }).error).toMatch(/daplink\.connect\(\) timed out after 15ms/);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

/** A fake satisfying only the `DAPLink` surface `flashViaDapLink` actually
 * calls (`connect`, `on`, `off`, `flash`, `disconnect`) -- not a
 * simulation of real `dapjs`/hardware behavior. The default `flash`
 * implementation fires one registered `EVENT_PROGRESS` listener before
 * resolving, so tests can observe the `"writing"` phase callback the
 * same way a real `DAPLink#flash()` call would trigger it.
 *
 * Ticket 014-001: now includes a working `.off` (delegating to the same
 * listener-removal logic as `removeListener` would), matching the real
 * vendored `DAPLink`'s shape -- see this file's own "resolves ok on a
 * successful flash" test above for the history of why this fake used to
 * deliberately omit it. `offCalls` records every `.off` invocation so
 * tests can assert cleanup actually ran. */
function createFakeDapLink(overrides?: {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  flash?: (buffer: Buffer) => Promise<void>;
  reset?: () => Promise<boolean>;
}): DAPLink & { offCalls: string[]; emitProgress: () => void } {
  const progressListeners: Array<() => void> = [];
  const offCalls: string[] = [];
  const removeProgressListener = (event: string, listener: () => void) => {
    if (event === DAPLink.EVENT_PROGRESS) {
      const index = progressListeners.indexOf(listener);
      if (index >= 0) {
        progressListeners.splice(index, 1);
      }
    }
  };
  const fake = {
    offCalls,
    connect: overrides?.connect ?? (async () => {}),
    disconnect: overrides?.disconnect ?? (async () => {}),
    reset: overrides?.reset ?? (async () => true),
    on(event: string, listener: () => void) {
      if (event === DAPLink.EVENT_PROGRESS) {
        progressListeners.push(listener);
      }
      return fake;
    },
    off(event: string, listener: () => void) {
      offCalls.push(event);
      removeProgressListener(event, listener);
      return fake;
    },
    /** Fire every registered `EVENT_PROGRESS` listener, as a real
     * `DAPLink#flash()` does once per written page. */
    emitProgress() {
      for (const listener of [...progressListeners]) {
        listener();
      }
    },
    flash:
      overrides?.flash ??
      (async () => {
        for (const listener of progressListeners) {
          listener();
        }
      }),
  };
  return fake as unknown as DAPLink & { offCalls: string[] };
}

describe("resetViaDapLink", () => {
  // OOP 2026-09-09: relay-via-radio support -- see this function's own
  // doc comment. Seam-level only, same precedent as flashViaDapLink's own
  // describe block above.

  it("calls connect, then reset, then disconnect, in that order, and resolves ok", async () => {
    const calls: string[] = [];
    const dapLink = createFakeDapLink({
      connect: async () => {
        calls.push("connect");
      },
      reset: async () => {
        calls.push("reset");
        return true;
      },
      disconnect: async () => {
        calls.push("disconnect");
      },
    });

    const result = await resetViaDapLink(device(), { createDapLink: () => dapLink });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["connect", "reset", "disconnect"]);
  });

  it("reports a classified failure without calling the factory when no HID path is available", async () => {
    const createDapLink = vi.fn();
    const result = await resetViaDapLink(device({ hid: {} }), { createDapLink });
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(createDapLink).not.toHaveBeenCalled();
  });

  it("reports the connect() failure as the error, never throws", async () => {
    const boom = new Error("mock: CMSIS-DAP open failed");
    const dapLink = createFakeDapLink({
      connect: async () => {
        throw boom;
      },
    });

    const result = await resetViaDapLink(device(), { createDapLink: () => dapLink });

    expect(result).toEqual({ ok: false, error: boom.message });
  });

  it("still disconnects, and reports the failure, when reset() itself throws", async () => {
    const calls: string[] = [];
    const boom = new Error("mock: reset failed");
    const dapLink = createFakeDapLink({
      connect: async () => {
        calls.push("connect");
      },
      reset: async () => {
        calls.push("reset");
        throw boom;
      },
      disconnect: async () => {
        calls.push("disconnect");
      },
    });

    const result = await resetViaDapLink(device(), { createDapLink: () => dapLink });

    expect(result).toEqual({ ok: false, error: boom.message });
    expect(calls).toEqual(["connect", "reset", "disconnect"]);
  });

  it("never rejects the returned promise even when the factory throws synchronously", async () => {
    await expect(
      resetViaDapLink(device(), {
        createDapLink: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("reports a timeout error and still disconnects best-effort when reset() never resolves within the configured budget", async () => {
    const disconnect = vi.fn(async () => {});
    const dapLink = createFakeDapLink({
      reset: () => new Promise<boolean>(() => {}),
      disconnect,
    });

    const result = await resetViaDapLink(device(), { createDapLink: () => dapLink, timeoutMs: 15 });

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/daplink\.reset\(\) timed out after 15ms/);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("flashViaMsd", () => {
  it("writes hex bytes to <volumePath>/MICROBIT.hex via the injected writer", async () => {
    const writeFile = vi.fn(async (_path: string, _data: Buffer) => {});
    const hex = Buffer.from(PLAIN_INTEL_HEX_FIXTURE, "utf-8");

    await flashViaMsd("/Volumes/MICROBIT1", hex, { writeFile });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = writeFile.mock.calls[0]!;
    expect(writtenPath).toBe("/Volumes/MICROBIT1/MICROBIT.hex");
    expect(writtenData).toBe(hex);
  });

  it("propagates a thrown error from the injected writer rather than swallowing it", async () => {
    const boom = new Error("mock: ENOSPC");
    const writeFile = vi.fn(async () => {
      throw boom;
    });

    await expect(
      flashViaMsd("/Volumes/MICROBIT1", Buffer.from("x"), { writeFile }),
    ).rejects.toBe(boom);
  });
});

describe("flash", () => {
  it("validates the hex before ever attempting to attach -- an invalid hex never calls createDapLink", async () => {
    const createDapLink = vi.fn();
    const result = await flash(device(), "this is not a hex file at all", () => {}, {
      createDapLink,
    });

    expect(result).toMatchObject({ status: "error", reason: "invalid-hex" });
    expect(createDapLink).not.toHaveBeenCalled();
  });

  it("extracts the universal-hex v2 block before flashing, not the raw universal hex", async () => {
    let flashedText = "";
    const createDapLink = () =>
      createFakeDapLink({
        flash: async (buffer) => {
          flashedText = buffer.toString("utf-8");
        },
      });

    const result = await flash(device(), UNIVERSAL_HEX_FIXTURE, () => {}, { createDapLink });

    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(flashedText).toContain(V2_DATA_LINE_1);
    expect(flashedText).not.toContain(V1_DATA_LINE);
  });

  it("passes a plain (non-universal) Intel hex through unchanged", async () => {
    let flashedText = "";
    const createDapLink = () =>
      createFakeDapLink({
        flash: async (buffer) => {
          flashedText = buffer.toString("utf-8");
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, { createDapLink });

    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(flashedText).toBe(PLAIN_INTEL_HEX_FIXTURE);
  });

  it("reports erasing -> writing -> resetting, in order, on a successful SWD flash", async () => {
    const phases: FlashPhase[] = [];
    const createDapLink = () => createFakeDapLink();

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, (phase) => phases.push(phase), {
      createDapLink,
    });

    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(phases).toEqual(["erasing", "writing", "resetting"]);
  });

  it("returns the SWD success outcome directly, without resolving a fallback volume", async () => {
    const resolveVolumePath = vi.fn();
    const createDapLink = () => createFakeDapLink();

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath,
    });

    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(resolveVolumePath).not.toHaveBeenCalled();
  });

  it("falls back to MSD when SWD attach fails and a volume can be resolved", async () => {
    const writeFile = vi.fn(async (_path: string, _data: Buffer) => {});
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile,
      ...fakeClock(),
    });

    expect(result).toEqual({ status: "ok", method: "msd" });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = writeFile.mock.calls[0]!;
    expect(writtenPath).toBe("/Volumes/MICROBIT1/MICROBIT.hex");
    expect(writtenData.toString("utf-8")).toBe(PLAIN_INTEL_HEX_FIXTURE);
  });

  it("falls back to MSD when SWD programming fails (not just attach)", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        flash: async () => {
          throw new Error("mock: write failed mid-program");
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile: async () => {},
      ...fakeClock(),
    });

    expect(result).toEqual({ status: "ok", method: "msd" });
  });

  it("returns the original SWD failure unchanged when no MSD volume can be resolved", async () => {
    const writeFile = vi.fn(async () => {});
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => undefined,
      writeFile,
    });

    expect(result).toMatchObject({ status: "error", method: "swd", reason: "attach-failed" });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("returns write-failed when the MSD fallback's own write throws", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile: async () => {
        throw new Error("mock: ENOSPC");
      },
      ...fakeClock(),
    });

    expect(result).toEqual({
      status: "error",
      method: "msd",
      reason: "write-failed",
      error: expect.stringContaining("ENOSPC"),
    });
  });

  // Sprint 017 ticket 004: the MSD path settles before writing, and
  // waits (best-effort) for the volume to disappear/reappear before
  // reporting done -- `writeFile` returning is no longer itself "done".

  it("waits the settle delay before starting the MSD write, and does not report writing/done before it elapses", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });
    const calls: string[] = [];
    const { now, delay } = fakeClock();

    const result = await flash(
      device(),
      PLAIN_INTEL_HEX_FIXTURE,
      (phase) => calls.push(`phase:${phase}`),
      {
        createDapLink,
        resolveVolumePath: async () => "/Volumes/MICROBIT1",
        writeFile: async () => {
          calls.push("writeFile");
        },
        volumeExists: async () => true,
        now,
        delay: async (ms) => {
          calls.push(`delay:${ms}`);
          await delay(ms);
        },
        msdSettleMs: 500,
        msdRemountTimeoutMs: 0,
      },
    );

    expect(result).toEqual({ status: "ok", method: "msd" });
    // The settle delay (500ms) is the very first thing that happens on
    // the MSD path -- before "writing" is reported and before the write
    // itself starts.
    expect(calls[0]).toBe("delay:500");
    expect(calls.indexOf("delay:500")).toBeLessThan(calls.indexOf("phase:writing"));
    expect(calls.indexOf("phase:writing")).toBeLessThan(calls.indexOf("writeFile"));
  });

  it("does not report the msd outcome until the volume is observed to disappear and reappear", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });
    // present -> gone -> gone -> present again (the remount).
    const presence = [true, false, false, true];
    const volumeExists = vi.fn(async () => {
      return presence.length > 1 ? presence.shift()! : presence[0]!;
    });
    const { now, delay } = fakeClock();

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile: async () => {},
      volumeExists,
      now,
      delay,
      msdSettleMs: 0,
      msdRemountTimeoutMs: 10_000,
      msdRemountPollMs: 100,
    });

    expect(result).toEqual({ status: "ok", method: "msd" });
    // The poll actually ran through the disappear/reappear sequence
    // (four checks: present, gone, gone, present-again) rather than
    // resolving on the very first (pre-disappear) check.
    expect(volumeExists.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("reports resetting before the remount poll resolves, and only reports done once it does", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });
    const phases: FlashPhase[] = [];
    const presence = [false, true];
    const volumeExists = async () => (presence.length > 1 ? presence.shift()! : presence[0]!);
    const { now, delay } = fakeClock();

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, (phase) => phases.push(phase), {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile: async () => {},
      volumeExists,
      now,
      delay,
      msdSettleMs: 0,
      msdRemountTimeoutMs: 10_000,
      msdRemountPollMs: 50,
    });

    expect(result).toEqual({ status: "ok", method: "msd" });
    expect(phases).toEqual(["writing", "resetting"]);
  });

  it("still reports success (best-effort) if the volume is never observed to disappear/reappear within the remount budget", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        connect: async () => {
          throw new Error("mock: attach failed");
        },
      });
    // Always present -- this fake board's volume is never observed to
    // go away at all, e.g. because the poll interval is too coarse to
    // catch a very fast remount cycle.
    const volumeExists = vi.fn(async () => true);
    const { now, delay } = fakeClock();

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath: async () => "/Volumes/MICROBIT1",
      writeFile: async () => {},
      volumeExists,
      now,
      delay,
      msdSettleMs: 0,
      msdRemountTimeoutMs: 1_000,
      msdRemountPollMs: 100,
    });

    expect(result).toEqual({ status: "ok", method: "msd" });
    expect(volumeExists.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not attempt a fallback on a successful-but-slow SWD write", async () => {
    const resolveVolumePath = vi.fn();
    const createDapLink = () =>
      createFakeDapLink({
        flash: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      resolveVolumePath,
    });

    expect(result).toEqual({ status: "ok", method: "swd" });
    expect(resolveVolumePath).not.toHaveBeenCalled();
  });

  it("classifies a wedged daplink.flash() as a timeout, forwarding flashTimeoutMs through to flashViaDapLink", async () => {
    const createDapLink = () =>
      createFakeDapLink({
        flash: () => new Promise<void>(() => {}),
      });

    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink,
      flashTimeoutMs: 15,
      resolveVolumePath: async () => undefined,
    });

    expect(result).toMatchObject({ status: "error", method: "swd", reason: "timeout" });
  });

  it("forwards flashIdleTimeoutMs through to flashViaDapLink", async () => {
    const result = await flash(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => createFakeDapLink({ flash: () => new Promise<void>(() => {}) }),
      flashIdleTimeoutMs: 15,
      resolveVolumePath: async () => undefined,
    });

    expect(result).toEqual({
      status: "error",
      method: "swd",
      reason: "timeout",
      error: "daplink.flash() made no progress for 15 ms",
    });
  });
});
