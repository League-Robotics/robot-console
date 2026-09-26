/**
 * endToEnd.test.ts — sprint 019 ticket 009's own end-to-end MCP tool
 * surface smoke test (the sprint's verification gate). Per ticket 009's
 * plan: "an end-to-end test file ... covering the full inspect -> connect
 * -> drive (immediate execution) -> flash (immediate execution) path
 * against a fake store, including `agent_actions` attribution at each
 * step."
 *
 * Deliberately exercises `createDefaultMcpServer` from `mcp/server.ts` --
 * the *real* production wiring that registers all four tool categories
 * (`registerInspectTools`/`registerConnectTools`/`registerDriveTools`/
 * `registerFlashTools`) onto one `McpServer` -- rather than re-registering
 * each category by hand as the four per-tool suites (`inspect.test.ts`,
 * `connect.test.ts`, `drive.test.ts`, `flash.test.ts`) already do in
 * isolation. Those four files are this ticket's own citation for each
 * tool's individual correctness; this file's job is narrower and
 * different: prove the pieces those four files test individually are
 * actually wired together correctly end to end, through one session,
 * against one real `:memory:` `Store` (never a hand-built fake -- same
 * discipline as every other MCP test file in this directory) with only
 * the reconciler/wire/flash collaborators faked (the same inherently
 * async, hardware-facing seams every sibling suite fakes).
 *
 * Per `sprint.md`'s Architecture Revision (tickets 006-008 dropped the
 * `pending_actions`/approval design this criterion originally
 * referenced): there is no Approve/Deny/expire step to simulate anywhere
 * below. What this file verifies instead is exactly what replaced it --
 * `request_drive`/`request_flash` reach the robot/board immediately, with
 * no intermediate state and no wait, and each executed call is durably
 * recorded in `agent_actions` with correct attribution.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deviceIdToName } from "@robot-console/protocol";
import { createDefaultMcpServer, type McpDeps } from "./server.js";
import { MBFLASH_SERVICE_TYPE, openStore, Store } from "../store/index.js";
import type { ConnectedSession } from "../connect/connector.js";
import type { DaplinkDevice } from "../devices.js";
import type { FlashResultLike } from "../server.js";

// ---------------------------------------------------------------------
// Harness -- one real McpServer with every tool category registered
// (createDefaultMcpServer, the exact function cli.ts uses in production),
// one real :memory: Store, one fake reconciler/session, one fake
// startFlash.
// ---------------------------------------------------------------------

const DRIVE_LINK_ID = "mbserial-e2e-robot";
const DRIVE_DEVICE_ID = 42424242;
const DRIVE_DEVICE_NAME = deviceIdToName(DRIVE_DEVICE_ID);

/** `onInboundLine`/`onAckNack` default to a no-op subscription (never
 * fires, returns a plain unsubscribe) -- 027-006's `send_command` now
 * calls `sendCommandWithReply`, which subscribes both unconditionally
 * before every send (`connect/sessionOps.ts`'s own doc comment); a real
 * `ConnectedSession.link` is always a `LineLink` instance (see
 * `connect/connector.ts`/`connect/relayBridger.ts`'s own construction
 * sites), which always exposes them for every transport, so this fake
 * mirrors that shape rather than a narrower one that would make this
 * end-to-end suite the odd one out among `connect/sessionOps.test.ts`/
 * `mcp/tools/connect.test.ts`'s own `fakeSession` helpers. */
function fakeSession(overrides: { sendCommand?: ReturnType<typeof vi.fn>; sendUnsequencedQuery?: ReturnType<typeof vi.fn> } = {}): ConnectedSession {
  const link = {
    sendCommand: overrides.sendCommand ?? vi.fn(() => "OK\n"),
    sendUnsequencedQuery: overrides.sendUnsequencedQuery ?? vi.fn(() => "OK\n"),
    onInboundLine: vi.fn(() => () => {}),
    onAckNack: vi.fn(() => () => {}),
  };
  return { linkId: DRIVE_LINK_ID, deviceId: DRIVE_DEVICE_ID, transport: "mbserial", link, classification: { type: "robot" } } as unknown as ConnectedSession;
}

