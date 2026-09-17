/**
 * mbflashClient.test.ts — ticket 018-014's own suite for the mbdeploy
 * `_mbflash._tcp` client. Every test drives a real loopback
 * `net.createServer` (port 0, closed in `afterEach`) speaking just
 * enough of the documented wire protocol for each scenario — never a
 * mocked socket — mirroring `mbserialEndToEnd.test.ts`'s own "a real
 * loopback server, not a mock" precedent for this codebase's TCP
 * clients.
 *
 * The fake server below is deliberately dumb: it parses only the
 * `FLASH <nbytes> sha256=<hex>` line (to know how many raw bytes follow
 * it) and otherwise just plays back whatever canned response text a
 * test hands it, at whatever stage the test asks for (right after the
 * `FLASH` line, or only once the full payload has arrived) -- exactly
 * the seam this module's own protocol needs exercised.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import {
  DEFAULT_MBFLASH_LINE_TIMEOUT_MS,
  flashOverMbflash,
  mbflashInfo,
  type MbflashOutcome,
} from "./mbflashClient.js";

// ---------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------

interface FlashLineEvent {
  socket: Socket;
  line: string;
  nbytes: number;
  sha256: string;
}

interface FakeServerScenario {
  /** Called once per connection, as soon as the `FLASH ...`/`INFO` line
   * has been parsed off the wire. For a `FLASH` line, return the text to
   * write back immediately (e.g. `"OK send\n"` or an `ERR ...\n` line);
   * return `undefined` to write nothing at this stage (used by the
   * timeout scenarios, and by the sha-mismatch scenario which only
   * replies once the payload has fully arrived). For a plain `INFO`
   * line (no `FLASH` prefix), always reply immediately regardless of
   * this return value's own timing assumptions -- `onInfoLine` (below)
   * is the seam for that instead. */
  onFlashLine?: (event: FlashLineEvent) => string | undefined;
  /** Called once the declared `nbytes` of payload have fully arrived
   * (only reached when `onFlashLine` returned `"OK send\n"`). Return the
   * text to write back (`"LOG ...\nOK flashed\n"`, an `ERR ...\n` line,
   * ...), or `undefined` to write nothing (the payload-then-timeout
   * scenario). */
  onPayload?: (socket: Socket, payload: Buffer) => string | undefined;
  /** Called for a plain `INFO\n` line. Defaults to nothing (the FLASH-
   * only scenarios never send INFO). */
  onInfo?: (socket: Socket) => string | undefined;
}

function startFakeServer(scenario: FakeServerScenario): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let stage: "await-line" | "await-payload" | "done" = "await-line";
      let expectedBytes = 0;

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (stage === "await-line") {
          const idx = buffer.indexOf("\n");
          if (idx === -1) {
            return;
          }
          const line = buffer.slice(0, idx).toString("utf-8").replace(/\r$/, "");
          buffer = buffer.subarray(idx + 1);

          if (line === "INFO") {
            stage = "done";
            const reply = scenario.onInfo?.(socket);
            if (reply !== undefined) {
              socket.write(reply);
            }
            return;
          }

          const match = /^FLASH (\d+) sha256=([0-9a-f]+)$/.exec(line);
          const nbytes = match?.[1] !== undefined ? Number(match[1]) : 0;
          const sha256 = match?.[2] ?? "";
          expectedBytes = nbytes;
          stage = "await-payload";
          const reply = scenario.onFlashLine?.({ socket, line, nbytes, sha256 });
          if (reply !== undefined) {
            socket.write(reply);
          }
          if (reply !== "OK send\n") {
            // Anything other than "OK send" ends the exchange -- no
            // payload is expected to follow (mirrors the real daemon
            // refusing before ever reading bytes).
            stage = "done";
          }
        }

        if (stage === "await-payload" && buffer.length >= expectedBytes) {
          const payload = buffer.subarray(0, expectedBytes);
          buffer = buffer.subarray(expectedBytes);
          stage = "done";
          const reply = scenario.onPayload?.(socket, payload);
          if (reply !== undefined) {
            socket.write(reply);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) {
      await close();
    }
  }
});

