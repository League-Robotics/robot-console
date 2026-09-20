/**
 * useDockPersistence.ts — the one `localStorage` seam for the console
 * dock's own UI preferences (sprint 022 ticket 003, SUC-001).
 *
 * ## Why a seam, not `ConsoleDock` reading `localStorage` directly
 *
 * Per this ticket's own Implementation Plan: isolating the read/write
 * mechanics here means `ConsoleDock.tsx` never has to know it's talking
 * to `localStorage` at all (it just gets a `{ open, heightPx }` pair and
 * a setter), and a test can fake/reset persistence by clearing
 * `window.localStorage` between cases rather than mocking a module.
 * Same shape this project already uses for per-robot calibration state
 * (`lib/calibration.ts`'s `readCalibrationState`/`writeCalibrationState`):
 * a fixed key, try/catch around every `localStorage` call (private
 * browsing, disabled storage, or a quota error must never crash the
 * page -- the dock should degrade to "always defaults," not throw), and
 * plain get/set functions underneath a thin hook for components.
 *
 * ## `{ open: boolean; heightPx: number }`, not `open` alone
 *
 * This ticket only *acts* on `open` (the collapse/expand toggle) --
 * `heightPx` has no UI writer yet, since the drag-resize handle is
 * ticket 004's work. It is still part of this module's shape from the
 * start, per sprint.md's Architecture §Step 3 ("persist both the dock's
 * open/collapsed state and its height... `heightPx` should be added
 * to the same module ticket 004 already anticipates") and this ticket's
 * own Description ("design the storage seam for two values, not one").
 * Adding a second field to an existing stored object later is exactly
 * the kind of shape change that benefits from being planned up front:
 * ticket 004 only has to call `update({ heightPx })` against a key that
 * already round-trips both fields, rather than migrating a
 * single-value key or introducing a second one.
 *
 * ## Collapsed is the fallback only when nothing is stored yet
 *
 * Per sprint.md's Design Rationale ("persist both the dock's
 * open/collapsed state..."): "collapsed by default" is deliberately read
 * as "collapsed on a never-before-visited browser," not "collapsed on
 * every reload regardless of what the student chose." This project has
 * already been bitten once by state that silently vanished across
 * sessions (see project memory on calibration writes) -- re-defaulting
 * `open` to `false` on every load would throw away a student's
 * deliberate choice to keep the dock open across a working session for
 * no stated reason. So `readDockState()` only substitutes
 * {@link DEFAULT_DOCK_STATE} when the key is entirely absent or its
 * JSON is malformed/foreign-shaped -- a validly-stored `open: true`
 * is returned as-is, forever, until the student (or a cleared browser)
 * changes it.
 */
import { useCallback, useState } from "react";

/** The one fixed `localStorage` key for dock UI preferences -- a single
 * key, not one per device, since the dock's open/collapsed state and
 * height are a global UI preference, not a per-robot one (unlike
 * `lib/calibration.ts`'s per-`name` keys). Named in this ticket's own
 * Description. */
const STORAGE_KEY = "robot-console:console-dock";

/** ~10 lines of console at the log's own `0.85rem`/`1.4` line-height
 * (`DeviceConsole.css`'s `.console-log`), plus the toolbar/send-box/
 * `CommandStrip` chrome that shares this same pane -- the "sensible
 * default height" this ticket's Description and SUC-001's main flow
 * call for when nothing has been dragged yet. Ticket 004's drag handle
 * is what ever changes this away from the default for a given browser. */
export const DEFAULT_DOCK_HEIGHT_PX = 320;

export interface DockPersistedState {
  /** Whether the open pane (log, toolbar, `SequencingIndicator`, send
   * box, `CommandStrip`) is showing below the "Debug Console" bar. */
  open: boolean;
  /** The open pane's height in pixels. Read/written from the start
   * (see this module's own doc comment) but only ever set by ticket
   * 004's drag handle -- ticket 003 always writes/reads the default. */
  heightPx: number;
}

const DEFAULT_DOCK_STATE: DockPersistedState = {
  open: false,
  heightPx: DEFAULT_DOCK_HEIGHT_PX,
};

/** Read the persisted dock state, falling back to
 * {@link DEFAULT_DOCK_STATE} whenever the key is unset, the stored JSON
 * doesn't parse, or either field is missing/the wrong type -- a
 * partially-valid object (e.g. a future field this module doesn't know
 * about yet, or `heightPx` dropped by a manual edit) still yields a
 * usable `open` rather than discarding the whole record. */
export function readDockState(): DockPersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_DOCK_STATE;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_DOCK_STATE;
    }
    const { open, heightPx } = parsed as Partial<DockPersistedState>;
    return {
      open: typeof open === "boolean" ? open : DEFAULT_DOCK_STATE.open,
      heightPx: typeof heightPx === "number" && Number.isFinite(heightPx) && heightPx > 0 ? heightPx : DEFAULT_DOCK_STATE.heightPx,
    };
  } catch {
    return DEFAULT_DOCK_STATE;
  }
}

/** Write the full persisted dock state. Best-effort, matching
 * `lib/calibration.ts`'s `writeCalibrationState` -- a quota error or
 * disabled storage (private browsing) must not crash the dock; it just
 * stops remembering the student's choice for next time. */
export function writeDockState(state: DockPersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best effort -- the dock still works for this session.
  }
}

/** The component-facing half of this seam: current state plus a
 * patch-and-persist updater, so `ConsoleDock.tsx` never touches
 * `localStorage` itself. `update` merges the patch onto the latest
 * state (functional `setState`, not the `state` this call closed over)
 * so a caller can safely do `update({ open: true })` without first
 * re-reading `heightPx`. */
export function useDockPersistence(): [DockPersistedState, (patch: Partial<DockPersistedState>) => void] {
  const [state, setState] = useState<DockPersistedState>(() => readDockState());

  const update = useCallback((patch: Partial<DockPersistedState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeDockState(next);
      return next;
    });
  }, []);

  return [state, update];
}
