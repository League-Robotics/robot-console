/**
 * cli.ts — the actual work behind `npx robot-console` (ticket 001's
 * `bin/robot-console.js` stub, completed by this ticket): start
 * `server.ts`'s Express/`ws` server and open the student's default
 * browser to the served UI page.
 *
 * `bin/robot-console.js` is a thin loader shim, not the real entry
 * point -- see its own comment for why it exists (in short: `npm run
 * build`, ticket 009, compiles this file to `dist/cli.js`, and the
 * shim imports that compiled output directly with plain `node`, no
 * loader hook). Keeping the real argv/env parsing and startup
 * sequence here, in a `.ts` module, means it is covered by the same
 * `tsc` typecheck as the rest of `host` rather than living in an
 * unchecked `.js` shim.
 *
 * ## Debugging flags (ticket 014-009, SUC-006)
 *
 * `--dump-store` and `--watch-store` are sprint-014-only debugging
 * affordances, both short-circuiting {@link main} before it ever
 * touches `server.ts`/`open()`/`getFirmwareConfig`:
 *
 * - `--dump-store`: prints a read-only JSON snapshot of
 *   `devices`/`links`/`services`/`sessions`/`tasks` and exits. See
 *   `debug/dumpStore.ts`.
 * - `--watch-store`: runs `usbWatcher`/`mdnsWatcher` headless against
 *   the real store and real backends, logging each store change as one
 *   JSON line, until `SIGINT`/`SIGTERM`. The bench-pass runner ticket
 *   010 uses to verify watcher rows without the UI.
 *
 * Both are throwaway -- see `sprint.md`'s Design Rationale and each
 * function's own doc comment below. Both are injectable via
 * {@link CliDeps}, the same "real defaults, fakes in tests" seam every
 * other module in this package uses (`watchers/usbWatcher.ts`'s
 * `UsbWatcherDeps`, `watchers/mdnsWatcher.ts`'s `MdnsWatcherDeps`, ...)
 * -- `cli.test.ts` substitutes fakes for all of them rather than
 * mocking modules, so no real store/watchers/ports/browser are ever
 * touched in tests.
 */

import open from "open";
import { startServer, type RunningServer, type StartServerOptions } from "./server.js";
import { getFirmwareConfig } from "./config.js";
import { dumpStore, formatStoreDump } from "./debug/dumpStore.js";
import { openStore, type Store } from "./store/index.js";
import { startUsbWatcher, type UsbWatcherHandle } from "./watchers/usbWatcher.js";
import { startMdnsWatcher, type MdnsWatcherHandle } from "./watchers/mdnsWatcher.js";
import { createBonjourBackend } from "./discovery/mdnsDiscovery.js";
import type { MdnsBackend } from "./discovery/mdnsDiscovery.js";

/** Injectable seams for {@link main} and the two debug flows below.
 * Every field defaults to the real implementation; `cli.test.ts`
 * substitutes fakes for whichever fields the flag under test touches,
 * mirroring `UsbWatcherDeps`/`MdnsWatcherDeps`'s own "real by default"
 * convention. */
export interface CliDeps {
  dumpStore?: typeof dumpStore;
  formatStoreDump?: typeof formatStoreDump;
  openStore?: typeof openStore;
  startUsbWatcher?: typeof startUsbWatcher;
  startMdnsWatcher?: typeof startMdnsWatcher;
  createBonjourBackend?: () => MdnsBackend;
  startServer?: (options?: StartServerOptions) => Promise<RunningServer>;
  getFirmwareConfig?: typeof getFirmwareConfig;
  /** Opens a browser to `url`. Defaults to the `open` package. Rejects
   * the same way a real browser-launch failure would, so {@link main}'s
   * own try/catch around it is exercised the same way in tests as in
   * production. */
  openBrowser?: (url: string) => Promise<void>;
}

/** `--port <n>` / `--port=<n>` from argv, if present and a valid
 * integer. */
function parsePortFlag(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (Number.isInteger(value)) {
        return value;
      }
    } else if (arg?.startsWith("--port=")) {
      const value = Number(arg.slice("--port=".length));
      if (Number.isInteger(value)) {
        return value;
      }
    }
  }
  return undefined;
}

/** `ROBOT_CONSOLE_PORT`, if present and a valid integer. */
function parsePortEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.ROBOT_CONSOLE_PORT;
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

/** `--dump-store` from argv (ticket 014-009 / SUC-006): print the store
 * as JSON and exit, never starting the server or opening a browser. */
function hasDumpStoreFlag(argv: readonly string[]): boolean {
  return argv.includes("--dump-store");
}

/** `--watch-store` from argv (ticket 014-009, team-lead addition for
 * ticket 010's bench pass): run both watchers headless against the real
 * store/enumerator/SWD-namer/mDNS backend, log each change event, and
 * never start the server or the old `deviceRegistry`. */
function hasWatchStoreFlag(argv: readonly string[]): boolean {
  return argv.includes("--watch-store");
}

/**
 * `--dump-store`: open a short-lived read-only connection (`debug/
 * dumpStore.ts`), print the JSON snapshot, and return -- no server, no
 * browser. See `sprint.md`'s Design Rationale ("debug affordance is a
 * CLI flag, not a read-only HTTP endpoint").
 */
