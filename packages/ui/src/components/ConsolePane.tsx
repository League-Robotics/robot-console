/**
 * ConsolePane.tsx — a console that takes the space left on the page and
 * never more (stakeholder, 2026-09-19: "the consoles are always forced
 * to fit on the page, you never expand the console past the page").
 *
 * ## Why this is a component and not more CSS
 *
 * The console was already viewport-bound, but only on the two pages
 * that opted in, and only by arithmetic: `RobotPage.css` pinned a
 * column to `calc(100vh - 12rem - 1rem)` and capped any panel stacked
 * above it at `calc(100vh - 12rem - 1rem - 1rem - 19rem)` -- the header
 * height, the gaps and the console's own floor, written out as
 * constants in two rules that had to be kept in step by hand. Anything
 * that changed what sits above the console (this same day's Calibration
 * tab put two panels there) made those constants wrong, and
 * `RelayPage`/`UnknownDevicePage` never opted in at all, so their
 * consoles grew the page instead.
 *
 * Measuring removes the constants. The pane asks where it actually
 * starts and takes what is left:
 *
 *     maxHeight = window.innerHeight - (this pane's top) - bottom gap
 *
 * That is correct on every page, whatever sits above it, at any window
 * size, with no rule to keep in sync. A page adds a console by mounting
 * this; it does not also have to know the header's height.
 *
 * ## Why measuring here does not loop
 *
 * The measured quantity is this pane's OWN top edge, which depends on
 * its siblings above, never on its own height -- so applying the result
 * cannot change the input. The ResizeObserver deliberately watches the
 * siblings and the document, not this element, and a change smaller
 * than a pixel is ignored, so a sub-pixel layout jitter cannot start a
 * feedback loop either.
 *
 * ## The floor
 *
 * `MIN_PANE_PX` stops a very short window (or an over-full column)
 * collapsing the console to nothing. Below that the page scrolls, which
 * is the honest outcome: the alternative is a console too small to read
 * with a send line you cannot reach.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { DeviceConsole, type DeviceConsoleProps } from "./DeviceConsole";
import "./ConsolePane.css";

/** Breathing room below the console, matching the page gutter. */
const BOTTOM_GAP_PX = 16;

/** Never shrink below this: a log too short to read helps nobody. */
const MIN_PANE_PX = 220;

/** Sub-pixel changes are ignored -- see this module's own doc comment
 * on why the observer cannot feed back into itself. */
const EPSILON_PX = 1;

export type ConsolePaneProps = DeviceConsoleProps;

export function ConsolePane({ link, name }: ConsolePaneProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof window === "undefined") return;

    const measure = (): void => {
      const top = el.getBoundingClientRect().top;
      // A detached or not-yet-laid-out element measures 0/0 (jsdom, and
      // the first frame of a hidden tab). Taking the viewport height in
      // that case is the harmless answer: it caps nothing until a real
      // layout arrives and re-runs this.
      const available = window.innerHeight - top - BOTTOM_GAP_PX;
      const next = Math.max(available, MIN_PANE_PX);
      setMaxHeight((previous) => (previous !== undefined && Math.abs(previous - next) < EPSILON_PX ? previous : next));
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      // The siblings above are what move this pane's top edge; the body
      // catches a page-level reflow. Observing `el` itself is what would
      // make this circular, so it is deliberately not observed.
      const parent = el.parentElement;
      if (parent) {
        for (const child of Array.from(parent.children)) {
          if (child !== el) observer.observe(child);
        }
      }
      if (document.body) observer.observe(document.body);
    }

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      className="console-pane"
      ref={ref}
      data-testid="console-pane"
      style={maxHeight === undefined ? undefined : { maxHeight: `${maxHeight}px` }}
    >
      <DeviceConsole link={link} name={name} />
    </div>
  );
}
