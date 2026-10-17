import { describe, expect, it } from "vitest";
import { waypointCode, waypointLines, type Waypoint } from "./waypointCode";

const POINTS: Waypoint[] = [
  { id: 1, n: 1, xMm: 300, yMm: 0, headingCentideg: 0 },
  { id: 2, n: 2, xMm: 300, yMm: 400, headingCentideg: 9000 },
  { id: 3, n: 3, xMm: -123.4, yMm: 400, headingCentideg: 17950 },
];

describe("waypointCode", () => {
  it("positions: an array literal in cm and degrees, numbered", () => {
    expect(waypointCode(POINTS, "positions")).toBe(
      [
        "// [x cm, y cm, heading deg]",
        "let waypoints = [",
        "    [30.0, 0.0, 0],  // 1",
        "    [30.0, 40.0, 90],  // 2",
        "    [-12.3, 40.0, 180],  // 3",
        "]",
      ].join("\n"),
    );
  });

  it("positions: omits the heading when the header has none", () => {
    expect(waypointLines([{ id: 1, n: 4, xMm: -0.4, yMm: 5, headingCentideg: undefined }], "positions")).toEqual([
      "[0.0, 0.5],  // 4",
    ]);
  });

  it("goto: one goToWorld per waypoint in cm", () => {
    expect(waypointCode(POINTS, "goto")).toBe(
      ["diffDrive.goToWorld(30.0, 0.0)  // 1", "diffDrive.goToWorld(30.0, 40.0)  // 2", "diffDrive.goToWorld(-12.3, 40.0)  // 3"].join("\n"),
    );
  });

  it("drive: pivot to face each waypoint from the previous one, then drive straight; no pivot when already facing it", () => {
    expect(waypointLines(POINTS, "drive")).toEqual([
      "diffDrive.move(30.0, 0)  // 1",
      "diffDrive.move(0, 90)  // 2: turn to face\ndiffDrive.move(40.0, 0)  // 2",
      "diffDrive.move(0, 90)  // 3: turn to face\ndiffDrive.move(42.3, 0)  // 3",
    ]);
  });

  it("drive: wraps the turn to the short way round and notes a waypoint on top of the previous one", () => {
    const points: Waypoint[] = [
      { id: 1, n: 1, xMm: -100, yMm: 0, headingCentideg: 0 },
      { id: 2, n: 2, xMm: -100, yMm: 0.2, headingCentideg: 0 },
      { id: 3, n: 3, xMm: -100, yMm: -100, headingCentideg: 0 },
    ];
    expect(waypointLines(points, "drive")).toEqual([
      "diffDrive.move(0, 180)  // 1: turn to face\ndiffDrive.move(10.0, 0)  // 1",
      "// 2: already here",
      "diffDrive.move(0, 90)  // 3: turn to face\ndiffDrive.move(10.0, 0)  // 3",
    ]);
  });

  it("empty list gives an empty array literal or empty text", () => {
    expect(waypointCode([], "positions")).toBe("// [x cm, y cm, heading deg]\nlet waypoints = [\n]");
    expect(waypointCode([], "goto")).toBe("");
  });
});