function runDumpStore(env: NodeJS.ProcessEnv, deps: Required<Pick<CliDeps, "dumpStore" | "formatStoreDump">>): void {
  const snapshot = deps.dumpStore({ env });
  console.log(deps.formatStoreDump(snapshot));
}

/**
 * `--watch-store`: the headless runner ticket 010's bench pass uses to
 * confirm "watcher rows visible in a debug dump" on real hardware
 * without the UI. Opens the store (real state dir, by default) and
 * starts both watchers against real dependencies -- `startUsbWatcher`'s
 * own seams already default to the real enumerator/serial adapter/SWD
 * namer (`watchers/usbWatcher.ts`), and `startMdnsWatcher` is handed the
 * real `bonjour-service` backend `discovery/mdnsDiscovery.ts` exports
 * for exactly this purpose. Every coalesced `store.onChange` batch is
 * logged as one JSON line to stdout.
 *
 * TODO(rearch-05): this is a sprint-014 debugging affordance, a stand-in
 * for the reconciler that does not exist until sprint 015 -- it starts
 * the same two watchers ticket 007/008 already ship, not a new startup
 * path of its own. Does not start `server.ts`'s Express/ws server or
 * the old `deviceRegistry.ts` path.
 *
 * Stops cleanly on `SIGINT`/`SIGTERM`: both watchers' `stop()`, the
 * change-feed unsubscribe, and `store.close()`, in that order. The
 * returned promise resolves only once that shutdown has run, which is
 * what keeps the process alive in the meantime -- both watchers'
 * internal timers are `unref()`'d (see their own modules), so nothing
 * else here would hold the event loop open.
 */
async function runWatchStore(
  env: NodeJS.ProcessEnv,
  deps: Required<Pick<CliDeps, "openStore" | "startUsbWatcher" | "startMdnsWatcher" | "createBonjourBackend">>,
): Promise<void> {
  const store: Store = deps.openStore({ env });
  const unsubscribe = store.onChange((changes) => {
    console.log(JSON.stringify({ type: "change", changes }));
  });

  const usbHandle: UsbWatcherHandle = deps.startUsbWatcher(store);
  const mdnsHandle: MdnsWatcherHandle = deps.startMdnsWatcher(store, { backend: deps.createBonjourBackend() });

  console.log("robot-console: --watch-store running (usbWatcher + mdnsWatcher) -- Ctrl-C to stop.");

  await new Promise<void>((resolve) => {
    let stopped = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      console.log(`robot-console: received ${signal}, stopping watchers...`);
      usbHandle.stop();
      mdnsHandle.stop();
      unsubscribe();
      store.close();
      resolve();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

/**
 * Start the host server and open the browser to it. `argv` is
 * everything after the program name (`process.argv.slice(2)`); `env`
 * defaults to `process.env`. A `--port`/`ROBOT_CONSOLE_PORT` override is
 * resolved here and handed to {@link startServer}; the port-busy check
 * itself (fail clearly rather than silently picking another) is
 * `server.ts`'s responsibility, not this module's.
 *
 * A failure to open a browser (headless environment, no default browser
 * configured, ...) is logged and does not fail startup -- the server is
 * still fully usable by pointing a browser or a WebSocket client at
 * {@link RunningServer.url} manually. A failure to *start the server*
 * (most commonly: the port is already in use) propagates to the caller.
 *
 * Also resolves the two flashable firmware sources via `config.ts`'s
 * {@link getFirmwareConfig} (sprint 2, ticket 002) and threads the
 * result into {@link startServer}'s options, alongside the
 * `--port`/`ROBOT_CONSOLE_PORT` resolution -- `getFirmwareConfig` never
 * throws, so a checkout with no `dotconfig` install at all still starts
 * normally, with both flash buttons rendering in their "not configured"
 * state.
 *
 * `deps` overrides any of this function's (or the two debug flows')
 * collaborators -- every field defaults to the real implementation, so
 * ordinary callers (`bin/robot-console.js`) never pass it. See
 * {@link CliDeps}.
 */
export async function main(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {},
): Promise<void> {
  if (hasDumpStoreFlag(argv)) {
    runDumpStore(env, {
      dumpStore: deps.dumpStore ?? dumpStore,
      formatStoreDump: deps.formatStoreDump ?? formatStoreDump,
    });
    return;
  }
  if (hasWatchStoreFlag(argv)) {
    await runWatchStore(env, {
      openStore: deps.openStore ?? openStore,
      startUsbWatcher: deps.startUsbWatcher ?? startUsbWatcher,
      startMdnsWatcher: deps.startMdnsWatcher ?? startMdnsWatcher,
      createBonjourBackend: deps.createBonjourBackend ?? createBonjourBackend,
    });
    return;
  }

  const startServerFn = deps.startServer ?? startServer;
  const getFirmwareConfigFn = deps.getFirmwareConfig ?? getFirmwareConfig;
  const openBrowser = deps.openBrowser ?? open;

  const port = parsePortFlag(argv) ?? parsePortEnv(env);
  const firmwareConfig = getFirmwareConfigFn(env);
  const server = await startServerFn({ ...(port !== undefined ? { port } : {}), firmwareConfig });
  console.log(`robot-console: listening on ${server.url}`);

  try {
    await openBrowser(server.url);
  } catch (error) {
    console.warn(
      `robot-console: could not open a browser automatically (${
        error instanceof Error ? error.message : String(error)
      }) -- open ${server.url} manually.`,
    );
  }
}
