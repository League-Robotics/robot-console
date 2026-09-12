/**
 * WifiCredentialsDialog.tsx — the header's "Set Wi-Fi" button (OOP
 * 2026-09-10, stakeholder direction). Opens a dialog to enter the
 * network name and password, saves them in the host's persistent
 * state (never the browser's), then writes them to the robot's
 * credential slot over whatever link is open: USB, radio relay or
 * WiFi. The host answers with the robot's own confirmation; the robot
 * picks the slot up at its next power cycle.
 *
 * The host never sends the password back, so the field starts empty
 * with a "saved -- leave blank to keep" hint whenever one is held.
 * Names and passwords with spaces are refused up front: the wire
 * splits on them. Mirrors `FlashDialog`'s native `<dialog>` pattern
 * (`showModal()` with a test-environment fallback) and reuses its
 * panel styles.
 *
 * ## Sprint 015 ticket 008: keyed by `linkId`, not an `EndpointListEntry`
 *
 * `provision-wifi` now carries `linkId` (`wsMessages.ts`), and whether a
 * session is open is a per-link fact (`SnapshotLink.session !==
 * undefined`) rather than a device-level `sessionOpen` flag -- a device
 * can have more than one link under the new contract. This component no
 * longer reaches into an `EndpointListEntry` for either fact: the
 * caller (which already knows which link it is opening this dialog
 * for) passes `linkId` and `linkOpen` directly, plus `name` for the
 * dialog's own title text (a link has no name of its own).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSendable, useWifiCredentials, useWifiProvisionResult, useWsActions } from "../ws/WsProvider";
import "./FlashDialog.css";
import "./CredentialsDialog.css";

export const WIFI_SSID_MAX = 32;
export const WIFI_PASSWORD_MAX = 63;

/** `null` when acceptable, else the reason. Exported for tests. */
export function validateWifiInput(ssid: string, password: string, hasStoredPassword: boolean): string | null {
  if (ssid.length === 0) {
    return "Enter the network name.";
  }
  if (/\s/.test(ssid) || /\s/.test(password)) {
    return "The network name and password cannot contain spaces.";
  }
  if (ssid.length > WIFI_SSID_MAX) {
    return `The network name is too long (${WIFI_SSID_MAX} characters at most).`;
  }
  if (password.length > WIFI_PASSWORD_MAX) {
    return `The password is too long (${WIFI_PASSWORD_MAX} characters at most).`;
  }
  if (password.length === 0 && !hasStoredPassword) {
    return "Enter the password.";
  }
  return null;
}

export interface WifiCredentialsDialogProps {
  linkId: string;
  /** Whether a session is currently open on `linkId` -- gates the
   * "Save and write to robot" button. */
  linkOpen: boolean;
  /** Display label for this dialog's title -- the owning device's name;
   * a link has none of its own. */
  name: string;
  triggerClassName?: string;
}

export function WifiCredentialsDialog({ linkId, linkOpen, name, triggerClassName = "device-button" }: WifiCredentialsDialogProps) {
  const { send } = useWsActions();
  // Ticket 011 (carried from 009's send-gating sweep): both the trigger
  // (opening the dialog at all) and the submit button gate on
  // `useSendable()` -- `linkOpen` alone (the caller's `link.session !==
  // undefined`) survives a host disconnect in the last-known snapshot,
  // same gap `useSendable`'s own doc comment describes.
  const sendable = useSendable();
  const stored = useWifiCredentials();
  const result = useWifiProvisionResult(linkId);
  const [open, setOpen] = useState(false);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      send({ type: "get-wifi-credentials" });
    }
  }, [open, send]);

  // Prefill the name from the host's stored network once known.
  useEffect(() => {
    if (open && stored?.ssid && ssid === "") {
      setSsid(stored.ssid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stored?.ssid]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
  }, [open]);

  useEffect(() => {
    if (result) {
      setWriting(false);
    }
  }, [result]);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
    setWriting(false);
    triggerRef.current?.focus();
  }, []);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!sendable) {
      return;
    }
    const trimmedSsid = ssid.trim();
    const problem = validateWifiInput(trimmedSsid, password, stored?.hasPassword === true && stored.ssid === trimmedSsid);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setWriting(true);
    send({ type: "set-wifi-credentials", ssid: trimmedSsid, password });
    send({ type: "provision-wifi", linkId, slot: 0 });
    setPassword("");
  }

  const hasStored = stored?.hasPassword === true && stored.ssid === ssid.trim();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        data-testid="wifi-credentials-trigger"
        disabled={!sendable}
        title={sendable ? undefined : "Disconnected from the host"}
        onClick={() => sendable && setOpen(true)}
      >
        Set Wi-Fi
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="flash-dialog"
          aria-label="Set Wi-Fi credentials"
          data-testid="wifi-credentials-dialog"
          onClose={close}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div className="flash-dialog-panel credentials-panel">
            <div className="flash-dialog-header">
              <h2>Set Wi-Fi on {name}</h2>
              <button type="button" className="flash-dialog-close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>
            <form className="credentials-form" onSubmit={handleSubmit}>
              <label>
                <span>Network name</span>
                <input
                  data-testid="wifi-ssid"
                  value={ssid}
                  maxLength={WIFI_SSID_MAX}
                  autoComplete="off"
                  onChange={(event) => setSsid(event.target.value)}
                />
              </label>
              <label>
                <span>Password</span>
                <span className="credentials-password-row">
                  <input
                    data-testid="wifi-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    maxLength={WIFI_PASSWORD_MAX}
                    autoComplete="off"
                    placeholder={hasStored ? "saved — leave blank to keep" : ""}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button type="button" className="credentials-show" onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </span>
              </label>
              <p className="credentials-note">
                {stored?.source === "stored"
                  ? "Saved on this computer. "
                  : stored?.source === "env"
                    ? "From this computer's configuration. "
                    : "No network saved on this computer yet. "}
                Written to the robot's credential slot 0 over the open link; the robot uses it after its
                next power cycle.
              </p>
              {error && (
                <p className="credentials-error" role="alert" data-testid="wifi-error">
                  {error}
                </p>
              )}
              {result && (
                <p
                  className={result.ok ? "credentials-result credentials-result-ok" : "credentials-result credentials-error"}
                  role="status"
                  data-testid="wifi-result"
                >
                  {result.message}
                </p>
              )}
              <div className="credentials-actions">
                <button
                  type="submit"
                  className="credentials-primary"
                  data-testid="wifi-write"
                  disabled={!linkOpen || writing || !sendable}
                  title={!sendable ? "Disconnected from the host" : linkOpen ? undefined : "Open a link to the robot first"}
                >
                  {writing ? "Writing…" : "Save and write to robot"}
                </button>
                <button type="button" onClick={close}>
                  Close
                </button>
              </div>
            </form>
          </div>
        </dialog>
      )}
    </>
  );
}
