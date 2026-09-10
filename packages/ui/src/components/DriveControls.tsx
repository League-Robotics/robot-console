/**
 * DriveControls.tsx — the robot page's single drive pad: held-direction
 * `WHEELS_V` driving, one-shot fixed-angle `MOVE_X` turns, and STOP/
 * E-STOP, all in one 3x3 grid (ticket 005 / SUC-001; STOP/E-STOP and
 * fixed turns merged in out-of-process, 2026-09-10).
 *
 * **Why `WHEELS_V` for held driving.** Per
 * `vendor/radio-robot-lib/docs/design/motion-api.md`, `DiffDriveAdapter`
 * — the only concrete `Adapter` this project's firmware ships — has no
 * planner and answers `WHEELS_X`/`MOVE_V`/`GO_TO_R`/`GO_TO_W` with an
 * unknown-command error. Only `WHEELS_V left right duration` (velocity,
 * `[mm/s]`) and `STOP`/`STOP now` were implemented at the time that
 * finding was written up. Offering any of the other verbs for *held*
 * driving would ship buttons that reliably error — not a real
 * capability.
 *
 * **`MOVE_X` for fixed turns is a deliberate, separately-verified
 * exception to that finding** (stakeholder spec, 2026-09-10): the fixed
 * 90°/180° turn buttons below are one-shot, not a held lease, and the
 * wire fields are exactly `MOVE_X <distance> <rotation> <cruise>
 * <timeout> #<id>` (`protocol.md` §6 verb table; `motion-api.md` §3.3
 * for the field list — distance `[mm]`, rotation, cruise `[mm/s]`,
 * timeout `[ms]`). `distance` is always `0` — these buttons turn in
 * place, they do not also translate.
 *
 * **`rotation` is milliradians on the wire, not degrees (fixed
 * out-of-process, 2026-09-10).** `motion-api.md` §9.1 states the rule
 * plainly -- "degrees at the API and milliradian integers on the
 * wire... the conversion lives in the binding, in one place" -- and
 * this component *is* that binding: it talks straight to the wire-level
 * `MOVE_X` verb via `sendCommand`, with no degrees-native client
 * library underneath doing the conversion for it. The first version of
 * these buttons sent a bare `90`/`180` and every fixed turn barely
 * twitched on real hardware. The bench capture that caught it commanded
 * a 90 degree pivot as `MOVE_X 0 1571 100 5000`
 * (`vendor/pxt-nezha-diffdrive/captures/bench-acceptance-029-20260904/
 * notes.md:95`) -- `1571 == round(90 * pi / 180 * 1000)`. See
 * {@link degreesToMilliradians}, which every fixed turn now goes
 * through before it ever reaches `sendCommand`.
 *
 * **Yaw is CCW-positive** (`vendor/pxt-nezha-diffdrive/src/blocks/
 * motion.ts`, "angle to turn CCW+"): a left turn is a positive rotation,
 * a right turn negative, in degrees at this component's own level --
 * {@link degreesToMilliradians} converts only at the point of sending.
 * See {@link TURN_CRUISE_MM_S}, {@link TURN_90_TIMEOUT_MS},
 * {@link TURN_180_TIMEOUT_MS} for the other three `MOVE_X` fields sent.
 *
 * **`duration` is a lease, not a one-shot** (motion-api.md §1: bounded
 * by time; the wheel kernel's `drive(velocity, twist, lease)` stops on
 * its own once the lease elapses even if nothing else ever speaks to
 * it again). A held directional control must therefore re-issue
 * `WHEELS_V` before the previous lease expires, and must send `STOP` on
 * release — otherwise either the robot stops mid-hold (lease expired,
 * nothing renewed it) or it coasts on past release (nothing ever told
 * it to stop).
 *
 * **Resend interval chosen here: {@link DRIVE_RESEND_INTERVAL_MS} = 150ms,
 * lease {@link DRIVE_LEASE_MS} = 400ms.** 150ms sits comfortably inside
 * a 400ms lease (2.6 resends per lease window), so a single missed
 * interval tick under normal event-loop jitter still lands well before
 * the lease would expire. 150ms is also nowhere near the host's own
 * ~10ms `WritePacer` floor (ticket 003) — this timer is a UI-side lease
 * discipline layered *on top of* that pacing, not a replacement for
 * it, and firing every 150ms rather than every 10ms avoids saturating
 * the pacer with resends a held button does not need.
 *
 * **Velocity magnitude ({@link DRIVE_VELOCITY_MM_S} = 150 mm/s)** is a
 * single moderate, classroom-safe demo speed — not tuned against a
 * real robot (that tuning is explicitly hardware-deferred, per this
 * ticket's Acceptance Criteria: this component's tests prove the
 * command *plumbing*, not real-world motion). Held-direction turning is
 * a pivot (`wheels_v(-v, +v)`/`wheels_v(+v, -v)`) rather than an arc,
 * mirroring motion-api.md §2's `wheels_x(+d, -d)` in-place-pivot special
 * case; sign convention follows motion-api.md §2.1's "CCW-positive,
 * left wheel is the slower one" rule (positive omega — a left turn —
 * comes from the left wheel going slower/negative, the right wheel
 * faster/positive).
 *
 * On release (mouse/touch up, mouse leaving the button while held, the
 * link closing, or this component unmounting while a direction is
 * held), the resend timer is cleared and an unsequenced-in-spirit but
 * still sequenced `STOP` (per protocol.md/motion-api.md §9.1, `STOP` is
 * one of the 11 sequenced verbs) is sent with no fields, matching
 * `stop()`'s wire form (`STOP #<id>`, no positional args).
 *
 * **STOP/E-STOP, merged in from the now-retired `EstopControl.tsx`
 * (out-of-process, 2026-09-10).** The center cell of the 3x3 pad carries
 * two square stop-sign-icon buttons side by side:
 *  - **STOP** (`data-testid="stop-button"`) — a plain, non-latching
 *    stop. `STOP now` zeroes the wheels this cycle and resolves the
 *    active motion with reason `stop` (firmware `WireAdapter::onStop`)
 *    — no latch, no clear step, the next drive command just works. A
 *    routine started with `RUN` (square, tour, ...) would keep issuing
 *    moves after that, so when the robot's function list includes
 *    `abort`, `RUN abort` is sent right after.
 *  - **E-STOP** (`data-testid="estop-button"`) — `ESTOP`, outside the
 *    sequence entirely (protocol.md §8.3/§9): no id, never acked or
 *    nacked, dispatched via plain `sendCommand` exactly like every
 *    other verb this component sends. Never gated on `sequencing`/
 *    pending state — a `WHEELS_V` lease resend in flight, a `GET`/`SET`
 *    awaiting `ack`, or any pending `MOVE_X` must never stand between a
 *    student and this button. Repeated presses are harmless: each is an
 *    independent `sendCommand` call, and `ESTOP` being unsequenced means
 *    the host never queues, rejects, or errors on a second one arriving
 *    while the first is still being acted on. Its icon gets a
 *    "latched" visual variant while
 *    `device.robotStatus?.estopped` is `true`.
 *  - **Clear E-STOP** (`data-testid="estop-clear-button"`) — rendered
 *    directly under the pad, only while `device.robotStatus?.estopped`
 *    is `true` (hidden entirely, not just disabled, the rest of the
 *    time — there is nothing to clear, and showing it regardless would
 *    invite a confusing no-op press): `SET estop_clear 1` (sequenced)
 *    to release the latch, immediately followed by a one-shot `STATUS`
 *    so the panel's own state reflects the clear without waiting for
 *    the host's next poll tick.
 *
 * None of the above three read or care about `sequencing` in any form
 * — the only thing that disables any button on this pad is
 * `device.sessionOpen` being false (nothing to send at all).
 *
 * **Hardware-deferred claim.** This component's own tests (fake
 * `WsProvider` socket) prove only that pressing a button sends the
 * exact wire line at the right time, under the right conditions. They
 * do not and cannot prove that a real robot moves or stops moving —
 * that is a hardware-verified safety claim, checked separately against
 * real hardware.
 *
 * **Hold/release + click hints.** "Hold a direction to drive; release
 * to stop." (bolded "Hold") covers the four directional buttons; "Click
 * a turn button for a fixed turn." (added 2026-09-10) covers the four
 * corner turn buttons, which are one-shot clicks, not holds.
 */
