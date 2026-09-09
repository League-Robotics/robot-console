import { describe, expect, it } from "vitest";
import { decodeLine, Session, type DecodedLine } from "@robot-console/protocol";
import { LineRouter } from "./LineRouter.js";

// Exercises the decode -> classify -> ack/nack -> resend -> dispatch
// path directly against a real Session, independent of any transport
// (no UsbSerialLink, no serial port fake) -- see the ticket's own
// acceptance criterion that this must be unit-tested on its own.

function router(session: Session) {
  const lines: unknown[] = [];
  const ackNacks: unknown[] = [];
  const resends: string[] = [];
  const unrouted: string[] = [];
  const lineRouter = new LineRouter(session, {
    onLine: (line) => lines.push(line),
    onAckNack: (event) => ackNacks.push(event),
    resend: (line) => resends.push(line),
    onUnrouted: (raw) => unrouted.push(raw),
  });
  return { lineRouter, lines, ackNacks, resends, unrouted };
}

describe("LineRouter", () => {
  it("delivers a recognized reply-direction line to onLine", () => {
    const { lineRouter, lines } = router(new Session());
    lineRouter.handleLine("pong");
    expect(lines).toEqual([{ kind: "line", verb: "pong", fields: [] }]);
  });

  it("hands a foreign (unrecognized lowercase) line to onUnrouted as raw text, never to onLine or the session", () => {
    const { lineRouter, lines, ackNacks, unrouted } = router(new Session());
    expect(() => lineRouter.handleLine("beep boop overheard")).not.toThrow();
    expect(lines).toEqual([]);
    expect(ackNacks).toEqual([]);
    expect(unrouted).toEqual(["beep boop overheard"]);
  });

  it("hands a relay's # command-plane reply to onUnrouted verbatim (OOP 2026-09-09: the console must show it)", () => {
    const { lineRouter, lines, unrouted } = router(new Session());
    lineRouter.handleLine("# Relay v0.20260907.1 -- commands: !CG !GO !P");
    expect(lines).toEqual([]);
    expect(unrouted).toEqual(["# Relay v0.20260907.1 -- commands: !CG !GO !P"]);
  });

  it("drops a blank line silently -- not even onUnrouted", () => {
    const { lineRouter, lines, unrouted } = router(new Session());
    lineRouter.handleLine("   ");
    expect(lines).toEqual([]);
    expect(unrouted).toEqual([]);
  });

  it("hands a command-direction line (an echo) to onUnrouted, never surfaced as a reply", () => {
    const { lineRouter, lines, unrouted } = router(new Session());
    lineRouter.handleLine("STOP #1");
    expect(lines).toEqual([]);
    expect(unrouted).toEqual(["STOP #1"]);
  });

  it("is unchanged for a caller that passes no onUnrouted: unrecognized lines are simply dropped", () => {
    const lineRouter = new LineRouter(new Session(), { onLine: () => {}, onAckNack: () => {}, resend: () => {} });
    expect(() => lineRouter.handleLine("# whatever")).not.toThrow();
  });

  it("feeds an ack to the session, fires onAckNack, and requests no resend", () => {
    const session = new Session();
    session.connect(); // seq = 1, next id = 1
    session.send("STOP"); // id 1
    const { lineRouter, lines, ackNacks, resends } = router(session);

    lineRouter.handleLine("ack 1 1 ok");

    expect(session.seq).toBe(1);
    expect(session.pendingCount).toBe(0);
    expect(ackNacks).toHaveLength(1);
    expect(resends).toEqual([]);
    // ack/nack lines are still dispatched to onLine, same as any other
    // reply verb.
    expect(lines).toHaveLength(1);
  });

  it("on nack, resends the correct pending line through the resend callback -- seq = n - 1, not n", () => {
    // Regression coverage for the nack arithmetic this class centralizes
    // (see its own module doc comment): `nack N` carries next-expected,
    // not last-good, so the correct update is `seq = N - 1`.
    const session = new Session();
    session.connect();
    const line = session.send("STOP"); // id 1, e.g. "STOP #1\n"
    const { lineRouter, resends } = router(session);

    lineRouter.handleLine("nack 1 0 none");

    expect(session.seq).toBe(0); // n - 1 = 1 - 1 = 0
    expect(resends).toEqual([line]);
  });

  it("resends every still-pending line in ascending id order on nack", () => {
    const session = new Session();
    session.connect();
    const first = session.send("STOP"); // id 1
    const second = session.send("RUN"); // id 2
    const { lineRouter, resends } = router(session);

    lineRouter.handleLine("nack 1 0 none");

    expect(resends).toEqual([first, second]);
  });

  it("never resends when the robot's sequence has desynced below every pending id -- no unbounded resend stream", () => {
    // Regression coverage for a real reported bug: the robot's own
    // expectedNext_ resets (reflash/power-cycle/stray HELLO) to a value
    // below every id the host is still holding pending. Every id the
    // host could resend is still numerically ahead of what the
    // just-reset robot expects, so it would be discarded and re-nacked
    // with the identical id -- forever, if this class ever called
    // `resend` for it. It must not.
    const session = new Session();
    session.connect();
    session.send("STOP"); // id 1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine); // confirm #1
    session.send("STOP"); // id 2
    session.send("RUN"); // id 3
    const { lineRouter, resends, ackNacks } = router(session);

    lineRouter.handleLine("nack 1 0 none");
    expect(resends).toEqual([]);
    expect(ackNacks).toEqual([
      expect.objectContaining({ kind: "nack", n: 1, desynced: true, resend: [] }),
    ]);

    // A second identical nack -- as an unresynced session would keep
    // producing -- still resends nothing. This is the "unbounded resend
    // stream" the bug report described; asserting it does not happen
    // twice in a row is the point, not just once.
    lineRouter.handleLine("nack 1 0 none");
    expect(resends).toEqual([]);
  });
});
