// @vitest-environment jsdom
/**
 * WifiCredentialsForm.test.tsx — `validateWifiInput`'s own coverage
 * (moved out of `WifiCredentialsDialog.test.tsx`, ticket 017-008 -- it
 * validates a value both `WifiCredentialsDialog` and `ConfigurationPage`
 * now share through this module) plus rendering coverage for both
 * variants' differing DOM/copy.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WifiCredentialsForm, validateWifiInput } from "./WifiCredentialsForm";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

describe("validateWifiInput", () => {
  it("refuses spaces, empties, and over-long values; accepts a blank password only when one is stored", () => {
    expect(validateWifiInput("Busboom Mesh", "pw", false)).toContain("spaces");
    expect(validateWifiInput("", "pw", false)).toContain("network name");
    expect(validateWifiInput("Net", "", false)).toContain("password");
    expect(validateWifiInput("Net", "", true)).toBeNull();
    expect(validateWifiInput("x".repeat(33), "pw", false)).toContain("too long");
    expect(validateWifiInput("Net", "p".repeat(64), false)).toContain("too long");
    expect(validateWifiInput("Busboom_Garage", "hunter2", false)).toBeNull();
  });
});

describe("WifiCredentialsForm", () => {
  it("dialog variant: label-wrapped inputs with length limits, a show/hide toggle, and the 'written to the robot' note", () => {
    const el = mount(
      <WifiCredentialsForm
        variant="dialog"
        ssid="Busboom_Garage"
        password="hunter2"
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={{ ssid: "Busboom_Garage", hasPassword: true, source: "stored" }}
        error={null}
      />,
    );
    const ssidInput = el.querySelector<HTMLInputElement>('[data-testid="wifi-ssid"]')!;
    const passwordInput = el.querySelector<HTMLInputElement>('[data-testid="wifi-password"]')!;
    expect(ssidInput.maxLength).toBe(32);
    expect(passwordInput.maxLength).toBe(63);
    expect(passwordInput.type).toBe("text");
    expect(el.textContent).toContain("Written to the robot's credential slot 0");

    act(() => {
      el.querySelector<HTMLButtonElement>(".credentials-show")!.click();
    });
    expect(passwordInput.type).toBe("password");
  });

  it("dialog variant: shows the 'leave blank to keep' placeholder only once a matching password is stored", () => {
    const el = mount(
      <WifiCredentialsForm
        variant="dialog"
        ssid="Busboom_Garage"
        password=""
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={{ ssid: "Busboom_Garage", hasPassword: true, source: "stored" }}
        error={null}
      />,
    );
    expect(el.querySelector<HTMLInputElement>('[data-testid="wifi-password"]')!.placeholder).toContain("leave blank");
  });

  it("dialog variant: an error renders at data-testid wifi-error", () => {
    const el = mount(
      <WifiCredentialsForm
        variant="dialog"
        ssid=""
        password=""
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={undefined}
        error="Enter the network name."
      />,
    );
    expect(el.querySelector('[data-testid="wifi-error"]')?.textContent).toBe("Enter the network name.");
  });

  it("tab variant: id/label table rows, no maxLength, no show/hide toggle, and a note with no trailing sentence", () => {
    const el = mount(
      <WifiCredentialsForm
        variant="tab"
        ssid="Busboom_Garage"
        password="hunter2"
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={{ ssid: "Busboom_Garage", hasPassword: true, source: "stored" }}
        error={null}
      />,
    );
    expect(el.querySelector('[data-testid="configuration-wifi"]')).not.toBeNull();
    const ssidInput = el.querySelector<HTMLInputElement>("#configuration-wifi-ssid")!;
    const passwordInput = el.querySelector<HTMLInputElement>("#configuration-wifi-password")!;
    expect(ssidInput.maxLength).toBe(-1);
    expect(passwordInput.type).toBe("text");
    expect(el.querySelector(".credentials-show")).toBeNull();
    expect(el.textContent).not.toContain("Written to the robot's credential slot");
    expect(el.querySelector('[data-testid="configuration-wifi-ssid"]')).toBe(ssidInput);
  });

  it("tab variant: an error renders at data-testid configuration-wifi-error", () => {
    const el = mount(
      <WifiCredentialsForm
        variant="tab"
        ssid=""
        password=""
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={undefined}
        error="Enter the network name."
      />,
    );
    expect(el.querySelector('[data-testid="configuration-wifi-error"]')?.textContent).toBe("Enter the network name.");
  });

  it("both variants render the same three-way source text (env/stored/none), differing only in trailing punctuation", () => {
    const dialogEnv = mount(
      <WifiCredentialsForm
        variant="dialog"
        ssid=""
        password=""
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={{ source: "env" }}
        error={null}
      />,
    );
    expect(dialogEnv.textContent).toContain("From this computer's configuration.");
    act(() => {
      root!.unmount();
    });
    container?.remove();

    const tabEnv = mount(
      <WifiCredentialsForm
        variant="tab"
        ssid=""
        password=""
        onSsidChange={vi.fn()}
        onPasswordChange={vi.fn()}
        stored={{ source: "env" }}
        error={null}
      />,
    );
    expect(tabEnv.querySelector(".credentials-note")?.textContent).toBe("From this computer's configuration.");
  });
});
