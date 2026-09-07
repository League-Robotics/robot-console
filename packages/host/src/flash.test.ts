import { describe, expect, it, vi } from "vitest";
import DapJs from "dapjs";
import type { DAPLink } from "dapjs";
import {
  extractV2Hex,
  flash,
  flashOverSwd,
  flashViaMsd,
  isUniversalHex,
  isValidIntelHexText,
} from "./flash.js";
import type { FlashPhase } from "./flash.js";
import type { DaplinkDevice } from "./devices.js";

// Per the ticket's Testing section: no micro:bit running cooperating
// firmware (or any board at all) is available this sprint, and no board
// can be flashed. `isUniversalHex`/`extractV2Hex`/`isValidIntelHexText`
// are pure data transformation and are tested thoroughly here against
// synthetic fixtures -- this is the part that is genuinely proven.
//
// `flashOverSwd`'s own describe block below stays narrow -- factory-seam
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

describe("flashOverSwd", () => {
  // Seam-level only, per this ticket's explicit precedent (see this
  // file's top doc comment) -- mirrors `swdName.test.ts`'s own
  // `CortexMFactory` coverage exactly.

  it("reports a classified failure without calling the factory when no HID path is available", async () => {
    const createDapLink = vi.fn();
    const result = await flashOverSwd(device({ hid: {} }), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
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
    const result = await flashOverSwd(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
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
    const result = await flashOverSwd(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
      createDapLink: () => {
        throw new Error("EACCES: permission denied opening HID device");
      },
    });
    expect(result).toMatchObject({ status: "error", reason: "permission" });
  });

  it("never rejects the returned promise even when the factory throws synchronously", async () => {
    await expect(
      flashOverSwd(device(), PLAIN_INTEL_HEX_FIXTURE, () => {}, {
        createDapLink: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ status: "error" });
  });
});

/** A fake satisfying only the `DAPLink` surface `flashOverSwd` actually
 * calls (`connect`, `on`, `off`, `flash`, `disconnect`) -- not a
 * simulation of real `dapjs`/hardware behavior. The default `flash`
 * implementation fires one registered `EVENT_PROGRESS` listener before
 * resolving, so tests can observe the `"writing"` phase callback the
 * same way a real `DAPLink#flash()` call would trigger it. */
function createFakeDapLink(overrides?: {
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  flash?: (buffer: Buffer) => Promise<void>;
}): DAPLink {
  const progressListeners: Array<() => void> = [];
  const fake = {
    connect: overrides?.connect ?? (async () => {}),
    disconnect: overrides?.disconnect ?? (async () => {}),
    on(event: string, listener: () => void) {
      if (event === DapJs.DAPLink.EVENT_PROGRESS) {
        progressListeners.push(listener);
      }
      return fake;
    },
    off(event: string, listener: () => void) {
      if (event === DapJs.DAPLink.EVENT_PROGRESS) {
        const index = progressListeners.indexOf(listener);
        if (index >= 0) {
          progressListeners.splice(index, 1);
        }
      }
      return fake;
    },
    flash:
      overrides?.flash ??
      (async () => {
        for (const listener of progressListeners) {
          listener();
        }
      }),
  };
  return fake as unknown as DAPLink;
}

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
    });

    expect(result).toEqual({
      status: "error",
      method: "msd",
      reason: "write-failed",
      error: expect.stringContaining("ENOSPC"),
    });
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
});
