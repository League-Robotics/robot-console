import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeLine, REPLY_VERBS, type DecodedLine } from "./codec.js";
import {
  isSequencedVerb,
  Session,
  SessionError,
  SEQUENCED_VERBS,
  MAX_RESENDS,
  type AckNackEvent,
  type MalformedReplyEvent,
} from "./session.js";

// ---------------------------------------------------------------------
// Conformance fixture: read from the vendored submodule, never copied
// into this repo (same posture as codec.test.ts/radioAddress.test.ts --
// a copy would silently drift from upstream). Parsed and filtered here
// at test time; the vectors themselves are never inlined.
//
// Canonical upstream source:
//   vendor/radio-robot-lib/tests/protocol/golden_vectors.txt
//   (normative spec: vendor/radio-robot-lib/docs/design/protocol.md S8)
// ---------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../",
);
const VECTORS_PATH = path.join(
  REPO_ROOT,
  "vendor/radio-robot-lib/tests/protocol/golden_vectors.txt",
);

/**
 * Whether the `vendor/radio-robot-lib` submodule is initialized in this
 * checkout. Every test below that needs the golden-vectors fixture is
 * gated on this so the synthetic, fixture-free tests in this file
 * always run without `git submodule update --init` (ticket 014-004's
 * fixture-independence acceptance criterion).
 */
const VENDOR_PRESENT = existsSync(VECTORS_PATH);