async function server(scenario: FakeServerScenario): Promise<{ port: number }> {
  const s = await startFakeServer(scenario);
  closers.push(s.close);
  return { port: s.port };
}

const HEX_BYTES = Buffer.from(":020000040000FA\n:00000001FF\n", "utf-8");
const HEX_SHA256 = createHash("sha256").update(HEX_BYTES).digest("hex");

// ---------------------------------------------------------------------
// flashOverMbflash: success path
// ---------------------------------------------------------------------

describe("mbflashClient: flashOverMbflash success path", () => {
  it("sends FLASH with the correct nbytes/sha256, then the raw bytes, reports LOG lines as progress, and resolves ok on OK flashed", async () => {
    let observedNbytes = -1;
    let observedSha = "";
    let observedPayload: Buffer | undefined;
    const { port } = await server({
      onFlashLine: (event) => {
        observedNbytes = event.nbytes;
        observedSha = event.sha256;
        return "OK send\n";
      },
      onPayload: (_socket, payload) => {
        observedPayload = Buffer.from(payload);
        return "LOG erasing\nLOG writing page 1\nOK flashed\n";
      },
    });

    const progressLines: string[] = [];
    const outcome = await flashOverMbflash(
      { host: "127.0.0.1", port },
      HEX_BYTES,
      (line) => progressLines.push(line),
    );

    expect(outcome).toEqual<MbflashOutcome>({ status: "ok" });
    expect(observedNbytes).toBe(HEX_BYTES.length);
    expect(observedSha).toBe(HEX_SHA256);
    expect(observedPayload?.equals(HEX_BYTES)).toBe(true);
    expect(progressLines).toEqual(["LOG erasing", "LOG writing page 1"]);
  });
});

// ---------------------------------------------------------------------
// flashOverMbflash: each documented ERR line
// ---------------------------------------------------------------------

