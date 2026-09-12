import { describe, expect, it } from "vitest";
import { Session } from "./session.js";
import { receive } from "./receive.js";

describe("receive()", () => {
  it("drops a blank line silently -- dropped: 'blank', nothing else set", () => {
    const result = receive(new Session(), "   ");
    expect(result).toEqual({ resend: [], dropped: "blank" });
  });

  it("drops an over-length line -- dropped: 'tooLong'", () => {
    const huge = "GET " + "x".repeat(300);
    const result = receive(new Session(), huge);
    expect(result.dropped).toBe("tooLong");
    expect(result.resend).toEqual([]);
    expect(result.line).toBeUndefined();
  });

  it("hands a foreign (unrecognized lowercase) line to unrouted, and fires onForeign", () => {
    const seen: string[] = [];
    const result = receive(new Session(), "beep boop overheard", { onForeign: (raw) => seen.push(raw) });
    expect(result).toEqual({ resend: [], unrouted: "beep boop overheard" });
    expect(seen).toEqual(["beep boop overheard"]);
  });

  it("does not require onForeign -- a foreign line is still unrouted, just unobserved", () => {
    const result = receive(new Session(), "# a relay comment");
    expect(result.unrouted).toBe("# a relay comment");
    expect(result.line).toBeUndefined();
  });

  it("hands a command-direction line (an echo) to unrouted, never dispatched as a reply", () => {
    const result = receive(new Session(), "STOP #1");
    expect(result).toEqual({ resend: [], unrouted: "STOP #1" });
  });

  it("dispatches a recognized non-ack/nack reply verb as 'line', with no ackNack", () => {
    const result = receive(new Session(), "pong");
    expect(result.line).toEqual({ kind: "line", verb: "pong", fields: [] });
    expect(result.ackNack).toBeUndefined();
    expect(result.resend).toEqual([]);
  });

  it("strips the '< ' receive-prefix before classifying (decodeLine's own job)", () => {
    const result = receive(new Session(), "< pong");
    expect(result.line).toEqual({ kind: "line", verb: "pong", fields: [] });
  });

  it("feeds an ack to the session and reports it via ackNack, with no resend", () => {
    const session = new Session();
    session.connect();
    session.send("STOP"); // #1
    const result = receive(session, "ack 1 1 ok");
    expect(result.ackNack).toEqual(
      expect.objectContaining({ kind: "ack", n: 1, seq: 1 }),
    );
    expect(result.resend).toEqual([]);
    expect(session.pendingCount).toBe(0);
  });

  it("reports a malformed ack/nack as ackNack.kind 'malformed', never throwing", () => {
    const session = new Session();
    expect(() => receive(session, "ack 1 0")).not.toThrow();
    const result = receive(session, "ack 1 0");
    expect(result.ackNack).toEqual(
      expect.objectContaining({ kind: "malformed", verb: "ack" }),
    );
    expect(result.resend).toEqual([]);
  });

  it("on nack, returns the resend lines that must be written before anything else", () => {
    const session = new Session();
    session.connect();
    const line = session.send("STOP"); // #1
    const result = receive(session, "nack 1 0 none");
    expect(result.resend).toEqual([line]);
    expect(result.ackNack).toEqual(
      expect.objectContaining({ kind: "nack", n: 1, seq: 0 }),
    );
  });

  it("reproduces the gap-stall-recover scenario end to end through raw wire text (previously exercised only via host/link/LineRouter.test.ts)", () => {
    const session = new Session();
    session.connect();
    const l1 = session.send("STOP"); // #1 -- lost in transit
    const l2 = session.send("RUN"); // #2

    // #2 arrives at the robot before #1 -- a numeric gap. It nacks
    // next-expected (still 1), and every still-pending id resends, in
    // order.
    const first = receive(session, "nack 1 0 none");
    expect(first.resend).toEqual([l1, l2]);
    expect(first.ackNack).toEqual(
      expect.objectContaining({ kind: "nack", n: 1, seq: 0, desynced: false }),
    );

    // The gap is still open -- a second nack for the identical id is
    // the stream still stalled, not recovering yet, and resends the
    // same backlog again.
    const second = receive(session, "nack 1 0 none");
    expect(second.resend).toEqual([l1, l2]);

    // The missing #1 (and everything behind it) finally arrives in
    // order -- one cumulative ack retires the whole backlog and the
    // stream recovers.
    const third = receive(session, "ack 2 0 none");
    expect(third.resend).toEqual([]);
    expect(third.ackNack).toEqual(
      expect.objectContaining({ kind: "ack", n: 2, seq: 2 }),
    );
    expect(session.seq).toBe(2);
    expect(session.pendingCount).toBe(0);
  });
});