function fakeStartFlash(outcome: FlashResultLike = { status: "ok" }): ReturnType<typeof vi.fn> {
  return vi.fn(async () => outcome);
}

interface Harness {
  client: Client;
  store: Store;
  session: ConnectedSession;
  startFlash: ReturnType<typeof vi.fn>;
  requestOpen: ReturnType<typeof vi.fn>;
  requestClose: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

async function makeHarness(options: { session?: ConnectedSession; startFlash?: ReturnType<typeof vi.fn> } = {}): Promise<Harness> {
  const store = openStore({ filePath: ":memory:" });
  const session = options.session ?? fakeSession();
  const startFlash = options.startFlash ?? fakeStartFlash();

  // A device+link the whole pipeline operates on -- seeded exactly the
  // way `flash.test.ts`'s `seedNetworkFlashableDevice` and
  // `connect.test.ts`'s open_session fixtures do (real store rows, not a
  // fake store).
  store.upsertDevice({ id: DRIVE_DEVICE_ID, name: DRIVE_DEVICE_NAME, kind: "robot", at: 1 });
  // Owned, per projection.ts's "owned gate": an un-owned device's
  // wifi/mbserial link is hidden from the snapshot, and a device with no
  // visible links and not owned is dropped from list_devices entirely --
  // this fixture needs both list_devices visibility and an operable
  // mbserial link, so it must be owned.
  store.setOwned(DRIVE_DEVICE_ID, true, 1);
  store.upsertLink({ id: DRIVE_LINK_ID, transport: "mbserial", address: { host: "e2e.local", port: 4000 }, deviceId: DRIVE_DEVICE_ID, at: 1 });
  // A flash-capable service row (mirrors flash.test.ts's own
  // seedNetworkFlashableDevice) -- resolveFlashLinkTarget needs this to
  // recognize the mbserial link as flashable, matching a real mbserial
  // robot's own two rows (the bridge link + its sibling mbflash service).
  store.upsertService({ instance: DRIVE_DEVICE_NAME, type: MBFLASH_SERVICE_TYPE, host: "e2e.local", port: 34567, txt: null, at: 1 });

  let sessionOpen = false;
  const requestOpen = vi.fn(async (linkId: string) => {
    store.openSession(linkId, Date.now());
    sessionOpen = true;
    return {};
  });
  const requestClose = vi.fn(async (_linkId: string) => {
    sessionOpen = false;
    return undefined;
  });

  const deps: McpDeps = {
    store,
    reconciler: {
      requestOpen,
      requestClose,
      sessions: { get: vi.fn((linkId: string) => (sessionOpen && linkId === DRIVE_LINK_ID ? session : undefined)) },
    },
    startFlash: startFlash as unknown as McpDeps["startFlash"],
    enumerateDaplinkDevices: vi.fn(async () => [] as DaplinkDevice[]),
  };

  const server = createDefaultMcpServer(deps);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  // Real McpServer, real Client, real InMemoryTransport pair -- server-side
  // McpServer.connect() call happens implicitly inside createDefaultMcpServer's
  // caller in production (cli.ts); here we connect it exactly the way every
  // sibling suite does, via server.connect() directly.
  const client = new Client({ name: "019-009-e2e-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    store,
    session,
    startFlash,
    requestOpen,
    requestClose,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
});

async function newHarness(options: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  const h = await makeHarness(options);
  harnesses.push(h);
  return h;
}

function parseToolText(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "");
}

// ---------------------------------------------------------------------
// Full drive path: list_devices -> open_session -> send_command STATUS ->
// request_drive -> agent_actions -> close_session
// ---------------------------------------------------------------------

describe("end-to-end: inspect -> connect -> drive (immediate execution, audited)", () => {
  it("list_devices sees the seeded device, then the full open/status/drive/close sequence executes immediately with correct attribution", async () => {
    const sendCommand = vi.fn(() => "WHEELS_V\n");
    const sendUnsequencedQuery = vi.fn(() => "STATUS\n");
    const session = fakeSession({ sendCommand, sendUnsequencedQuery });
    const h = await newHarness({ session });

    // 1. list_devices -- the device is visible before any session exists.
    const listed = await h.client.callTool({ name: "list_devices", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const listedPayload = parseToolText(listed as { content: Array<{ type: string; text?: string }> }) as {
      devices: Array<{ name: string; links: Array<{ id: string }> }>;
    };
    const seededDevice = listedPayload.devices.find((d) => d.name === DRIVE_DEVICE_NAME);
    expect(seededDevice).toBeDefined();
    expect(seededDevice!.links.map((l) => l.id)).toContain(DRIVE_LINK_ID);

    // 2. open_session
    const opened = await h.client.callTool({ name: "open_session", arguments: { linkId: DRIVE_LINK_ID } });
    expect(opened.isError).toBeFalsy();
    expect(h.requestOpen).toHaveBeenCalledWith(DRIVE_LINK_ID);

    // 3. send_command STATUS -- an unsequenced query, not gated.
    const status = await h.client.callTool({ name: "send_command", arguments: { linkId: DRIVE_LINK_ID, verb: "STATUS" } });
    expect(status.isError).toBeFalsy();
    expect(sendUnsequencedQuery).toHaveBeenCalledWith("STATUS", []);

    // 4. request_drive -- immediate execution, no intermediate state, no
    // wait: the call resolves synchronously with sendCommand already
    // having been invoked by the time it returns.
    const drive = await h.client.callTool({
      name: "request_drive",
      arguments: { linkId: DRIVE_LINK_ID, verb: "WHEELS_V", fields: [50, 50, 1000] },
    });
    expect(drive.isError).toBeFalsy();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("WHEELS_V", [50, 50, 1000]);
    const drivePayload = parseToolText(drive as { content: Array<{ type: string; text?: string }> }) as { ok: boolean; sent: string };
    expect(drivePayload).toEqual({ ok: true, sent: "WHEELS_V" });

    // 5. Exactly one agent_actions row, kind 'drive', correct
    // caller/verb/fields/executedAt.
    const driveRows = h.store.recentAgentActions({ linkId: DRIVE_LINK_ID }, 10);
    expect(driveRows).toHaveLength(1);
    expect(driveRows[0]).toMatchObject({
      kind: "drive",
      linkId: DRIVE_LINK_ID,
      caller: "019-009-e2e-agent",
      result: "sent",
      params: { verb: "WHEELS_V", fields: [50, 50, 1000] },
    });
    expect(typeof driveRows[0]!.executedAt).toBe("number");
    expect(driveRows[0]!.executedAt).toBeGreaterThan(0);

    // 6. close_session
    const closed = await h.client.callTool({ name: "close_session", arguments: { linkId: DRIVE_LINK_ID } });
    expect(closed.isError).toBeFalsy();
    expect(h.requestClose).toHaveBeenCalledWith(DRIVE_LINK_ID);
  });

  it("negative space: a non-allowlisted verb through request_drive never reaches sendCommand and writes no agent_actions row", async () => {
    const sendCommand = vi.fn();
    const session = fakeSession({ sendCommand });
    const h = await newHarness({ session });
    await h.client.callTool({ name: "open_session", arguments: { linkId: DRIVE_LINK_ID } });

    const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: DRIVE_LINK_ID, verb: "ESTOP", fields: [] } });

    expect(result.isError).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(h.store.recentAgentActions({ linkId: DRIVE_LINK_ID }, 10)).toHaveLength(0);
  });

  it("negative space: malformed fields for an allowlisted verb never reach sendCommand and write no agent_actions row", async () => {
    const sendCommand = vi.fn();
    const session = fakeSession({ sendCommand });
    const h = await newHarness({ session });
    await h.client.callTool({ name: "open_session", arguments: { linkId: DRIVE_LINK_ID } });

    // WHEELS_V needs exactly 3 fields; 1 is malformed.
    const result = await h.client.callTool({ name: "request_drive", arguments: { linkId: DRIVE_LINK_ID, verb: "WHEELS_V", fields: [50] } });

    expect(result.isError).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(h.store.recentAgentActions({ linkId: DRIVE_LINK_ID }, 10)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Full flash path: request_flash -> startFlash (immediate) -> mcp
// origin/caller overlay -> agent_actions
// ---------------------------------------------------------------------

describe("end-to-end: flash (immediate execution, audited, mcp-origin overlay)", () => {
  it("request_flash resolves the seeded device's own flashable link and calls startFlash immediately with the mcp origin/caller overlay, recording one agent_actions row", async () => {
    const startFlash = fakeStartFlash({ status: "ok" });
    const h = await newHarness({ startFlash });

    const result = await h.client.callTool({ name: "request_flash", arguments: { deviceId: DRIVE_DEVICE_ID, firmwareRef: "robot" } });

    expect(result.isError).toBeFalsy();
    expect(startFlash).toHaveBeenCalledTimes(1);
    // The flash snapshot overlay this ticket's own dispatch asks about:
    // startFlash's third argument is exactly the {origin, caller} pair
    // server.ts's runFlashTask threads into the live flash-overlay
    // snapshot for the operation's duration (server.test.ts's own job to
    // verify the overlay's snapshot shape end to end -- this file's job
    // is confirming request_flash actually passes it through).
    expect(startFlash).toHaveBeenCalledWith(DRIVE_LINK_ID, { kind: "release", firmware: "robot" }, { origin: "mcp", caller: "019-009-e2e-agent" });

    const payload = parseToolText(result as { content: Array<{ type: string; text?: string }> }) as { ok: boolean };
    expect(payload.ok).toBe(true);

    const rows = h.store.recentAgentActions({ deviceId: DRIVE_DEVICE_ID }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "flash",
      deviceId: DRIVE_DEVICE_ID,
      caller: "019-009-e2e-agent",
      result: "sent",
      params: { firmwareRef: "robot" },
    });
  });

  it("negative space: an unflashable target (no flashable link on the device) never reaches startFlash and writes no agent_actions row", async () => {
    const startFlash = fakeStartFlash({ status: "ok" });
    const store = openStore({ filePath: ":memory:" });
    try {
      // A device with no link at all -- nothing for resolveFlashLinkTarget
      // to resolve to.
      store.upsertDevice({ id: 99999999, name: deviceIdToName(99999999), kind: "robot", at: 1 });
      const deps: McpDeps = {
        store,
        reconciler: { requestOpen: vi.fn(), requestClose: vi.fn(), sessions: { get: vi.fn(() => undefined) } },
        startFlash: startFlash as unknown as McpDeps["startFlash"],
        enumerateDaplinkDevices: vi.fn(async () => []),
      };
      const server = createDefaultMcpServer(deps);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "019-009-e2e-agent", version: "1.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({ name: "request_flash", arguments: { deviceId: 99999999, firmwareRef: "robot" } });
        expect(result.isError).toBe(true);
        expect(startFlash).not.toHaveBeenCalled();
        expect(store.recentAgentActions({ deviceId: 99999999 }, 10)).toHaveLength(0);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------
// Ticket 021-004: request_flash outliving a disconnected/timed-out
// client -- through the exact production wiring (createDefaultMcpServer)
// -- and the durable recovery path a fresh get_device_status call gives.
// ---------------------------------------------------------------------

describe("end-to-end: request_flash outliving a disconnected client -- the outcome is still recoverable via get_device_status", () => {
  it("settles after the caller's own connection drops; a fresh get_device_status call recovers kind/caller/result from recentAgentActions[0]", async () => {
    const store = openStore({ filePath: ":memory:" });
    try {
      store.upsertDevice({ id: DRIVE_DEVICE_ID, name: DRIVE_DEVICE_NAME, kind: "robot", at: 1 });
      store.setOwned(DRIVE_DEVICE_ID, true, 1);
      store.upsertLink({ id: DRIVE_LINK_ID, transport: "mbserial", address: { host: "e2e.local", port: 4000 }, deviceId: DRIVE_DEVICE_ID, at: 1 });
      store.upsertService({ instance: DRIVE_DEVICE_NAME, type: MBFLASH_SERVICE_TYPE, host: "e2e.local", port: 34567, txt: null, at: 1 });

      let resolveFlash!: (outcome: FlashResultLike) => void;
      const deferred = new Promise<FlashResultLike>((resolve) => {
        resolveFlash = resolve;
      });
      const startFlash = vi.fn(() => deferred);

      const deps: McpDeps = {
        store,
        reconciler: { requestOpen: vi.fn(), requestClose: vi.fn(), sessions: { get: vi.fn(() => undefined) } },
        startFlash: startFlash as unknown as McpDeps["startFlash"],
        enumerateDaplinkDevices: vi.fn(async () => [] as DaplinkDevice[]),
      };
      // createDefaultMcpServer -- the exact function cli.ts uses in
      // production, registering every tool category on one McpServer
      // (this file's own module doc comment).
      const server = createDefaultMcpServer(deps);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "021-004-e2e-agent", version: "1.0.0" });

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        // Break delivery on the server's own transport -- simulates the
        // caller's own connection dropping (or its request timing out)
        // partway through, exactly as mcp/tools/flash.test.ts's own
        // disconnect test does; see that file's doc comment for why this
        // is a faithful stand-in for a real StreamableHTTPServerTransport
        // whose SSE stream the client gave up on, rather than the whole
        // session/transport closing.
        const originalSend = serverTransport.send.bind(serverTransport);
        let breakDelivery = false;
        serverTransport.send = vi.fn(async (message: unknown, options?: unknown) => {
          if (breakDelivery) {
            throw new Error("write after close: the client's own connection is gone");
          }
          return originalSend(message as never, options as never);
        });

        // Not awaited to completion -- once `breakDelivery` flips, the
        // server can never deliver a response to this call, so the
        // client's own promise only settles once `client.close()` tears
        // the session down in the `finally` below. `.catch()` just keeps
        // that eventual rejection from ever surfacing as unhandled.
        const flashCallPromise = client
          .callTool({ name: "request_flash", arguments: { deviceId: DRIVE_DEVICE_ID, firmwareRef: "robot" } })
          .catch((error: unknown) => error);
        void flashCallPromise;

        // waitFor rather than a fixed microtask-flush count since the
        // precondition check's own resolveFlashLinkTarget call is
        // genuinely async (enumerateDaplinkDevices).
        await vi.waitFor(() => expect(startFlash).toHaveBeenCalledTimes(1));

        // The client's own call times out / its connection drops here --
        // well before startFlash settles.
        breakDelivery = true;
        resolveFlash({ status: "ok" });

        // Exactly one durable row, regardless of the disconnect.
        await vi.waitFor(() => {
          expect(store.recentAgentActions({ deviceId: DRIVE_DEVICE_ID }, 10)).toHaveLength(1);
        });
        const rows = store.recentAgentActions({ deviceId: DRIVE_DEVICE_ID }, 10);
        expect(rows[0]).toMatchObject({ kind: "flash", deviceId: DRIVE_DEVICE_ID, result: "sent" });

        // Delivery works again for the *next* call -- a fresh
        // get_device_status, exactly what request_flash's own tool
        // description (corrected by this ticket) now tells a caller who
        // missed the inline response to do.
        breakDelivery = false;
        const status = await client.callTool({ name: "get_device_status", arguments: { name: DRIVE_DEVICE_NAME } });
        expect(status.isError).toBeFalsy();
        const payload = parseToolText(status as { content: Array<{ type: string; text?: string }> }) as {
          recentAgentActions: Array<{ kind: string; caller: string; summary: string }>;
        };
        expect(payload.recentAgentActions[0]).toMatchObject({ kind: "flash", caller: "021-004-e2e-agent" });
        expect(payload.recentAgentActions[0]!.summary).toContain("sent");

        // No uncaught exception / unhandled rejection escaped anywhere in
        // this flow -- the process-crash risk this ticket asks to verify.
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      }
    } finally {
      store.close();
    }
  });
});
