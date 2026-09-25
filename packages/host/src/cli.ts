/**
 * cli.ts — the actual work behind `npx robot-console` (ticket 001's
 * `bin/robot-console.js` stub): compose the runtime (`runtime.ts`),
 * start `server.ts`'s Express/`ws` server against it, open the
 * student's default browser, and handle `SIGINT`/`SIGTERM` cleanly
 * (sprint 015 ticket 005).
 *
 * `bin/robot-console.js` is a thin loader shim, not the real entry
 * point -- see its own comment for why it exists. Keeping the real
 * argv/env parsing and startup sequence here, in a `.ts` module, means
 * it is covered by the same `tsc` typecheck as the rest of `host` rather
 * than living in an unchecked `.js` shim.
 *
 * ## `--dump-store` (kept) / `--watch-store` (retired, ticket 005)
 *
 * `--dump-store` remains a sprint-014-only debugging affordance (see
 * `debug/dumpStore.ts`'s own doc comment) that short-circuits
 * {@link main} before it ever touches `runtime.ts`/`server.ts`/
 * `open()`/`getFirmwareConfig`.
 *
 * `--watch-store` -- which ran the USB/mDNS watchers headless against
 * the real store to prove SUC-005/SUC-006 without the UI -- is removed
 * by this ticket. It was always a stand-in for production startup
 * actually exercising the store and watchers, which it did not do until
 * now: {@link main}'s ordinary (non-flag) path composes exactly the same
 * `openStoreWithImports`/`startUsbWatcher`/`startMdnsWatcher` calls via
 * {@link startRuntime}, so the stand-in is superseded, not replaced by
 * anything else.
 *
 * ## Signal handling (ticket 005, SUC-006)
 *
 * `SIGINT`/`SIGTERM` call `server.close()` (which waits for any
 * in-flight `flash-start` task to finish or fail naturally before
 * returning -- see `server.ts`'s own doc comment) and then
 * `runtime.stop()`, then exit(0). Idempotent: a second signal while the
 * first is still shutting down is a no-op, mirroring the retired
 * `--watch-store`'s own idempotent shutdown.
 *
 * Every collaborator is injectable via {@link CliDeps}, the same "real
 * defaults, fakes in tests" seam this module has always used --
 * `cli.test.ts` substitutes fakes for all of them rather than mocking
 * modules, so no real store/watchers/ports/browser/process-exit is ever
 * touched in tests.
 */

import open from "open";
import { startServer, type RunningServer, type StartServerOptions } from "./server.js";
import { startRuntime, type Runtime, type StartRuntimeOptions } from "./runtime.js";
import { getFirmwareConfig } from "./config.js";
import { dumpStore, formatStoreDump } from "./debug/dumpStore.js";

/** Injectable seams for {@link main}. Every field defaults to the real
 * implementation; `cli.test.ts` substitutes fakes for whichever fields
 * the case under test touches. */
