/**
 * Modal.tsx — the `<dialog>` open/`showModal()`/fallback/close-focus
 * boilerplate (ticket 017-007; `docs/reviews/2026-09-11/04-ui.md` §4,
 * "`<dialog>` open/showModal/fallback/close-focus boilerplate"),
 * previously three independent, near-identical copies in
 * `FlashDialog.tsx`, `WifiCredentialsDialog.tsx`, and
 * `RadioAddressDialog.tsx`.
 *
 * ## What this component owns, and what it deliberately does not
 *
 * This is a thin shell, not a full modal framework: it owns exactly the
 * "call `showModal()` (falling back to a plain `open` attribute in an
 * environment that doesn't implement it -- this package's pinned jsdom
 * version, as of this ticket) once `open` becomes true" effect, and
 * renders nothing at all while `open` is `false` (mirroring every
 * pre-extraction caller's own `{open && (<dialog ...>)}` pattern) so a
 * caller can mount `<Modal>` unconditionally.
 *
 * Everything else stays with the caller, passed straight through as
 * props, because the three pre-extraction dialogs disagreed on it in
 * ways this ticket's "pure extraction, parity not redesign" mandate
 * forbids papering over:
 *  - **Close/cancel/backdrop handling** differs per dialog (`FlashDialog`
 *    suppresses Escape/backdrop-click while a flash is in progress and
 *    adds a Tab-cycling focus trap; `WifiCredentialsDialog`/
 *    `RadioAddressDialog` do not) -- so `onClose`/`onCancel`/`onClick`/
 *    `onKeyDown` are plain pass-through props, never second-guessed
 *    here.
 *  - **Focus-on-open** (`dialog.focus()`) is `FlashDialog`-only
 *    (`focusOnOpen`, default `false` -- the other two never called it).
 *  - **The dialog element itself** is still exposed to the caller via
 *    `dialogRef` (a caller-supplied ref, not one this component keeps to
 *    itself) because `FlashDialog`'s own Tab-cycling handler and
 *    backdrop-click comparison (`event.target !== dialogRef.current`)
 *    both need direct access to the node.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  SyntheticEvent,
} from "react";

export interface ModalProps {
  /** Renders nothing at all while `false` -- see this module's own doc
   * comment. */
  open: boolean;
  /** Exposes the underlying `<dialog>` node to the caller (Tab-cycling,
   * backdrop-click target comparison, etc.); when omitted, an internal
   * ref is used (the node just isn't reachable from outside). */
  dialogRef?: RefObject<HTMLDialogElement | null>;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  tabIndex?: number;
  /** `FlashDialog`-only: calls `dialog.focus()` once `open` becomes
   * true, immediately after `showModal()`/the fallback. Default
   * `false`. */
  focusOnOpen?: boolean;
  onClose?: (event: SyntheticEvent<HTMLDialogElement>) => void;
  onCancel?: (event: SyntheticEvent<HTMLDialogElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLDialogElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

export function Modal({
  open,
  dialogRef: externalRef,
  className,
  ariaLabel,
  testId,
  tabIndex,
  focusOnOpen = false,
  onClose,
  onCancel,
  onClick,
  onKeyDown,
  children,
}: ModalProps) {
  const internalRef = useRef<HTMLDialogElement>(null);
  const dialogRef = externalRef ?? internalRef;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      // jsdom fallback -- see this module's doc comment.
      dialog.setAttribute("open", "");
    }
    if (focusOnOpen) {
      dialog.focus();
    }
    // `dialogRef` is a ref object, stable across renders whether it's
    // the caller's own or this component's internal one -- including it
    // does not cause extra re-runs.
  }, [open, focusOnOpen, dialogRef]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
      tabIndex={tabIndex}
      onClose={onClose}
      onCancel={onCancel}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </dialog>
  );
}
