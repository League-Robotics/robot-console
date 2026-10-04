/**
 * ForgetDeviceDialog.tsx — the header's "Forget" button: asks first,
 * then tells the host to forget the device and goes back to the list.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSendable, useWsActions } from "../ws/WsProvider";
import { Modal } from "./Modal";

export interface ForgetDeviceDialogProps {
  deviceId: number;
  name: string;
  triggerClassName?: string;
}

export function ForgetDeviceDialog({ deviceId, name, triggerClassName }: ForgetDeviceDialogProps) {
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
        data-testid="forget-device-trigger"
        onClick={() => setOpen(true)}
      >
        Forget
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
