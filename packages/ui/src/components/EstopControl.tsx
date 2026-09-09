/**
 * EstopControl.tsx — always-reachable emergency-stop control for
 * `RobotPage` (ticket 006 / SUC-002).
 *
 * Kept separate from ticket 005's `DriveControls`/`CommandStrip`
 * deliberately: those components model ordinary command plumbing, but
 * e-stop is a safety affordance a student reaches for
 * when something is *already* going wrong, so this component's own
 * reachability cannot depend on any of them. It is a fully standalone
 * component — `RobotPage` mounts it directly, not nested inside another
 * panel that could hide it behind a tab, a modal, or a collapsed
 * section.
 *
 * **Dispatch.** `ESTOP` is outside the sequence entirely (protocol.md
 * §8.3/§9): no id, never acked/nacked in the sequencing sense. This
 * component sends it with `useWsActions().sendCommand(endpointId,
 * "ESTOP")` and nothing else — exactly the same action every other
 * verb on this page goes through. It deliberately does not import or
 * re-derive `isSequencedVerb`: that classification is singly owned by
 * `@robot-console/protocol`, applied host-side (ticket 003); this
 * component just calls `sendCommand` and lets the host route it via
 * `DeviceRegistry.sendCommand`/`Link.sendUnsequenced`.
 *
 * **Never gated on sequencing.** This component does not read
 * `useSequencing`/`sequencing`/`pendingCount` in any form, and the only
 * thing that disables its button is `device.sessionOpen` being false
 * (nothing to send at all). A `WHEELS_V` lease resend in flight, a
 * `GET`/`SET` awaiting `ack`, or any other pending sequenced activity
 * must never stand between a student and this button.
 *
 * **Repeated presses are harmless.** There is no cooldown, disable-
 * after-click, or dedup here: each press is an independent, ordinary
 * `sendCommand` call, and `ESTOP` being unsequenced means the host never
 * queues, rejects, or errors on a second one arriving while the first
 * is still being acted on. A student mashing this button under stress
 * gets N independent stop commands, never a queue or an error.
 *
 * **Hardware-deferred claim.** This component's own tests (fake
 * `WsProvider` socket) prove only that pressing this button sends the
 * exact unsequenced `ESTOP` line at the right time, under the right
 * conditions. They do not and cannot prove that a real robot stops
 * moving — that is a hardware-verified safety claim, checked separately
 * against real hardware, and is never checked off by this component's
 * own test suite (see `sprint.md`'s Success Criteria).
 *
 * **Clear E-STOP (added out-of-process, 2026-09-09).** Once the robot's
 * status reply reports its e-stop latch as engaged
 * (`device.robotStatus?.estopped`, from `wsMessages.ts`'s `RobotStatus`
 * -- the host polls `STATUS` on its own, so this refreshes without this
 * component asking), a second button renders next to E-STOP: `SET
 * estop_clear 1` (sequenced) to release the latch, immediately followed
 * by a one-shot `STATUS` so the panel's own state reflects the clear
 * without waiting for the host's next poll tick. Both are ordinary
 * `sendCommand` calls, same seam as `ESTOP` itself. Hidden entirely
 * (not just disabled) while `estopped` is not `true` -- there is nothing
 * to clear, and showing it regardless would invite a confusing no-op
 * press.
 */
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import "./EstopControl.css";

export interface EstopControlProps {
  device: EndpointListEntry;
}

export function EstopControl({ device }: EstopControlProps) {
  const endpointId = device.endpointId;
  const linkOpen = device.sessionOpen;
  const { sendCommand } = useWsActions();

  // OOP 2026-09-09: a plain, non-latching stop next to the e-stop.
  // `STOP now` zeroes the wheels this cycle and resolves the active
  // motion with reason `stop` (firmware `WireAdapter::onStop`) -- no
  // latch, no clear step, the next drive command just works. A routine
  // started with `RUN` (square, tour, ...) would keep issuing moves
  // after that, so when the robot's function list includes `abort`
  // (`test.ts`'s queue-bypassing abort), that is sent too.
  const canAbortRun = device.functions?.some((fn) => fn.name === "abort") === true;
  function handleStop(): void {
    sendCommand(endpointId, "STOP", ["now"]);
    if (canAbortRun) {
      sendCommand(endpointId, "RUN", ["abort"]);
    }
  }

  return (
    <section className="estop-control" aria-label="Emergency stop">
      <button
        type="button"
        className="estop-control-stop-button"
        data-testid="stop-button"
        disabled={!linkOpen}
        onClick={handleStop}
        title="Stop the current motion (does not latch)"
      >
        STOP
      </button>
      <button
        type="button"
        className="estop-control-button"
        data-testid="estop-button"
        disabled={!linkOpen}
        onClick={() => sendCommand(endpointId, "ESTOP")}
      >
        E-STOP
      </button>
      {device.robotStatus?.estopped === true && (
        <button
          type="button"
          className="estop-control-clear-button"
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
      {!linkOpen && (
        <p className="estop-control-hint" role="status">
          No link open — there is nothing to stop.
        </p>
      )}
    </section>
  );
}
