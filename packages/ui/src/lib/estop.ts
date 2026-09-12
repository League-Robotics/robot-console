/**
 * estop.ts — the shared "Clear E-STOP" wire sequence (ticket 017-007;
 * `docs/reviews/2026-09-11/04-ui.md` §4, "Clear E-STOP (`SET estop_clear
 * 1` + `STATUS`)"), previously two independent, identical copies in
 * `StatusPanel.tsx` and `DriveControls.tsx`.
 *
 * `SET estop_clear 1` (sequenced) releases the latch; the immediate
 * follow-up `STATUS` (unsequenced) means the panel reflects the clear
 * without waiting for the host's next poll tick, rather than the two
 * calls being independently reinvented at each button.
 */
import type { WireField } from "@robot-console/protocol";

/** A minimal `sendCommand`-shaped function -- matches
 * `useWsActions().sendCommand`'s own signature without importing
 * `WsProvider` here. */
export type SendCommand = (linkId: string, verb: string, fields?: WireField[]) => void;

/** Sends `SET estop_clear 1` followed by a one-shot `STATUS` on
 * `linkId` -- the single source of this wire sequence, shared by
 * `StatusPanel`'s and `DriveControls`' own Clear E-STOP buttons. */
export function clearEstop(sendCommand: SendCommand, linkId: string): void {
  sendCommand(linkId, "SET", ["estop_clear", "1"]);
  sendCommand(linkId, "STATUS");
}
