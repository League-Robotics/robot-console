/**
 * FlashControls.tsx — the release-flash + local-hex flash UI, extracted
 * from `UnknownDevicePage.tsx` (ticket 012-002) so the front-page card
 * (`FrontPage.tsx`'s `EndpointCard`), the per-device unknown page
 * (`UnknownDevicePage.tsx`), and the app header's Flash entry
 * (ticket 004) render the exact same flow instead of three independent,
 * drifting copies of the same intricate progress/error/upload state
 * machine.
 *
 * **Contract: one endpoint in, no knowledge of caller, no gating.**
 * This component's only prop is `{ endpoint }`. It owns all of its own
 * progress/error/local-hex-upload state and the
 * `onFlashResult`/`onFlashLocalReady` subscriptions internally. It
 * never reads the current route, never takes an `onFlash`/`onDone`
 * callback, and never assumes anything about what else is on the page
 * around it.
 *
 * **Out-of-process modal work (2026-09-08): gating moved to
 * `FlashDialog.tsx`.** Before this change, this component decided for
 * itself, via `canBeFlashed`, whether to render anything at all (a
 * `forceShow` escape hatch let `AppHeader` bypass that gate for an
 * identified device). The stakeholder asked for the whole flash flow to
 * move into a popup modal, with each call site left holding just a
 * trigger -- and a trigger is exactly where "should this device even
 * offer to be flashed" now belongs, not inside the dialog content. Every
 * call site now mounts `FlashDialog` (`./FlashDialog.tsx`), which owns
 * the `canBeFlashed` gate (skippable via its own `forceShow`, still used
 * only by `AppHeader` for an identified relay/robot device), the trigger
 * button, and the `<dialog>` chrome; this component always renders its
 * full UI once mounted; it is never mounted un-gated. See
 * `FlashDialog.tsx`'s doc comment for the gating/dismissal/focus
 * decisions -- this file is unchanged in every other respect.
 *
 * Two flash affordances, both ported from `DevicesTab.tsx`'s
 * `DeviceCard` (moved, not redesigned) plus one added in sprint 8:
 *
 *  - **Release flash** (existing flow, SUC-002): relay/robot buttons,
 *    shown for any device that hasn't identified with a role yet
 *    (`canBeFlashed`, which covers both a failed-identify device and a
 *    silent, unflashed board) and gated per-firmware on live
 *    `firmwareStatus` (`firmwareDisabledReason`) -- verbatim from
 *    `DeviceCard`, just relocated here, then relocated again out of
 *    `UnknownDevicePage` by this ticket.
 *  - **Local-hex flash** (SUC-003): a file input drives the
 *    `flash-local-begin` -> `flash-local-ready` -> one binary frame
 *    handshake `wsMessages.ts`/`localHexUpload.ts` define. The binary
 *    frame is sent automatically the moment `flash-local-ready`
 *    arrives; only the final `flash-start` waits for an explicit "Flash
 *    this file" click, so the student has a chance to see what's about
 *    to happen before it does. The oversize check
 *    (`MAX_LOCAL_HEX_BYTES`, mirroring `localHexUpload.ts`'s
 *    server-side `MAX_UPLOAD_BYTE_LENGTH`) runs client-side, before
 *    anything is sent, so an oversized file is never even offered to
 *    the server -- consistent with, not a replacement for, the
 *    server's own before-allocating-a-buffer rejection.
 *  - **Diagnostic detail, out-of-process (2026-09-08):** each release
 *    button's disabled hint (`firmwareDisabledReason`) is deliberately
 *    calm, generic, student-facing text -- it never names a repo, tag,
 *    or missing asset. That specific detail (`firmwareDiagnosticDetail`,
 *    `deviceDisplay.ts`) is real and already computed on the host
 *    (`releases.ts`'s `resolveRelease`), but showing it inline would
 *    turn a "go ask your instructor" line into an engineer-facing wall
 *    of text for every student who hits it. It's rendered instead as a
 *    collapsed `<details>` disclosure right under the hint: invisible
 *    until opened, so a student's flow is unchanged, but one click away
 *    for whoever is actually diagnosing the setup (an instructor at the
 *    same dialog, or a student relaying "it says ... " over their
 *    shoulder) -- no source reading or GitHub API querying required.
 *    Rendered here (inside the dialog `FlashDialog.tsx` now wraps this
 *    component in) rather than in `FlashDialog.tsx` itself, since the
 *    detail is per-firmware-button, exactly where the hint it
 *    supplements already lives.
 *  - A warn-don't-block compatibility note sits above the file picker:
 *    this codebase has no way to confirm a hex targets this board's
 *    hardware family (`isValidIntelHexText` has no board-family
 *    awareness), so a v1-only image can flash onto a v2 board and leave
 *    it silent. That is always recoverable (a micro:bit can be
 *    re-flashed over SWD or MSD no matter what is currently on it), so
 *    the copy says exactly that instead of refusing the flash outright.
 *
 * Progress rendering (both flash kinds) reads `useFlashProgress`, not
 * `EndpointListEntry.flashStatus` -- the latter is frozen to
 * `{ firmware, phase }` and has no shape for a local-hex source, so it
 * cannot represent that flow's progress at all. This does inherit
 * `useFlashProgress`'s documented reconnect gap (a client that
 * reconnects mid-flash sees no progress until the next live
 * `flash-progress` event, for *either* source kind here, whereas
 * `flashStatus` alone would have self-healed a release-kind flash from
 * the snapshot) -- accepted, not fixed (that gap is `WsProvider`'s doc
 * comment's to close, not this component's).
 *
 * **Post-flash navigation** (SUC-002 step 4, SUC-004): subscribes to
 * `onFlashResult` for this link only. `status: "ok"` with no
 * `reidentify` field navigates to the front page immediately -- the
 * message's own re-identify is already folded into the next `snapshot`
 * by the time this arrives (reidentify-before-result sequencing), so
 * there is no stale-type flash to land on. Mounted from the front page
 * itself (`FrontPage.tsx`'s unassigned-board card) this is a harmless
 * no-op navigation, not a special case this component needs to know
 * about -- exactly the kind of caller-blindness the "no knowledge of
 * caller" contract above is meant to buy. `status: "ok", reidentify:
 * "timeout"` deliberately does **not** navigate -- SUC-004 calls for
 * rendering "waiting for the board to come back" in place instead.
 * `status: "error"` never navigates; the message surfaces as a
 * flash-error note instead. A result for a *different* link (the
 * student navigated to another device while a flash from this one was
 * still in flight) is ignored -- checked via a closure over the current
 * `link.id`, kept fresh by this effect's own dependency array, since
 * `react-router` does not unmount a component just because its `link`
 * prop changed to a different one.
 *
 * ## Sprint 015 ticket 008: takes a `SnapshotLink`, not an `EndpointListEntry`
 *
 * `link.id` replaces `endpoint.endpointId` throughout (`flash-start`'s
 * `linkId` field, `useFlashProgress(link.id)`, `onFlashResult`'s own
 * `linkId` field) -- `useFirmwareStatus` is unaffected (still one
 * global `Record<FirmwareKind, FirmwareAvailability>`, not per-link).
 */
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import type {
  FirmwareAvailability,
  FirmwareKind,
  FlashLocalReadyMessage,
  SnapshotLink,
} from "@robot-console/host/src/wsMessages.js";
import { useFirmwareStatus, useFlashProgress, useSendable, useWsActions, type FlashProgressState } from "../ws/WsProvider";
import {
  FIRMWARE_LABEL,
  PHASE_LABEL,
  firmwareDiagnosticDetail,
  firmwareDisabledReason,
  firmwareSourceText,
  releaseDisplayName,
} from "../deviceDisplay";
import "./FlashControls.css";

