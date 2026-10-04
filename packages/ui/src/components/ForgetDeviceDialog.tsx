/**
 * ForgetDeviceDialog.tsx — the trash-can "Forget" control, in the
 * header and on a card with nothing else to press: asks first, then
 * tells the host to forget the device and goes back to the list.
 */
import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useSendable, useWsActions } from "../ws/WsProvider";
import { Modal } from "./Modal";

export interface ForgetDeviceDialogProps {
  deviceId: number;
  name: string;
  triggerClassName?: string;
  /** Shown instead of the word "Forget". */
  triggerIcon?: ReactNode;
}

/** A trash can in the same stroke style as the cards' arrow and lightning icons. */
export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 7 20 7" />
        <path d="M9 7V4h6v3" />
        <path d="M6 7l1 13h10l1-13" />
        <line x1="10" y1="11" x2="10" y2="17" />
        <line x1="14" y1="11" x2="14" y2="17" />
      </g>
    </svg>
  );
}

export function ForgetDeviceDialog({ deviceId, name, triggerClassName, triggerIcon }: ForgetDeviceDialogProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { send } = useWsActions();
  const sendable = useSendable();
  const navigate = useNavigate();

  function forget(): void {
    send({ type: "forget-device", deviceId });
    setOpen(false);
    navigate("/");
  }

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-label={`Forget ${name}`}
        title={`Forget ${name}`}
        data-testid="forget-device-trigger"
        onClick={() => setOpen(true)}
      >
        {triggerIcon ?? "Forget"}
      </button>
      <Modal
        open={open}
        dialogRef={dialogRef}
        className="flash-dialog"
        ariaLabel={`Forget ${name}`}
        testId="forget-device-dialog"
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        <div className="flash-dialog-panel credentials-panel">
          <div className="flash-dialog-header">
            <h2>Forget {name}?</h2>
            <button type="button" className="flash-dialog-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <p className="credentials-note">
            {name} is removed from this console&apos;s list. It comes back the next time it is plugged into this
            computer.
          </p>
          <div className="network-settings-actions">
            <button type="button" data-testid="forget-device-confirm" disabled={!sendable} onClick={forget}>
              Forget {name}
            </button>
            <button type="button" data-testid="forget-device-cancel" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
