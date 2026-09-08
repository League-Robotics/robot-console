/**
 * renderWithRouter.tsx — shared `MemoryRouter` test wrapper (ticket
 * 007).
 *
 * Route-aware tests (`FrontPage.test.tsx`, `DevicePage.test.tsx`) all
 * need the same two things: a router context to mount `Link`/
 * `useParams`/route-dependent hooks under, and a way to assert "the
 * URL changed" without reaching into `MemoryRouter`'s internal
 * history object. This is the one shared copy every such test imports
 * instead of hand-rolling its own `MemoryRouter` + location-probe
 * boilerplate, mirroring `FakeSocket.ts`'s role for socket-driven
 * tests.
 */
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

export interface WithRouterOptions {
  /** Initial history stack, oldest first -- passed straight through to
   * `MemoryRouter`. Defaults to `["/"]`. */
  initialEntries?: string[];
}

/** Wrap `children` in a `MemoryRouter` seeded with `initialEntries`,
 * alongside a hidden element (`data-testid="location"`) reporting the
 * current pathname, so a test can assert navigation happened by
 * reading that element's text content. */
export function withRouter(children: ReactNode, options: WithRouterOptions = {}): ReactElement {
  return (
    <MemoryRouter initialEntries={options.initialEntries ?? ["/"]}>
      <LocationProbe />
      {children}
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location" hidden>
      {location.pathname}
    </span>
  );
}