describe("mbflashClient: flashOverMbflash ERR classification", () => {
  it("ERR busy -- refused before any bytes are sent", async () => {
    const { port } = await server({ onFlashLine: () => "ERR busy\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "busy" });
    expect((outcome as { error: string }).error).toContain("ERR busy");
  });

  it("ERR relay refused — send force-relay", async () => {
    const { port } = await server({ onFlashLine: () => "ERR relay refused -- send force-relay\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "relay-refused" });
  });

  it("ERR flash disabled", async () => {
    const { port } = await server({ onFlashLine: () => "ERR flash disabled\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "flash-disabled" });
  });

  it("ERR short payload", async () => {
    const { port } = await server({ onFlashLine: () => "ERR short payload\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "short-payload" });
  });

  it("ERR auth required", async () => {
    const { port } = await server({ onFlashLine: () => "ERR auth required\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "auth-required" });
  });

  it("ERR sha256 mismatch -- reported only after the full payload has been sent", async () => {
    let payloadReceived = false;
    const { port } = await server({
      onFlashLine: () => "OK send\n",
      onPayload: () => {
        payloadReceived = true;
        return "ERR sha256 mismatch\n";
      },
    });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(payloadReceived).toBe(true);
    expect(outcome).toMatchObject({ status: "error", reason: "sha-mismatch" });
  });

  it("an unrecognized ERR line classifies as protocol, not silently as one of the known reasons", async () => {
    const { port } = await server({ onFlashLine: () => "ERR something this client has never heard of\n" });
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "protocol" });
  });
});

// ---------------------------------------------------------------------
// flashOverMbflash: timeout + one retry
// ---------------------------------------------------------------------

describe("mbflashClient: flashOverMbflash timeout + retry", () => {
  it("a read timeout on the first attempt is retried once, and the retry succeeds", async () => {
    let connectionCount = 0;
    const { port } = await server({
      onFlashLine: () => {
        connectionCount += 1;
        if (connectionCount === 1) {
          // First connection: never reply -- the client's own
          // lineTimeoutMs below fires while waiting for "OK send".
          return undefined;
        }
        return "OK send\n";
      },
      onPayload: () => "LOG writing\nOK flashed\n",
    });

    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {}, {
      lineTimeoutMs: 50,
    });

    expect(connectionCount).toBe(2);
    expect(outcome).toEqual<MbflashOutcome>({ status: "ok" });
  });

  it("a read timeout on the retry too is reported with the known 'board may be left without firmware' note", async () => {
    const { port } = await server({ onFlashLine: () => undefined });

    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {}, {
      lineTimeoutMs: 50,
    });

    expect(outcome).toMatchObject({ status: "error", reason: "timeout" });
    expect((outcome as { error: string }).error.toLowerCase()).toContain("without firmware");
  });

  it("a non-timeout failure (e.g. ERR busy) is never retried", async () => {
    let connectionCount = 0;
    const { port } = await server({
      onFlashLine: () => {
        connectionCount += 1;
        return "ERR busy\n";
      },
    });

    const outcome = await flashOverMbflash({ host: "127.0.0.1", port }, HEX_BYTES, () => {});

    expect(connectionCount).toBe(1);
    expect(outcome).toMatchObject({ status: "error", reason: "busy" });
  });
});

// ---------------------------------------------------------------------
// flashOverMbflash: connection failure
// ---------------------------------------------------------------------

describe("mbflashClient: connection failure", () => {
  it("nothing listening on the target port fails plainly with reason 'connection', never throws", async () => {
    // Port 1 is a real, almost-certainly-closed low port -- ECONNREFUSED
    // arrives quickly, no server to spin up or tear down for this case.
    const outcome = await flashOverMbflash({ host: "127.0.0.1", port: 1 }, HEX_BYTES, () => {});
    expect(outcome).toMatchObject({ status: "error", reason: "connection" });
  });
});

// ---------------------------------------------------------------------
// mbflashInfo
// ---------------------------------------------------------------------

describe("mbflashClient: mbflashInfo", () => {
  // Manually verified against a real farm board (tigez on magni.local,
  // 2026-09-13, INFO probed read-only per this ticket's own safety
  // note) -- this is the exact reply text observed.
  const REAL_TIGEZ_REPLY =
    'OK {"uid": "99063602000528203b43773cab0210ea000000006e052820", "board_name": "tigez", "role": "NEZHA2", "port": "/dev/ttyACM0", "connected": true}\n';

  it("parses OK {json} into { ok: true, info }", async () => {
    const { port } = await server({ onInfo: () => REAL_TIGEZ_REPLY });
    const result = await mbflashInfo({ host: "127.0.0.1", port });
    expect(result).toEqual({
      ok: true,
      info: {
        uid: "99063602000528203b43773cab0210ea000000006e052820",
        board_name: "tigez",
        role: "NEZHA2",
        port: "/dev/ttyACM0",
        connected: true,
      },
    });
  });

  it("a reply that isn't 'OK ...' at all comes back as { ok: false }, not a throw", async () => {
    const { port } = await server({ onInfo: () => "ERR not identified\n" });
    const result = await mbflashInfo({ host: "127.0.0.1", port });
    expect(result.ok).toBe(false);
  });

  it("a reply whose JSON is malformed comes back as { ok: false }, not a throw", async () => {
    const { port } = await server({ onInfo: () => "OK {not valid json\n" });
    const result = await mbflashInfo({ host: "127.0.0.1", port });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------

describe("mbflashClient: default timeouts", () => {
  it("the default line timeout sits within the protocol's own documented ~30-90s range", () => {
    expect(DEFAULT_MBFLASH_LINE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_MBFLASH_LINE_TIMEOUT_MS).toBeLessThanOrEqual(90_000);
  });
});
