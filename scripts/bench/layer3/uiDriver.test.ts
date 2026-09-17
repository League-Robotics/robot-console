import { describe, expect, it } from "vitest";
import { connectionLabelMatchesPath, directPathLabelPrefix, isIdReplyLine, isRawIdLeak, isRelayStatusReplyLine, looksLinked, parseRelayPoolName } from "./uiDriver.js";

describe("parseRelayPoolName", () => {
  it("extracts the pool name from a radio-via-mbrelay path", () => {
    expect(parseRelayPoolName("radio-via-mbrelay:torture")).toBe("torture");
  });

  it("returns undefined for a direct transport path", () => {
    expect(parseRelayPoolName("usb")).toBeUndefined();
    expect(parseRelayPoolName("mbserial")).toBeUndefined();
    expect(parseRelayPoolName("wifi")).toBeUndefined();
  });
});

describe("directPathLabelPrefix", () => {
  it("maps each direct transport to its connectionLabel() prefix", () => {
    expect(directPathLabelPrefix("usb")).toBe("USB");
    expect(directPathLabelPrefix("mbserial")).toBe("mbserial");
    expect(directPathLabelPrefix("wifi")).toBe("WiFi");
  });

  it("returns undefined for a relay path", () => {
    expect(directPathLabelPrefix("radio-via-mbrelay:torture")).toBeUndefined();
  });
});

describe("isRawIdLeak", () => {
  it("is undefined for clean, plain-language card text", () => {
    expect(isRawIdLeak("Couldn't connect: no banner within the identify budget")).toBeUndefined();
  });

  it("flags a 'connector:' prefix leak", () => {
    expect(isRawIdLeak('Couldn\'t connect: connector: link "usb-9906E2E782" produced no banner')).toBe("connector:");
  });

  it("flags a 'relayBridger:' prefix leak", () => {
    expect(isRawIdLeak("relayBridger: candidate rejected")).toBe("relayBridger:");
  });

  it('flags a link "..." quoted internal id', () => {
    expect(isRawIdLeak('failed via link "mbserial-tigez"')).toBe('link "');
  });

  it('flags a candidate "..." quoted internal id', () => {
    expect(isRawIdLeak('candidate "radio-gopiv-via-mbrelay-torture" rejected')).toBe('candidate "');
  });

  it("flags a raw usb-9906 serial-prefixed id", () => {
    expect(isRawIdLeak("attached to usb-9906E2E782")).toBe("usb-9906");
  });
});

describe("looksLinked", () => {
  it("is true when the header text contains the word Linked", () => {
    expect(looksLinked("gopiv Linked mbserial · loki.local:37317")).toBe(true);
  });

  it("is true even when 'Linked' is glued directly onto adjacent text with no whitespace -- innerText() across sibling spans concatenates with nothing between them (live 018-003 finding: 'mbserial · loki.local:36627Linked')", () => {
    expect(looksLinked("mbserial · loki.local:36627Linked")).toBe(true);
  });

  it("is false for 'Not connected' / 'connecting' style text", () => {
    expect(looksLinked("gopiv Not connected")).toBe(false);
    expect(looksLinked("gopiv Connecting…")).toBe(false);
  });
});

describe("isIdReplyLine", () => {
  it("recognizes a genuine rx id reply line (« prefix, DeviceConsole.tsx's own direction glyph)", () => {
    expect(isIdReplyLine("«id diffdrive calibration-0.20260913.1 1.20260912.8 gopiv")).toBe(true);
  });

  it("does not mistake the echoed tx 'ID' line for a reply", () => {
    expect(isIdReplyLine("»ID")).toBe(false);
  });

  it("does not match unrelated console chatter", () => {
    expect(isIdReplyLine("«DBG:wifi something")).toBe(false);
  });
});

// 018-004: a relay has no `ID` verb -- probed with `?` instead, and its
// own status reply (not an "id ..." reply, and not a second HELLO
// banner either -- see isRelayStatusReplyLine's own doc comment) is the
// expected match.
// 018-007 Step 0: this harness's own regression guard for the bug this
// ticket fixed -- Layer 3 used to click a device card's top-level arrow
// (the device's "primary" link) rather than the exact link resolved for
// the path under test, so a radio check could silently land on and pass
// an already-usable mbserial link instead (live bench evidence: header
// read "mbserial · loki.local:36627 · Linked" while the report recorded
// a radio-via-mbrelay PASS).
describe("connectionLabelMatchesPath", () => {
  it("matches a direct wifi label", () => {
    expect(connectionLabelMatchesPath("WiFi · 192.168.1.193:7654", "wifi")).toBe(true);
  });

  it("matches a direct mbserial label", () => {
    expect(connectionLabelMatchesPath("mbserial · loki.local:36627", "mbserial")).toBe(true);
  });

  it("matches a direct usb label", () => {
    expect(connectionLabelMatchesPath("USB · /dev/cu.usbmodem1234", "usb")).toBe(true);
  });

  it("matches a radio-via-relay label naming the right pool", () => {
    expect(connectionLabelMatchesPath("Radio · ch47/grp60 (via relay torture)", "radio-via-mbrelay:torture")).toBe(true);
  });

  it("rejects a radio label naming a different pool", () => {
    expect(connectionLabelMatchesPath("Radio · ch47/grp60 (via relay magni)", "radio-via-mbrelay:torture")).toBe(false);
  });

  it("rejects the exact live-verified 018-007 mismatch: on mbserial while radio was expected", () => {
    expect(connectionLabelMatchesPath("mbserial · loki.local:36627", "radio-via-mbrelay:torture")).toBe(false);
  });

  it("rejects a direct label whose prefix doesn't match the path", () => {
    expect(connectionLabelMatchesPath("WiFi · 192.168.1.193:7654", "mbserial")).toBe(false);
  });

  it("rejects a direct-shaped label for a radio path (missing the via-relay suffix)", () => {
    expect(connectionLabelMatchesPath("Radio · ch47/grp60", "radio-via-mbrelay:torture")).toBe(false);
  });
});

describe("isRelayStatusReplyLine", () => {
  it("recognizes a genuine rx relay status reply line (« prefix)", () => {
    expect(isRelayStatusReplyLine("«# channel: 0 group: 10 mode: RAW250 power: 7")).toBe(true);
  });

  it("does not mistake the echoed tx '?' line for a reply", () => {
    expect(isRelayStatusReplyLine("»?")).toBe(false);
  });

  it("does not match an id reply, a HELLO banner, or unrelated console chatter", () => {
    expect(isRelayStatusReplyLine("«id gopiv NEZHA2 v1.2.3")).toBe(false);
    expect(isRelayStatusReplyLine("«DEVICE:RADIOBRIDGE:relay:vitut:2198604104")).toBe(false);
    expect(isRelayStatusReplyLine("«DBG:wifi something")).toBe(false);
  });
});
