/**
 * UnknownDevicePage.tsx — `/d/:endpointId` for the `unknown`
 * classification (SUC-002, SUC-003, SUC-004), including
 * `DevicePage`'s `default` dispatch arm for any classification `type`
 * this client doesn't recognize -- the mechanism that makes a future
 * fourth device type purely additive on the wire (see
 * `wsMessages.ts`'s module doc comment).
 *
 * This is the page that gets real exercise on the current bench: every
 * attached micro:bit classifies as `unknown` today (no board announces
 * after a flash -- `flash-succeeds-but-board-never-announces.md`), so
 * this is where a student actually goes to recover a device.
 *
 * Two flash affordances, both ported from `DevicesTab.tsx`'s
 * `DeviceCard` (moved, not redesigned) plus one new one:
 *
 *  - **Release flash** (existing flow, SUC-002): relay/robot buttons,
 *    shown for any device that hasn't identified with a role yet
 *    (`canBeFlashed`, which covers both a failed-identify device and a
 *    silent, unflashed board) and gated per-firmware on live
 *    `firmwareStatus` (`firmwareDisabledReason`) -- verbatim from
 *    `DeviceCard`, just relocated here.
 *  - **Local-hex flash** (new, SUC-003): a file input drives the
 *    `flash-local-begin` -> `flash-local-ready` -> one binary frame
 *    handshake `wsMessages.ts`/`localHexUpload.ts` (ticket 005) define.
 *    The binary frame is sent automatically the moment
 *    `flash-local-ready` arrives; only the final `flash-start` waits
 *    for an explicit "Flash this file" click, so the student has a
 *    chance to see what's about to happen before it does. The oversize
 *    check (`MAX_LOCAL_HEX_BYTES`, mirroring `localHexUpload.ts`'s
 *    server-side `MAX_UPLOAD_BYTE_LENGTH`) runs client-side, before
 *    anything is sent, so an oversized file is never even offered to
 *    the server -- consistent with, not a replacement for, the
 *    server's own before-allocating-a-buffer rejection.
 *  - A warn-don't-block compatibility note sits above the file picker:
 *    this codebase has no way to confirm a hex targets this board's
 *    hardware family (`isValidIntelHexText` has no board-family
 *    awareness -- ticket 005), so a v1-only image can flash onto a v2
 *    board and leave it silent. That is always recoverable (a
 *    micro:bit can be re-flashed over SWD or MSD no matter what is
 *    currently on it), so the copy says exactly that instead of
 *    refusing the flash outright.
 *
 * Progress rendering (both flash kinds) reads `useFlashProgress`
 * (ticket 006), not `EndpointListEntry.flashStatus` -- the latter is
 * frozen to `{ firmware, phase }` and has no shape for a local-hex
 * source, so it cannot represent that flow's progress at all. This
 * does inherit `useFlashProgress`'s documented reconnect gap (a client
 * that reconnects mid-flash sees no progress until the next live
 * `flash-progress` event, for *either* source kind here, whereas
 * `flashStatus` alone would have self-healed a release-kind flash from
 * the snapshot) -- accepted here per this ticket's own instruction to
 * render both kinds identically, not fixed (that gap is `WsProvider`'s
 * ticket 006 doc comment's, not this ticket's, to close.
 *
 * **Post-flash navigation** (SUC-002 step 4, SUC-004): subscribes to
 * `onFlashResult` for this endpoint only. `status: "ok"` with no
 * `reidentify` field navigates to the front page immediately -- the
 * message's own `classification` is already folded into the next
 * `endpoints` snapshot by the time this arrives (ticket 004's
 * reidentify-before-result sequencing), so there is no stale-type
 * flash to land on. `status: "ok", reidentify: "timeout"` deliberately
 * does **not** navigate -- SUC-004 calls for *this page* to render
 * "waiting for the board to come back", and the front page would show
 * nothing different yet regardless (the endpoint is still `unknown`
 * there too). `status: "error"` never navigates; the message surfaces
 * as this page's own flash-error note instead. A result for a
 * *different* endpoint (the student navigated to another device's
 * page while a flash from this one was still in flight) is ignored --
 * checked via a closure over the current `endpoint.endpointId`, kept
 * fresh by this effect's own dependency array, since `react-router`
 * does not unmount this component just because its `endpoint` prop
 * changed to a different device of the same classification.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router";
import type {
  EndpointListEntry,
  FirmwareKind,
  FlashLocalReadyMessage,
} from "@robot-console/host/src/wsMessages.js";
import { useFirmwareStatus, useFlashProgress, useWsActions, type FlashProgressState } from "../ws/WsProvider";
import { FIRMWARE_LABEL, PHASE_LABEL, canBeFlashed, firmwareDisabledReason } from "../deviceDisplay";
import { DeviceConsole } from "../components/DeviceConsole";
import "./UnknownDevicePage.css";

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
  | { phase: "uploaded"; uploadId: string; fileName: string; sha256: string };

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

function sourceLabel(source: FlashProgressState["source"]): string {
  return source.kind === "release" ? FIRMWARE_LABEL[source.firmware] : `"${source.fileName}"`;
}

function flashProgressText(progress: FlashProgressState): string {
  return `Flashing ${sourceLabel(progress.source)}: ${PHASE_LABEL[progress.phase]}…`;
}

export interface UnknownDevicePageProps {
  endpoint: EndpointListEntry;
}

export function UnknownDevicePage({ endpoint }: UnknownDevicePageProps) {
  const firmwareStatus = useFirmwareStatus();
  const progress = useFlashProgress(endpoint.endpointId);
  const { send, sendBinary, onFlashResult, onFlashLocalReady } = useWsActions();
  const navigate = useNavigate();

  const [flashError, setFlashError] = useState<string | null>(null);
  const [reidentifyTimedOut, setReidentifyTimedOut] = useState(false);
  const [localHex, setLocalHex] = useState<LocalHexState>({ phase: "idle" });

  useEffect(() => {
    return onFlashResult((message) => {
      if (message.endpointId !== endpoint.endpointId) {
        return;
      }
      if (message.status === "error") {
        setFlashError(message.message ?? "Flash failed.");
        return;
      }
      setFlashError(null);
      if (message.reidentify === "timeout") {
        // The write succeeded; the board just hasn't announced yet (see
        // this module's doc comment). Never worded as a failure, and
        // deliberately does not navigate away.
        setReidentifyTimedOut(true);
        return;
      }
      navigate("/");
    });
  }, [endpoint.endpointId, navigate, onFlashResult]);

  useEffect(() => {
    return onFlashLocalReady((message: FlashLocalReadyMessage) => {
      setLocalHex((prev) => {
        if (prev.phase !== "awaiting-ready") {
          // A stray or duplicate reply, or one for an upload this page
          // has already moved on from -- ignored rather than
          // resurrecting stale state.
          return prev;
        }
        sendBinary(buildUploadFrame(message.uploadId, prev.bytes));
        return { phase: "uploaded", uploadId: message.uploadId, fileName: prev.fileName, sha256: prev.sha256 };
      });
    });
  }, [onFlashLocalReady, sendBinary]);

  const flashRelease = useCallback(
    (firmware: FirmwareKind) => {
      setFlashError(null);
      setReidentifyTimedOut(false);
      send({ type: "flash-start", endpointId: endpoint.endpointId, source: { kind: "release", firmware } });
    },
    [endpoint.endpointId, send],
  );

  const handleFileSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset immediately so selecting the same file again still fires
      // `onChange`.
      event.target.value = "";
      if (!file) {
        return;
      }
      setFlashError(null);
      setReidentifyTimedOut(false);
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
    [send],
  );

  const flashLocalFile = useCallback(() => {
    if (localHex.phase !== "uploaded") {
      return;
    }
    setFlashError(null);
    setReidentifyTimedOut(false);
    send({
      type: "flash-start",
      endpointId: endpoint.endpointId,
      source: { kind: "local-hex", uploadId: localHex.uploadId, fileName: localHex.fileName, sha256: localHex.sha256 },
    });
    setLocalHex({ phase: "idle" });
  }, [endpoint.endpointId, localHex, send]);

  const showFlashControls = canBeFlashed(endpoint);
  const relayReason = firmwareDisabledReason(firmwareStatus.relay);
  const robotReason = firmwareDisabledReason(firmwareStatus.robot);
  const localHexBusy = localHex.phase === "awaiting-ready";

  return (
    <section className="unknown-device-page" aria-label="Unknown device">
      <h2>{endpoint.name ?? endpoint.endpointId}</h2>

      {endpoint.sessionError && <p className="device-note">Link attempt: {endpoint.sessionError}</p>}

      {showFlashControls &&
        (progress ? (
          <p className="device-flash-progress" role="status">
            {flashProgressText(progress)}
          </p>
        ) : (
          <div className="device-flash-section">
            <div className="device-flash-actions">
              <div className="device-flash-control">
                <button
                  type="button"
                  className="device-button"
                  disabled={relayReason !== null}
                  onClick={() => flashRelease("relay")}
                >
                  Flash relay firmware
                </button>
                {relayReason && <p className="device-flash-hint">{relayReason}</p>}
              </div>
              <div className="device-flash-control">
                <button
                  type="button"
                  className="device-button"
                  disabled={robotReason !== null}
                  onClick={() => flashRelease("robot")}
                >
                  Flash robot firmware
                </button>
                {robotReason && <p className="device-flash-hint">{robotReason}</p>}
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
                disabled={localHexBusy}
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
                  <p className="device-flash-hint">Ready to flash "{localHex.fileName}".</p>
                  <button
                    type="button"
                    className="device-button device-button-primary"
                    onClick={flashLocalFile}
                  >
                    Flash this file
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

      {showFlashControls && !progress && flashError && (
        <p className="device-note device-note-error" role="alert">
          {flashError}
        </p>
      )}

      {reidentifyTimedOut && (
        <p className="device-note" role="status">
          Flashed. Waiting for the board to come back…
        </p>
      )}

      <DeviceConsole device={endpoint} />
    </section>
  );
}