/** Hard cap on a local-hex upload, checked client-side before a single
 * byte is read into memory or sent -- mirrors
 * `host/src/localHexUpload.ts`'s `MAX_UPLOAD_BYTE_LENGTH` (4MB, a
 * universal hex is ~1.8MB). Restated here rather than imported: that
 * module pulls in `node:crypto` for its own hashing, which has no
 * place in a browser bundle, so the two constants are kept in sync by
 * hand (both derive from the same `sprint.md` design decision) rather
 * than shared across the host/UI boundary. */
export const MAX_LOCAL_HEX_BYTES = 4 * 1024 * 1024;

/** State machine for the local-hex upload handshake, one file at a
 * time. `bytes` is carried in `awaiting-ready` (not re-read from the
 * `<input>`, which is cleared immediately on selection so picking the
 * same file twice in a row still fires `onChange`) so the binary frame
 * can be assembled the moment `flash-local-ready` arrives. */
type LocalHexState =
  | { phase: "idle" }
  | { phase: "oversize"; fileName: string; byteLength: number }
  | { phase: "awaiting-ready"; fileName: string; byteLength: number; sha256: string; bytes: ArrayBuffer }
  | { phase: "uploaded"; uploadId: string; fileName: string; byteLength: number; sha256: string };

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** `uploadId` (ASCII, exactly `UPLOAD_ID_BYTE_LENGTH` bytes) immediately
 * followed by the file's raw bytes -- no length prefix or delimiter,
 * per `wsMessages.ts`'s binary-frame convention. */
