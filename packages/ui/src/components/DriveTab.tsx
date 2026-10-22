/**
 * DriveTab.tsx — the robot page's Drive tab (OOP 2026-09-10,
 * stakeholder direction; "Functions & charts" folded in 2026-09-14;
 * console moved to `ConsoleDock` in sprint 022 ticket 007).
 *
 * **Layout (2026-10-17).** Left column: the drive pad with the chart's
 * controls and time series beside it, the keyboard/gamepad aids, the
 * path trace with a current-pose readout, then Functions. Right column
 * (viewport-bound, `.robot-page-column-console`): Record and the
 * waypoint list. Waypoints are owned here and handed to both the trace
 * and the list so their numbering and selection agree; numbers are
 * never reused after a delete.
 *
 * Besides the pad, two more ways to hold a direction while this tab is
 * showing:
 *
 *  - **Cursor keys** (and WASD): up/down drive, left/right turn in
 *    place, a diagonal arcs. Space or Escape stops. Delete/Backspace
 *    removes the selected waypoint. Keys are ignored while a text field
 *    has focus.
 *  - **A gamepad**, if one is plugged in: the left stick gives
 *    proportional speed and turn. Read through the Gamepad API on a
 *    short poll (there is no event for stick movement).
 *
 * Both feed one {@link useDriveEngine}, layered over the shared
 * {@link useHeldDrive} engine (`../hooks/useHeldDrive.ts` -- the same
 * held-direction resend/`STOP` discipline `DriveControls` uses for a
 * held button). This module's own `useDriveEngine` adds exactly one
 * thing: merging two named sources (keyboard, gamepad -- gamepad wins
 * while off-centre) into the one target it hands the shared engine.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useSendable, useTelemetry, useTelemetryHeader, useWsActions } from "../ws/WsProvider";
import { isLinkUsable } from "../deviceDisplay";
import { useHeldDrive, type WheelTarget as HeldDriveTarget } from "../hooks/useHeldDrive";
import { findPoseColumns, poseFromValues } from "../lib/pose";
import type { Waypoint, WaypointFormat } from "../lib/waypointCode";
import { ChartsPanel } from "./ChartsPanel";
import { DriveControls, driveSpeedFrom } from "./DriveControls";
import { FunctionsPanel } from "./FunctionsPanel";
import { PathTracePanel } from "./PathTracePanel";
import { WaypointsPanel } from "./WaypointsPanel";
import "./DriveTab.css";

/** Same number `DriveControls` drives at -- one dialect for every held
 * drive. */
export const DRIVE_VELOCITY_MM_S = 150;
/** How often the gamepad is sampled. */
export const GAMEPAD_POLL_MS = 50;
/** Stick travel below this is treated as centred. */
export const GAMEPAD_DEADZONE = 0.12;

export type WheelTarget = HeldDriveTarget;

/** Speeds are quantised to 5 mm/s so stick jitter does not read as a
 * new target every sample. */
const SPEED_STEP_MM_S = 5;

function clamp(value: number, limit: number): number {
  const stepped = Math.round(value / SPEED_STEP_MM_S) * SPEED_STEP_MM_S;
  return Math.max(-limit, Math.min(limit, stepped));
}

/** `[left, right]` mm/s for a forward demand `v` and a turn demand `w`
 * (both in mm/s, positive = forward / turn right), clamped to the pad's
 * speed. Turning right means the left wheel runs faster. */
export function mixWheels(v: number, w: number, speed: number = DRIVE_VELOCITY_MM_S): WheelTarget {
  return [clamp(v + w, speed), clamp(v - w, speed)];
}

/** Keyboard state -> wheel target, or `null` when nothing is held. */
export function keyboardTarget(held: ReadonlySet<string>, speed: number = DRIVE_VELOCITY_MM_S): WheelTarget | null {
  const up = held.has("ArrowUp") || held.has("KeyW");
  const down = held.has("ArrowDown") || held.has("KeyS");
  const left = held.has("ArrowLeft") || held.has("KeyA");
  const right = held.has("ArrowRight") || held.has("KeyD");
  const v = (up ? 1 : 0) - (down ? 1 : 0);
  const w = (right ? 1 : 0) - (left ? 1 : 0);
  if (v === 0 && w === 0) {
    return null;
  }
  return mixWheels(v * speed, w * speed, speed);
}

