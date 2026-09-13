/**
 * clipboard.ts — the shared "copy to clipboard, then say Copied for a
 * moment" behavior (ticket 017-007; `docs/reviews/2026-09-11/04-ui.md`
 * §4, "Copy-to-clipboard with 1.5 s 'Copied'"), previously two
 * independent, identical copies in `CalibrationPage.tsx` and
 * `ConfigurationPage.tsx`.
 *
 * `useCopied()` owns only the "Copied" flash timing; the text to copy
 * and the button itself stay with the caller (each has its own code
 * panel and its own disabled/empty states around the button). Ticket
 * 017-008's calibration/configuration copy buttons are the first
 * consumers -- this ticket only introduces the hook.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** [ms] -- how long the "Copied" state is shown before reverting. */
export const COPIED_TIMEOUT_MS = 1500;

export interface UseCopiedResult {
  /** `true` for {@link COPIED_TIMEOUT_MS} after the last successful
   * `copy()` call. */
  copied: boolean;
  /** Writes `text` to the clipboard (best-effort -- a rejected or
   * throwing `navigator.clipboard` is swallowed, mirroring both
   * pre-extraction copies: the text stays selectable either way) and
   * starts (or restarts) the "Copied" flash. */
  copy: (text: string) => void;
}

/** `1.5s "Copied" state` -- see this module's own doc comment. */
export function useCopied(timeoutMs: number = COPIED_TIMEOUT_MS): UseCopiedResult {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  const copy = useCallback(
    (text: string) => {
      // Mirrors both pre-extraction copies exactly: `setCopied`/the
      // revert timer are inside the same `try` as the clipboard write
      // itself, so a synchronously-throwing `navigator.clipboard` (rare
      // -- writeText normally rejects a Promise rather than throwing)
      // skips the "Copied" flash too, not just the write.
      try {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        if (timer.current !== undefined) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => setCopied(false), timeoutMs);
      } catch {
        // Clipboard unavailable -- the text is selectable either way.
      }
    },
    [timeoutMs],
  );

  return { copied, copy };
}
