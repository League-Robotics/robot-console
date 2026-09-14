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
 * Prefilling now reads the device's already-resolved address
 * (`radio`, the snapshot's `SnapshotDevice.radio` -- `{ channel, group,
 * source }`) rather than a locally-cached guess, so the dialog opens
 * showing whatever `override -> registry -> derived` resolution
 * (`radioOverride.ts`) the host already settled on. `radio` is optional
 * only because no snapshot naming this device may have arrived yet at
 * the instant this dialog is first rendered; the dialog still opens and
 * falls back to the name-derived default (`nameToRadioAddress`) in that
 * case. **Deferred to ticket 007/008**: no caller in this codebase can
 * actually supply a real `radio` yet -- `WsProvider` still speaks the
 * retired `endpoints` wire contract (`EndpointListEntry` has no `radio`
 * field at all) until those tickets migrate it to the `Snapshot`
 * contract this prop is shaped after. `AppHeader.tsx`'s call site is
 * unchanged pending that migration and does not yet pass `radio` (or a
 * numeric `deviceId` -- see that file's own TODO-shaped gap, tracked
 * outside this ticket).
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
import { useEffect, useRef, useState, type FormEvent } from "react";
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
}

export function RadioAddressDialog({ deviceId, name, radio, triggerClassName = "device-button" }: RadioAddressDialogProps) {
  const { send } = useWsActions();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("");
  const [group, setGroup] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const current = radio ?? { ...nameToRadioAddress(name), source: "derived" as const };
    setChannel(String(current.channel));
    setGroup(String(current.group));
    setSaved(false);
    setError(null);
  }, [open, name, radio]);

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
    setSaved(true);
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
      </Modal>
    </>
  );
}
