import { describe, expect, it, vi } from "vitest";
import { deviceIdToName } from "@robot-console/protocol";
import { FICR_DEVICEID1, readSwdName, swdNameResultFromDeviceId } from "./swdName.js";
import type { CortexM } from "./vendor/dapjs/index.js";
import type { DaplinkDevice } from "./devices.js";

// Per the ticket's Testing section: the SWD read itself is a thin wrapper
// around real hardware access and is not meaningfully unit-testable
// without a physical DAPLink device (see this sprint's hardware smoke
// test, recorded in the ticket, for that coverage). What *is*
// unit-testable here is the narrow, pure hand-off from a raw register
// value to a name/result, plus the error paths that don't require a real
// SWD read at all (no HID path; a failing `createCortexM`/`connect`).

describe("swdNameResultFromDeviceId", () => {
  it("hands the raw FICR.DEVICEID[1] value to naming.ts's codec unchanged", () => {
    // Worked example from naming.ts's own docstring / mbdeploy's
    // devices.py: 2314287040 -> "tovez".
    const result = swdNameResultFromDeviceId(2314287040);
    expect(result).toEqual({ status: "named", name: "tovez", deviceId: 2314287040 });
    expect(result.name).toBe(deviceIdToName(2314287040));
  });

  it("produces a well-formed five-letter name (consonant/vowel/consonant/vowel/consonant)", () => {
    const result = swdNameResultFromDeviceId(0x12345678);
    expect(result.status).toBe("named");
    expect(result.name).toMatch(/^[zvgpt][uoiea][zvgpt][uoiea][zvgpt]$/);
  });
});

describe("readSwdName", () => {
  function device(overrides: Partial<DaplinkDevice> = {}): DaplinkDevice {
    return {
      serialNumber: "9906360200052820aba2e384f40cfd6c000000006e052820",
      displaySerial: "aba2e384f40cfd6c",
      availability: "full",
      ...overrides,
    };
  }

  it("reports detected-but-unnamed with a distinct reason when no HID path is available", async () => {
    const result = await readSwdName(device({ hid: {} }));
    expect(result).toEqual({
      status: "unnamed",
      reason: "no-hid-path",
      error: expect.any(String),
    });
  });

  it("reports detected-but-unnamed with a distinct reason when device.hid itself is absent", async () => {
    const result = await readSwdName(device());
    expect(result.status).toBe("unnamed");
    if (result.status === "unnamed") {
      expect(result.reason).toBe("no-hid-path");
    }
  });

  it("never throws, and reports attach-failed, when the transport/processor factory throws", async () => {
    const boom = new Error("mock: CMSIS-DAP open failed");
    const result = await readSwdName(device({ hid: { path: "IOHIDDevice@fake" } }), {
      createCortexM: () => {
        throw boom;
      },
    });
    expect(result).toEqual({
      status: "unnamed",
      reason: "attach-failed",
      error: boom.message,
    });
  });

  it("classifies a permission-flavored error message distinctly from a generic attach failure", async () => {
    const result = await readSwdName(device({ hid: { path: "IOHIDDevice@fake" } }), {
      createCortexM: () => {
        throw new Error("EACCES: permission denied opening HID device");
      },
    });
    expect(result).toMatchObject({ status: "unnamed", reason: "permission" });
  });

  it("never rejects the returned promise even when the factory throws synchronously", async () => {
    await expect(
      readSwdName(device({ hid: { path: "IOHIDDevice@fake" } }), {
        createCortexM: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toMatchObject({ status: "unnamed" });
  });

  // Sprint 017 ticket 003: `processor.connect()`/`readMem32()` are now
  // bound by `lib/withTimeout.ts`'s `withTimeout` -- a wedged transport
  // used to hang this call (and the naming `board_owner` slot) forever.

  it("classifies a wedged processor.connect() as a timeout, and still disconnects (the existing finally block)", async () => {
    const disconnect = vi.fn(async () => {});
    const fakeProcessor = {
      connect: () => new Promise<void>(() => {}),
      readMem32: vi.fn(),
      disconnect,
    } as unknown as CortexM;
    const result = await readSwdName(device({ hid: { path: "IOHIDDevice@fake" } }), {
      createCortexM: () => fakeProcessor,
      connectTimeoutMs: 15,
    });

    expect(result).toMatchObject({ status: "unnamed", reason: "timeout" });
    expect((result as { error: string }).error).toMatch(/processor\.connect\(\) timed out after 15ms/);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("classifies a wedged processor.readMem32() as a timeout, and still disconnects", async () => {
    const disconnect = vi.fn(async () => {});
    const fakeProcessor = {
      connect: async () => {},
      readMem32: () => new Promise<number>(() => {}),
      disconnect,
    } as unknown as CortexM;
    const result = await readSwdName(device({ hid: { path: "IOHIDDevice@fake" } }), {
      createCortexM: () => fakeProcessor,
      readTimeoutMs: 15,
    });

    expect(result).toMatchObject({ status: "unnamed", reason: "timeout" });
    expect((result as { error: string }).error).toMatch(/processor\.readMem32\(\) timed out after 15ms/);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("FICR_DEVICEID1", () => {
  it("is the documented FICR.DEVICEID[1] address", () => {
    expect(FICR_DEVICEID1).toBe(0x10000064);
  });
});
