/**
 * usbProbe.ts — Layer 1 raw probe for a directly USB-attached DAPLink
 * board: enumerate via `serialport` directly, open the port, send
 * `HELLO` (and, for a robot, `ID`; for a relay, `?` too — per the
 * ticket's own bench facts), capture the banner verbatim.
 *
 * ## Deliberately no SWD naming here
 *
 * `usbWatcher.ts`/`swdName.ts` read a board's five-letter name over SWD
 * via the vendored `dapjs` stack under `packages/host/src/vendor/
 * dapjs/` — that is host-internal code this harness's own plan
 * explicitly says not to import ("Layer 1 must exercise the wire, not
 * the host's code paths"), and duplicating a full SWD/CMSIS-DAP client
 * here would be a second, harder-to-maintain implementation of exactly
 * the thing this ticket is supposed to test independently of. Per the
 * ticket's own escape hatch ("record the USB serial number and rely on
 * the banner"), this probe identifies a board only by its USB serial
 * number (from `serialport.list()`) plus whatever name its own banner
 * announces over the wire — the same "no privileged shortcuts" posture
 * Layer 1 takes with every other transport.
 *
 * ## `tty.`/`cu.` callout path
 *
 * `serialport.list()` reports the `tty.` (dial-in) path on darwin; this
 * probe must open the `cu.` (callout) path instead, per the ticket's own
 * instruction and matching `devices.ts`'s `toCalloutPath` behavior
 * (duplicated here in miniature, not imported — same host-internals
 * boundary as above; {@link toCalloutPath} is a two-line string
 * transform, not meaningfully "shared logic" worth reaching into host
 * code for).
 *
 * ## Break-reset retry (018-002 Layer 1 gap #2)
 *
 * Live-verified 2026-09-13: a relay parked in its data plane (after a
 * host sent it `!GO`) forwards `HELLO` over radio instead of answering
 * it itself, so a USB probe against it times out waiting for a banner
 * — indistinguishable, from the wire alone, from a dead/misbehaving
 * board. Rather than report that ambiguity as a plain failure, this
 * probe performs **one** UART break-reset (`port.set({brk:true})` held
 * for {@link DEFAULT_BREAK_MS}, then `{brk:false}}` — the same primitive
 * `packages/host/src/link/adapters/serialStream.ts`'s `sendBreak`
 * uses, duplicated here in miniature per this module's own
 * host-internals boundary, not imported), waits
 * {@link DEFAULT_POST_BREAK_WAIT_MS} for the reset to take effect, then
 * retries `HELLO`/`?` exactly once more. The retry's outcome is
 * recorded as its own transcript segment (`dir: "info"` markers bracket
 * it) so a reader can see both the original timeout and what the reset
 * did, never silently overwriting one with the other.
 */
import { SerialPort } from "serialport";
import { parseBanner, parseIdReply, type ParsedBanner } from "@robot-console/protocol";
import { LineReassembler } from "./lineReassembler.js";
import type { PathResult, SerialProbeEndpoint, TranscriptLine } from "./types.js";

export const DAPLINK_VENDOR_ID = 0x0d28;
export const DAPLINK_PRODUCT_ID = 0x0204;

const DARWIN_TTY_PREFIX = "/dev/tty.";
const DARWIN_CU_PREFIX = "/dev/cu.";

/** darwin `tty.` -> `cu.` callout-path translation (see module doc
 * comment). A no-op on any other platform or for a path that is not
 * already `tty.`-prefixed. */
export function toCalloutPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin" || !path.startsWith(DARWIN_TTY_PREFIX)) {
    return path;
  }
  return DARWIN_CU_PREFIX + path.slice(DARWIN_TTY_PREFIX.length);
}

/** `serialport`'s `vendorId`/`productId` are lowercase-hex strings (or
 * `undefined`) -- compare numerically. */
function hexIdMatches(value: string | undefined, expected: number): boolean {
  return value !== undefined && Number.parseInt(value, 16) === expected;
}

