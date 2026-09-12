// @vitest-environment jsdom
/**
 * SequencingIndicator.test.tsx — component tests (ticket 005 / SUC-003;
 * rewritten sprint 015 ticket 008 against `SnapshotLink.session`).
 *
 * Covers both states this component can render: the populated case (a
 * `session` object present) and the explicit "no session" case
 * (`session` absent) -- per this component's own doc comment, an absent
 * session is an ordinary value here, not an error, and must render as a
 * clear statement rather than blank space. Fixture props only -- no
 * `WsProvider` dependency any more (the retired `useSequencing` hook is
 * gone; the link's own `session` field is passed straight in).
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotLink } from "@robot-console/host/src/wsMessages.js";
import { SequencingIndicator } from "./SequencingIndicator";

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

function session(overrides: Partial<NonNullable<SnapshotLink["session"]>> = {}): NonNullable<SnapshotLink["session"]> {
  return { seq: 0, pending: 0, lastDone: null, lastDoneReason: null, robotStatus: null, functions: null, ...overrides };
}

describe("SequencingIndicator", () => {
  it("shows an explicit 'no session' state when session is undefined", () => {
    const el = mount(<SequencingIndicator session={undefined} />);
    expect(el.textContent).toMatch(/no session/i);
  });

  it("renders seq/pending/lastDone/lastDoneReason from the link's own session", () => {
    const el = mount(<SequencingIndicator session={session({ seq: 3, pending: 1, lastDone: 2, lastDoneReason: "none" })} />);
    expect(el.textContent).not.toMatch(/no session/i);
    expect(el.textContent).toContain("3");
    expect(el.textContent).toContain("1");
    expect(el.textContent).toContain("2");
    expect(el.textContent).toContain("none");
  });

  it("updates when a fresh session prop changes", () => {
    const el = mount(<SequencingIndicator session={session({ seq: 1, pending: 1, lastDone: 0, lastDoneReason: "none" })} />);
    expect(el.textContent).toContain("1");

    act(() => {
      root!.render(<SequencingIndicator session={session({ seq: 2, pending: 0, lastDone: 2, lastDoneReason: "ok" })} />);
    });
    expect(el.textContent).toContain("2");
    expect(el.textContent).toContain("ok");
  });
});
