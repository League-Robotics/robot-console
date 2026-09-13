/**
 * harvester.ts — the real implementation behind `connect/connector.ts`'s
 * {@link HarvesterAttach} seam (sprint 015 ticket 003; issue
 * `rearch-05-connector-reconciler-harvester-retire-deviceregistry.md`;
 * `docs/design/architecture.md` §8). Ticket 001 stubbed the seam with a
 * no-op default so the connector did not have to wait for this module to
 * exist; this is that real implementation, wired in by whichever caller
 * constructs the connector (ticket 005's composition root).
 *
 * Per open {@link ConnectedSession}, salvaged near-verbatim from
 * `deviceRegistry.ts`'s own per-endpoint bookkeeping (line numbers as of
 * this sprint's own review pass, `docs/reviews/2026-09-11/01-host-device-
 * model.md`):
 *
 * - `handleInboundLine` (`:3349-3408`) — dispatch on `decoded.verb`.
 * - `handleTelemetryLine` (`:3502-3520`) — `thdr`/`t` zipping via
 *   `@robot-console/protocol`'s `TelemetryDecoder`.
 * - `adoptStatusNext` (`:3531-3543`) — silently resync the session's own
 *   next-id counter when a `status` reply's `next=` field disagrees and
 *   nothing is pending.
 * - `reportDesyncIfNeeded` (`:3705-3729`) — a resync notice, once per
 *   episode, never once per send.
 * - `startRobotProbes`/`pollStatus` (`:3579-3645`) — the unsequenced `ID`
 *   probe sent once per identify, and the `STATUS` poll plus its
 *   watchdog.
 *
 * ## What changed from the original
 *
 * Two deliberate differences, both per this ticket's own Description:
 *
 * - The missed-poll watchdog applies to **every** transport, not only
 *   WiFi (the original's `WIFI_POLL_MISS_LIMIT` gate was itself a
 *   stand-in for "this link can go silent without the OS telling us",
 *   which is just as true of a radio/mbrelay hop as it is of WiFi).
 * - Exactly one error path: {@link ConnectedSession.link}'s own
 *   `onClose`, and the missed-poll watchdog, both funnel through one
 *   internal `fail()` that writes `links.state = 'unresponsive'` at most
 *   once and stops polling — never an emit per poll, per this ticket's
 *   own acceptance criteria. The old module's `sessionError`/`emitDevices`/
 *   `emitError` fan-out has no equivalent here: this module owns no
 *   broadcast of its own (ticket 004's wire contract reads `links`/
 *   `sessions` rows through the store's own change feed instead).
 *
 * Telemetry (`thdr`/`t`) is deliberately never written to `sessions` —
 * matches the original's own "no `emitDevices` on the 20 Hz path"
 * discipline — and is instead forwarded to {@link HarvesterDeps.onTelemetry},
 * an injectable sink ticket 004's snapshot projection wires up for real.
 * A resync notice ({@link reportDesyncIfNeeded}'s old text) is forwarded
 * the same way, via {@link HarvesterDeps.onNotice}; both default to a
 * no-op so this module has no hard dependency on either not existing yet.
 */
import {
  TelemetryDecoder,
  type AckNackEvent,
  type DecodedLine,
} from "@robot-console/protocol";
import type { RobotFunction, RobotStatus } from "../wsMessages.js";
import type { Store } from "../store/index.js";
import type { ConnectedSession, HarvesterAttach } from "./connector.js";

/** `STATUS` poll cadence — matches `deviceRegistry.ts`'s own
 * `DeviceRegistryOptions.statusPollIntervalMs` default. */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
/** Missed-`STATUS`-poll ceiling before a link is declared dead —
 * `deviceRegistry.ts`'s own `WIFI_POLL_MISS_LIMIT`, generalized to every
 * transport per this module's own doc comment. */
export const DEFAULT_MISSED_POLL_LIMIT = 3;

/** One decoded `thdr`/`t` event, forwarded to {@link HarvesterDeps.onTelemetry} —
 * mirrors `wsMessages.ts`'s own `TelemetryMessage` shape minus the
 * envelope (`type`/`endpointId`), which is ticket 004's concern, not
 * this module's. */
export interface HarvesterTelemetryEvent {
  header?: readonly string[];
  frame?: Record<string, string>;
}

export interface HarvesterDeps {
  /** Wall-clock reader for every store timestamp. Defaults to
   * `Date.now`. */
  now?: () => number;
  /** `STATUS` poll cadence. Defaults to {@link DEFAULT_STATUS_POLL_INTERVAL_MS}.
   * `0` disables polling entirely (tests only — production never sets
   * this). */
  statusPollIntervalMs?: number;
  /** Missed-poll ceiling. Defaults to {@link DEFAULT_MISSED_POLL_LIMIT}. */
  missedPollLimit?: number;
  /** `thdr`/`t` sink — see the module doc comment. Defaults to a no-op. */
  onTelemetry?: (linkId: string, event: HarvesterTelemetryEvent) => void;
  /** Resync-notice sink — see the module doc comment. Defaults to a
   * no-op. */
  onNotice?: (linkId: string, message: string) => void;
}