import { useEffect, useRef, useState } from "react";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import "./DriveControls.css";

/** [mm/s] -- see this module's doc comment for why 150. */
const DRIVE_VELOCITY_MM_S = 150;
/** [ms] -- the `WHEELS_V` lease length sent with every resend. */
const DRIVE_LEASE_MS = 400;
/** [ms] -- how often a held direction re-issues `WHEELS_V`, well inside
 * {@link DRIVE_LEASE_MS}. See this module's doc comment. */
const DRIVE_RESEND_INTERVAL_MS = 150;

/** `cruise` field for every fixed-angle `MOVE_X` turn. `0` is not "zero
 * speed" -- it is the wire's own "use the robot's configured default
 * cruise" sentinel (`motion-api.md` §1.1: "An X-form's commanded value
 * is a displacement... so `cruise` is its own argument. Pass `0` for
 * the configured default."), confirmed against a real board by the
 * `MOVE_X 100 0 0 8000 #1` line in the tovez acceptance capture
 * (`vendor/pxt-nezha-diffdrive/captures/
 * consolidation-acceptance-tovez-20260906/notes.md:100`). Corrected
 * out-of-process, 2026-09-10, from a previously-sent `150` -- an
 * assumed mm/s value that was never actually verified against the
 * wire's own contract for this field, the same class of mistake as the
 * `rotation` units bug this same pass fixed (see this module's doc
 * comment). */