/** The minimal slice of `SerialPort.list()`'s element type this module
 * needs -- narrower than `serialport`'s own `PortInfo` so a test fixture
 * only needs these fields. */
export interface SerialPortListingLike {
  path: string;
  // `| undefined` (not just `?`) on every optional field below matches
  // `serialport`'s own `PortInfo` shape exactly under
  // `exactOptionalPropertyTypes` -- that flag distinguishes "key may be
  // absent" from "key present, value may be undefined", and `PortInfo`
  // uses the latter for all four of these.
  vendorId?: string | undefined;
  productId?: string | undefined;
  serialNumber?: string | undefined;
  manufacturer?: string | undefined;
}

/** Filter a raw `serialport.list()` result down to DAPLink boards. Pure
 * — directly testable against a captured listing, independent of any
 * real USB enumeration. */
export function filterDaplinkPorts<T extends SerialPortListingLike>(ports: readonly T[]): T[] {
  return ports.filter((port) => hexIdMatches(port.vendorId, DAPLINK_VENDOR_ID) && hexIdMatches(port.productId, DAPLINK_PRODUCT_ID));
}

/** Injectable listing function — defaults to the real `serialport.list()`;
 * tests substitute a fixed array. */
export type ListSerialPortsFn = () => Promise<SerialPortListingLike[]>;

export async function listDaplinkPorts(list: ListSerialPortsFn = () => SerialPort.list()): Promise<SerialPortListingLike[]> {
  const all = await list();
  return filterDaplinkPorts(all);
}

export const DEFAULT_HELLO_TIMEOUT_MS = 3_000;
export const DEFAULT_ID_TIMEOUT_MS = 3_000;

/**
 * Minimal seam over a real (or faked) open serial port — deliberately
 * narrower than `serialport`'s own `SerialPort`, mirroring
 * `link/adapters/serialStream.ts`'s own `SerialPortLike` convention (not
 * imported — same host-internals boundary as the rest of this module).
 */
export interface UsbSerialPortLike {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  close(callback?: (err?: Error | null) => void): void;
  /** UART break-reset primitive (see this module's doc comment,
   * "Break-reset retry") — mirrors `serialport`'s own
   * `SerialPort.set({brk})`, which the real port already implements
   * (no wrapping needed for {@link defaultCreateSerialPort}'s cast). */
  set(options: { brk?: boolean }, callback?: (err?: Error | null) => void): void;
}

export type CreateSerialPortFn = (path: string, baudRate: number) => UsbSerialPortLike;

/** DAPLink CDC serial ports always run at this fixed baud rate (mirrors
 * `link/adapters/serialStream.ts`'s own `BAUD_RATE` — a fixed hardware
 * fact, not something worth importing host code for). */
export const DAPLINK_BAUD_RATE = 115_200;

function defaultCreateSerialPort(path: string, baudRate: number): UsbSerialPortLike {
  return new SerialPort({ path, baudRate }) as unknown as UsbSerialPortLike;
}

/** Injectable wait function for the break-reset retry's own delays —
 * tests substitute an instant resolver so the suite never actually
 * sleeps. Mirrors `link/pacing.ts`'s own `Scheduler.delay` shape in
 * miniature (not imported — same host-internals boundary as the rest
 * of this module). */
export type DelayFn = (ms: number) => Promise<void>;

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to hold the break condition asserted — matches
 * `serialStream.ts`'s own `DEFAULT_BREAK_MS`, duplicated here per this
 * module's host-internals boundary. */
export const DEFAULT_BREAK_MS = 250;

/** How long to wait after clearing the break condition before retrying
 * `HELLO`, per the ticket's own "~1.5s" instruction — long enough for a
 * relay's firmware to notice the reset pulse and drop back out of the
 * data plane before the retry is sent. */
export const DEFAULT_POST_BREAK_WAIT_MS = 1_500;

export interface UsbProbeOptions {
  helloTimeoutMs?: number;
  idTimeoutMs?: number;
  openTimeoutMs?: number;
  createPort?: CreateSerialPortFn;
  platform?: NodeJS.Platform;
  /** Break-reset retry tuning (018-002 Layer 1 gap #2) — see this
   * module's doc comment. */
  breakDurationMs?: number;
  postBreakWaitMs?: number;
  delay?: DelayFn;
}

