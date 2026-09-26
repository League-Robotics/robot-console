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
 *
 * ## Ticket 017-008: fields shared with `ConfigurationPage` via
 * `WifiCredentialsForm`
 *
 * The ssid/password inputs, their validation (`validateWifiInput`), and
 * the "where this network came from" note moved to
 * `components/WifiCredentialsForm.tsx`, shared with `ConfigurationPage`'s
 * Wi-Fi tab (`04-ui.md` §4). This dialog keeps the surrounding `<dialog>`
 * chrome, the submit flow (`set-wifi-credentials` + `provision-wifi`),
 * and the write-result display -- see that module's own doc comment for
 * why the save flow itself did not move.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSendable, useWifiCredentials, useWifiProvisionResult, useWsActions } from "../ws/WsProvider";
import { Modal } from "./Modal";
import { WifiCredentialsForm, validateWifiInput } from "./WifiCredentialsForm";
import "./FlashDialog.css";
import "./CredentialsDialog.css";

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
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      // `reveal: true` -- matches `ConfigurationPage.tsx`'s own request
      // (ticket 027-007). Everyone in the room already knows the
      // password (stakeholder direction); without this the Show/Hide
      // toggle has nothing to act on, because the host only includes
      // the saved password in its reply when asked to reveal it.
      send({ type: "get-wifi-credentials", reveal: true });
    }
  }, [open, send]);

  // Prefill the name and password from the host's stored network once
  // known -- once, on open, and only into a field the user has not
  // already started typing into (so a value in flight is never
  // clobbered by a reply that arrives after keystrokes).
  useEffect(() => {
    if (open && stored?.ssid && ssid === "") {
      setSsid(stored.ssid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stored?.ssid]);

  useEffect(() => {
    if (open && stored?.password && password === "") {
      setPassword(stored.password);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stored?.password]);

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
      <Modal
        open={open}
        dialogRef={dialogRef}
        className="flash-dialog"
        ariaLabel="Set Wi-Fi credentials"
        testId="wifi-credentials-dialog"
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
            <WifiCredentialsForm
              variant="dialog"
              ssid={ssid}
              password={password}
              onSsidChange={setSsid}
              onPasswordChange={setPassword}
              stored={stored}
              error={error}
            />
            {result && (
              <p
                className={result.ok ? "credentials-result credentials-result-ok" : "credentials-result credentials-error"}
                role="status"
                data-testid="wifi-result"
              >
                {result.message}
              </p>
            )}
            {result?.ok === true && (
              // The credential really is stored at this point -- and the
              // robot will carry on joining whatever network it picked at
              // boot, indefinitely, until it is reset.
              //
              // `Protocol::serviceWifi()` chooses its credential source
              // **once**, at the first poll after boot: flash store, else
              // `setupWifi()`, else the baked default. If the store was
              // empty at boot the flash branch is never taken and
              // `wifiBegun_` stays true forever; a credential written
              // afterwards lands in the slot correctly and has no effect
              // on the join already running. `setupWifi()`'s own doc says
              // it: "A call made after the link has already started is
              // ignored."
              //
              // So "stored" is only half the story, and a student who
              // clicks this and waits waits forever. The stakeholder hit
              // exactly that -- the store accepted Busboom_Garage while
              // the robot kept retrying a different network, 27 restarts
              // deep. Saying it here is the difference between a working
              // button and a mystery.
              <p className="credentials-result-hint" role="status" data-testid="wifi-result-reset-hint">
                <strong>Now reset the robot</strong> — power cycle it, or press its reset button. It keeps trying the
                network it picked when it last started up until then, so nothing changes until it restarts.
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
      </Modal>
    </>
  );
}