function buildUploadFrame(uploadId: string, bytes: ArrayBuffer): Uint8Array {
  const idBytes = new TextEncoder().encode(uploadId);
  const frame = new Uint8Array(idBytes.length + bytes.byteLength);
  frame.set(idBytes, 0);
  frame.set(new Uint8Array(bytes), idBytes.length);
  return frame;
}

/** What a flash's `source` should be called in progress/result copy
 * (ticket 018-017: "Flashing nezha-robot-template v0.20260913.1:
 * writing…" rather than the old generic "Flashing relay: …") -- the
 * configured release's own repo+tag name when one is known, falling
 * back to {@link FIRMWARE_LABEL}'s generic word only in the edge case
 * where `firmwareStatus` doesn't (yet, or any more) have that firmware
 * configured. A local-hex flash is always named by its own file name --
 * there is no release source to look up. */
function flashSourceName(source: FlashProgressState["source"], firmwareStatus: Record<FirmwareKind, FirmwareAvailability>): string {
  if (source.kind === "release") {
    return releaseDisplayName(firmwareStatus[source.firmware]) ?? FIRMWARE_LABEL[source.firmware];
  }
  return source.fileName;
}

function flashProgressText(progress: FlashProgressState, firmwareStatus: Record<FirmwareKind, FirmwareAvailability>): string {
  return `Flashing ${flashSourceName(progress.source, firmwareStatus)}: ${PHASE_LABEL[progress.phase]}…`;
}

export interface FlashControlsProps {
  link: SnapshotLink;
}