function readVectorsFile(): string {
  try {
    return readFileSync(VECTORS_PATH, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Golden vectors file not found at ${VECTORS_PATH}. ` +
          "The vendor/radio-robot-lib submodule is not initialized -- " +
          "run `git submodule update --init` from the repo root, then re-run the tests.",
      );
    }
    throw err;
  }
}

interface AckNackVector {
  /** The literal wire content, e.g. "ack 1 7 stop". */
  content: string;
  kind: "ack" | "nack";
  n: number;
  lastDone: number;
  reason: string;
}

/**
 * Every `OUT ack ...` / `OUT nack ...` line in the fixture, parsed into
 * its own vector. golden_vectors.txt's own header states each block
 * "runs against a handle that has JUST BEEN RESET" (a fresh `HELLO` at
 * the top of every block) -- so each `ack`/`nack` line's `n`/`lastDone`/
 * `reason` triple is independently meaningful without needing to replay
 * a whole block's SETUP/IN history: this test only exercises
 * session.ts's own arithmetic (`ack N -> seq=N`, `nack N -> seq=N-1`,
 * `lastDone`/`lastDoneReason` piggyback), not the C++ handler's
 * decode/dispatch logic that produced these lines in the first place --
 * that side is codec.ts/ticket 004's own concern.
 */
function parseAckNackVectors(raw: string): AckNackVector[] {
  const vectors: AckNackVector[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("OUT ack ") && !line.startsWith("OUT nack ")) {
      continue;
    }
    const content = line.slice(4);
    const decoded = decodeLine(content);
    if (decoded.kind !== "line") {
      continue;
    }
    const kind = decoded.verb as "ack" | "nack";
    const [nText, lastDoneText, reason] = decoded.fields;
    if (nText === undefined || lastDoneText === undefined || reason === undefined) {
      continue;
    }
    vectors.push({
      content,
      kind,
      n: Number(nText),
      lastDone: Number(lastDoneText),
      reason,
    });
  }
  return vectors;
}

const ACK_NACK_VECTORS = VENDOR_PRESENT ? parseAckNackVectors(readVectorsFile()) : [];

describe("golden_vectors.txt fixture", () => {
  it.skipIf(!VENDOR_PRESENT)("finds at least one ack vector and one nack vector", () => {
    expect(ACK_NACK_VECTORS.some((v) => v.kind === "ack")).toBe(true);
    expect(ACK_NACK_VECTORS.some((v) => v.kind === "nack")).toBe(true);
  });
});

describe("golden vectors drive Session's ack/nack arithmetic", () => {
  it.each(ACK_NACK_VECTORS.map((v) => [v.content, v] as const))(
    "%s",
    (_content, vector) => {
      // Each vector is fed to a FRESH session, matching the fixture's own
      // "just reset" framing -- this isolates session.ts's own
      // arithmetic from any pending/retransmit bookkeeping, which the
      // synthetic sequence tests below cover directly.
      const session = new Session();
      const decoded = decodeLine(vector.content) as DecodedLine;
      const event = session.handleReply(decoded) as AckNackEvent;
      expect(event.kind).toBe(vector.kind);
      expect(event.n).toBe(vector.n);
      expect(event.lastDone).toBe(vector.lastDone);
      expect(event.lastDoneReason).toBe(vector.reason);
      if (vector.kind === "ack") {
        expect(session.seq).toBe(vector.n);
      } else {
        expect(session.seq).toBe(vector.n - 1);
      }
      expect(session.lastDone).toBe(vector.lastDone);
      expect(session.lastDoneReason).toBe(vector.reason);
    },
  );
});

// ---------------------------------------------------------------------
// nack N -> seq = N-1, explicit and named (the arithmetic a sibling
// repo actually got backwards, per the ticket -- pinned directly so a
// future edit that regresses this fails loudly, not against hardware).
// ---------------------------------------------------------------------

describe("nack N sets seq to N-1, NOT N (the logged-bug arithmetic)", () => {
  it("nack 5 ... sets seq to 4", () => {
    const session = new Session();
    const decoded = decodeLine("nack 5 0 none") as DecodedLine;
    const event = session.handleReply(decoded) as AckNackEvent;
    expect(event.n).toBe(5);
    expect(event.seq).toBe(4);
    expect(session.seq).toBe(4);
    // The wrong, last-good interpretation would set this to 5 -- assert
    // it explicitly so a regression here fails this exact expectation,
    // not just a golden-vector round trip.
    expect(session.seq).not.toBe(5);
  });

  it("ack 5 ... (contrast) sets seq to exactly 5", () => {
    const session = new Session();
    const decoded = decodeLine("ack 5 0 none") as DecodedLine;
    const event = session.handleReply(decoded) as AckNackEvent;
    expect(event.seq).toBe(5);
    expect(session.seq).toBe(5);
  });
});

// ---------------------------------------------------------------------
// The 12-verb id-bearing allowlist -- positive and negative
// ---------------------------------------------------------------------

describe("only the 13 named verbs are id-bearing", () => {
  const ELEVEN = [
    "GET",
    "SET",
    "TLM",
    "STOP",
    "RUN",
    "WHEELS_X",
    "WHEELS_V",
    "MOVE_X",
    "MOVE_V",
    "GO_TO_R",
    "GO_TO_W",
    "FUNCS",
    "WIFICRED",
  ];

  it("SEQUENCED_VERBS is exactly the 13 named verbs", () => {
    expect([...SEQUENCED_VERBS].sort()).toEqual([...ELEVEN].sort());
    expect(SEQUENCED_VERBS.size).toBe(13);
  });

  it.each(ELEVEN)("send() assigns a sequence id to %s", (verb) => {
    const session = new Session();
    const line = session.send(verb, []);
    expect(line).toMatch(/ #1\n$/);
    expect(isSequencedVerb(verb)).toBe(true);
  });

  it.each(["HELLO", "PING", "STATUS", "ID", "VER", "HELP", "ESTOP", "FOO"])(
    "send() refuses %s -- it is not one of the 11",
    (verb) => {
      const session = new Session();
      expect(() => session.send(verb, [])).toThrow(SessionError);
      expect(isSequencedVerb(verb)).toBe(false);
    },
  );

  it.each(["PING", "STATUS", "ID", "VER", "HELP", "ESTOP", "FOO"])(
    "sendUnsequenced() formats %s with no id at all",
    (verb) => {
      const session = new Session();
      const line = session.sendUnsequenced(verb, []);
      expect(line).toBe(`${verb}\n`);
      expect(line).not.toContain("#");
    },
  );

  it.each(ELEVEN)(
    "sendUnsequenced() refuses %s -- it IS one of the 11",
    (verb) => {
      const session = new Session();
      expect(() => session.sendUnsequenced(verb, [])).toThrow(SessionError);
    },
  );

  it("sending an id-bearing verb never touches seq/lastDone, only ack/nack does", () => {
    const session = new Session();
    session.send("GET", ["foo"]);
    expect(session.seq).toBe(0);
    expect(session.lastDone).toBe(0);
    expect(session.lastDoneReason).toBe("none");
  });
});

// ---------------------------------------------------------------------
// HELLO: connect() is the only path that formats it, and it resets
// local state; sendUnsequenced("HELLO") is refused with a pointer to
// connect()/checkLiveness() -- the "structurally awkward, not just
// documented" requirement.
// ---------------------------------------------------------------------

describe("HELLO resets the session -- connect() vs. checkLiveness()", () => {
  it("connect() formats HELLO with no id", () => {
    const session = new Session();
    expect(session.connect()).toBe("HELLO\n");
  });

  it("connect() resets seq to 1", () => {
    const session = new Session();
    session.send("GET", ["foo"]); // no ack yet
    const decoded = decodeLine("ack 1 0 none") as DecodedLine;
    session.handleReply(decoded);
    expect(session.seq).toBe(1);
    session.connect();
    expect(session.seq).toBe(1);
  });

  it("connect() resets the id counter -- the next send() is #1 again", () => {
    const session = new Session();
    session.send("GET", ["foo"]); // #1
    session.send("GET", ["bar"]); // #2
    session.connect();
    const line = session.send("GET", ["baz"]);
    expect(line).toBe("GET baz #1\n");
  });

  it("connect() clears the pending table -- nothing pre-reset is retransmittable afterward", () => {
    const session = new Session();
    session.send("GET", ["foo"]); // #1, never acked
    expect(session.pendingCount).toBe(1);
    session.connect();
    expect(session.pendingCount).toBe(0);
    expect(() => session.retransmit(1)).toThrow(SessionError);
  });

  it("connect() does NOT touch lastDone/lastDoneReason (Adapter-owned, protocol.md S8.8)", () => {
    const session = new Session();
    session.handleReply(decodeLine("ack 1 7 stop") as DecodedLine);
    expect(session.lastDone).toBe(7);
    session.connect();
    expect(session.lastDone).toBe(7);
    expect(session.lastDoneReason).toBe("stop");
  });

  it("connect() resets lastResendN/resendStreak, matching resyncTo() -- a reconnect must not inherit a pre-reset give-up streak", () => {
    // Regression coverage for the bug this ticket fixes: connect() used
    // to reset nextId/pending/seq but not lastResendN/resendStreak. A
    // session that had already resent #1 MAX_RESENDS times against a
    // stuck nack, then reconnected and sent a brand new #1, would trip
    // resendStreak > MAX_RESENDS on the very first ordinary resend after
    // reconnecting and give up prematurely.
    const session = new Session();
    session.send("STOP"); // #1
    for (let i = 0; i < MAX_RESENDS; i++) {
      const event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
      expect(event.gaveUp).toBeUndefined();
    }
    // One more identical nack would give up here, pre-reconnect -- do
    // NOT send it; reconnect instead.
    session.connect(); // fresh HELLO -- id counter, pending table, AND the streak all reset
    session.send("STOP"); // brand new #1 under the fresh session
    const afterReconnect = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(afterReconnect.gaveUp).toBeUndefined();
    expect(afterReconnect.resend).toHaveLength(1);
  });

  it("checkLiveness() formats PING with no id and touches no session state", () => {
    const session = new Session();
    session.send("GET", ["foo"]);
    const before = { seq: session.seq, pendingCount: session.pendingCount };
    expect(session.checkLiveness()).toBe("PING\n");
    expect(session.seq).toBe(before.seq);
    expect(session.pendingCount).toBe(before.pendingCount);
  });

  it("sendUnsequenced('HELLO') is refused, structurally steering the caller to connect()", () => {
    const session = new Session();
    expect(() => session.sendUnsequenced("HELLO", [])).toThrow(SessionError);
    try {
      session.sendUnsequenced("HELLO", []);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).message).toMatch(/connect\(\)/);
      expect((err as SessionError).message).toMatch(/checkLiveness\(\)/);
    }
  });
});

// ---------------------------------------------------------------------
// Synthetic sequencing scenarios: in-order flow, lost ack + retransmit
// (original id reused), a gap + stall, recovery, and the trailing-nack-
// after-reply tolerance.
// ---------------------------------------------------------------------

describe("in-order flow", () => {
  it("two sequenced sends, cumulative ack retires both", () => {
    const session = new Session();
    const l1 = session.send("WHEELS_V", [100, 100, 1000]);
    const l2 = session.send("STOP", []);
    expect(l1).toBe("WHEELS_V 100 100 1000 #1\n");
    expect(l2).toBe("STOP #2\n");
    expect(session.pendingCount).toBe(2);

    const event = session.handleReply(
      decodeLine("ack 2 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.kind).toBe("ack");
    expect(event.resend).toEqual([]);
    expect(session.seq).toBe(2);
    expect(session.pendingCount).toBe(0);
  });
});

describe("a lost ack: retransmit reuses the ORIGINAL id", () => {
  it("nack naming the still-outstanding id resends the exact original line", () => {
    const session = new Session();
    const original = session.send("WHEELS_V", [100, 100, 1000]);
    expect(original).toBe("WHEELS_V 100 100 1000 #1\n");

    // The robot never saw (or never got the ack for) #1 -- it re-nacks
    // #1, the still-outstanding id.
    const event = session.handleReply(
      decodeLine("nack 1 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.kind).toBe("nack");
    expect(event.resend).toEqual([original]);
    // Byte-identical: same id, same fields, not a freshly-generated id.
    expect(event.resend[0]).toContain("#1");
  });

  it("retransmit(id) independently returns the same original line, never a fresh one", () => {
    const session = new Session();
    const original = session.send("GET", ["wheel_control.pid_kp"]);
    expect(session.retransmit(1)).toBe(original);
  });

  it("retransmit() refuses an id that was never sent or is already retired", () => {
    const session = new Session();
    expect(() => session.retransmit(1)).toThrow(SessionError);
    session.send("GET", ["foo"]); // #1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine);
    expect(() => session.retransmit(1)).toThrow(SessionError);
  });
});

describe("a gap stalls the stream until the missing id arrives, then recovers", () => {
  it("eight-command-style scenario: a middle command lost, gap nacked, backlog resent, then recovery", () => {
    const session = new Session();
    const l1 = session.send("MOVE_X", [400, 1571, 200, 5000]); // #1 -- this one is lost in transit
    const l2 = session.send("MOVE_X", [400, 0, 200, 5000]); // #2
    const l3 = session.send("STOP", []); // #3

    // #2 arrived at the robot before #1 -- a numeric gap. The robot
    // discards #2 without executing it and nacks expectedNext_ (still
    // 1, since #1 never arrived) -- it does NOT "recover" by skipping
    // ahead to #2.
    let event = session.handleReply(
      decodeLine("nack 1 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.kind).toBe("nack");
    expect(session.seq).toBe(0);
    // Every still-pending id >= the gap resends, in order -- the whole
    // backlog, not just the missing one, matching protocol.md S8.1's
    // "resend from next forward, in order".
    expect(event.resend).toEqual([l1, l2, l3]);

    // A second, later inbound line while the gap is still open re-nacks
    // the SAME next-id (S8.1: "a lost nack self-heals" because every
    // subsequent line re-triggers the identical nack) -- the stream is
    // still stalled, not recovering yet.
    event = session.handleReply(
      decodeLine("nack 1 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.seq).toBe(0);
    expect(event.resend).toEqual([l1, l2, l3]);

    // The missing #1 (and everything resent behind it) finally arrives
    // in order -- a single cumulative ack retires the whole backlog.
    event = session.handleReply(
      decodeLine("ack 3 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.kind).toBe("ack");
    expect(session.seq).toBe(3);
    expect(session.pendingCount).toBe(0);
  });
});

describe("trailing nack after an unsequenced verb's own reply (protocol.md S8.3's conditional reminder)", () => {
  it("a pong followed by its own trailing nack, as two separate lines, is not a protocol violation", () => {
    const session = new Session();
    session.send("GET", ["foo"]); // #1, outstanding -- a stall is open

    // The reply line itself: session has no opinion about `pong`.
    const pongEvent = session.handleReply(decodeLine("pong 999") as DecodedLine);
    expect(pongEvent).toBeNull();

    // The trailing reminder nack, on its OWN line right after: handled
    // exactly like any other nack, not flagged as unexpected merely for
    // following a reply that itself carried no ack/nack.
    const nackEvent = session.handleReply(
      decodeLine("nack 1 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(nackEvent.kind).toBe("nack");
    expect(nackEvent.n).toBe(1);
    expect(session.seq).toBe(0);
  });

  it("every non-ack/nack reply verb returns null from handleReply, never throws", () => {
    const session = new Session();
    for (const verb of REPLY_VERBS) {
      if (verb === "ack" || verb === "nack") {
        continue;
      }
      const decoded: DecodedLine = { kind: "line", verb, fields: [] };
      expect(session.handleReply(decoded)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------
// Desync detection: a nack the host cannot possibly satisfy by
// retransmitting (the robot's own sequence reset below everything the
// host is holding) must not produce an unbounded resend stream. See
// AckNackEvent.desynced's own doc comment for the full reasoning.
// ---------------------------------------------------------------------

describe("a robot whose sequence reset below every pending id is a desync, not a lost frame", () => {
  it("nack 1 with every pending id above 1 does not retransmit, is flagged desynced, and resyncs to 1 (OOP 2026-09-09)", () => {
    const session = new Session();
    session.send("WHEELS_V", [100, 100, 1000]); // #1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine); // confirm #1 -- seq=1
    session.send("WHEELS_V", [100, 100, 1000]); // #2
    session.send("WHEELS_V", [100, 100, 1000]); // #3
    expect(session.pendingCount).toBe(2);

    // The robot rebooted mid-session: its own expectedNext_ reset to 1.
    // #2/#3 can never satisfy a robot asking for #1, and retransmitting
    // them would just re-trigger the identical nack forever.
    const event = session.handleReply(
      decodeLine("nack 1 0 none") as DecodedLine,
    ) as AckNackEvent;
    expect(event.kind).toBe("nack");
    expect(event.desynced).toBe(true);
    expect(event.resend).toEqual([]);
    expect(session.pendingCount).toBe(0);
    // The robot said what it wants next; the session simply adopts it.
    expect(session.nextSequenceId).toBe(1);
    expect(session.seq).toBe(0);
    expect(session.send("WHEELS_V", [100, 100, 1000])).toBe("WHEELS_V 100 100 1000 #1\n");
  });

  it("a held-button style repeat converges: after the desync the next send carries the robot's expected id and a further nack is an ordinary resend", () => {
    const session = new Session();
    session.send("WHEELS_V", [100, 100, 1000]); // #1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine); // confirm #1 -- seq=1

    session.send("WHEELS_V", [100, 100, 1000]); // #2 -- robot has since reset
    let event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.resend).toEqual([]);
    expect(event.desynced).toBe(true);

    const resent = session.send("WHEELS_V", [100, 100, 1000]); // now #1, which the robot expects
    expect(resent).toBe("WHEELS_V 100 100 1000 #1\n");
    // A nack 1 now (a genuinely lost frame) is satisfiable: resend #1.
    event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.desynced).toBe(false);
    expect(event.resend).toEqual([resent]);
    // And the ack lands normally.
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine);
    expect(session.pendingCount).toBe(0);
    expect(session.nextSequenceId).toBe(2);
  });

  it("a bare repeated nack with nothing newly sent is not re-flagged (nothing left to protect)", () => {
    const session = new Session();
    session.send("WHEELS_V", [100, 100, 1000]); // #1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine);
    session.send("WHEELS_V", [100, 100, 1000]); // #2

    const first = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(first.desynced).toBe(true);
    expect(session.pendingCount).toBe(0);

    const second = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(second.resend).toEqual([]);
    expect(second.desynced).toBe(false);
  });

  it("resyncTo(n) adopts n directly (status next= while nothing is pending), ignoring nonsense", () => {
    const session = new Session();
    session.send("GET", []); // #1
    session.handleReply(decodeLine("ack 1 0 none") as DecodedLine);
    expect(session.nextSequenceId).toBe(2);
    session.resyncTo(7);
    expect(session.nextSequenceId).toBe(7);
    expect(session.seq).toBe(6);
    session.resyncTo(0);
    session.resyncTo(2.5);
    expect(session.nextSequenceId).toBe(7);
  });

  it("gives up on a line the robot keeps nacking after MAX_RESENDS identical resends, resyncs to n, and reports the dropped line", () => {
    const session = new Session();
    const bad = session.send("GET", []); // #1 -- pretend the robot cannot decode it
    session.send("GET", []); // #2
    for (let i = 0; i < MAX_RESENDS; i++) {
      const event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
      expect(event.gaveUp).toBeUndefined();
      expect(event.resend[0]).toBe(bad);
    }
    const event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.gaveUp).toBe(bad);
    expect(event.resend).toEqual([]);
    expect(session.pendingCount).toBe(0);
    // The stream moves on: the next command reuses the id the robot is waiting for.
    expect(session.send("GET", [])).toBe("GET #1\n");
    expect(session.nextSequenceId).toBe(2);
  });

  it("the give-up counter resets on progress: alternating nacks for different ids never trip it", () => {
    const session = new Session();
    session.send("GET", []); // #1
    session.send("GET", []); // #2
    for (let i = 0; i < MAX_RESENDS + 2; i++) {
      expect((session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent).gaveUp).toBeUndefined();
      session.handleReply(decodeLine("ack 1 0 none") as DecodedLine);
      session.send("GET", []);
      expect((session.handleReply(decodeLine("nack 2 0 none") as DecodedLine) as AckNackEvent).gaveUp).toBeUndefined();
      session.handleReply(decodeLine("ack 2 0 none") as DecodedLine);
      session.resyncTo(1);
      session.send("GET", []);
      session.send("GET", []);
    }
  });

  it("does NOT regress the legitimate case: a nack for an id the host still holds is not desynced, and resends normally", () => {
    const session = new Session();
    const original = session.send("WHEELS_V", [100, 100, 1000]); // #1
    const event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.desynced).toBe(false);
    expect(event.resend).toEqual([original]);
  });

  it("does NOT regress the golden-vector gap-and-recovery scenario's repeated identical nack", () => {
    // Mirrors the "a gap stalls the stream" describe block above:
    // pending = {#1, #2, #3}, nack 1 arrives twice in a row -- both
    // times the host DOES hold #1, so this must keep resending the
    // whole backlog both times, not just once.
    const session = new Session();
    const l1 = session.send("MOVE_X", [400, 1571, 200, 5000]);
    const l2 = session.send("MOVE_X", [400, 0, 200, 5000]);
    const l3 = session.send("STOP", []);

    let event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.desynced).toBe(false);
    expect(event.resend).toEqual([l1, l2, l3]);

    event = session.handleReply(decodeLine("nack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.desynced).toBe(false);
    expect(event.resend).toEqual([l1, l2, l3]);
  });

  it("ack events are never desynced", () => {
    const session = new Session();
    session.send("GET", ["foo"]);
    const event = session.handleReply(decodeLine("ack 1 0 none") as DecodedLine) as AckNackEvent;
    expect(event.desynced).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Case folding: a caller-supplied verb spelling must never select a
// different classification or wire-cased output depending on its case
// -- protocol.md S2.1's case-as-direction rule governs what a line
// looks like ON THE WIRE, not how a caller's own verb text is
// classified before this class ever encodes it.
// ---------------------------------------------------------------------

describe("verb comparisons fold case -- lowercase input never silently switches behavior", () => {
  it("isSequencedVerb is case-insensitive", () => {
    expect(isSequencedVerb("get")).toBe(true);
    expect(isSequencedVerb("Get")).toBe(true);
    expect(isSequencedVerb("GET")).toBe(true);
    expect(isSequencedVerb("hello")).toBe(false);
  });

  it("send() accepts a lowercase spelling of a sequenced verb and encodes it canonically uppercase", () => {
    const session = new Session();
    const line = session.send("get", ["foo"]);
    expect(line).toBe("GET foo #1\n");
  });

  it("sendUnsequenced() accepts a lowercase spelling and encodes it canonically uppercase", () => {
    const session = new Session();
    const line = session.sendUnsequenced("ping");
    expect(line).toBe("PING\n");
  });

  it("sendUnsequenced('hello') is refused exactly like sendUnsequenced('HELLO') -- case cannot pick a different code path", () => {
    const session = new Session();
    for (const spelling of ["hello", "Hello", "HELLO", "hElLo"]) {
      expect(() => session.sendUnsequenced(spelling, [])).toThrow(SessionError);
    }
  });

  it("send() refuses a lowercase non-sequenced verb exactly like its uppercase spelling", () => {
    const session = new Session();
    expect(() => session.send("ping", [])).toThrow(SessionError);
  });
});

describe("malformed ack/nack replies return a {kind: 'malformed'} event rather than throwing (ticket 014-004)", () => {
  it("too few fields -- returns {kind: 'malformed'}, does not throw", () => {
    const session = new Session();
    const decoded: DecodedLine = { kind: "line", verb: "ack", fields: ["1"] };
    let event: AckNackEvent | MalformedReplyEvent | null = null;
    expect(() => {
      event = session.handleReply(decoded);
    }).not.toThrow();
    expect(event).toEqual({
      kind: "malformed",
      verb: "ack",
      fields: ["1"],
      reason: expect.stringContaining("expected 3 fields"),
    });
  });

  it("non-integer n -- returns {kind: 'malformed'}, does not throw", () => {
    const session = new Session();
    const decoded: DecodedLine = {
      kind: "line",
      verb: "ack",
      fields: ["notanumber", "0", "none"],
    };
    const event = session.handleReply(decoded);
    expect(event).toEqual({
      kind: "malformed",
      verb: "ack",
      fields: ["notanumber", "0", "none"],
      reason: expect.stringContaining("non-integer"),
    });
  });

  it("a malformed nack is reported the same way, tagged verb: 'nack'", () => {
    const session = new Session();
    const decoded: DecodedLine = { kind: "line", verb: "nack", fields: ["not-a-number", "0", "none"] };
    const event = session.handleReply(decoded);
    expect(event).toEqual(
      expect.objectContaining({ kind: "malformed", verb: "nack" }),
    );
  });

  it("a malformed reply leaves session state completely untouched", () => {
    const session = new Session();
    session.send("STOP"); // #1, outstanding
    const before = { seq: session.seq, pendingCount: session.pendingCount, lastDone: session.lastDone };
    session.handleReply({ kind: "line", verb: "ack", fields: ["oops"] });
    expect(session.seq).toBe(before.seq);
    expect(session.pendingCount).toBe(before.pendingCount);
    expect(session.lastDone).toBe(before.lastDone);
  });
});
