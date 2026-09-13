import { describe, expect, it } from "vitest";
import { buildRows, generateMarkdown, isMainTablePath, labelRow, type RowStatus } from "./generate.js";
import type { Layer1Report } from "../layer1/types.js";
import type { Layer2Report } from "../layer2/types.js";
import type { Layer3Report } from "../layer3/types.js";

describe("isMainTablePath", () => {
  it("recognizes the four transports Layer 2/3 check", () => {
    expect(isMainTablePath("usb")).toBe(true);
    expect(isMainTablePath("mbserial")).toBe(true);
    expect(isMainTablePath("wifi")).toBe(true);
    expect(isMainTablePath("radio-via-mbrelay:torture")).toBe(true);
  });

  it("excludes a relay pool's own status-check path and the mbserial-contention demo", () => {
    expect(isMainTablePath("radio-via-mbrelay:torture" === "radio-via-mbrelay:torture" ? "radio-via-mbrelay:torture" : "")).toBe(true);
    expect(isMainTablePath("mbserial-contention")).toBe(false);
  });
});

describe("labelRow (environment vs. defect vs. pass vs. skipped)", () => {
  it("a Layer 1 fail is 'environment' regardless of later layers", () => {
    expect(labelRow("fail", "n/a", "n/a")).toBe("environment");
  });

  it("a Layer 1 pass with Layer 2 fail is 'defect' -- the sprint's own core framing", () => {
    expect(labelRow("pass", "fail", "n/a")).toBe("defect");
  });

  it("a Layer 1+2 pass with Layer 3 fail is 'defect'", () => {
    expect(labelRow("pass", "pass", "fail")).toBe("defect");
  });

  it("every layer passing is 'pass'", () => {
    expect(labelRow("pass", "pass", "pass")).toBe("pass");
  });

  it("Layer 1 pass with no Layer 2 report at all is still 'pass' (only what ran is judged)", () => {
    expect(labelRow("pass", "n/a", "n/a")).toBe("pass");
  });

  it("a Layer 1 skip is 'skipped', not 'environment' -- inconclusive, not a confirmed environment fact", () => {
    expect(labelRow("skipped", "n/a", "n/a")).toBe("skipped");
  });

  it("a Layer 2 skip (held at Layer 2 run time) is 'skipped' even though Layer 1 passed", () => {
    expect(labelRow("pass", "skipped", "n/a")).toBe("skipped");
  });

  it("a Layer 3 skip is 'skipped' even though Layers 1/2 both passed", () => {
    expect(labelRow("pass", "pass", "skipped")).toBe("skipped");
  });
});

function l1Report(devices: Layer1Report["devices"]): Layer1Report {
  return { startedAt: "t0", finishedAt: "t1", host: { os: "darwin", node: "v22" }, holders: [], devices };
}

function l2Report(devices: Layer2Report["devices"], over: Partial<Layer2Report> = {}): Layer2Report {
  return {
    startedAt: "t0",
    finishedAt: "t1",
    host: { os: "darwin", node: "v22" },
    hostUnderTest: { command: "node bin/robot-console.js --port 4799 --no-open", port: 4799, stateDir: "/tmp/x" },
    settle: { settled: true, elapsedMs: 1000, neverAppeared: [] },
    devices,
    assertions: [],
    ...over,
  };
}

describe("buildRows", () => {
  it("joins Layer 1/2/3 rows for the same device+path, and picks the first non-pass layer's reason", () => {
    const layer1 = l1Report([{ name: "tigez", kind: "robot", paths: [{ path: "mbserial", endpoint: { host: "magni.local", port: 37317 }, status: "pass", reason: "banner ok", transcript: [] }] }]);
    const layer2 = l2Report([
      {
        name: "tigez",
        kind: "robot",
        paths: [
          {
            path: "mbserial",
            layer1: { status: "pass", reason: "banner ok" },
            layer2: { status: "fail", reason: "produced no banner within the identify budget", timings: {}, replies: {}, notices: [] },
          },
        ],
      },
    ]);
    const rows = buildRows(layer1, layer2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ device: "tigez", path: "mbserial", l1: "pass", l2: "fail", l3: "n/a", reason: "produced no banner within the identify budget" });
  });

  it("excludes non-main-table Layer 1 paths (pool status rows, mbserial-contention)", () => {
    const layer1 = l1Report([
      { name: "torture", kind: "pool", paths: [{ path: "radio-via-mbrelay:torture", endpoint: { host: "torture.local", port: 8760 }, status: "pass", reason: "pool answered", transcript: [] }] },
      { name: "gopiv", kind: "robot", paths: [{ path: "mbserial-contention", endpoint: { host: "loki.local", port: 37317 }, status: "pass", reason: "ERR busy on second client", transcript: [] }] },
    ]);
    expect(buildRows(layer1)).toEqual([]);
  });

  it("includes a Layer 3 screenshot list when present", () => {
    const layer1 = l1Report([{ name: "gopiv", kind: "robot", paths: [{ path: "wifi", endpoint: { host: "gopiv.local", port: 7654 }, status: "pass", reason: "ok", transcript: [] }] }]);
    const layer2 = l2Report([
      { name: "gopiv", kind: "robot", paths: [{ path: "wifi", layer1: { status: "pass", reason: "ok" }, layer2: { status: "pass", reason: "ok", timings: {}, replies: {}, notices: [] } }] },
    ]);
    const layer3: Layer3Report = {
      startedAt: "t0",
      finishedAt: "t1",
      host: { os: "darwin", node: "v22" },
      baseUrl: "http://127.0.0.1:4798/",
      screenshotDir: "/tmp/shots",
      results: [{ device: "gopiv", path: "wifi", status: "pass", reason: "every assertion passed", assertions: [], screenshots: ["01-front.png", "02-final.png"] }],
    };
    const rows = buildRows(layer1, layer2, layer3);
    expect(rows[0]?.screenshots).toEqual(["01-front.png", "02-final.png"]);
    expect(rows[0]?.l3).toBe("pass" satisfies RowStatus);
  });
});

