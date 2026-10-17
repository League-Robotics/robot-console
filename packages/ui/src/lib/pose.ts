/** Which telemetry columns carry the pose, in preference order: the
 * firmware's own `x`/`y`/`h` first, the raw OTOS `ox`/`oy`/`oh` as a
 * fallback. Both are mm and centidegrees. */
export const POSE_COLUMN_SETS = [
  { x: "x", y: "y", h: "h" },
  { x: "ox", y: "oy", h: "oh" },
] as const;

export type PoseColumns = (typeof POSE_COLUMN_SETS)[number];

export interface Pose {
  xMm: number;
  yMm: number;
  headingCentideg: number | undefined;
}

export function findPoseColumns(header: readonly string[] | undefined): PoseColumns | undefined {
  if (!header) {
    return undefined;
  }
  return POSE_COLUMN_SETS.find((set) => header.includes(set.x) && header.includes(set.y));
}

export function poseFromValues(values: Record<string, number>, columns: PoseColumns): Pose | undefined {
  const xMm = values[columns.x];
  const yMm = values[columns.y];
  if (xMm === undefined || yMm === undefined || !Number.isFinite(xMm) || !Number.isFinite(yMm)) {
    return undefined;
  }
  const h = values[columns.h];
  return { xMm, yMm, headingCentideg: h !== undefined && Number.isFinite(h) ? h : undefined };
}

export function formatCm(mm: number): string {
  const text = (mm / 10).toFixed(1);
  return text === "-0.0" ? "0.0" : text;
}

export function formatDeg(centideg: number): string {
  return String(Math.round(centideg / 100));
}
