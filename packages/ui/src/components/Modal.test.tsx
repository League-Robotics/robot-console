// @vitest-environment jsdom
/**
 * Modal.test.tsx — focused tests for the shared `<dialog>` shell
 * (ticket 017-007): renders nothing while closed, opens via
 * `showModal()` (falling back to a plain `open` attribute in this
 * package's jsdom, which does not implement `showModal`/`close`),
 * optionally focuses itself on open, and forwards every handler prop
 * untouched. `FlashDialog.test.tsx`/`WifiCredentialsDialog.test.tsx`/
 * `RadioAddressDialog.test.tsx` keep their own integration-level open/
 * close/dismissal assertions; this file is the one place the shell's
 * own open-effect/fallback/focus mechanics are pinned directly.
 */
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

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

function rerender(node: ReactElement): void {
  act(() => {
    root!.render(node);
  });
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

describe("Modal", () => {
  it("renders nothing while closed", () => {
    const el = mount(<Modal open={false}>content</Modal>);
    expect(el.querySelector("dialog")).toBeNull();
  });

  it("renders the dialog with the given className/aria-label/children once open", () => {
    const el = mount(
      <Modal open={true} className="flash-dialog" ariaLabel="Example dialog">
        <p>hello</p>
      </Modal>,
    );
    const dialog = el.querySelector("dialog")!;
    expect(dialog).not.toBeNull();
    expect(dialog.className).toBe("flash-dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Example dialog");
    expect(dialog.textContent).toBe("hello");
  });

  it("falls back to a plain open attribute in this jsdom version (no real showModal)", () => {
    const el = mount(<Modal open={true}>content</Modal>);
    const dialog = el.querySelector("dialog")!;
    // jsdom (this package's pinned version) does not implement
    // `showModal`, so the fallback path (`setAttribute("open", "")`)
    // is what actually runs -- this assertion pins that path directly.
    expect(typeof dialog.showModal).not.toBe("function");
    expect(dialog.hasAttribute("open")).toBe(true);
  });

  it("calls dialog.focus() on open only when focusOnOpen is true", () => {
    // `tabIndex={-1}` mirrors `FlashDialog.tsx`'s own usage -- a jsdom
    // `<dialog>` is only actually focusable with one set (as it is via
    // this prop in the one real caller that passes `focusOnOpen`).
    const elA = mount(
      <Modal open={true} focusOnOpen={true} tabIndex={-1}>
        <button type="button">inside</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(elA.querySelector("dialog"));

    act(() => {
      root!.unmount();
    });
    container!.remove();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    act(() => {
      root!.render(<Modal open={true}>content</Modal>);
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("forwards onClose/onCancel/onClick/onKeyDown to the dialog element untouched", () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const el = mount(
      <Modal open={true} onClose={onClose} onCancel={onCancel} onClick={onClick} onKeyDown={onKeyDown}>
        content
      </Modal>,
    );
    const dialog = el.querySelector("dialog")!;

    act(() => {
      dialog.dispatchEvent(new Event("close", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("exposes the dialog node through a caller-supplied dialogRef", () => {
    const ref = createRef<HTMLDialogElement>();
    const el = mount(
      <Modal open={true} dialogRef={ref}>
        content
      </Modal>,
    );
    expect(ref.current).toBe(el.querySelector("dialog"));
  });

  it("re-runs the open effect (and re-applies the fallback) when re-opened after closing", () => {
    const el = mount(<Modal open={false}>content</Modal>);
    expect(el.querySelector("dialog")).toBeNull();

    rerender(<Modal open={true}>content</Modal>);
    expect(el.querySelector("dialog")?.hasAttribute("open")).toBe(true);

    rerender(<Modal open={false}>content</Modal>);
    expect(el.querySelector("dialog")).toBeNull();

    rerender(<Modal open={true}>content</Modal>);
    expect(el.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  });
});
