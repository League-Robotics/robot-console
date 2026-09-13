/**
 * types.ts — shared JSON shapes for the Layer 3 headless-Chrome bench
 * harness (sprint 018 ticket 003). Mirrors Layers 1/2's own report
 * shape (one row per device x path) — see `layer1/types.ts`'s module
 * doc comment for why that consistency matters across all three
 * layers and the report generator that reads them.
 */

export type Layer3Status = "pass" | "fail" | "skipped";

/** One assertion Layer 3 checked on a given path's page(s) -- reported
 * individually (not folded into one whole-path pass/fail) so a report
 * reader can see exactly which check failed, matching Layers 1/2's own
 * "one result per thing checked" discipline. */
export interface Layer3Assertion {
  name: "reply-within-5s" | "header-shows-linked" | "no-disabled-controls-when-not-linked" | "no-raw-ids-in-card-text" | "relay-names-attempted-robot";
  pass: boolean;
  detail: string;
}

export interface Layer3PathResult {
  device: string;
  path: string;
  status: Layer3Status;
  reason: string;
  assertions: Layer3Assertion[];
  /** Screenshot file paths, relative to the report's own screenshot
   * directory -- absolute paths are never embedded here so a report
   * moved to another machine still links correctly. */
  screenshots: string[];
}

export interface Layer3Report {
  startedAt: string;
  finishedAt: string;
  host: { os: string; node: string };
  baseUrl: string;
  /** Directory every `screenshots[]` entry above is relative to. */
  screenshotDir: string;
  results: Layer3PathResult[];
}
