/** Waypoints recorded on the Drive tab, expressed as text a student can
 * paste into a MakeCode program. Pose is mm/centidegrees on the wire;
 * the `diffDrive` API takes cm and degrees. */
import { formatCm, formatDeg } from "./pose";

export interface Waypoint {
  id: number;
  n: number;
  xMm: number;
  yMm: number;
  headingCentideg: number | undefined;
}

export type WaypointFormat = "positions" | "drive" | "goto";

export const WAYPOINT_FORMATS: readonly { value: WaypointFormat; label: string }[] = [
  { value: "positions", label: "Positions" },
  { value: "drive", label: "Drive" },
  { value: "goto", label: "Go to" },
];

function wrapDeg(deg: number): number {
  let out = deg % 360;
  if (out > 180) {
    out -= 360;
  } else if (out <= -180) {
    out += 360;
  }
  return out;
}

function positionLine(w: Waypoint): string {
  const fields = [formatCm(w.xMm), formatCm(w.yMm)];
  if (w.headingCentideg !== undefined) {
    fields.push(formatDeg(w.headingCentideg));
  }
  return `[${fields.join(", ")}],  // ${w.n}`;
}

function goToLine(w: Waypoint): string {
  return `diffDrive.goToWorld(${formatCm(w.xMm)}, ${formatCm(w.yMm)})  // ${w.n}`;
}

/** Legs from the origin pose (0, 0, heading 0): pivot to face the next
 * waypoint, then drive straight to it. */
function driveLines(waypoints: readonly Waypoint[]): string[] {
  let xMm = 0;
  let yMm = 0;
  let headingDeg = 0;
  return waypoints.map((w) => {
    const dx = w.xMm - xMm;
    const dy = w.yMm - yMm;
    const distance = formatCm(Math.hypot(dx, dy));
    if (distance === "0.0") {
      return `// ${w.n}: already here`;
    }
    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
    const yaw = Math.round(wrapDeg(bearing - headingDeg));
    xMm = w.xMm;
    yMm = w.yMm;
    headingDeg = bearing;
    const lines: string[] = [];
    if (yaw !== 0) {
      lines.push(`diffDrive.move(0, ${yaw})  // ${w.n}: turn to face`);
    }
    lines.push(`diffDrive.move(${distance}, 0)  // ${w.n}`);
    return lines.join("\n");
  });
}

/** One entry per waypoint (a drive entry may hold two statements). */
export function waypointLines(waypoints: readonly Waypoint[], format: WaypointFormat): string[] {
  switch (format) {
    case "positions":
      return waypoints.map(positionLine);
    case "goto":
      return waypoints.map(goToLine);
    case "drive":
      return driveLines(waypoints);
  }
}

export function waypointCode(waypoints: readonly Waypoint[], format: WaypointFormat): string {
  const lines = waypointLines(waypoints, format);
  if (format === "positions") {
    return ["// [x cm, y cm, heading deg]", "let waypoints = [", ...lines.map((line) => `    ${line}`), "]"].join("\n");
  }
  return lines.join("\n");
}