export interface CliDeps {
  dumpStore?: typeof dumpStore;
  formatStoreDump?: typeof formatStoreDump;
  /** Overrides {@link startRuntime} itself (rarely needed -- prefer
   * {@link runtimeOptions} to inject fakes for individual collaborators
   * while still exercising the real composition logic). */
  startRuntime?: typeof startRuntime;
  /** Forwarded to whichever {@link startRuntime} is in effect --
   * `cli.test.ts`'s own production-startup case uses this to inject
   * fakes for `openStoreWithImports`/`startUsbWatcher`/`startMdnsWatcher`/
   * etc. while calling the real {@link startRuntime}, so the assertion
   * is "does `main()`'s wiring actually reach `startRuntime`'s own
   * dependencies", not "was `startRuntime` itself called". */
  runtimeOptions?: StartRuntimeOptions;
  startServer?: (options: StartServerOptions) => Promise<RunningServer>;
  getFirmwareConfig?: typeof getFirmwareConfig;
  /** Opens a browser to `url`. Defaults to the `open` package. Rejects
   * the same way a real browser-launch failure would, so {@link main}'s
   * own try/catch around it is exercised the same way in tests as in
   * production. */
  openBrowser?: (url: string) => Promise<void>;
  /** Terminates the process. Defaults to `process.exit`. Injectable so
   * `cli.test.ts` can observe a clean `SIGINT`/`SIGTERM` shutdown
   * without ending the test process itself. */
  exit?: (code: number) => void;
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
 * as JSON and exit, never starting the runtime/server or opening a
 * browser. */
function hasDumpStoreFlag(argv: readonly string[]): boolean {
  return argv.includes("--dump-store");
}

/**
 * `--dump-store`: open a short-lived read-only connection (`debug/
 * dumpStore.ts`), print the JSON snapshot, and return -- no runtime, no
 * server, no browser.
 */
function runDumpStore(env: NodeJS.ProcessEnv, deps: Required<Pick<CliDeps, "dumpStore" | "formatStoreDump">>): void {
  const snapshot = deps.dumpStore({ env });
  console.log(deps.formatStoreDump(snapshot));
}

/**
 * Registers `SIGINT`/`SIGTERM` handlers that close `server`, stop
 * `runtime`, and exit -- see the module doc comment's "Signal handling"
 * section. Idempotent: a second signal while shutdown is already
 * running is ignored. Returns an unregister function (used by
 * `cli.test.ts`'s own cleanup, mirroring the retired `--watch-store`
 * suite's `process.removeAllListeners` discipline).
 */
function installShutdownHandlers(server: RunningServer, runtime: Runtime, exit: (code: number) => void): () => void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`robot-console: received ${signal}, shutting down...`);
    try {
      // server.close() itself waits for any in-flight flash-start task
      // to finish or fail naturally (closing its DAPLink/HID handle)
      // before resolving -- see server.ts's own doc comment.
      await server.close();
    } finally {
      await runtime.stop();
    }
    exit(0);
  };

  const onSigint = (): void => void shutdown("SIGINT");
  const onSigterm = (): void => void shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

/**
 * Start the host: compose the runtime, start the server against it,
 * install signal handlers, and open the browser. `argv` is everything
 * after the program name (`process.argv.slice(2)`); `env` defaults to
 * `process.env`. A `--port`/`ROBOT_CONSOLE_PORT` override is resolved
 * here and handed to {@link startServer}.
 *
 * A failure to open a browser is logged and does not fail startup -- the
 * server is still fully usable by pointing a browser or a WebSocket
 * client at {@link RunningServer.url} manually. A failure to *start the
 * runtime or server* propagates to the caller.
 *
 * `deps` overrides any of this function's collaborators -- every field
 * defaults to the real implementation, so ordinary callers
 * (`bin/robot-console.js`) never pass it. See {@link CliDeps}.
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

  const startRuntimeFn = deps.startRuntime ?? startRuntime;
  const startServerFn = deps.startServer ?? startServer;
  const getFirmwareConfigFn = deps.getFirmwareConfig ?? getFirmwareConfig;
  const openBrowser = deps.openBrowser ?? open;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const port = parsePortFlag(argv) ?? parsePortEnv(env);

  // Ticket 005: production startup now actually opens the store and
  // starts both watchers (until this ticket, only the retired
  // `--watch-store` flag did) -- see the module doc comment. Sprint 018
  // ticket 006: `startRuntime` is now `async` (it resolves/spawns and
  // connects the mbregistry client before returning), so this is
  // awaited -- a resolution/spawn failure here propagates out of `main`
  // itself, exactly like a real `startServer` failure already did.
  const runtime = await startRuntimeFn({ storeOptions: { env }, ...deps.runtimeOptions });

  // Sprint 017 ticket 001: `getFirmwareConfig` reads `settings` via the
  // store, not `env`/a `.env` file directly, so it must be called after
  // `runtime` (and its store, with `openStoreWithImports`'s
  // `importFirmwareConfig` already having run) exists.
  const firmwareConfig = getFirmwareConfigFn(runtime.store);

  const server = await startServerFn({
    store: runtime.store,
    runtime,
    ...(port !== undefined ? { port } : {}),
    firmwareConfig,
    // Sprint 018 ticket 006: the same already-connected mbregistry
    // client/label `startRuntime` resolved and handed to the connector
    // -- `server.ts#runFlashTask`'s `mbregistry`-transport branch uses
    // this, not a second, separately-resolved client.
    mbregistryClient: runtime.mbregistryClient,
    mbregistryLabel: runtime.mbregistryLabel,
  });
  console.log(`robot-console: listening on ${server.url}`);

  installShutdownHandlers(server, runtime, exit);

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
