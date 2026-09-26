import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runRconsole, HELP_TEXT } from "./cli.js";
import { AGENT_INSTRUCTIONS } from "./agentInstructions.js";
import * as daemonCli from "../daemon/cli.js";
import { getCliVersion } from "../cliVersion.js";

// `rconsole` owns no logic beyond composition, so these tests assert
// exactly that: which daemon function each verb calls, in what order,
// and that the bare invocation is the only one that both starts and
// opens. The daemon functions themselves are covered by
// `daemon/cli.test.ts` (sprint 021 ticket 003) and are spied on here
// rather than re-tested.

function collect(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), lines };
}

describe("runRconsole", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with no arguments, starts the host and then opens the UI", async () => {
    const order: string[] = [];
    const start = vi.spyOn(daemonCli, "runStart").mockImplementation(async () => {
      order.push("start");
      return { outcome: "started", url: "http://127.0.0.1:4795" };
    });
    const open = vi.spyOn(daemonCli, "runOpen").mockImplementation(async () => {
      order.push("open");
      return {
        outcome: "opened",
        localUrl: "http://127.0.0.1:4795",
        shareableUrl: "http://gala.local:4795",
      };
    });

    const result = await runRconsole([], { write: () => {} });

    expect(order).toEqual(["start", "open"]);
    expect(start).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(result).toEqual({ outcome: "started", url: "http://127.0.0.1:4795" });
  });

  it("with no arguments against an already-running host, does not start a second one", async () => {
    vi.spyOn(daemonCli, "runStart").mockResolvedValue({
      outcome: "already-running",
      url: "http://127.0.0.1:4795",
    });
    vi.spyOn(daemonCli, "runOpen").mockResolvedValue({
      outcome: "opened",
      localUrl: "http://127.0.0.1:4795",
      shareableUrl: "http://gala.local:4795",
    });

    const result = await runRconsole([], { write: () => {} });

    expect(result).toEqual({ outcome: "already-running", url: "http://127.0.0.1:4795" });
  });

  it("with no arguments, does not report success when no host could be reached", async () => {
    vi.spyOn(daemonCli, "runStart").mockResolvedValue({
      outcome: "started",
      url: "http://127.0.0.1:4795",
    });
    vi.spyOn(daemonCli, "runOpen").mockResolvedValue({ outcome: "not-running" });

    const result = await runRconsole([], { write: () => {} });

    expect(result).toEqual({ outcome: "not-running" });
  });

  it("`start` never opens a browser", async () => {
    vi.spyOn(daemonCli, "runStart").mockResolvedValue({
      outcome: "started",
      url: "http://127.0.0.1:4795",
    });
    const open = vi.spyOn(daemonCli, "runOpen");

    const result = await runRconsole(["start"], { write: () => {} });

    expect(open).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "started", url: "http://127.0.0.1:4795" });
  });

  it("`stop` reports a non-stopped outcome as a failure rather than success", async () => {
    vi.spyOn(daemonCli, "runStop").mockResolvedValue({ outcome: "timed-out" } as never);

    const result = await runRconsole(["stop"], { write: () => {} });

    expect(result).toEqual({ outcome: "stop-failed", reason: "timed-out" });
  });

  it("`stop` reports success only when the daemon actually stopped", async () => {
    vi.spyOn(daemonCli, "runStop").mockResolvedValue({ outcome: "stopped" } as never);

    const result = await runRconsole(["stop"], { write: () => {} });

    expect(result).toEqual({ outcome: "stopped" });
  });

  it("`ui` and `open` are the same command", async () => {
    const open = vi.spyOn(daemonCli, "runOpen").mockResolvedValue({
      outcome: "opened",
      localUrl: "http://127.0.0.1:4795",
      shareableUrl: "http://gala.local:4795",
    });
    const start = vi.spyOn(daemonCli, "runStart");

    const viaUi = await runRconsole(["ui"], { write: () => {} });
    const viaOpen = await runRconsole(["open"], { write: () => {} });

    expect(viaUi).toEqual(viaOpen);
    expect(open).toHaveBeenCalledTimes(2);
    // `ui` opens a UI; it does not silently start a host.
    expect(start).not.toHaveBeenCalled();
  });

  it("`ui` against nothing running does not claim to have opened anything", async () => {
    vi.spyOn(daemonCli, "runOpen").mockResolvedValue({ outcome: "not-running" });

    const result = await runRconsole(["ui"], { write: () => {} });

    expect(result).toEqual({ outcome: "not-running" });
  });

  it("`status` reports running or not without starting anything", async () => {
    const start = vi.spyOn(daemonCli, "runStart");
    vi.spyOn(daemonCli, "runStatus").mockResolvedValue({ outcome: "not-running" });

    const result = await runRconsole(["status"], { write: () => {} });

    expect(result).toEqual({ outcome: "status", running: false });
    expect(start).not.toHaveBeenCalled();
  });

  it("`help` prints usage and touches no daemon function", async () => {
    const start = vi.spyOn(daemonCli, "runStart");
    const status = vi.spyOn(daemonCli, "runStatus");
    const sink = collect();

    const result = await runRconsole(["help"], { write: sink.write });

    expect(result).toEqual({ outcome: "help" });
    expect(sink.lines.join("\n")).toBe(HELP_TEXT);
    expect(start).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("`--help` and `-h` are aliases for `help`", async () => {
    for (const flag of ["--help", "-h"]) {
      const sink = collect();
      const result = await runRconsole([flag], { write: sink.write });
      expect(result).toEqual({ outcome: "help" });
      expect(sink.lines.join("\n")).toBe(HELP_TEXT);
    }
  });

  it("`agent` prints the agent instructions and touches no daemon function", async () => {
    const start = vi.spyOn(daemonCli, "runStart");
    const sink = collect();

    const result = await runRconsole(["agent"], { write: sink.write });

    expect(result).toEqual({ outcome: "agent" });
    expect(sink.lines.join("\n")).toBe(AGENT_INSTRUCTIONS);
    expect(start).not.toHaveBeenCalled();
  });

  it("an unknown command is an error, and prints help", async () => {
    const sink = collect();

    const result = await runRconsole(["frobnicate"], { write: sink.write });

    expect(result).toEqual({ outcome: "unknown-command", command: "frobnicate" });
    expect(sink.lines.join("\n")).toContain('unknown command "frobnicate"');
    expect(sink.lines.join("\n")).toContain("Usage:");
  });

  it("`version`, `--version`, and `-V` all print `rconsole <version>` and touch no daemon function", async () => {
    const start = vi.spyOn(daemonCli, "runStart");
    const version = getCliVersion();

    for (const arg of ["version", "--version", "-V"]) {
      const sink = collect();

      const result = await runRconsole([arg], { write: sink.write });

      expect(result).toEqual({ outcome: "version", version });
      expect(sink.lines).toEqual([`rconsole ${version}`]);
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("`rconsole help` lists the version option", () => {
    expect(HELP_TEXT).toMatch(/version/);
    expect(HELP_TEXT).toContain("--version");
    expect(HELP_TEXT).toContain("-V");
  });
});

describe("agent instructions", () => {
  // The whole value of `rconsole agent` is that it carries the things
  // that are expensive to learn by experiment. These assertions exist so
  // a future edit cannot quietly drop one.
  it("tells an agent that HELLO is the identity tiebreak", () => {
    expect(AGENT_INSTRUCTIONS).toContain("HELLO");
    expect(AGENT_INSTRUCTIONS).toMatch(/only .?HELLO.? comes from the chip/i);
  });

  it("warns that a flash timeout is not a failure and must not be retried", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/timeout is not a\s+.?failure/i);
    expect(AGENT_INSTRUCTIONS).toMatch(/do \*\*not\*\* retry/i);
    expect(AGENT_INSTRUCTIONS).toContain("recentAgentActions[0]");
  });

  it("states that drive and flash are ungated, and that ID should be read before flashing", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/ungated/i);
    expect(AGENT_INSTRUCTIONS).toMatch(/read a board's .?ID.? before flashing/i);
  });

  it("tells an agent never to kill a process it did not start", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/never kill or signal a process you did not start/i);
  });

  it("says there is only ever one host", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/only ever one host/i);
  });

  it("tells an agent how to actually connect, not just what the tools are", () => {
    // The point of the Connecting section: an agent that has never seen
    // this bench must be able to get from `rconsole agent` to a working
    // MCP client without asking a human.
    expect(AGENT_INSTRUCTIONS).toContain("http://127.0.0.1:4795/mcp");
    expect(AGENT_INSTRUCTIONS).toContain("claude mcp add --transport http");
    expect(AGENT_INSTRUCTIONS).toContain('"type": "http"');
    // Streamable HTTP, not stdio -- the single most likely wrong guess,
    // since this repo's own .mcp.json uses a stdio server.
    expect(AGENT_INSTRUCTIONS).toMatch(/not stdio/i);
    // And the endpoint does not exist without a host.
    expect(AGENT_INSTRUCTIONS).toMatch(/no host means no endpoint/i);
  });

  it("tells an agent its client name is recorded and visible to humans", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/caller/);
    expect(AGENT_INSTRUCTIONS).toMatch(/recognize/i);
  });
});
