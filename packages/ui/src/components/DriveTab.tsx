/**
 * DriveTab.tsx — the robot page's Drive tab (OOP 2026-09-10,
 * stakeholder direction): just the drive pad, plus two more ways to
 * hold a direction while this tab is showing:
 *
 *  - **Cursor keys** (and WASD): up/down drive, left/right turn in
 *    place, a diagonal arcs. Space or Escape stops. Keys are ignored
 *    while a text field has focus.
 *  - **A gamepad**, if one is plugged in: the left stick gives
 *    proportional speed and turn. Read through the Gamepad API on a
 *    short poll (there is no event for stick movement).
 *
 * Both feed one {@link useDriveEngine}, which speaks exactly the wire
 * dialect `DriveControls` uses for a held button: `WHEELS_V left right
 * lease` re-sent every {@link DRIVE_RESEND_INTERVAL_MS} inside a
 * {@link DRIVE_LEASE_MS} lease, then one `STOP` on release -- so the
 * robot's own lease still stops it if this tab dies mid-hold. The
 * gamepad wins over the keyboard when both are active.
 */
import { useEffect, useRef, useState } from "react";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { useSendable, useWsActions } from "../ws/WsProvider";
import { DriveControls } from "./DriveControls";
import "./DriveTab.css";

/** Same numbers as `DriveControls` -- one dialect for every held drive. */
export const DRIVE_VELOCITY_MM_S = 150;
export const DRIVE_LEASE_MS = 400;
export const DRIVE_RESEND_INTERVAL_MS = 150;
/** How often the gamepad is sampled. */
export const GAMEPAD_POLL_MS = 50;
/** Stick travel below this is treated as centred. */
export const GAMEPAD_DEADZONE = 0.12;

export type WheelTarget = readonly [left: number, right: number];

/** Speeds are quantised to 5 mm/s so stick jitter does not read as a
 * new target every sample. */
const SPEED_STEP_MM_S = 5;

function clamp(value: number): number {
  const stepped = Math.round(value / SPEED_STEP_MM_S) * SPEED_STEP_MM_S;
  return Math.max(-DRIVE_VELOCITY_MM_S, Math.min(DRIVE_VELOCITY_MM_S, stepped));
}

/** `[left, right]` mm/s for a forward demand `v` and a turn demand `w`
 * (both in mm/s, positive = forward / turn right), clamped to the pad's
 * speed. Turning right means the left wheel runs faster. */
export function mixWheels(v: number, w: number): WheelTarget {
  return [clamp(v + w), clamp(v - w)];
}

/** Keyboard state -> wheel target, or `null` when nothing is held. */
export function keyboardTarget(held: ReadonlySet<string>): WheelTarget | null {
  const up = held.has("ArrowUp") || held.has("KeyW");
  const down = held.has("ArrowDown") || held.has("KeyS");
  const left = held.has("ArrowLeft") || held.has("KeyA");
  const right = held.has("ArrowRight") || held.has("KeyD");
  const v = (up ? 1 : 0) - (down ? 1 : 0);
  const w = (right ? 1 : 0) - (left ? 1 : 0);
  if (v === 0 && w === 0) {
    return null;
  }
  return mixWheels(v * DRIVE_VELOCITY_MM_S, w * DRIVE_VELOCITY_MM_S);
}

/** Left stick -> wheel target, or `null` inside the dead zone. `y` is
 * the browser's convention (up is negative). */
export function gamepadTarget(x: number, y: number): WheelTarget | null {
  const fx = Math.abs(x) < GAMEPAD_DEADZONE ? 0 : x;
  const fy = Math.abs(y) < GAMEPAD_DEADZONE ? 0 : y;
  if (fx === 0 && fy === 0) {
    return null;
  }
  return mixWheels(-fy * DRIVE_VELOCITY_MM_S, fx * DRIVE_VELOCITY_MM_S);
}

const DRIVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"]);
const STOP_KEYS = new Set(["Space", "Escape"]);

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

/** The one place a held drive turns into wire traffic -- see this
 * module's doc comment. Two named sources (`keyboard`, `gamepad`); the
 * gamepad wins while it is off-centre. */
function useDriveEngine(linkId: string, linkOpen: boolean) {
  const { sendCommand } = useWsActions();
  const sources = useRef<{ keyboard: WheelTarget | null; gamepad: WheelTarget | null }>({ keyboard: null, gamepad: null });
  const active = useRef<WheelTarget | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const sendRef = useRef(sendCommand);
  sendRef.current = sendCommand;
  // `DriveTab`'s own keyboard/gamepad effects (below) mount once
  // (`[linkId]`/`[]` deps) and keep calling the exact `setSource`
  // closure this hook returned on that first render -- `sources`/
  // `active`/`timer` stay correct across renders because `useRef`
  // itself is stable, but a plain captured `linkOpen` parameter would
  // freeze at whatever it was on that first render forever (ticket 009
  // surfaced this: `linkOpen` now depends on `useSendable()`, which is
  // still `false` on the very first render, before the test/production
  // socket has even reported "open"). A ref sidesteps that: every call
  // to `apply()`, however stale the closure invoking it, reads the
  // current value.
  const linkOpenRef = useRef(linkOpen);
  linkOpenRef.current = linkOpen;

  function apply(): void {
    const next = linkOpenRef.current ? (sources.current.gamepad ?? sources.current.keyboard) : null;
    const was = active.current;
    if (next === null) {
      if (timer.current !== undefined) {
        clearInterval(timer.current);
        timer.current = undefined;
      }
      if (was !== null) {
        sendRef.current(linkId, "STOP");
      }
      active.current = null;
      return;
    }
    active.current = next;
    if (was !== null) {
      // Already driving: the running resend picks up the new target at
      // its next tick. Never send per stick sample -- the gamepad is
      // polled every 50 ms and a moving stick would otherwise flood the
      // link at 20 commands a second (observed to knock gopiv's WiFi
      // module off the network).
      return;
    }
    const resend = () => {
      const target = active.current;
      if (target !== null) {
        sendRef.current(linkId, "WHEELS_V", [target[0], target[1], DRIVE_LEASE_MS]);
      }
    };
    resend();
    timer.current = setInterval(resend, DRIVE_RESEND_INTERVAL_MS);
  }

  function setSource(name: "keyboard" | "gamepad", target: WheelTarget | null): void {
    sources.current[name] = target;
    apply();
  }

  // Link closed mid-hold: drop the timer (STOP is dropped by
  // sendCommand anyway with no socket).
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
}

export function DriveTab({ link }: DriveTabProps) {
  const linkId = link.id;
  const sendable = useSendable();
  const linkOpen = link.session !== undefined && sendable;
  const { sendCommand } = useWsActions();
  const engine = useDriveEngine(linkId, linkOpen);
  const [heldKeys, setHeldKeys] = useState<string[]>([]);
  const [gamepadId, setGamepadId] = useState<string | null>(null);
  const [stick, setStick] = useState<WheelTarget | null>(null);

  // Keyboard.
  useEffect(() => {
    const held = new Set<string>();
    const sync = () => {
      engine.setSource("keyboard", keyboardTarget(held));
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
      const target = pad ? gamepadTarget(pad.axes[0] ?? 0, pad.axes[1] ?? 0) : null;
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
    <div className="drive-tab" data-testid="robot-tab-panel-drive">
      <div className="drive-tab-pad">
        <DriveControls link={link} />
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
    </div>
  );
}
