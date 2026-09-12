/**
 * useHeldDrive.ts — the shared held-direction drive engine (ticket
 * 017-007; `docs/reviews/2026-09-11/04-ui.md` §4, "Held-drive engine
 * (`WHEELS_V` resend every 150 ms, `STOP` on release)").
 *
 * `DriveControls.tsx`'s single-button pad and `DriveTab.tsx`'s
 * keyboard/gamepad engine each re-issue `WHEELS_V left right lease`
 * every {@link HELD_DRIVE_RESEND_INTERVAL_MS} while a direction is held
 * (comfortably inside the {@link HELD_DRIVE_LEASE_MS} lease the wheel
 * kernel enforces -- see `DriveControls.tsx`'s own doc comment for the
 * full 150/400 rationale, unchanged by this extraction) and send exactly
 * one `STOP` the moment nothing is held any more -- on release, on the
 * link closing out from under a hold, or on the owning component
 * unmounting mid-hold. This hook is exactly that engine, factored out so
 * neither caller re-implements the resend timer or the release/unmount
 * `STOP` discipline for itself.
 *
 * **What this hook does NOT own.** `DriveControls` presses one direction
 * at a time (guarded by its own "already holding" check before ever
 * calling {@link HeldDriveEngine.setTarget}); `DriveTab` merges two
 * named sources (keyboard, gamepad -- gamepad wins while off-centre) into
 * one target before calling it. Both of those policies stay in the
 * calling component; this hook only ever sees the single, already-
 * resolved target each caller hands it.
 *
 * **Redundant `setTarget` calls do not restart the resend.** While
 * already driving, a new target lands in {@link HeldDriveEngine.setTarget}
 * without an immediate send -- the running resend timer picks up the
 * latest value at its own next tick. This matters for `DriveTab`'s
 * polled gamepad stick: sending on every sample (every {@link
 * import("../components/DriveTab").GAMEPAD_POLL_MS}, 50 ms) would flood
 * the link at 20 commands a second, which was observed to knock a
 * robot's WiFi module off the network. `null` (nothing held) is the one
 * exception -- it always sends `STOP` immediately when transitioning
 * away from a held target.
 */
import { useEffect, useRef } from "react";
import type { WireField } from "@robot-console/protocol";

/** `[left, right]` wheel velocities, `[mm/s]`, for the currently-held
 * direction. */
export type WheelTarget = readonly [left: number, right: number];

/** [ms] -- the `WHEELS_V` lease length sent with every resend. Shared by
 * every held-drive control; see `DriveControls.tsx`'s own doc comment
 * for why 400ms. */
export const HELD_DRIVE_LEASE_MS = 400;

/** [ms] -- how often a held target re-issues `WHEELS_V`, well inside
 * {@link HELD_DRIVE_LEASE_MS}. See `DriveControls.tsx`'s own doc
 * comment for why 150ms. */
export const HELD_DRIVE_RESEND_INTERVAL_MS = 150;

export interface HeldDriveEngine {
  /** Set (or, with `null`, clear) the currently-held wheel target. See
   * this module's own doc comment for why a redundant non-null call
   * does not restart the resend. */
  setTarget: (target: WheelTarget | null) => void;
}

/** A minimal `sendCommand`-shaped function -- matches
 * `useWsActions().sendCommand`'s own signature without importing
 * `WsProvider` here, so this hook stays a plain, provider-independent
 * unit (its own test mounts it with no `WsProvider` in the tree at
 * all). */
export type SendCommand = (linkId: string, verb: string, fields?: WireField[]) => void;

export function useHeldDrive(sendCommand: SendCommand, linkId: string, linkOpen: boolean): HeldDriveEngine {
  const active = useRef<WheelTarget | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Refs for every value a delayed timer callback or a stale-closure
  // effect might otherwise read a frozen copy of -- see
  // `DriveTab.tsx`'s own doc comment (carried from ticket 009) on why a
  // plain captured `linkOpen` is not safe here: this hook's `setTarget`
  // is handed out once and called from callers whose own closures may
  // be arbitrarily stale.
  const sendRef = useRef(sendCommand);
  sendRef.current = sendCommand;
  const linkIdRef = useRef(linkId);
  linkIdRef.current = linkId;
  const linkOpenRef = useRef(linkOpen);
  linkOpenRef.current = linkOpen;

  function apply(requested: WheelTarget | null): void {
    const next = linkOpenRef.current ? requested : null;
    const was = active.current;
    if (next === null) {
      if (timer.current !== undefined) {
        clearInterval(timer.current);
        timer.current = undefined;
      }
      if (was !== null) {
        sendRef.current(linkIdRef.current, "STOP");
      }
      active.current = null;
      return;
    }
    active.current = next;
    if (was !== null) {
      // Already driving -- see this module's doc comment on why a
      // redundant `setTarget` never sends immediately.
      return;
    }
    const resend = () => {
      const target = active.current;
      if (target !== null) {
        sendRef.current(linkIdRef.current, "WHEELS_V", [target[0], target[1], HELD_DRIVE_LEASE_MS]);
      }
    };
    resend();
    timer.current = setInterval(resend, HELD_DRIVE_RESEND_INTERVAL_MS);
  }

  function setTarget(target: WheelTarget | null): void {
    apply(target);
  }

  // The link closing out from under a hold (disconnect/session close)
  // must not leave the resend timer running -- `apply(null)` tears it
  // down and sends STOP (silently dropped by `sendCommand` if the
  // socket isn't actually open) exactly like an ordinary release.
  useEffect(() => {
    if (!linkOpen) {
      apply(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkOpen]);

  // Never leave a resend timer running (or the robot believing it
  // should keep moving) past this hook's own lifetime.
  useEffect(() => {
    return () => {
      apply(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { setTarget };
}
