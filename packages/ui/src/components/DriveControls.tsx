/**
 * DriveControls.tsx — `WHEELS_V`-only drive controls (ticket 005 /
 * SUC-001).
 *
 * **Why `WHEELS_V` only.** Per
 * `vendor/radio-robot-lib/docs/design/motion-api.md`, `DiffDriveAdapter`
 * — the only concrete `Adapter` this project's firmware ships — has no
 * planner and answers `WHEELS_X`/`MOVE_X`/`MOVE_V`/`GO_TO_R`/`GO_TO_W`
 * with an unknown-command error. Only `WHEELS_V left right duration`
 * (velocity, `[mm/s]`) and `STOP`/`STOP now` are actually implemented.
 * Offering any of the other five would ship buttons that reliably
 * error — not a real capability.
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
 * command *plumbing*, not real-world motion). Turning is a pivot
 * (`wheels_v(-v, +v)`/`wheels_v(+v, -v)`) rather than an arc, mirroring
 * motion-api.md §2's `wheels_x(+d, -d)` in-place-pivot special case;
 * sign convention follows motion-api.md §2.1's "CCW-positive, left
 * wheel is the slower one" rule (positive omega — a left turn — comes
 * from the left wheel going slower/negative, the right wheel faster/
 * positive).
 *
 * On release (mouse/touch up, mouse leaving the button while held, the
 * link closing, or this component unmounting while a direction is
 * held), the resend timer is cleared and an unsequenced-in-spirit but
 * still sequenced `STOP` (per protocol.md/motion-api.md §9.1, `STOP` is
 * one of the 11 sequenced verbs) is sent with no fields, matching
 * `stop()`'s wire form (`STOP #<id>`, no positional args).
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

  const directions: DriveDirection[] = ["forward", "backward", "left", "right"];

  return (
    <section className="drive-controls" aria-label="Drive controls">
      {!linkOpen && (
        <p className="drive-controls-hint" role="status">
          No link open — open a link before driving.
        </p>
      )}
      <div className="drive-controls-pad">
        {directions.map((direction) => (
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
        ))}
      </div>
      <p className="drive-controls-note">
        Hold a direction to drive; release to stop. {activeDirection ? `Holding: ${DIRECTION_LABELS[activeDirection]}.` : ""}
      </p>
    </section>
  );
}