/** Parse a `status k=v ...` reply's fields (robot firmware
 * `wire_handler.cpp` `execStatus`) into a {@link RobotStatus}. Salvaged
 * verbatim from `deviceRegistry.ts:1031-1053` (deleted by this same
 * ticket) — see that function's own original doc comment: the named
 * booleans come from the `flags=<hex>` bitfield (`wire_adapter.h`: bit0
 * ready, bit1 estopped, bit2 stall-halted, bit3 lease-expired); a field
 * with no `=` is kept under its own text with an empty value rather than
 * dropped. */
function parseStatusReply(fields: readonly string[], now: number): RobotStatus {
  const map: Record<string, string> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1) {
      map[field] = "";
    } else {
      map[field.slice(0, eq)] = field.slice(eq + 1);
    }
  }
  const flagsText = map["flags"];
  const flags = flagsText !== undefined ? Number.parseInt(flagsText, 16) : Number.NaN;
  const bit = (n: number): boolean => Number.isFinite(flags) && (flags & (1 << n)) !== 0;
  return {
    receivedAt: now,
    fields: map,
    ready: Number.isFinite(flags) ? bit(0) : map["ready"] === "1",
    active: map["active"] === "1",
    estopped: bit(1),
    stallHalted: bit(2),
    leaseExpired: bit(3),
  };
}

/**
 * Build the real {@link HarvesterAttach} implementation bound to `store`.
 * See the module doc comment for the full contract.
 */