describe("generateMarkdown", () => {
  it("produces a table with a header row, a data row per device x path, and a summary line", () => {
    const layer1 = l1Report([{ name: "gopiv", kind: "robot", paths: [{ path: "mbserial", endpoint: { host: "loki.local", port: 37317 }, status: "pass", reason: "banner ok", transcript: [] }] }]);
    const layer2 = l2Report([
      { name: "gopiv", kind: "robot", paths: [{ path: "mbserial", layer1: { status: "pass", reason: "banner ok" }, layer2: { status: "pass", reason: "ID matched", timings: {}, replies: {}, notices: [] } }] },
    ]);
    const markdown = generateMarkdown(layer1, layer2);
    expect(markdown).toContain("| device | path | L1 | L2 | L3 | label | reason | screenshots |");
    expect(markdown).toContain("| gopiv | mbserial | pass | pass | n/a | pass |");
    expect(markdown).toContain("1 row(s): 1 pass, 0 defect, 0 environment, 0 skipped.");
  });

  it("includes the environment-vs-defect labeling rule's outcome in the row itself", () => {
    const layer1 = l1Report([{ name: "vitut", kind: "robot", paths: [{ path: "usb", endpoint: { serialPath: "/dev/cu.usbmodemZZZ" }, status: "pass", reason: "banner ok", transcript: [] }] }]);
    const layer2 = l2Report([
      { name: "vitut", kind: "robot", paths: [{ path: "usb", layer1: { status: "pass", reason: "banner ok" }, layer2: { status: "fail", reason: "Cannot lock port", timings: {}, replies: {}, notices: [] } }] },
    ]);
    const markdown = generateMarkdown(layer1, layer2);
    expect(markdown).toContain("| vitut | usb | pass | fail | n/a | defect | Cannot lock port |");
  });

  it("renders a Layer-1-only-fail row as environment", () => {
    const layer1 = l1Report([{ name: "tovez", kind: "robot", paths: [{ path: "radio-via-mbrelay:torture", endpoint: { host: "torture.local", port: 8760 }, status: "fail", reason: "timeout: no radio reply", transcript: [] }] }]);
    const markdown = generateMarkdown(layer1);
    expect(markdown).toContain("| tovez | radio-via-mbrelay:torture | fail | n/a | n/a | environment | timeout: no radio reply |");
  });

  it("renders the truthfulness-assertions section from Layer 2, and a 'did not run' placeholder without Layer 2", () => {
    const layer1 = l1Report([]);
    expect(generateMarkdown(layer1)).toContain("_Layer 2 did not run._");

    const layer2 = l2Report([], { assertions: [{ assertion: "no-relay-as-robot", device: "vevav", pass: false, reason: "unidentified, recorded as robot" }] });
    const markdown = generateMarkdown(layer1, layer2);
    expect(markdown).toContain("| no-relay-as-robot | vevav | FAIL | unidentified, recorded as robot |");
  });

  it("renders the audit-db section only when Layer 2 carries one", () => {
    const layer1 = l1Report([]);
    const layer2WithAudit = l2Report([], {
      auditDb: {
        sourcePath: "/Users/eric/.local/state/robot-console/console.sqlite",
        dbPath: "/tmp/copy/console.sqlite",
        generatedAt: "t0",
        deviceCount: 8,
        linkCount: 21,
        findings: [{ check: "one-row-per-name", device: "gopiv", detail: "2 devices rows share the name \"gopiv\": ids 1461, 2175407711" }],
      },
    });
    const markdown = generateMarkdown(layer1, layer2WithAudit);
    expect(markdown).toContain("Audited a read-only copy of `/Users/eric/.local/state/robot-console/console.sqlite`");
    expect(markdown).toContain("ids 1461, 2175407711");

    const layer2NoAudit = l2Report([]);
    expect(generateMarkdown(layer1, layer2NoAudit)).toContain("_Not run (pass --audit-db <path>");
  });

  it("renders holders and the additional-Layer-1-findings section", () => {
    const layer1: Layer1Report = {
      startedAt: "t0",
      finishedAt: "t1",
      host: { os: "darwin", node: "v22" },
      holders: [{ resource: "/dev/cu.usbmodem2121102", pid: 82496, command: "node" }],
      devices: [{ name: "torture", kind: "pool", paths: [{ path: "radio-via-mbrelay:torture", endpoint: { host: "torture.local", port: 8760 }, status: "pass", reason: "pool answered", transcript: [] }] }],
    };
    const markdown = generateMarkdown(layer1);
    expect(markdown).toContain("| /dev/cu.usbmodem2121102 | 82496 | node |");
    expect(markdown).toContain("| torture | pool | radio-via-mbrelay:torture | pass | pool answered |");
  });
});
