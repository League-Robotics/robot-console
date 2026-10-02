/**
 * statusPollControl.ts — the per-link on/off switch for
 * `connect/harvester.ts`'s periodic `STATUS` poll, set from the robot
 * page's Diagnostics tab (`set-status-polling`, `wsMessages.ts`).
 *
 * Held in memory, keyed by link id rather than by session, so a link
 * turned off stays off across a reconnect — the bench case this exists
 * for (2026-10-01, vevov over Wi-Fi) is reconnecting to get a fresh
 * TCP connection without the poll's replies refilling the robot's
 * 8-line transmit queue. A host restart turns every link back on.
 */
export interface StatusPollControl {
  isPaused(linkId: string): boolean;
  anyPaused(): boolean;
  setPaused(linkId: string, paused: boolean): void;
}

export function createStatusPollControl(): StatusPollControl {
  const paused = new Set<string>();
  return {
    isPaused: (linkId) => paused.has(linkId),
    anyPaused: () => paused.size > 0,
    setPaused(linkId, value): void {
      if (value) {
        paused.add(linkId);
      } else {
        paused.delete(linkId);
      }
    },
  };
}
