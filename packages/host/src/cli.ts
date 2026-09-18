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
 * ## MCP server (sprint 019 ticket 004, SUC-004)
 *
 * `startMcpServer` (`mcp/server.ts`) is wired in via `startServer`'s own
 * `mountRoutes` hook (`server.ts`'s doc comment on that option) — this is
 * what "started ... before/alongside `startServer()`" (ticket 004's own
 * acceptance criterion) actually means in code: `mountRoutes` runs
 * synchronously inside `startServer`, before its Express app's
 * static-file/SPA catch-all route is registered, so the MCP route is
 * never shadowed by it, and the route only starts accepting real
 * connections once `startServer`'s own `listen()` succeeds — by which
 * point `runtime` (and its `store`) already exists, so there is no window
 * where an MCP call could race store construction. Injectable via
 * {@link CliDeps.startMcpServer}, mirroring every other collaborator here.
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

import { startServer, PortInUseError, type RunningServer, type StartServerOptions } from "./server.js";
import { startRuntime, type Runtime, type StartRuntimeOptions } from "./runtime.js";
import { getFirmwareConfig } from "./config.js";
import { dumpStore, formatStoreDump } from "./debug/dumpStore.js";
import { startMcpServer } from "./mcp/server.js";
import { startConsoleAdvertiser, type ConsoleAdvertiser } from "./discovery/consoleAdvertiser.js";
import { openInChrome } from "./browserOpen.js";
import { runStart, runStop, runStatus, runOpen } from "./daemon/cli.js";
import { writeDaemonInfo, removeDaemonInfo } from "./daemon/daemonInfo.js";

/** The shape `GET /api/host-info` (`server.ts`) answers with. Only `ok`
 * is required to treat a response as parseable at all -- `service`/
 * `port` are checked explicitly by {@link main}'s own attach decision
 * (an occupant that answers `{ok: true}` with some other `service`, or
 * none, never identifies as robot-console). */
export interface HostInfoProbeResult {
  readonly ok: boolean;
  readonly service?: string;
  readonly port?: number;
}

/** Probes a candidate occupant's `GET /api/host-info` to decide whether
 * an `EADDRINUSE` conflict on the default port is actually another
 * robot-console host (attach) or something else -- a stray Vite dev
 * server, a leftover bench run on the default port (hard fail, the
 * escape hatch `sprint.md`'s own Design Rationale preserves verbatim).
 * Returns `undefined` for anything that isn't a clean, parseable
 * `{ok: ...}` JSON response -- a timeout, a connection error, a non-2xx
 * status, or a body that doesn't parse as JSON at all. */
export type ProbeHostInfoFn = (url: string) => Promise<HostInfoProbeResult | undefined>;

/** Bounded wait for {@link defaultProbeHostInfo}'s real `fetch` -- "a few
 * seconds" per ticket 021-001, generous for a loopback round trip while
 * still failing fast when nothing is listening at all (the common case:
 * a genuinely free port never rejects with `PortInUseError` in the first
 * place, so this timeout is only ever paid on an actual conflict). */
const HOST_INFO_PROBE_TIMEOUT_MS = 3000;

function isHostInfoProbeResult(value: unknown): value is HostInfoProbeResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Real default for {@link CliDeps.probeHostInfo} -- a bounded-timeout
 * `fetch`, never a real socket in `cli.test.ts` (which always injects a
 * fake here instead). */
async function defaultProbeHostInfo(url: string): Promise<HostInfoProbeResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_INFO_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const data: unknown = await response.json();
    return isHostInfoProbeResult(data) ? data : undefined;
  } catch {
    // Connection refused, timed out (the `AbortController` above),
    // malformed JSON -- all of these mean "could not confirm this is a
    // robot-console host", never a thrown error out of the probe itself.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

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
  /** Mounts the MCP Streamable HTTP endpoint (`mcp/server.ts`). Defaults
   * to the real {@link startMcpServer}. Overriding this is how
   * `cli.test.ts` observes that `main()`'s wiring reaches it (via the
   * `mountRoutes` hook below) without ever touching a real Express app or
   * HTTP port -- `mcp/server.test.ts` is where `startMcpServer` itself is
   * tested. */
  startMcpServer?: typeof startMcpServer;
  /** Advertises this host over mDNS (`discovery/consoleAdvertiser.ts`)
   * once {@link startServer} resolves. Defaults to the real
   * {@link startConsoleAdvertiser} (a real `bonjour-service` backend,
   * lazily constructed) -- `cli.test.ts` always overrides this so no
   * test in that suite opens a real multicast socket. */
  startConsoleAdvertiser?: typeof startConsoleAdvertiser;
  getFirmwareConfig?: typeof getFirmwareConfig;
  /** Sprint 021 ticket 001: probes an `EADDRINUSE` occupant's own
   * `/api/host-info` to decide attach-vs-hard-fail on the default port.
   * Defaults to {@link defaultProbeHostInfo} (a real, bounded-timeout
   * `fetch`) -- `cli.test.ts` always overrides this so the attach/
   * hard-fail branches are exercised without ever opening a real
   * socket. */
  probeHostInfo?: ProbeHostInfoFn;
  /** Opens a browser to `url`. Defaults to {@link openInChrome} (Chrome,
   * falling back to the OS default browser if Chrome is not installed).
   * Rejects the same way a real browser-launch failure would, so
   * {@link main}'s own try/catch around it is exercised the same way in
   * tests as in production. */
  openBrowser?: (url: string) => Promise<void>;
  /** Terminates the process. Defaults to `process.exit`. Injectable so
   * `cli.test.ts` can observe a clean `SIGINT`/`SIGTERM` shutdown
   * without ending the test process itself. */
  exit?: (code: number) => void;
  /** Writes `daemon.json` once {@link startServer} resolves
   * (`daemon/daemonInfo.ts`). Defaults to the real {@link writeDaemonInfo}
   * -- `cli.test.ts` always overrides this so no test in that suite ever
   * touches the real state directory (sprint 021 ticket 003). */
  writeDaemonInfo?: typeof writeDaemonInfo;
  /** Removes `daemon.json` during shutdown. Defaults to the real
   * {@link removeDaemonInfo} -- same reasoning as {@link writeDaemonInfo}
   * above. */
  removeDaemonInfo?: typeof removeDaemonInfo;
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

/** `--no-open` from argv, or `ROBOT_CONSOLE_NO_OPEN` (any non-empty
 * value) from env: skip the automatic browser launch entirely.
 *
 * Added for sprint 018 ticket 002's Layer 2 bench harness, which starts
 * a real host against a scratch state dir on a headless bench run --
 * without this, {@link main} would try to launch a real desktop browser
 * every time the harness starts a host, which is both unwanted (no
 * student is at this bench run) and, on a CI/headless box, itself a
 * source of a hung or failing `open()` call unrelated to anything this
 * harness is testing. No pre-existing flag/env covered this ("dev.mjs"
 * launches a full graphical session for its own bench sessions, not a
 * headless one), so this ticket adds it. */
function hasNoOpenFlag(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--no-open")) {
    return true;
  }
  const raw = env.ROBOT_CONSOLE_NO_OPEN;
  return raw !== undefined && raw.length > 0;
}