/** Assert a UART break condition for `durationMs`, then clear it —
 * identical primitive to `serialStream.ts`'s own `sendBreak`, duplicated
 * here in miniature (see this module's host-internals boundary doc
 * comment). */
function sendBreak(port: UsbSerialPortLike, durationMs: number, delay: DelayFn): Promise<void> {
  return new Promise((resolve, reject) => {
    port.set({ brk: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      delay(durationMs).then(() => {
        port.set({ brk: false }, (err2) => (err2 ? reject(err2) : resolve()));
      }, reject);
    });
  });
}

/** Whether this board's banner identifies it as a relay (probed with
 * `?` in addition to `HELLO`, per the ticket's own instruction) or a
 * robot (probed with `ID`). Mirrors `deviceType.ts`'s own
 * `commonName`-first precedence in miniature — this harness only needs
 * the relay/robot split, not the full classification. */
function isRelayBanner(banner: ParsedBanner): boolean {
  return banner.commonName.toLowerCase() === "relay" || /^RADIO(BRIDGE|RELAY)$/i.test(banner.role);
}

/**
 * Open `port.path` directly (no host process, no watcher), send `HELLO`,
 * and — depending on what the banner says it is — either `ID` (robot)
 * or `?` (relay). Never sends a motion/drive verb, never flashes,
 * matching this ticket's own hard constraint.
 */
