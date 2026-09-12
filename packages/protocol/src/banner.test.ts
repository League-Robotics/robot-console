import { describe, expect, it } from "vitest";
import { bannerNameMatchesSerial, parseBanner } from "./banner.js";
import { deviceIdToName } from "./naming.js";

describe("parseBanner", () => {
  it("parses the colon-form RADIOBRIDGE example with a decimal serial", () => {
    // Serial chosen so deviceIdToName(1779042365) === "getez" -- the
    // fixture is internally consistent (see bannerNameMatchesSerial's
    // own tests below), unlike the previous 1779042496 value, which
    // named a different device ("gatav").
    const result = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042365");
    expect(result).toEqual({
      role: "RADIOBRIDGE",
      commonName: "relay",
      name: "getez",
      serial: 1779042365,
      dialect: "colon",
      raw: "DEVICE:RADIOBRIDGE:relay:getez:1779042365",
    });
  });

  it("parses a legacy colon-form RADIORELAY example with a hexadecimal serial", () => {
    // Same physical FICR.DEVICEID[1] value as the RADIOBRIDGE example
    // above (1779042365 decimal), but legacy MakeCode relay firmware
    // prints it in hex instead.
    const result = parseBanner("DEVICE:RADIORELAY:relay:getez:6a0a083d");
    expect(result).toEqual({
      role: "RADIORELAY",
      commonName: "relay",
      name: "getez",
      serial: 0x6a0a083d,
      dialect: "colon",
      raw: "DEVICE:RADIORELAY:relay:getez:6a0a083d",
    });
    expect(result?.serial).toBe(1779042365);
  });

  it("parses the space-form NEZHA2 example with a decimal serial", () => {
    const result = parseBanner("device NEZHA2 robot vevov 1198504156");
    expect(result).toEqual({
      role: "NEZHA2",
      commonName: "robot",
      name: "vevov",
      serial: 1198504156,
      dialect: "space",
      raw: "device NEZHA2 robot vevov 1198504156",
    });
  });

  it("produces the same shaped output for both dialects", () => {
    const colon = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    const space = parseBanner("device NEZHA2 robot vevov 1198504156");
    expect(colon && Object.keys(colon).sort()).toEqual(
      space && Object.keys(space).sort(),
    );
  });

  it("parses an unrecognized role rather than rejecting it, defaulting to decimal", () => {
    const result = parseBanner("DEVICE:RADIOTHING2:relay:qzxty:42");
    expect(result).toEqual({
      role: "RADIOTHING2",
      commonName: "relay",
      name: "qzxty",
      serial: 42,
      dialect: "colon",
      raw: "DEVICE:RADIOTHING2:relay:qzxty:42",
    });
  });

  it("returns null for a line matching neither grammar", () => {
    expect(parseBanner("not a banner at all")).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseBanner("")).toBeNull();
  });

  it("returns null for a colon-form line missing fields", () => {
    expect(parseBanner("DEVICE:RADIOBRIDGE:relay:getez")).toBeNull();
  });

  it("returns null for a colon-form line with a non-hex serial token", () => {
    expect(parseBanner("DEVICE:RADIOBRIDGE:relay:getez:not-a-number")).toBeNull();
  });

  it("returns null for an uppercase space-form sentinel (DEVICE is the colon sentinel only)", () => {
    expect(parseBanner("DEVICE NEZHA2 robot vevov 1198504156")).toBeNull();
  });

  it("returns null for a space-form line missing fields", () => {
    expect(parseBanner("device NEZHA2 robot vevov")).toBeNull();
  });
});

describe("bannerNameMatchesSerial", () => {
  it("is true for the (fixed) RADIOBRIDGE fixture -- name and serial now agree", () => {
    const banner = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042365");
    expect(banner).not.toBeNull();
    expect(bannerNameMatchesSerial(banner!)).toBe(true);
  });

  it("is true for the RADIORELAY (hex-serial) fixture", () => {
    const banner = parseBanner("DEVICE:RADIORELAY:relay:getez:6a0a083d");
    expect(banner).not.toBeNull();
    expect(bannerNameMatchesSerial(banner!)).toBe(true);
  });

  it("is true for the NEZHA2 (space-form) fixture", () => {
    const banner = parseBanner("device NEZHA2 robot vevov 1198504156");
    expect(banner).not.toBeNull();
    expect(bannerNameMatchesSerial(banner!)).toBe(true);
  });

  it("is false when name and serial disagree (a mis-radixed serial, the bug this catches)", () => {
    // 1779042496 -> deviceIdToName gives a different name than "getez"
    // (this was the previous, inconsistent RADIOBRIDGE fixture value).
    const banner = parseBanner("DEVICE:RADIOBRIDGE:relay:getez:1779042496");
    expect(banner).not.toBeNull();
    expect(bannerNameMatchesSerial(banner!)).toBe(false);
    expect(deviceIdToName(1779042496)).not.toBe("getez");
  });
});
