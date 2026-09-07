import { describe, expect, it } from "vitest";
import { deviceIdToName } from "@robot-console/protocol";
import { FICR_DEVICEID1, readSwdName, swdNameResultFromDeviceId } from "./swdName.js";
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
});

describe("FICR_DEVICEID1", () => {
  it("is the documented FICR.DEVICEID[1] address", () => {
    expect(FICR_DEVICEID1).toBe(0x10000064);
  });
});
