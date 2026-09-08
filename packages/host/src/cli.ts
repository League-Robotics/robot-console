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
 */

import open from "open";
import { startServer } from "./server.js";
import { getFirmwareConfig } from "./config.js";

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
 */
export async function main(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const port = parsePortFlag(argv) ?? parsePortEnv(env);
  const firmwareConfig = getFirmwareConfig(env);
  const server = await startServer({ ...(port !== undefined ? { port } : {}), firmwareConfig });
  console.log(`robot-console: listening on ${server.url}`);

  try {
    await open(server.url);
  } catch (error) {
    console.warn(
      `robot-console: could not open a browser automatically (${
        error instanceof Error ? error.message : String(error)
      }) -- open ${server.url} manually.`,
    );
  }
}