const TURN_CRUISE_MM_S = 0;
/** [ms] -- `timeout` field for a fixed 90 degree `MOVE_X` turn. */
const TURN_90_TIMEOUT_MS = 4000;
/** [ms] -- `timeout` field for a fixed 180 degree `MOVE_X` turn (longer
 * than {@link TURN_90_TIMEOUT_MS} -- twice the rotation, more time to
 * finish it before the adapter gives up). */
const TURN_180_TIMEOUT_MS = 6000;

/** Converts a signed API-level angle in whole degrees to the signed
 * wire-level integer milliradians `MOVE_X`'s `rotation` field actually
 * wants -- see this module's doc comment for why this conversion has to
 * happen here rather than further down some binding this project
 * doesn't have. Verified against the bench capture that caught the bug
 * this fixes: `round(90 * pi / 180 * 1000) === 1571`, matching
 * `MOVE_X 0 1571 100 5000`'s commanded +90 degrees
 * (`vendor/pxt-nezha-diffdrive/captures/bench-acceptance-029-20260904/
 * notes.md:95`). */
const degreesToMilliradians = (deg: number) => Math.round((deg * Math.PI) / 180 * 1000);

export type DriveDirection = "forward" | "backward" | "left" | "right";

const DIRECTION_LABELS: Record<DriveDirection, string> = {
  forward: "Forward",
  backward: "Backward",
  left: "Turn left",
  right: "Turn right",
};

/** `[left, right]` wheel velocities, `[mm/s]`, for one held direction.
 * See this module's doc comment for the sign convention. */
function wheelVelocities(direction: DriveDirection): [number, number] {
  switch (direction) {
    case "forward":
      return [DRIVE_VELOCITY_MM_S, DRIVE_VELOCITY_MM_S];
    case "backward":
      return [-DRIVE_VELOCITY_MM_S, -DRIVE_VELOCITY_MM_S];
    case "left":
      return [-DRIVE_VELOCITY_MM_S, DRIVE_VELOCITY_MM_S];
    case "right":
      return [DRIVE_VELOCITY_MM_S, -DRIVE_VELOCITY_MM_S];
  }
}

/** One entry per fixed-turn button. `rotation` is the signed `[deg]`
 * field sent as `MOVE_X`'s second argument -- CCW-positive, so every
 * "left" entry is positive and every "right" entry negative (this
 * module's doc comment). `gridArea` names the `grid-template-areas`
 * cell (DriveControls.css) the button occupies in the 3x3 pad. */
interface FixedTurn {
  testId: string;
  ariaLabel: string;
  degreesLabel: string;
  icon: "ccw" | "cw";
  rotation: number;
  timeoutMs: number;
  gridArea: string;
}

/** Named individually (rather than indexed out of an array) so every
 * call site is a direct reference `TypeScript` can prove is defined --
 * `noUncheckedIndexedAccess` makes `array[i]` come back `T | undefined`
 * even for a literal in-range index. */
const TURN_90_LEFT: FixedTurn = {
  testId: "turn-90-left",
  ariaLabel: "Turn 90 degrees left",
  degreesLabel: "90",
  icon: "ccw",
  rotation: 90,
  timeoutMs: TURN_90_TIMEOUT_MS,
  gridArea: "turn90left",
};

