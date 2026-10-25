/**
 * RadioAddressDialog.tsx — the header's "Set Radio" button (OOP
 * 2026-09-10; migrated off `localStorage` by sprint 015 ticket 006).
 * The robot firmware has no wire verb for its own radio address -- the
 * channel and group are compiled into the build when it is flashed --
 * so what this sets is the address the *console* uses for this
 * device's name when connecting through a relay: a device-level
 * override, now persisted in the host's own DB (`devices.radio_channel`/
 * `radio_group`/`radio_source`, `docs/design/architecture.md` §2/§9)
 * rather than a per-name browser `localStorage` cache.
 *
 * ## Ticket 006: sends `set-radio-override`, no more `localStorage`
 *
 * Submitting sends `{ type: "set-radio-override", deviceId, channel,
 * group }` (`wsMessages.ts`) through `useWsActions().send` -- the host
 * validates the same `0-83`/`0-255` integer range this dialog checks
 * client-side (`radioOverride.ts`'s `isValidRadioOverride`, the one
 * authoritative check) and rejects an invalid value with a `notice`
 * rather than persisting it; this dialog's own check exists only for
 * immediate feedback, not as the source of truth. `readStoredAddress`/
 * `writeStoredAddress` (this component's former `localStorage` read/
 * write, shared with `RelayPage`/`ConfigurationPage`) are gone --
 * ticket 006's acceptance criterion that `grep -rn "localStorage"
 * packages/ui/src` shows no key holding a channel or group value.
 *
 * ## The `radio` prop
 *
 * Prefilling reads the device's already-resolved address (`radio`, the
 * snapshot's `SnapshotDevice.radio` -- `{ channel, group, source }`), so
 * the dialog opens showing whatever `override -> registry -> derived`
 * resolution (`radioOverride.ts`) the host settled on. `AppHeader.tsx`
 * passes both `deviceId` and `radio`. `radio` stays optional only for the
 * instant before a snapshot naming this device arrives; the dialog then
 * falls back to the name-derived default (`nameToRadioAddress`). While
 * `radio.source` is `"override"` the dialog offers "Revert to derived",
 * which sends `set-radio-override` with `clear: true`.
 *
 * ## Ticket 017-008: validation shared with `ConfigurationPage` via
 * `lib/radioAddress.ts`
 *
 * The `0-83`/`0-255` client-side range check moved to
 * `lib/radioAddress.ts`'s `validateRadioOverrideInput`, shared with
 * `ConfigurationPage.tsx`'s own Radio panel (`04-ui.md` §4) -- see that
 * module's own doc comment for why it mirrors the host's
 * `isValidRadioOverride` range rather than `@robot-console/protocol`'s
 * narrower, derived-address-space `validateRadioAddress`. The host's
 * `set-radio-override` handler remains the actual authority either way.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { nameToRadioAddress } from "@robot-console/protocol";
import type { RadioSourceWire } from "@robot-console/host/src/wsMessages.js";
import { useWsActions } from "../ws/WsProvider";
import { validateRadioOverrideInput } from "../lib/radioAddress";
import { Modal } from "./Modal";
import "./FlashDialog.css";
import "./CredentialsDialog.css";

export interface RadioAddressDialogProps {
  /** `devices.id` -- the target of the `set-radio-override` this dialog
   * sends. */
  deviceId: number;
  name: string;
  /** The device's current resolved radio address (the snapshot's
   * `SnapshotDevice.radio`) -- absent only before any snapshot naming
   * this device has arrived, in which case the dialog falls back to the
   * name-derived default. See this module's doc comment. */
  radio?: { channel: number; group: number; source: RadioSourceWire };
  triggerClassName?: string;
  triggerContent?: ReactNode;
}

export function RadioAddressDialog({ deviceId, name, radio, triggerClassName = "device-button", triggerContent }: RadioAddressDialogProps) {
  const { send } = useWsActions();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [group, setGroup] = useState("");
  const [saved, setSaved] = useState(false);
  const [reverted, setReverted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hasRadio = radio !== undefined;
  const radioChannel = radio?.channel;
  const radioGroup = radio?.group;
  const radioSource = radio?.source;

  useEffect(() => {
    if (!open) {
      return;
    }
    const current = hasRadio
      ? { channel: radioChannel, group: radioGroup }
      : nameToRadioAddress(name);
    setChannel(String(current.channel));
    setGroup(String(current.group));
    setSaved(false);
    setReverted(false);
    setError(null);
  }, [open, name, hasRadio, radioChannel, radioGroup, radioSource]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const ch = Number(channel);
    const gr = Number(group);
    const problem = validateRadioOverrideInput(ch, gr);
    if (problem) {
      setError(problem);
      return;
    }
    send({ type: "set-radio-override", deviceId, channel: ch, group: gr });
    setError(null);
    setReverted(false);
    setSaved(true);
  }

  function handleRevert(): void {
    send({ type: "set-radio-override", deviceId, clear: true });
    setError(null);
    setSaved(false);
    setReverted(true);
  }

  const derived = nameToRadioAddress(name);

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        data-testid="radio-address-trigger"
        title="Set radio address"
        onClick={() => setOpen(true)}
      >
        {triggerContent ?? "Set Radio"}
      </button>
      <Modal
        open={open}
        dialogRef={dialogRef}
        className="flash-dialog"
        ariaLabel="Set radio address"
        testId="radio-address-dialog"
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
              a robot flashed before the fleet moved to the 73-channel map may still use its old pair), so set this to
              match the build on the robot.
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
            {reverted && (
              <p className="credentials-result credentials-result-ok" role="status" data-testid="radio-reverted">
                Reverted. The next relay connection to {name} will use its derived address.
              </p>
            )}
            <div className="credentials-actions">
              <button type="submit" className="credentials-primary" data-testid="radio-save">
                Save
              </button>
              {radio?.source === "override" && (
                <button type="button" data-testid="radio-revert" onClick={handleRevert}>
                  Revert to derived
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </form>
        </div>
      </Modal>
    </>
  );
}