/** Left stick -> wheel target, or `null` inside the dead zone. `y` is
 * the browser's convention (up is negative). */
export function gamepadTarget(x: number, y: number, speed: number = DRIVE_VELOCITY_MM_S): WheelTarget | null {
  const fx = Math.abs(x) < GAMEPAD_DEADZONE ? 0 : x;
  const fy = Math.abs(y) < GAMEPAD_DEADZONE ? 0 : y;
  if (fx === 0 && fy === 0) {
    return null;
  }
  return mixWheels(-fy * speed, fx * speed, speed);
}

const DRIVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"]);
const STOP_KEYS = new Set(["Space", "Escape"]);
const DELETE_KEYS = new Set(["Delete", "Backspace"]);

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

/** The one place a held drive turns into wire traffic. Two named
 * sources (`keyboard`, `gamepad`); the gamepad wins while it is
 * off-centre. The resend timer and release/unmount `STOP` discipline is
 * `useHeldDrive`'s job. */
function useDriveEngine(linkId: string, linkOpen: boolean) {
  const { sendCommand } = useWsActions();
  const held = useHeldDrive(sendCommand, linkId, linkOpen);
  const sources = useRef<{ keyboard: WheelTarget | null; gamepad: WheelTarget | null }>({ keyboard: null, gamepad: null });
  const active = useRef<WheelTarget | null>(null);

  function apply(): void {
    const next = sources.current.gamepad ?? sources.current.keyboard;
    active.current = next;
    held.setTarget(next);
  }

  function setSource(name: "keyboard" | "gamepad", target: WheelTarget | null): void {
    sources.current[name] = target;
    apply();
  }

  useEffect(() => {
    if (!linkOpen) {
      sources.current = { keyboard: null, gamepad: null };
      apply();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkOpen]);
  useEffect(
    () => () => {
      sources.current = { keyboard: null, gamepad: null };
      apply();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { setSource, active };
}

export interface DriveTabProps {
  link: SnapshotLink;
  /** The owning device's already-resolved name, for the functions
   * panel's remembered-arguments key. */
  name: string;
}

export function DriveTab({ link, name }: DriveTabProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = isLinkUsable(link) && sendable;
  const { sendCommand } = useWsActions();
  const engine = useDriveEngine(linkId, linkOpen);
  const [speedText, setSpeedText] = useState(String(DRIVE_VELOCITY_MM_S));
  const speedRef = useRef(DRIVE_VELOCITY_MM_S);
  speedRef.current = driveSpeedFrom(speedText);
  const [heldKeys, setHeldKeys] = useState<string[]>([]);
  const [gamepadId, setGamepadId] = useState<string | null>(null);
  const [stick, setStick] = useState<WheelTarget | null>(null);

  const header = useTelemetryHeader(linkId);
  const telemetry = useTelemetry(linkId);
  const poseColumns = useMemo(() => findPoseColumns(header), [header]);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [format, setFormat] = useState<WaypointFormat>("positions");
  const nextNumber = useRef(1);

  function recordWaypoint(): void {
    const latest = telemetry.latest;
    if (!poseColumns || !latest) {
      return;
    }
    const pose = poseFromValues(latest.values, poseColumns);
    if (!pose) {
      return;
    }
    const n = nextNumber.current++;
    setWaypoints((previous) => [...previous, { id: n, n, ...pose }]);
    setSelectedId(n);
  }

  function deleteWaypoint(id: number): void {
    setWaypoints((previous) => previous.filter((w) => w.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Keyboard.
  useEffect(() => {
    const held = new Set<string>();
    const sync = () => {
      engine.setSource("keyboard", keyboardTarget(held, speedRef.current));
      setHeldKeys([...held]);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextTarget(event.target)) {
        return;
      }
      if (STOP_KEYS.has(event.code)) {
        event.preventDefault();
        held.clear();
        sync();
        sendCommand(linkId, "STOP", ["now"]);
        return;
      }
      if (DELETE_KEYS.has(event.code)) {
        if (selectedIdRef.current !== null) {
          event.preventDefault();
          deleteWaypoint(selectedIdRef.current);
        }
        return;
      }
      if (!DRIVE_KEYS.has(event.code)) {
        return;
      }
      event.preventDefault();
      if (event.repeat || held.has(event.code)) {
        return;
      }
      held.add(event.code);
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!DRIVE_KEYS.has(event.code)) {
        return;
      }
      held.delete(event.code);
      sync();
    };
    const onBlur = () => {
      held.clear();
      sync();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId]);

  // Gamepad.
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      return;
    }
    let lastId: string | null = null;
    let lastTarget: WheelTarget | null = null;
    const poll = () => {
      let pad: Gamepad | null = null;
      try {
        for (const candidate of navigator.getGamepads()) {
          if (candidate && candidate.connected && candidate.axes.length >= 2) {
            pad = candidate;
            break;
          }
        }
      } catch {
        pad = null;
      }
      const id = pad ? pad.id : null;
      if (id !== lastId) {
        lastId = id;
        setGamepadId(id);
      }
      const target = pad ? gamepadTarget(pad.axes[0] ?? 0, pad.axes[1] ?? 0, speedRef.current) : null;
      const changed =
        (target === null) !== (lastTarget === null) ||
        (target !== null && lastTarget !== null && (target[0] !== lastTarget[0] || target[1] !== lastTarget[1]));
      if (changed) {
        lastTarget = target;
        setStick(target);
        engine.setSource("gamepad", target);
      }
    };
    const timer = setInterval(poll, GAMEPAD_POLL_MS);
    poll();
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId]);

  const keyLabel = heldKeys.length > 0 ? heldKeys.map((code) => code.replace(/^Arrow|^Key/, "")).join(" + ") : null;

  return (
    <div className="robot-page-columns drive-tab" data-testid="robot-tab-panel-drive">
      <div className="robot-page-column robot-page-column-left drive-tab-left">
        <div className="drive-tab-top">
          <div className="drive-tab-pad">
            <DriveControls link={link} speedText={speedText} onSpeedText={setSpeedText} />
          </div>
          <div className="robot-page-panel drive-tab-charts" aria-label="Charts">
            <h3>Charts</h3>
            <ChartsPanel linkId={linkId} />
          </div>
        </div>
        <div className="drive-tab-aids">
          <p className="drive-tab-aid" data-testid="drive-tab-keyboard">
            <strong>Keyboard:</strong> arrow keys (or WASD) drive and turn; space stops.
            {keyLabel ? ` Holding ${keyLabel}.` : ""}
          </p>
          <p className="drive-tab-aid" data-testid="drive-tab-gamepad">
            <strong>Gamepad:</strong>{" "}
            {gamepadId
              ? `${gamepadId} — left stick drives with proportional speed.${stick ? ` Wheels ${stick[0]} / ${stick[1]} mm/s.` : ""}`
              : "none detected — plug in a controller and move its stick."}
          </p>
        </div>
        <div className="robot-page-panel drive-tab-trace" aria-label="Path trace">
          <h3>Path trace</h3>
          <PathTracePanel
            linkId={linkId}
            linkOpen={linkOpen}
            waypoints={waypoints}
            selectedWaypointId={selectedId}
            onSelectWaypoint={setSelectedId}
          />
        </div>
        <div className="robot-page-panel">
          <h3>Functions</h3>
          <FunctionsPanel link={link} name={name} />
        </div>
      </div>
      <div className="robot-page-column robot-page-column-right robot-page-column-console drive-tab-right">
        <WaypointsPanel
          waypoints={waypoints}
          selectedId={selectedId}
          format={format}
          canRecord={poseColumns !== undefined}
          onRecord={recordWaypoint}
          onSelect={setSelectedId}
          onDelete={deleteWaypoint}
          onFormatChange={setFormat}
        />
      </div>
    </div>
  );
}