export function FlashControls({ link }: FlashControlsProps) {
  const firmwareStatus = useFirmwareStatus();
  const progress = useFlashProgress(link.id);
  const { send, sendBinary, onFlashResult, onFlashLocalReady } = useWsActions();
  const navigate = useNavigate();
  // Ticket 011 (carried from 009's send-gating sweep): the dialog's
  // trigger (`FlashDialog.tsx`) already gates opening on `useSendable()`,
  // but a connection can still drop while the dialog is already open --
  // these buttons gate independently so a stale-open dialog doesn't
  // leave a live-looking send control active.
  const sendable = useSendable();

  const [flashError, setFlashError] = useState<string | null>(null);
  // Ticket 018-017: what to name in "Flashed <name>. Waiting …" -- `null`
  // means no reidentify-timeout result is currently showing; a non-null
  // value is the flash's own source name ({@link flashSourceName}),
  // computed once at the moment the result arrives (not re-derived later
  // from `firmwareStatus`, which can move on to a newer poll by the time
  // this renders).
  const [reidentifyName, setReidentifyName] = useState<string | null>(null);
  // What to name in "Flashed <name>." after a plain `ok` result. The
  // `navigate("/")` below only leaves this component when it was opened
  // from a device page; opened from the front page (the card's Flash
  // button) that navigation is a no-op and the dialog stays open, so
  // without this line a finished flash just dropped back to the firmware
  // choices with no confirmation (real-hardware finding, Ubuntu 24.04).
  const [flashedName, setFlashedName] = useState<string | null>(null);
  const [localHex, setLocalHex] = useState<LocalHexState>({ phase: "idle" });

  useEffect(() => {
    return onFlashResult((message) => {
      if (message.linkId !== link.id) {
        return;
      }
      setFlashedName(null);
      if (message.status === "error") {
        setFlashError(message.message ?? "Flash failed.");
        return;
      }
      setFlashError(null);
      if (message.reidentify !== "timeout") {
        setFlashedName(flashSourceName(message.source, firmwareStatus));
      }
      if (message.reidentify === "timeout") {
        // The write succeeded; the board just hasn't announced yet (see
        // this module's doc comment). Never worded as a failure, and
        // deliberately does not navigate away.
        setReidentifyName(flashSourceName(message.source, firmwareStatus));
        return;
      }
      navigate("/");
    });
  }, [link.id, navigate, onFlashResult, firmwareStatus]);

  useEffect(() => {
    return onFlashLocalReady((message: FlashLocalReadyMessage) => {
      setLocalHex((prev) => {
        if (prev.phase !== "awaiting-ready") {
          // A stray or duplicate reply, or one for an upload this
          // component has already moved on from -- ignored rather than
          // resurrecting stale state.
          return prev;
        }
        sendBinary(buildUploadFrame(message.uploadId, prev.bytes));
        return { phase: "uploaded", uploadId: message.uploadId, fileName: prev.fileName, byteLength: prev.byteLength, sha256: prev.sha256 };
      });
    });
  }, [onFlashLocalReady, sendBinary]);

  const flashRelease = useCallback(
    (firmware: FirmwareKind) => {
      if (!sendable) {
        return;
      }
      setFlashError(null);
      setReidentifyName(null);
      setFlashedName(null);
      send({ type: "flash-start", linkId: link.id, source: { kind: "release", firmware } });
    },
    [link.id, send, sendable],
  );

  const handleFileSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset immediately so selecting the same file again still fires
      // `onChange`.
      event.target.value = "";
      if (!file || !sendable) {
        return;
      }
      setFlashError(null);
      setReidentifyName(null);
      setFlashedName(null);
      if (file.size > MAX_LOCAL_HEX_BYTES) {
        setLocalHex({ phase: "oversize", fileName: file.name, byteLength: file.size });
        return;
      }
      void (async () => {
        const bytes = await file.arrayBuffer();
        const sha256 = await sha256Hex(bytes);
        setLocalHex({ phase: "awaiting-ready", fileName: file.name, byteLength: file.size, sha256, bytes });
        send({ type: "flash-local-begin", fileName: file.name, byteLength: file.size, sha256 });
      })();
    },
    [send, sendable],
  );

  const flashLocalFile = useCallback(() => {
    if (localHex.phase !== "uploaded" || !sendable) {
      return;
    }
    setFlashError(null);
    setReidentifyName(null);
    setFlashedName(null);
    send({
      type: "flash-start",
      linkId: link.id,
      source: { kind: "local-hex", uploadId: localHex.uploadId, fileName: localHex.fileName, sha256: localHex.sha256 },
    });
    setLocalHex({ phase: "idle" });
  }, [link.id, localHex, send, sendable]);

  const relayReason = firmwareDisabledReason(firmwareStatus.relay);
  const robotReason = firmwareDisabledReason(firmwareStatus.robot);
  const relayDetail = firmwareDiagnosticDetail(firmwareStatus.relay);
  const robotDetail = firmwareDiagnosticDetail(firmwareStatus.robot);
  const relaySource = firmwareSourceText(firmwareStatus.relay);
  const robotSource = firmwareSourceText(firmwareStatus.robot);
  const localHexBusy = localHex.phase === "awaiting-ready";

  return (
    <div className="flash-controls">
      {progress ? (
        <p className="device-flash-progress" role="status">
          {flashProgressText(progress, firmwareStatus)}
        </p>
      ) : (
        <div className="device-flash-section">
          <div className="device-flash-actions">
            <div className="device-flash-control">
              <button
                type="button"
                className="device-button"
                disabled={relayReason !== null || !sendable}
                onClick={() => flashRelease("relay")}
              >
                Flash relay firmware
              </button>
              {/* Ticket 018-017: mutually exclusive with the reason
               * paragraph -- "if unavailable, show the plain reason
               * instead" of the source line. */}
              {relayReason ? (
                <p className="device-flash-hint">{relayReason}</p>
              ) : (
                relaySource && (
                  <p className="device-flash-source" data-testid="flash-source-relay">
                    <a href={relaySource.href} target="_blank" rel="noreferrer noopener">
                      {relaySource.repoName}
                    </a>{" "}
                    {relaySource.tag} · {relaySource.checkedText}
                  </p>
                )
              )}
              {relayDetail && (
                <details className="device-flash-detail">
                  <summary>Details for instructors</summary>
                  <p>{relayDetail}</p>
                </details>
              )}
            </div>
            <div className="device-flash-control">
              <button
                type="button"
                className="device-button"
                disabled={robotReason !== null || !sendable}
                onClick={() => flashRelease("robot")}
              >
                Flash robot firmware
              </button>
              {robotReason ? (
                <p className="device-flash-hint">{robotReason}</p>
              ) : (
                robotSource && (
                  <p className="device-flash-source" data-testid="flash-source-robot">
                    <a href={robotSource.href} target="_blank" rel="noreferrer noopener">
                      {robotSource.repoName}
                    </a>{" "}
                    {robotSource.tag} · {robotSource.checkedText}
                  </p>
                )
              )}
              {robotDetail && (
                <details className="device-flash-detail">
                  <summary>Details for instructors</summary>
                  <p>{robotDetail}</p>
                </details>
              )}
            </div>
          </div>

          <div className="device-flash-local">
            <h3>Flash a hex file from disk</h3>
            <p className="device-flash-hint">
              This doesn't check whether the file matches this board's hardware. If you flash
              the wrong kind of hex, the board may just stop responding — that's fine, plug it
              back in and flash it again; a micro:bit can always be re-flashed.
            </p>
            <input
              type="file"
              accept=".hex"
              data-testid="local-hex-file-input"
              onChange={handleFileSelected}
              disabled={localHexBusy || !sendable}
            />
            {localHex.phase === "oversize" && (
              <p className="device-note device-note-error" role="alert">
                "{localHex.fileName}" is too large ({Math.ceil(localHex.byteLength / 1024)}KB) —
                files over 4MB can't be uploaded. Pick a smaller file.
              </p>
            )}
            {localHex.phase === "awaiting-ready" && (
              <p className="device-flash-hint" role="status">
                Preparing "{localHex.fileName}"…
              </p>
            )}
            {localHex.phase === "uploaded" && (
              <>
                <p className="device-flash-hint">
                  Ready to flash "{localHex.fileName}" ({Math.ceil(localHex.byteLength / 1024)}KB).
                </p>
                <button
                  type="button"
                  className="device-button device-button-primary"
                  disabled={!sendable}
                  onClick={flashLocalFile}
                >
                  Flash this file
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!progress && flashError && (
        <p className="device-note device-note-error" role="alert">
          {flashError}
        </p>
      )}

      {!progress && flashedName !== null && (
        <p className="credentials-result credentials-result-ok" role="status" data-testid="flash-success">
          Flashed {flashedName}.
        </p>
      )}

      {reidentifyName !== null && (
        <p className="device-note" role="status">
          Flashed {reidentifyName}. Waiting for the board to come back…
        </p>
      )}
    </div>
  );
}
