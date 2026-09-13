/**
 * types.ts — shared JSON shapes for the Layer 2 host-over-WebSocket
 * bench harness (sprint 018 ticket 002).
 *
 * Deliberately mirrors Layer 1's own report shape
 * (`layer1/types.ts`'s `Layer1Report`/`DeviceEntry`/`PathResult`) --
 * one `devices[].paths[]` row per device x path, with a `layer2` field
 * added onto each path alongside the `layer1` verdict it was computed
 * from, plus a top-level `assertions[]` array for the three
 * card-truthfulness checks -- per the ticket's own "JSON output shape
 * consistent with Layer 1" instruction.
 */
import type { ProbeStatus } from "../layer1/types.js";

/** Outcome of one path's `session-open` -> `send-command ID` ->
 * `session-close` round trip over the host's own WebSocket contract.
 * `"skipped"` mirrors Layer 1's own meaning: the exclusivity check
 * found this path's underlying resource held by another process. */
export type Layer2Status = "pass" | "fail" | "skipped";

export interface Layer2Timings {
  /** How long from `session-open` until the link was observed
   * `state: "connected"` with a session, in the snapshot stream. */
  toConnectedMs?: number;
  /** How long from `send-command ID` until a matching `line` rx
   * arrived. */
  toReplyMs?: number;
}

export interface Layer2Replies {
  /** The verbatim `line` rx text the `ID` command's reply matched
   * (`toLowerCase().startsWith("id ")`), if any. */
  line?: string;
}

export interface Layer2Check {
  status: Layer2Status;
  reason: string;
  timings: Layer2Timings;
  replies: Layer2Replies;
  /** Every `notice` observed for this link during the check (verbatim
   * `text`), plus the link's own `state`/`reason` on failure -- so a
   * failure here carries the same "verbatim, not summarized" evidence
   * Layer 1's own transcripts do. */
  notices: string[];
}

/** One device x path row -- `layer1` is that path's Layer 1 verdict,
 * carried through for a reader's convenience (this is the "one path
 * that passed Layer 1 but failed Layer 2 is a host/UI defect" table
 * the whole harness exists to produce); `layer2` is this ticket's own
 * new verdict. */
export interface Layer2PathEntry {
  path: string;
  layer1: { status: ProbeStatus; reason: string };
  layer2: Layer2Check;
}

export interface Layer2DeviceEntry {
  name: string;
  kind: string;
  paths: Layer2PathEntry[];
}

export type AssertionName = "no-stale-while-advertised" | "no-relay-as-robot" | "one-row-per-name";

/** One card-truthfulness assertion result, always per-device (never
 * folded into one whole-run pass/fail), per the ticket's own
 * acceptance criterion. */
export interface AssertionResult {
  assertion: AssertionName;
  device: string;
  pass: boolean;
  reason: string;
}

export interface Layer2Report {
  startedAt: string;
  finishedAt: string;
  host: { os: string; node: string };
  hostUnderTest: { command: string; port: number; stateDir: string };
  /** The settle step's own outcome -- see `wsClient.ts`'s
   * `waitForSettle`. `neverAppeared` names every expected path (by its
   * `describeTarget`-style label) whose link never showed up in any
   * snapshot within the bound. */
  settle: { settled: boolean; elapsedMs: number; neverAppeared: string[] };
  devices: Layer2DeviceEntry[];
  assertions: AssertionResult[];
}