const TURN_90_RIGHT: FixedTurn = {
  testId: "turn-90-right",
  ariaLabel: "Turn 90 degrees right",
  degreesLabel: "90",
  icon: "cw",
  rotation: -90,
  timeoutMs: TURN_90_TIMEOUT_MS,
  gridArea: "turn90right",
};

const TURN_180_LEFT: FixedTurn = {
  testId: "turn-180-left",
  ariaLabel: "Turn 180 degrees left",
  degreesLabel: "180",
  icon: "ccw",
  rotation: 180,
  timeoutMs: TURN_180_TIMEOUT_MS,
  gridArea: "turn180left",
};

const TURN_180_RIGHT: FixedTurn = {
  testId: "turn-180-right",
  ariaLabel: "Turn 180 degrees right",
  degreesLabel: "180",
  icon: "cw",
  rotation: -180,
  timeoutMs: TURN_180_TIMEOUT_MS,
  gridArea: "turn180right",
};

/** A small circular-arrow glyph (Feather-style `rotate-ccw`/`rotate-cw`
 * paths) -- deliberately icon-only with no visible text, so the button
 * itself carries the degree number and `aria-label` carries the words
 * ("Turn 90 degrees left") that a screen reader or a test asserts on.
 * `aria-hidden` here because the enclosing button's own `aria-label`
 * already gives the accessible name -- this SVG must never be read as a
 * second, redundant description. */
function TurnArrowIcon({ direction }: { direction: "ccw" | "cw" }) {
  const commonProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      className="drive-controls-turn-icon"
    >
      {direction === "ccw" ? (
        <>
          <polyline points="1 4 1 10 7 10" {...commonProps} />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" {...commonProps} />
        </>
      ) : (
        <>
          <polyline points="23 4 23 10 17 10" {...commonProps} />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" {...commonProps} />
        </>
      )}
    </svg>
  );
}

/** A plain octagonal stop sign, optionally carrying a white "E" (the
 * E-STOP variant) and an optional "latched" visual state (dimmed body,
 * outlined rather than filled) for while `robotStatus.estopped` is
 * `true`. `aria-hidden` for the same reason as {@link TurnArrowIcon} --
 * the enclosing button's own `aria-label`/text is the accessible name. */
function StopSignIcon({ letter, latched }: { letter: boolean; latched: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <polygon
        points="8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8"
        className={
          latched
            ? "drive-controls-stop-icon-body drive-controls-stop-icon-body-latched"
            : "drive-controls-stop-icon-body"
        }
      />
      {letter && (
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          className={
            latched
              ? "drive-controls-stop-icon-letter drive-controls-stop-icon-letter-latched"
              : "drive-controls-stop-icon-letter"
          }
        >
          E
        </text>
      )}
    </svg>
  );
}

export interface DriveControlsProps {
  device: EndpointListEntry;
}

