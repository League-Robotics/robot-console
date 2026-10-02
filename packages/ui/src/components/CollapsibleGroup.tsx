/**
 * CollapsibleGroup — a front-page device group with a toggle in its
 * heading. Starts collapsed; the choice is remembered per group in this
 * browser.
 */
import { useState, type ReactNode } from "react";
import "./CollapsibleGroup.css";

function storageKey(id: string): string {
  return `robot-console.group.${id}.open`;
}

function readOpen(id: string): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    return raw === null ? undefined : raw === "1";
  } catch {
    return undefined;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(storageKey(id), open ? "1" : "0");
  } catch {
    // A browser that refuses storage just forgets the choice.
  }
}

export interface CollapsibleGroupProps {
  id: string;
  title: string;
  /** Shown next to the title while collapsed, e.g. how many items are hidden. */
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  ariaLabel?: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function CollapsibleGroup({ id, title, count, defaultOpen = false, className, ariaLabel, hint, children }: CollapsibleGroupProps) {
  const [open, setOpen] = useState<boolean>(() => readOpen(id) ?? defaultOpen);
  const contentId = `devices-group-${id}-content`;
  function toggle(): void {
    const next = !open;
    setOpen(next);
    writeOpen(id, next);
  }
  return (
    <section className={`devices-group${className ? ` ${className}` : ""}`} aria-label={ariaLabel ?? title} data-testid={`devices-group-${id}`}>
      <h2 className="devices-group-heading">
        <button
          type="button"
          className="devices-group-toggle"
          data-testid={`devices-group-toggle-${id}`}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
        >
          <span className="devices-group-arrow" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {title}
          {!open && count !== undefined && <span className="devices-group-count"> ({count})</span>}
        </button>
      </h2>
      <div id={contentId} className="devices-group-content" data-testid={`devices-group-${id}-content`} hidden={!open}>
        {hint}
        {children}
      </div>
    </section>
  );
}