/** `--sweep` from argv, or `ROBOT_CONSOLE_ENABLE_SWEEP` (any non-empty
 * value) from env: start the relay sweeper (`runtime.ts`'s own
 * `StartRuntimeOptions.disableSweep`, which now defaults to `true` --
 * see that field's own doc comment).
 *
 * Ticket 018-010 ("you're not going to sweep when you're idle
 * RadioRelay, so turn that off") inverts sprint 018 ticket 005 Step
 * 0b's original `--no-sweep`/`ROBOT_CONSOLE_DISABLE_SWEEP` flag: the
 * sweeper now defaults OFF for every caller (production startup
 * included, not just the bench harness), and this flag is the opt back
 * IN for anyone who still wants a relay's idle radio periodically swept
 * for reachable robots. `--no-sweep`/`ROBOT_CONSOLE_DISABLE_SWEEP` are
 * still accepted as plain, silently-ignored argv/env tokens (never an
 * error) purely for compatibility -- `scripts/bench`'s Layer 2/3 still
 * pass `--no-sweep` on their own command line, and there is no reason to
 * make that a hard error now that it is simply already the default.
 * Mirrors {@link hasNoOpenFlag}'s exact shape. */
function hasSweepFlag(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--sweep")) {
    return true;
  }
  const raw = env.ROBOT_CONSOLE_ENABLE_SWEEP;
  return raw !== undefined && raw.length > 0;
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
function installShutdownHandlers(
  server: RunningServer,
  runtime: Runtime,
  advertiser: ConsoleAdvertiser,
  exit: (code: number) => void,
  removeDaemonInfoFn: () => void,
): () => void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`robot-console: received ${signal}, shutting down...`);
    // Withdraw the mDNS advertisement (a real "goodbye" packet) before
    // the server itself stops accepting connections, rather than letting
    // it expire on its own TTL -- sprint 021 ticket 002's own acceptance
    // criterion ("stops the advertiser before (or alongside) closing the
    // server"). Synchronous and best-effort: `ConsoleAdvertiser.stop()`
    // never throws (bonjour-service's own `Service#stop()`/`Bonjour#destroy()`
    // are fire-and-forget from this module's perspective), so there is
    // nothing to await or catch here.
    advertiser.stop();
    try {
      // server.close() itself waits for any in-flight flash-start task
      // to finish or fail naturally (closing its DAPLink/HID handle)
      // before resolving -- see server.ts's own doc comment.
      await server.close();
    } finally {
      // Sprint 021 ticket 003: `runtime.stop()` now awaits
      // `reconciler.stop()`, which closes every session it still holds
      // before resolving (issue `reconciler-stop-leaks-open-sessions.md`)
      // -- so by the time this call returns, no session this process
      // opened is still holding a real socket to a robot. This is what
      // makes `daemon/cli.ts`'s `stop` verb honest: it sends `SIGTERM`
      // and waits for this process to actually exit, and this process
      // never calls `exit(0)` below until session teardown has already
      // happened.
      await runtime.stop();
    }
    // Remove `daemon.json` only after the runtime (and its sessions) are
    // actually torn down -- a `stop`/`status` call racing this shutdown
    // must never see "not running" (no daemon-info) while a session is
    // still technically open.
    removeDaemonInfoFn();
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
  // Sprint 021 ticket 003: `start`/`stop`/`status`/`open` dispatch to
  // `daemon/cli.ts` *before* any of today's flag parsing (including
  // `hasDumpStoreFlag` below) ever runs -- these are argv[0] literal
  // subcommands, not `--flag` tokens, so they collide with nothing today's
  // parsing recognizes. Every other invocation (no subcommand, or any
  // invocation starting with a `--flag`) falls through unchanged. Each
  // `run*` function owns its own defaults (real fs/network/spawn) --
  // `main()` passes only `env`, mirroring how it already threads `env`
  // into `runtimeOptions.storeOptions` below.
  switch (argv[0]) {
    case "start":
      await runStart({ env });
      return;
    case "stop":
      await runStop({ env });
      return;
    case "status":
      await runStatus({ env });
      return;
    case "open":
      await runOpen({ env });
      return;
    default:
      break;
  }

  if (hasDumpStoreFlag(argv)) {
    runDumpStore(env, {
      dumpStore: deps.dumpStore ?? dumpStore,
      formatStoreDump: deps.formatStoreDump ?? formatStoreDump,
    });
    return;
  }

  const startRuntimeFn = deps.startRuntime ?? startRuntime;
  const startServerFn = deps.startServer ?? startServer;
  const startMcpServerFn = deps.startMcpServer ?? startMcpServer;
  const startConsoleAdvertiserFn = deps.startConsoleAdvertiser ?? startConsoleAdvertiser;
  const getFirmwareConfigFn = deps.getFirmwareConfig ?? getFirmwareConfig;
  const openBrowser = deps.openBrowser ?? openInChrome;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const probeHostInfoFn = deps.probeHostInfo ?? defaultProbeHostInfo;
  const writeDaemonInfoFn = deps.writeDaemonInfo ?? writeDaemonInfo;
  const removeDaemonInfoFn = deps.removeDaemonInfo ?? removeDaemonInfo;

  const port = parsePortFlag(argv) ?? parsePortEnv(env);

  // Ticket 005: production startup now actually opens the store and
  // starts both watchers (until this ticket, only the retired
  // `--watch-store` flag did) -- see the module doc comment.
  // 018-010: the sweeper defaults off; `--sweep`/`ROBOT_CONSOLE_ENABLE_SWEEP`
  // is the explicit opt back in (`hasSweepFlag`'s own doc comment). An
  // explicit `deps.runtimeOptions.disableSweep` (a test's own override)
  // still wins, since it spreads last.
  const runtime = startRuntimeFn({ storeOptions: { env }, disableSweep: !hasSweepFlag(argv, env), ...deps.runtimeOptions });

  // Sprint 017 ticket 001: `getFirmwareConfig` reads `settings` via the
  // store, not `env`/a `.env` file directly, so it must be called after
  // `runtime` (and its store, with `openStoreWithImports`'s
  // `importFirmwareConfig` already having run) exists.
  const firmwareConfig = getFirmwareConfigFn(runtime.store);

  let server: RunningServer;
  try {
    server = await startServerFn({
      store: runtime.store,
      runtime,
      ...(port !== undefined ? { port } : {}),
      firmwareConfig,
      // Sprint 019 ticket 004 (SUC-004): mounts the MCP Streamable HTTP
      // endpoint on this same server's own Express app -- see this
      // module's own doc comment, "MCP server", and `server.ts`'s doc
      // comment on `mountRoutes` for why this must be a hook `startServer`
      // itself invokes (before its static/SPA catch-all route exists)
      // rather than something done to its `app` after the fact.
      mountRoutes: (app, extra) => {
        // Sprint 019 ticket 005: the MCP tool surface now needs the
        // reconciler too (connect/command tools), not just the store --
        // see `mcp/server.ts`'s own `McpDeps`. Ticket 008: `extra` carries
        // the exact `startFlash`/`enumerateDaplinkDevices` this server's
        // own `flash-start` WS handler uses (`server.ts`'s own
        // `MountRoutesExtra` doc comment) -- `mcp/tools/flash.ts`'s
        // `request_flash` calls the *same* `startFlash`, not a second,
        // divergent way of starting a flash.
        startMcpServerFn(app, {
          store: runtime.store,
          reconciler: runtime.reconciler,
          startFlash: extra.startFlash,
          enumerateDaplinkDevices: extra.enumerateDaplinkDevices,
        });
      },
    });
  } catch (error) {
    // Sprint 021 ticket 001: EADDRINUSE on the *default* port means "a
    // robot-console singleton is already running here" -- attach to it
    // instead of hard-failing. Scoped to exactly the case no explicit
    // --port/ROBOT_CONSOLE_PORT was given (`port === undefined`): an
    // explicit port keeps today's exact hard-fail behavior verbatim,
    // since `scripts/bench`'s own layer2/layer3 rely on an explicit
    // --port always meaning a fresh, isolated instance (`sprint.md`'s
    // Design Rationale, "Attach applies to the default port only").
    if (error instanceof PortInUseError && port === undefined) {
      const occupantUrl = `http://${error.host}:${error.port}`;
      // "Never attach on a bare port match" (sprint.md's Design
      // Rationale): a positive identification from the occupant's own
      // `/api/host-info` is required before treating "in use" as "safe
      // to attach to" -- a conflict that does not identify as
      // robot-console falls through to the same hard failure below,
      // preserving the escape hatch for a genuine, non-robot-console
      // conflict (a stray Vite dev server, a leftover bench run).
      const identity = await probeHostInfoFn(`${occupantUrl}/api/host-info`);
      if (identity?.ok === true && identity.service === "robot-console") {
        console.log(`robot-console: a host is already running at ${occupantUrl} -- attaching instead of starting a second one.`);
        // This invocation's own runtime never got as far as binding a
        // port, but `startRuntimeFn` above already opened the store and
        // started the USB/mDNS/firmware watchers -- exactly the
        // "half-start a runtime, grab hardware, then discover it should
        // have attached" hazard this ticket exists to prevent (sprint
        // 019 ticket 006's vevov incident). Stopping it here, the moment
        // attach is decided, closes that window: if the reconciler's
        // slow tick had already opened a session in the brief window
        // between `startRuntimeFn` and this catch block, `runtime.stop()`
        // now closes it too (sprint 021 ticket 003 fixed
        // `connect/reconciler.ts`'s own `stop()` to close every session
        // it still holds, rather than leaving it open --
        // `clasi/issues/reconciler-stop-leaks-open-sessions.md`). Also:
        // returning without this call would leave the watchers'
        // intervals scheduled forever, which would hang the process
        // (Node never exits with a pending timer) even though `main()`
        // itself returns normally.
        //
        // This same `startRuntimeFn`-before-any-probe shape is also why
        // `daemon/cli.ts`'s own `runStart` never builds a runtime at
        // all: it probes `/api/host-info` (and, failing that, a bounded
        // `spawn`+wait) before ever importing/constructing anything that
        // could touch hardware, closing this window from the outside
        // rather than opening-then-stopping it from the inside, the way
        // this in-process `main()` path still does.
        await runtime.stop();
        if (!hasNoOpenFlag(argv, env)) {
          try {
            await openBrowser(occupantUrl);
          } catch (openError) {
            console.warn(
              `robot-console: could not open a browser automatically (${
                openError instanceof Error ? openError.message : String(openError)
              }) -- open ${occupantUrl} manually.`,
            );
          }
        }
        return;
      }
    }
    throw error;
  }
  console.log(`robot-console: listening on ${server.url}`);

  // Sprint 021 ticket 003: write `daemon.json` the moment `startServer`
  // resolves -- for *every* way the host is started (a bare terminal
  // invocation, the bench harness's own direct spawn with its own
  // scratch `ROBOT_CONSOLE_STATE_DIR`, or `daemon/cli.ts`'s `start`
  // spawning this same entry point), not only when launched via `start`
  // -- see `daemon/daemonInfo.ts`'s own doc comment. `server.port` is the
  // actual bound port (never the requested one -- same reasoning as the
  // advertiser below); `server.host` is deliberately not stored as the
  // record's own probeable address (it is the literal bind address
  // `0.0.0.0`, not a usable one -- `daemon/cli.ts` always probes/opens
  // against `127.0.0.1`/`<hostname>.local` instead).
  writeDaemonInfoFn({ pid: process.pid, host: server.host, port: server.port, startedAt: Date.now() }, { env });

  // Sprint 021 ticket 002: advertise this host over mDNS at its actual
  // bound port (server.port, not the requested one -- see server.ts's
  // own `boundPort` doc comment for why those can differ) now that
  // binding widens beyond 127.0.0.1 -- see `discovery/consoleAdvertiser.ts`'s
  // own doc comment for what is advertised and why. Only reached once
  // startServer has actually succeeded (never on the EADDRINUSE-attach
  // early return above), so an attaching invocation never advertises a
  // host it never bound.
  const advertiser = startConsoleAdvertiserFn({ port: server.port });

  installShutdownHandlers(server, runtime, advertiser, exit, () => removeDaemonInfoFn({ env }));

  if (hasNoOpenFlag(argv, env)) {
    return;
  }

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