export async function probeUsb(port: SerialPortListingLike, options: UsbProbeOptions = {}): Promise<PathResult> {
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const idTimeoutMs = options.idTimeoutMs ?? DEFAULT_ID_TIMEOUT_MS;
  const openTimeoutMs = options.openTimeoutMs ?? 5000;
  const createPort = options.createPort ?? defaultCreateSerialPort;
  const breakDurationMs = options.breakDurationMs ?? DEFAULT_BREAK_MS;
  const postBreakWaitMs = options.postBreakWaitMs ?? DEFAULT_POST_BREAK_WAIT_MS;
  const delay = options.delay ?? realDelay;
  const calloutPath = toCalloutPath(port.path, options.platform);
  const endpoint: SerialProbeEndpoint = { serialPath: calloutPath };
  const startedAt = Date.now();
  const transcript: TranscriptLine[] = [];
  const record = (dir: TranscriptLine["dir"], line: string): void => {
    transcript.push({ t: Date.now() - startedAt, dir, line });
  };

  let serialPort: UsbSerialPortLike;
  try {
    serialPort = await new Promise<UsbSerialPortLike>((resolve, reject) => {
      const sp = createPort(calloutPath, DAPLINK_BAUD_RATE);
      const timer = setTimeout(() => reject(new Error(`open timed out after ${openTimeoutMs}ms`)), openTimeoutMs);
      sp.once("open", () => {
        clearTimeout(timer);
        resolve(sp);
      });
      sp.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } catch (error) {
    return {
      path: "usb",
      endpoint,
      status: "fail",
      reason: `failed to open ${calloutPath}: ${error instanceof Error ? error.message : String(error)}`,
      transcript,
    };
  }

  const reassembler = new LineReassembler();
  const lineWaiters = new Set<{ predicate: (line: string) => boolean; resolve: (line: string | undefined) => void }>();
  serialPort.on("data", (chunk: Buffer) => {
    for (const line of reassembler.push(chunk)) {
      record("rx", line);
      for (const waiter of [...lineWaiters]) {
        if (waiter.predicate(line)) {
          lineWaiters.delete(waiter);
          waiter.resolve(line);
        }
      }
    }
  });

  function waitForLine(predicate: (line: string) => boolean, timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve: (line: string | undefined) => resolve(line) };
      lineWaiters.add(waiter);
      setTimeout(() => {
        if (lineWaiters.delete(waiter)) {
          resolve(undefined);
        }
      }, timeoutMs);
    });
  }

  function send(line: string): void {
    record("tx", line);
    serialPort.write(`${line}\n`);
  }

  /**
   * The break-reset retry itself (see module doc comment) — only ever
   * called once, from the initial `HELLO` timeout branch below. Its own
   * transcript segment is bracketed by `dir: "info"` markers so it
   * reads as clearly separate from the initial (failed) attempt.
   */
  async function retryAfterBreakReset(): Promise<PathResult> {
    record("info", "no banner -- relay may be parked in the data plane; attempting one break-reset retry");
    try {
      await sendBreak(serialPort, breakDurationMs, delay);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record("info", `break-reset failed: ${message}`);
      return {
        path: "usb",
        endpoint,
        status: "fail",
        reason: `no banner -- relay may be parked in the data plane; break-reset failed: ${message}`,
        transcript,
      };
    }
    await delay(postBreakWaitMs);
    record("info", `retrying HELLO ${postBreakWaitMs}ms after break-reset`);
    const retryHelloWait = waitForLine((line) => parseBanner(line) !== null, helloTimeoutMs);
    send("HELLO");
    const retryBannerLine = await retryHelloWait;
    if (retryBannerLine === undefined) {
      return {
        path: "usb",
        endpoint,
        status: "fail",
        reason: `no banner -- relay may be parked in the data plane; retried HELLO after break-reset but still no banner within ${helloTimeoutMs}ms`,
        transcript,
      };
    }
    const retryBanner = parseBanner(retryBannerLine)!;
    const recoveredKind = isRelayBanner(retryBanner) ? "relay" : "device";
    record("info", `banner recovered after break-reset (${recoveredKind}); querying status with '?'`);
    const retryQueryWait = waitForLine((line) => line.startsWith("#"), idTimeoutMs);
    send("?");
    const retryQueryReply = await retryQueryWait;
    return {
      path: "usb",
      endpoint,
      status: retryQueryReply !== undefined ? "pass" : "fail",
      reason:
        retryQueryReply !== undefined
          ? `no banner initially (parked in the data plane) -- recovered after one break-reset retry: ${recoveredKind} banner + '?' reply captured (${retryBanner.raw})`
          : `no banner initially (parked in the data plane) -- break-reset retry recovered a ${recoveredKind} banner (${retryBanner.raw}) but no reply to '?' within ${idTimeoutMs}ms`,
      transcript,
    };
  }

  try {
    const helloWait = waitForLine((line) => parseBanner(line) !== null, helloTimeoutMs);
    send("HELLO");
    const bannerLine = await helloWait;
    if (bannerLine === undefined) {
      return await retryAfterBreakReset();
    }
    const banner = parseBanner(bannerLine)!;

    if (isRelayBanner(banner)) {
      const queryWait = waitForLine((line) => line.startsWith("#"), idTimeoutMs);
      send("?");
      const queryReply = await queryWait;
      return {
        path: "usb",
        endpoint,
        status: queryReply !== undefined ? "pass" : "fail",
        reason:
          queryReply !== undefined
            ? `relay banner + '?' status reply captured (${banner.raw})`
            : `relay banner captured (${banner.raw}) but no reply to '?' within ${idTimeoutMs}ms`,
        transcript,
      };
    }

    const idWait = waitForLine((line) => line.toLowerCase().startsWith("id "), idTimeoutMs);
    send("ID");
    const idLine = await idWait;
    if (idLine === undefined) {
      return {
        path: "usb",
        endpoint,
        status: "fail",
        reason: `banner captured (${banner.raw}) but no ID reply within ${idTimeoutMs}ms`,
        transcript,
      };
    }
    const idReply = parseIdReply(idLine.trim().split(/\s+/).slice(1));
    return {
      path: "usb",
      endpoint,
      status: "pass",
      reason: `banner + ID matched (${banner.raw} / ${idReply ? idLine : "unparsed id reply"})`,
      transcript,
    };
  } finally {
    await new Promise<void>((resolve) => serialPort.close(() => resolve()));
  }
}
