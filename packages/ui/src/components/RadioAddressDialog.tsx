/**
 * RadioAddressDialog.tsx — the header's "Set Radio" button (OOP
 * 2026-09-10). The robot firmware has no wire verb for its own radio
 * address -- the channel and group are compiled into the build when it
 * is flashed -- so what this sets is the address the *console* uses
 * for this robot's name when connecting through a relay: the same
 * per-name stored address `RelayPage` and the front page's relay
 * quick-connect read (`readStoredAddress`/`writeStoredAddress`).
 * Defaults to the name-derived address from `@robot-console/protocol`.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { EndpointListEntry } from "@robot-console/host/src/wsMessages.js";
import { readStoredAddress, writeStoredAddress } from "../pages/RelayPage";
import "./FlashDialog.css";
import "./CredentialsDialog.css";

export interface RadioAddressDialogProps {
  endpoint: EndpointListEntry;
  triggerClassName?: string;
}

export function RadioAddressDialog({ endpoint, triggerClassName = "device-button" }: RadioAddressDialogProps) {
  const name = endpoint.name;
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [group, setGroup] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open || !name) {
      return;
    }
    const current = readStoredAddress(name) ?? nameToRadioAddress(name);
    setChannel(String(current.channel));
    setGroup(String(current.group));
    setSaved(false);
    setError(null);
  }, [open, name]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }, [open]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!name) {
      return;
    }
    const ch = Number(channel);
    const gr = Number(group);
    if (!Number.isInteger(ch) || ch < 0 || ch > 83) {
      setError("Channel must be a whole number from 0 to 83.");
      return;
    }
    if (!Number.isInteger(gr) || gr < 0 || gr > 255) {
      setError("Group must be a whole number from 0 to 255.");
      return;
    }
    writeStoredAddress(name, { channel: ch, group: gr });
    setError(null);
    setSaved(true);
  }

  if (!name) {
    return null;
  }
  const derived = nameToRadioAddress(name);

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        data-testid="radio-address-trigger"
        onClick={() => setOpen(true)}
      >
        Set Radio
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="flash-dialog"
          aria-label="Set radio address"
          data-testid="radio-address-dialog"
          onClose={() => setOpen(false)}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div className="flash-dialog-panel credentials-panel">
            <div className="flash-dialog-header">
              <h2>Radio address for {name}</h2>
              <button type="button" className="flash-dialog-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <form className="credentials-form" onSubmit={handleSubmit}>
              <label>
                <span>Channel</span>
                <input data-testid="radio-channel" inputMode="numeric" value={channel} onChange={(event) => setChannel(event.target.value)} />
              </label>
              <label>
                <span>Group</span>
                <input data-testid="radio-group" inputMode="numeric" value={group} onChange={(event) => setGroup(event.target.value)} />
              </label>
              <p className="credentials-note">
                This is the address the console uses for {name} when connecting through a relay. The robot's own
                radio address is fixed when it is flashed (the name-derived default is {derived.channel}/{derived.group};
                the shared template image uses 55/114), so set this to match the build on the robot.
              </p>
              {error && (
                <p className="credentials-error" role="alert" data-testid="radio-error">
                  {error}
                </p>
              )}
              {saved && (
                <p className="credentials-result credentials-result-ok" role="status" data-testid="radio-saved">
                  Saved. The next relay connection to {name} will use channel {channel}, group {group}.
                </p>
              )}
              <div className="credentials-actions">
                <button type="submit" className="credentials-primary" data-testid="radio-save">
                  Save
                </button>
                <button type="button" onClick={() => setOpen(false)}>
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
