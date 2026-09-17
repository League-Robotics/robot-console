/**
 * deviceDisplay.localFirmware.test.ts — out-of-process, 2026-09-16.
 * The UI half of "a firmware source can be a local .hex path": these pin
 * that every shared display helper renders the local-file arm of
 * `FirmwareAvailability` sensibly, and -- the point of the whole
 * exercise -- that a filesystem path is never rendered as a link.
 *
 * Kept in its own file rather than appended to `deviceDisplay.test.ts`
 * so the existing 018-017 release-source suite there stays untouched and
 * continues to prove the release path did not regress.
 */
import { describe, expect, it } from "vitest";
import {
  firmwareDiagnosticDetail,
  firmwareDisabledReason,
  firmwareSourceText,
  releaseDisplayName,
} from "./deviceDisplay";

const HEX_PATH = "/Volumes/Proj/proj/RobotProjects/microbit-radio-relay/MICROBIT.hex";

function localAvailability(overrides: Record<string, unknown> = {}) {
  return {
    configured: true as const,
    kind: "local-file" as const,
    hexPath: HEX_PATH,
    fileName: "MICROBIT.hex",
    tag: "built 2026-09-13 10:52",
    available: true,
    checkedAt: null as number | null,
    ...overrides,
  };
}

describe("local-file firmware source rendering", () => {
  it("firmwareSourceText returns href: null so the file name renders as plain text, not a link", () => {
    const now = 1_000_000;
    const info = firmwareSourceText(localAvailability({ checkedAt: now - 5 * 60_000 }), now);
    expect(info).toEqual({
      href: null,
      repoName: "MICROBIT.hex",
      tag: "built 2026-09-13 10:52",
      checkedText: "checked 5 minutes ago",
    });
  });

  it("firmwareSourceText still says 'checked: never' for a local source never polled", () => {
    expect(firmwareSourceText(localAvailability({ checkedAt: null }))?.checkedText).toBe("checked: never");
  });

  it("releaseDisplayName names the file and its build stamp", () => {
    expect(releaseDisplayName(localAvailability())).toBe("MICROBIT.hex built 2026-09-13 10:52");
  });

  it("firmwareDiagnosticDetail names the configured path, which is the whole diagnostic", () => {
    const detail = firmwareDiagnosticDetail(
      localAvailability({ available: false, reason: "file-missing", message: `no file at ${HEX_PATH}` }),
    );
    expect(detail).toBe(`Checked ${HEX_PATH}: no file at ${HEX_PATH}`);
  });

  it("firmwareDiagnosticDetail stays null while the local build is present and available", () => {
    expect(firmwareDiagnosticDetail(localAvailability())).toBeNull();
  });

  it("firmwareDisabledReason has calm student-facing text for every local failure reason", () => {
    const reasonFor = (reason: string): string | null =>
      firmwareDisabledReason(localAvailability({ available: false, reason, message: "detail" }));

    expect(reasonFor("file-missing")).toBe(
      "The build file isn't where it's expected — ask your instructor to check the setup.",
    );
    expect(reasonFor("not-a-file")).toBe(
      "The build file isn't where it's expected — ask your instructor to check the setup.",
    );
    expect(reasonFor("unreadable")).toBe("The build file couldn't be read — ask your instructor to check the setup.");
    expect(reasonFor("invalid-hex")).toBe(
      "The build file looks incomplete — if it's still building, try again in a moment.",
    );
  });

  it("firmwareDisabledReason is null (button enabled) once the local build is available", () => {
    expect(firmwareDisabledReason(localAvailability())).toBeNull();
  });

  it("never leaks the path into student-facing text", () => {
    const student = firmwareDisabledReason(
      localAvailability({ available: false, reason: "file-missing", message: `no file at ${HEX_PATH}` }),
    );
    expect(student).not.toContain(HEX_PATH);
  });
});
