#!/usr/bin/env node
// `npm run dev` — the whole development stack in one terminal.
//
// Development needs two servers: the privileged Node host (USB/SWD/
// serial plus the WebSocket contract in `packages/host/src/server.ts`)
// and Vite, which serves `packages/ui` with hot module replacement.
// Running them as two npm scripts means two terminals, two Ctrl-Cs, and
// two chances to forget one. This script runs both inside a *single*
// Node process instead -- Vite has a JS API (`createServer`) and the
// host exports `startServer`, so neither needs to be a child process,
// and one Ctrl-C tears down both.
//
// Why not have Vite proxy the WebSocket back to the host, keeping one
// origin? The host's `ws` server listens on `/`, the same path Vite
// must serve `index.html` from, so a path-based proxy rule cannot
// separate them. Instead the two stay on their own ports and the page
// is told where the host is: `defaultSocketUrl()` in
// `packages/ui/src/ws/WsProvider.tsx` reads `import.meta.env.VITE_WS_URL`
// when set, and `define` below sets it to the host's real address. In a
// production `vite build` that define is absent, so the UI falls back
// to connecting to whatever origin served it -- which is the host
// itself, exactly as `npx robot-console` intends.
//
// Unlike the built `bin/robot-console.js` (ticket 009 -- that shim now
// runs compiled `dist/` output via plain `node`), this dev script keeps
// no-compile-step development by registering `tsx` itself, so it can
// import `packages/host/src/server.ts` directly from TypeScript source.
// `tsx` stays a devDependency for exactly this.
import { register } from "tsx/esm/api";

register();

const { startServer, DEFAULT_PORT } = await import("../packages/host/src/server.ts");
const { startRuntime } = await import("../packages/host/src/runtime.ts");
const { createServer } = await import("vite");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiRoot = path.join(repoRoot, "packages", "ui");

/** `--host-port <n>` / `--host-port=<n>`, else `ROBOT_CONSOLE_PORT`,
 * else the host's own default. Mirrors `packages/host/src/cli.ts`'s
 * flag handling, under a distinct name so it is unambiguous which of
 * the two dev servers a port is meant for. */
function parsePort(argv, env) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host-port") {
      const value = Number(argv[i + 1]);
      if (Number.isInteger(value)) return value;
    } else if (arg?.startsWith("--host-port=")) {
      const value = Number(arg.slice("--host-port=".length));
      if (Number.isInteger(value)) return value;
    }
  }
  const raw = env.ROBOT_CONSOLE_PORT;
  if (raw !== undefined) {
    const value = Number(raw);
    if (Number.isInteger(value)) return value;
  }
  return DEFAULT_PORT;
}

const argv = process.argv.slice(2);
const hostPort = parsePort(argv, process.env);

// The host first: if its port is busy it throws a clear error, and
// there is no point standing Vite up only to tear it down again. Ticket
// 015-005: `startServer` no longer composes the store/watchers/
// reconciler itself -- `startRuntime` (`runtime.ts`) is the composition
// root, mirroring `cli.ts`'s own `main()`.
const runtime = startRuntime();
const host = await startServer({ store: runtime.store, runtime, port: hostPort });
console.log(`robot-console: host listening on ${host.url}`);

// Stakeholder instruction (018-010): open Chrome, not the OS default
// (Safari) -- Vite's `server.open` shells out to the `open` package,
// which honours `process.env.BROWSER` as the app name to launch, so set
// it (unless the user already overrode it) before `createServer` runs.
process.env.BROWSER ??= "google chrome";

const vite = await createServer({
  configFile: path.join(uiRoot, "vite.config.ts"),
  root: uiRoot,
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(
      `ws://${host.host}:${host.port}/`,
    ),
  },
  // Vite opens the browser itself once it is listening, so this script
  // needs no browser-launching dependency of its own.
  server: { open: true },
});
await vite.listen();

const uiUrl = vite.resolvedUrls?.local?.[0] ?? "(see Vite output above)";
console.log(`robot-console: UI (hot reload) on ${uiUrl}`);
console.log("robot-console: press Ctrl-C to stop both.");

let shuttingDown = false;
async function shutdown() {
  // Ctrl-C at a terminal delivers SIGINT to the whole process group, so
  // a second one can arrive while the first teardown is still running.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nrobot-console: shutting down...");
  await Promise.allSettled([vite.close(), host.close()]);
  runtime.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