export function createHarvester(store: Store, deps: HarvesterDeps = {}): HarvesterAttach {
  const now = deps.now ?? (() => Date.now());
  const statusPollIntervalMs = deps.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const missedPollLimit = deps.missedPollLimit ?? DEFAULT_MISSED_POLL_LIMIT;
  const onTelemetry = deps.onTelemetry ?? (() => {});
  const onNotice = deps.onNotice ?? (() => {});

  return {
    attach(session: ConnectedSession): void {
      const { linkId, link, classification } = session;

      let functions: RobotFunction[] = [];
      let pollAwaitingStatus = false;
      let pollMisses = 0;
      let desyncNotified = false;
      let failed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const telemetryDecoder = new TelemetryDecoder();

      function stopPolling(): void {
        if (pollTimer !== undefined) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
      }

      /** The one error path (module doc comment): writes `unresponsive`
       * at most once and stops polling for good -- neither `onClose` nor
       * a later missed-poll tick can re-enter once this has run.
       *
       * Bench defect 010 addendum (2026-09-13, "dead transport leaves
       * session, blocks reconnect"): also closes `link` itself. A
       * missed-poll-detected death (the watchdog branch below) is, on
       * its own, only ever a `links.state` write -- the transport is
       * still nominally open, so nothing raises `LineLink.onClose`, and
       * `connect/reconciler.ts`'s own teardown (the single owner of a
       * `sessions` row -- see that module's doc comment) never runs. A
       * real `onClose`-triggered `fail()` call already has an idempotent
       * `link.close()` to make (the stream is already closed at that
       * point), so this is a no-op there; it is exactly what closes the
       * transport for the watchdog branch, converging both causes of
       * death on the one `onClose` event the reconciler reacts to. */
      function fail(reason: string): void {
        if (failed) {
          return;
        }
        failed = true;
        stopPolling();
        store.setLinkState({ id: linkId, state: "unresponsive", at: now(), reason });
        void link.close();
      }

      function pollStatus(): void {
        if (failed || !link.isOpen) {
          return;
        }
        if (pollAwaitingStatus) {
          pollMisses += 1;
          if (pollMisses >= missedPollLimit) {
            fail(`no reply to ${missedPollLimit} STATUS polls -- link presumed dead`);
            return;
          }
        }
        try {
          link.sendUnsequenced("STATUS");
          pollAwaitingStatus = true;
        } catch {
          // A failed write is not, on its own, evidence the link is
          // dead -- the missed-poll ceiling (or `onClose`) is what
          // decides that; see this function's own "exactly one error
          // path" doc comment.
        }
      }

      function handleTelemetryLine(decoded: DecodedLine): void {
        if (decoded.verb === "thdr") {
          telemetryDecoder.handleHeader(decoded.fields);
          onTelemetry(linkId, { header: telemetryDecoder.currentHeader ?? decoded.fields });
          return;
        }
        const result = telemetryDecoder.decodeFrame(decoded.fields);
        if (result.kind === "noHeaderHeld" || result.kind === "fieldCountMismatch") {
          // Drop silently -- see `handleTelemetryLine`'s original doc
          // comment ("Passive header recovery"): there is nothing useful
          // to send to speed recovery up, and the decoder's held header
          // (if any) is untouched by a mismatch.
          return;
        }
        onTelemetry(linkId, { frame: result.fields });
      }

      /** `status next=<expectedNext_>` (protocol.md §8.7): with nothing
       * pending, adopt the robot's own next-expected id silently if it
       * disagrees with this session's local counter -- never touched
       * while a command is in flight (the ack/nack path owns that
       * case). Salvaged from `deviceRegistry.ts:3531-3543`. */
      function adoptStatusNext(status: RobotStatus): void {
        const nextText = status.fields["next"];
        if (nextText === undefined || link.session.pendingCount > 0) {
          return;
        }
        const next = Number(nextText);
        if (!Number.isInteger(next) || next < 1 || next === link.session.nextSequenceId) {
          return;
        }
        link.session.resyncTo(next);
        desyncNotified = false;
      }

      /** Persist the session's own sequencing counters -- part of "Writes
       * `sessions.robot_status`/`functions`/`seq`/`pending`" (this
       * ticket's own Description) -- alongside whatever verb-specific
       * patch a caller also supplies. */
      function syncSession(patch: { robotStatus?: RobotStatus; functions?: RobotFunction[] } = {}): void {
        store.updateSession(linkId, {
          seq: link.session.seq,
          pending: link.session.pendingCount,
          lastDone: link.session.lastDone,
          lastDoneReason: link.session.lastDoneReason,
          // `Store.updateSession`'s own `robotStatus`/`functions` fields
          // are pre-serialized JSON text (it JSON-encodes `functions`
          // itself but not `robotStatus` -- see `UpdateSessionInput`'s
          // own doc comment in store/index.ts), so this module -- the
          // one place that ever writes either -- serializes here.
          ...(patch.robotStatus !== undefined ? { robotStatus: JSON.stringify(patch.robotStatus) } : {}),
          ...(patch.functions !== undefined ? { functions: patch.functions } : {}),
        });
      }

      // No detach counterpart exists on `HarvesterAttach` (ticket 001's
      // own interface), so nothing in this module ever needs to
      // unsubscribe early -- these three subscriptions live as long as
      // `link` itself, torn down implicitly once the connector/
      // reconciler discards the `LineLink` instance.
      link.onClose((reason) => {
        fail(reason ? reason.message : "link closed");
      });

      link.onLine((decoded: DecodedLine) => {
        if (failed) {
          return;
        }
        if (decoded.verb === "thdr" || decoded.verb === "t") {
          // Deliberately never reaches `syncSession` -- see the module
          // doc comment's "no `emitDevices` on the 20 Hz path" note.
          handleTelemetryLine(decoded);
          return;
        }
        if (decoded.verb === "status") {
          pollAwaitingStatus = false;
          pollMisses = 0;
          const status = parseStatusReply(decoded.fields, now());
          syncSession({ robotStatus: status });
          adoptStatusNext(status);
          return;
        }
        if (decoded.verb === "estop") {
          // The `ESTOP` verb's own reply -- flip `estopped` immediately,
          // ahead of the next `STATUS` poll confirming it (mirrors
          // `handleInboundLine`'s own `estop` branch).
          syncSession({
            robotStatus: {
              receivedAt: now(),
              fields: {},
              ready: false,
              active: false,
              estopped: true,
              stallHalted: false,
              leaseExpired: false,
            },
          });
          return;
        }
        if (decoded.verb === "funcs") {
          const name = decoded.fields[0];
          if (name !== undefined && name.length > 0) {
            const fn: RobotFunction = { name };
            const signature = decoded.fields.slice(1).join(" ");
            if (signature.length > 0) {
              fn.signature = signature;
            }
            functions = [...functions, fn];
          }
          syncSession({ functions });
          return;
        }
        // Every other reply verb (`id`, `ack`/`nack`'s own decoded line,
        // `ver`, `help`, `debug`, ...) still refreshes the session's own
        // sequencing counters even though this module harvests nothing
        // verb-specific from it -- matches this ticket's own acceptance
        // criteria ("id ... update the session row").
        syncSession();
      });

      /** Resync notice, once per episode -- salvaged from
       * `deviceRegistry.ts:3705-3729`. */
      link.onAckNack((event: AckNackEvent) => {
        if (failed) {
          return;
        }
        if (event.kind === "ack") {
          // Progress: a later reset is a new episode worth reporting again.
          desyncNotified = false;
          return;
        }
        if (event.gaveUp !== undefined) {
          onNotice(
            linkId,
            `The robot kept rejecting "${event.gaveUp.replace(/\n$/, "")}" as malformed -- dropped it and continued at #${event.n}.`,
          );
          return;
        }
        if (!event.desynced || desyncNotified) {
          return;
        }
        desyncNotified = true;
        onNotice(linkId, `The robot restarted its command counter -- resynced automatically, continuing at #${event.n}.`);
      });

      if (classification.type === "robot") {
        try {
          link.sendUnsequenced("ID");
        } catch {
          // Best-effort, exactly like `pollStatus`'s own write failure
          // handling -- absence of a reply (or a failed send) is never
          // evidence of anything; classification simply stays as-is.
        }
        if (statusPollIntervalMs > 0) {
          pollStatus();
          pollTimer = setInterval(pollStatus, statusPollIntervalMs);
          pollTimer.unref?.();
        }
      }
    },
  };
}
