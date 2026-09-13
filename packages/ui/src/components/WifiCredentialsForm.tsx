/**
 * WifiCredentialsForm.tsx — the ssid/password fields, validation, and
 * "where this network came from" note shared by `WifiCredentialsDialog`
 * (the header's "Set Wi-Fi" button) and `ConfigurationPage`'s own Wi-Fi
 * tab (ticket 017-008; `docs/reviews/2026-09-11/04-ui.md` §4's "Wi-Fi
 * save flow ... and source note text" row).
 *
 * The two call sites' *save flow* genuinely differs (the dialog's one
 * submit both sets and provisions immediately; the tab's page-level
 * Save button only updates the draft, and a separate Write-to-robot
 * button provisions later) and stays owned by each caller, same as
 * `Modal`'s division of labor in ticket 007 -- this component only
 * covers the two fields, their validation, and the note text those two
 * flows both need. `variant` reproduces each site's exact prior DOM
 * (the dialog's `<label>`-wrapped inputs with a show/hide toggle and
 * length limits vs. the tab's own `calibration-table`-styled rows with
 * neither) and copy (the dialog's note ends with the "written to the
 * robot's credential slot" sentence the tab's never had) rather than
 * picking one -- a pure extraction, not a redesign.
 */
import { useState } from "react";

export const WIFI_SSID_MAX = 32;
export const WIFI_PASSWORD_MAX = 63;

/** `null` when acceptable, else the reason. */
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

/** The slice of `useWifiCredentials()`'s result this form needs to
 * prefill the password placeholder and render the source note. */
export interface WifiCredentialsFormStored {
  ssid?: string | null;
  hasPassword?: boolean;
  source?: string;
}

export type WifiCredentialsFormVariant = "dialog" | "tab";

export interface WifiCredentialsFormProps {
  variant: WifiCredentialsFormVariant;
  ssid: string;
  password: string;
  onSsidChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  stored: WifiCredentialsFormStored | undefined;
  error?: string | null;
}

export function WifiCredentialsForm({ variant, ssid, password, onSsidChange, onPasswordChange, stored, error }: WifiCredentialsFormProps) {
  // The show/hide toggle is a dialog-only, purely presentational bit of
  // state -- the tab variant never renders it -- so it lives here
  // rather than being threaded through as a prop from either caller.
  const [showPassword, setShowPassword] = useState(true);

  if (variant === "tab") {
    return (
      <>
        <table className="calibration-table" data-testid="configuration-wifi">
          <tbody>
            <tr>
              <th scope="row">
                <label htmlFor="configuration-wifi-ssid">Network name</label>
              </th>
              <td>
                <input
                  id="configuration-wifi-ssid"
                  data-testid="configuration-wifi-ssid"
                  value={ssid}
                  autoComplete="off"
                  onChange={(event) => onSsidChange(event.target.value)}
                />
              </td>
            </tr>
            <tr>
              <th scope="row">
                <label htmlFor="configuration-wifi-password">Password</label>
              </th>
              <td>
                <input
                  id="configuration-wifi-password"
                  data-testid="configuration-wifi-password"
                  type="text"
                  value={password}
                  autoComplete="off"
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>
        {error && (
          <p className="credentials-error" role="alert" data-testid="configuration-wifi-error">
            {error}
          </p>
        )}
        <p className="credentials-note">
          {stored?.source === "stored"
            ? "Saved on this computer."
            : stored?.source === "env"
              ? "From this computer's configuration."
              : "No network saved on this computer yet."}
        </p>
      </>
    );
  }

  const hasStored = stored?.hasPassword === true && stored.ssid === ssid.trim();
  return (
    <>
      <label>
        <span>Network name</span>
        <input
          data-testid="wifi-ssid"
          value={ssid}
          maxLength={WIFI_SSID_MAX}
          autoComplete="off"
          onChange={(event) => onSsidChange(event.target.value)}
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
            onChange={(event) => onPasswordChange(event.target.value)}
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
    </>
  );
}
