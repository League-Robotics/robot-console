/**
 * cli.test.ts — `robot-console-supervisor`'s `--version`/`-V` handling
 * (sprint 026 ticket 001). `parseSupervisorConfig` itself is already
 * covered by `supervisor.test.ts`; this file covers only what `main()`
 * adds: the version short-circuit, checked before `parseSupervisorConfig`
 * (and therefore before `startSupervisor` and its host child) ever runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type SupervisorCliDeps } from "./cli.js";
import { getCliVersion } from "../cliVersion.js";
import type { RunningSupervisor } from "./supervisor.js";

describe("supervisor cli: main -- --version / -V", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["--version", "-V"])("%s prints 'robot-console-supervisor <version>' and starts nothing", async (flag) => {
    const startSupervisorMock = vi.fn<() => Promise<RunningSupervisor>>();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps: SupervisorCliDeps = { startSupervisor: startSupervisorMock };

    const result = await main([flag], process.env, deps);

    const version = getCliVersion();
    expect(result).toEqual({ outcome: "version", version });
    expect(logSpy).toHaveBeenCalledWith(`robot-console-supervisor ${version}`);
    // Never starts the supervisor (and therefore never spawns the host
    // child process either).
    expect(startSupervisorMock).not.toHaveBeenCalled();
  });

  it("is checked before parseSupervisorConfig, so an otherwise-invalid config never surfaces", async () => {
    const startSupervisorMock = vi.fn<() => Promise<RunningSupervisor>>();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // ROBOT_CONSOLE_HOST_PORT equal to the default public port would
    // normally make parseSupervisorConfig throw (see
    // supervisor.test.ts's own "both 4795" case) -- --version must never
    // reach that validation.
    const env = { ...process.env, ROBOT_CONSOLE_HOST_PORT: "4795" };

    await expect(main(["--version"], env, { startSupervisor: startSupervisorMock })).resolves.toEqual({
      outcome: "version",
      version: getCliVersion(),
    });
    expect(startSupervisorMock).not.toHaveBeenCalled();
  });
});
