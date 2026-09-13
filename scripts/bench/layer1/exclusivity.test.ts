import { describe, expect, it } from "vitest";
import { describeHolders, evaluateExclusivity, findHolders, type LsofRunner } from "./exclusivity.js";

// Captured real `lsof` output shapes (2026-09-13 bench, this ticket's own
// live evidence run) -- see this ticket's completion notes for the
// unmodified capture these fixtures are drawn from.

const SERIAL_HELD = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    82496 eric   39u   CHR    9,7 0t134275 1969 /dev/cu.usbmodem2121102`;

const SERIAL_FREE_HEADER_ONLY = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME`;

const TCP_ESTABLISHED = `COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      82496 eric   23u  IPv4 0x1234567890abcdef      0t0  TCP 192.168.1.50:54321->192.168.1.193:7654 (ESTABLISHED)
claude      285 eric    7u  IPv4 0xe3dc3174550857e6      0t0  TCP 192.168.1.40:64625->160.79.104.10:443 (ESTABLISHED)`;

function scriptedLsof(byArgs: Record<string, string>): LsofRunner {
  return async (args: string[]) => {
    const key = args.join(" ");
    if (!(key in byArgs)) {
      throw new Error(`unexpected lsof invocation: ${key}`);
    }
    return byArgs[key]!;
  };
}

describe("findHolders", () => {
  it("reports the process holding a serial device", async () => {
    const runLsof = scriptedLsof({ "/dev/cu.usbmodem2121102": SERIAL_HELD });
    const holders = await findHolders([{ kind: "serial", path: "/dev/cu.usbmodem2121102" }], runLsof, 1);
    expect(holders).toEqual([{ resource: "/dev/cu.usbmodem2121102", pid: 82496, command: "node" }]);
  });

  it("reports no holders for a free serial device (header-only lsof output)", async () => {
    const runLsof = scriptedLsof({ "/dev/cu.usbmodem2121202": SERIAL_FREE_HEADER_ONLY });
    const holders = await findHolders([{ kind: "serial", path: "/dev/cu.usbmodem2121202" }], runLsof, 1);
    expect(holders).toEqual([]);
  });

  it("reports no holders for a free serial device (empty lsof output, lsof's own exit-1 case)", async () => {
    const runLsof = scriptedLsof({ "/dev/cu.usbmodem2121402": "" });
    const holders = await findHolders([{ kind: "serial", path: "/dev/cu.usbmodem2121402" }], runLsof, 1);
    expect(holders).toEqual([]);
  });

  it("matches an established TCP connection by remote host:port only", async () => {
    const runLsof = scriptedLsof({ "-nP -iTCP -sTCP:ESTABLISHED": TCP_ESTABLISHED });
    const holders = await findHolders(
      [{ kind: "tcp", host: "192.168.1.193", port: 7654 }],
      runLsof,
      1,
    );
    expect(holders).toEqual([{ resource: "192.168.1.193:7654", pid: 82496, command: "node" }]);
  });

  it("ignores established connections that do not match any requested endpoint", async () => {
    const runLsof = scriptedLsof({ "-nP -iTCP -sTCP:ESTABLISHED": TCP_ESTABLISHED });
    const holders = await findHolders(
      [{ kind: "tcp", host: "10.0.0.1", port: 9999 }],
      runLsof,
      1,
    );
    expect(holders).toEqual([]);
  });

  it("excludes the harness's own pid from the holder list", async () => {
    const runLsof = scriptedLsof({ "/dev/cu.usbmodem2121102": SERIAL_HELD });
    const holders = await findHolders(
      [{ kind: "serial", path: "/dev/cu.usbmodem2121102" }],
      runLsof,
      82496,
    );
    expect(holders).toEqual([]);
  });

  it("issues exactly one lsof call for all TCP resources combined, and one per serial path", async () => {
    let tcpCalls = 0;
    let serialCalls = 0;
    const runLsof: LsofRunner = async (args) => {
      if (args[0] === "-nP") {
        tcpCalls += 1;
        return TCP_ESTABLISHED;
      }
      serialCalls += 1;
      return SERIAL_HELD;
    };
    await findHolders(
      [
        { kind: "serial", path: "/dev/cu.usbmodem2121102" },
        { kind: "serial", path: "/dev/cu.usbmodem2121202" },
        { kind: "tcp", host: "192.168.1.193", port: 7654 },
        { kind: "tcp", host: "loki.local", port: 36627 },
      ],
      runLsof,
      1,
    );
    expect(tcpCalls).toBe(1);
    expect(serialCalls).toBe(2);
  });
});

describe("evaluateExclusivity", () => {
  const holders = [{ resource: "/dev/cu.usbmodem2121102", pid: 82496, command: "node" }];

  it("refuses by default when any holder is found", () => {
    const outcome = evaluateExclusivity(holders, false);
    expect(outcome.refuse).toBe(true);
    expect(outcome.skipped).toEqual([]);
  });

  it("never refuses with --skip-held, and reports skipped resources instead", () => {
    const outcome = evaluateExclusivity(holders, true);
    expect(outcome.refuse).toBe(false);
    expect(outcome.skipped).toEqual([
      { resource: "/dev/cu.usbmodem2121102", reason: "held by pid 82496 (node)" },
    ]);
  });

  it("never refuses with no holders, flag either way", () => {
    expect(evaluateExclusivity([], false).refuse).toBe(false);
    expect(evaluateExclusivity([], true).refuse).toBe(false);
  });
});

describe("describeHolders", () => {
  it("names each holder's resource, pid, and command on its own line", () => {
    const message = describeHolders([
      { resource: "/dev/cu.usbmodem2121102", pid: 82496, command: "node" },
      { resource: "loki.local:36627", pid: 100, command: "npm" },
    ]);
    expect(message).toBe(
      "/dev/cu.usbmodem2121102 held by pid 82496 (node)\nloki.local:36627 held by pid 100 (npm)",
    );
  });
});
