/**
 * browserOpen.ts — the one place that opens a real browser window,
 * shared by `cli.ts`'s own post-start launch and `daemon/cli.ts`'s
 * `open` verb (sprint 021 ticket 003).
 *
 * Factored out of `cli.ts` (where it was a private function) specifically
 * so `daemon/cli.ts` can reuse it without creating an import cycle:
 * `cli.ts` imports `daemon/cli.ts`'s `runStart`/`runStop`/`runStatus`/
 * `runOpen` to dispatch the `start`/`stop`/`status`/`open` subcommands,
 * so `daemon/cli.ts` cannot import anything back from `cli.ts` itself.
 * This module depends on neither, so both can depend on it.
 */
import open, { apps } from "open";

/** Opens `url` in Google Chrome specifically -- the stakeholder does not
 * want whichever OS default browser happens to be installed (Safari, on
 * the macOS benches this project runs on). Falls back to the plain
 * OS-default `open(url)` (and warns once) if Chrome itself is not
 * installed, so a missing Chrome degrades to that instead of failing
 * outright. */
export async function openInChrome(url: string): Promise<void> {
  try {
    await open(url, { app: { name: apps.chrome } });
  } catch (error) {
    console.warn(
      `robot-console: Google Chrome not found (${
        error instanceof Error ? error.message : String(error)
      }) -- opening the default browser instead.`,
    );
    await open(url);
  }
}