export function DriveControls({ device }: DriveControlsProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();
  const [activeDirection, setActiveDirection] = useState<DriveDirection | null>(null);
  const activeRef = useRef<DriveDirection | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function release(): void {
    if (intervalRef.current !== undefined) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
    if (activeRef.current !== null) {
      sendCommand(endpointId, "STOP");
    }
    activeRef.current = null;
    setActiveDirection(null);
  }

  function press(direction: DriveDirection): void {
    if (!linkOpen || activeRef.current !== null) {
      return;
    }
    activeRef.current = direction;
    setActiveDirection(direction);
    const [left, right] = wheelVelocities(direction);
    const resend = () => sendCommand(endpointId, "WHEELS_V", [left, right, DRIVE_LEASE_MS]);
    resend();
    intervalRef.current = setInterval(resend, DRIVE_RESEND_INTERVAL_MS);
  }

  /** One-shot fixed turn -- a click, not a hold. See this module's doc
   * comment for why `MOVE_X` (not `WHEELS_V`) is used here, and why
   * `rotationDeg` is converted through {@link degreesToMilliradians}
   * before it goes on the wire. */
  function turn(rotationDeg: number, timeoutMs: number): void {
    if (!linkOpen) {
      return;
    }
    sendCommand(endpointId, "MOVE_X", [
      0,
      degreesToMilliradians(rotationDeg),
      TURN_CRUISE_MM_S,
      timeoutMs,
    ]);
  }

  const canAbortRun = device.functions?.some((fn) => fn.name === "abort") === true;
  function handleStop(): void {
    sendCommand(endpointId, "STOP", ["now"]);
    if (canAbortRun) {
      sendCommand(endpointId, "RUN", ["abort"]);
    }
  }

  const estopped = device.robotStatus?.estopped === true;

  // A held direction must not survive the link closing out from under
  // it (disconnect/session close mid-hold) -- release() sends STOP,
  // which `sendCommand` silently drops if the socket isn't open, but
  // the local resend timer must still be torn down regardless.
  useEffect(() => {
    if (!linkOpen) {
      release();
    }
    // `release` itself is intentionally omitted from the dependency
    // list: it is a plain function recreated every render (no memo),
    // and only `linkOpen` transitioning to false should ever trigger
    // this effect body -- rerunning it every render for an unrelated
    // reason would just call `release()` redundantly while a direction
    // is not held (a harmless no-op) but adds nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkOpen]);

  // Never leave a resend timer running (or the robot believing it
  // should keep moving) past this component's own lifetime.
  useEffect(() => {
    return () => {
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function directionButton(direction: DriveDirection) {
    return (
      <button
        key={direction}
        type="button"
        className={`drive-controls-button drive-controls-button-${direction}`}
        data-testid={`drive-${direction}`}
        disabled={!linkOpen}
        onMouseDown={() => press(direction)}
        onMouseUp={release}
        onMouseLeave={release}
        onTouchStart={(event) => {
          event.preventDefault();
          press(direction);
        }}
        onTouchEnd={release}
      >
        {DIRECTION_LABELS[direction]}
      </button>
    );
  }

  function turnButton(fixedTurn: FixedTurn) {
    return (
      <button
        key={fixedTurn.testId}
        type="button"
        className={`drive-controls-button drive-controls-turn-button drive-controls-button-${fixedTurn.gridArea}`}
        data-testid={fixedTurn.testId}
        aria-label={fixedTurn.ariaLabel}
        title={fixedTurn.ariaLabel}
        disabled={!linkOpen}
        onClick={() => turn(fixedTurn.rotation, fixedTurn.timeoutMs)}
      >
        <TurnArrowIcon direction={fixedTurn.icon} />
        <span className="drive-controls-turn-degrees" aria-hidden="true">
          {fixedTurn.degreesLabel}
        </span>
      </button>
    );
  }

  return (
    <section className="drive-controls" aria-label="Drive controls">
      {!linkOpen && (
        <p className="drive-controls-hint" role="status">
          No link open — open a link before driving.
        </p>
      )}
      <p className="drive-controls-note">
        <strong>Hold</strong> a direction to drive; release to stop. Click a turn button for a
        fixed turn.{" "}
        {activeDirection ? `Holding: ${DIRECTION_LABELS[activeDirection]}.` : ""}
      </p>
      <div className="drive-controls-pad">
        {turnButton(TURN_90_LEFT)}
        {directionButton("forward")}
        {turnButton(TURN_90_RIGHT)}

        {directionButton("left")}
        <div className="drive-controls-stop-cell">
          <button
            type="button"
            className="drive-controls-button drive-controls-stop-button"
            data-testid="stop-button"
            aria-label="Stop"
            title="Stop the current motion (does not latch)"
            disabled={!linkOpen}
            onClick={handleStop}
          >
            <StopSignIcon letter={false} latched={false} />
          </button>
          <button
            type="button"
            className="drive-controls-button drive-controls-estop-button"
            data-testid="estop-button"
            aria-label="Emergency stop"
            title={estopped ? "Emergency stop (latched)" : "Emergency stop"}
            disabled={!linkOpen}
            onClick={() => sendCommand(endpointId, "ESTOP")}
          >
            <StopSignIcon letter={true} latched={estopped} />
          </button>
        </div>
        {directionButton("right")}

        {turnButton(TURN_180_LEFT)}
        {directionButton("backward")}
        {turnButton(TURN_180_RIGHT)}
      </div>
      {estopped && (
        <button
          type="button"
          className="drive-controls-clear-estop-button"
          data-testid="estop-clear-button"
          disabled={!linkOpen}
          onClick={() => {
            sendCommand(endpointId, "SET", ["estop_clear", "1"]);
            sendCommand(endpointId, "STATUS");
          }}
        >
          Clear E-STOP
        </button>
      )}
    </section>
  );
}
