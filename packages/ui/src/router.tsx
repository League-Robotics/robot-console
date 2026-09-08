/**
 * router.tsx — the two-level navigation's route table (ticket 007,
 * SUC-001).
 *
 * `App.tsx` wraps this in `BrowserRouter`; this module owns only the
 * `Routes`/`Route` registration so a test can drop it inside a
 * `MemoryRouter` instead (see `src/testing/renderWithRouter.tsx`).
 *
 * Two routes today:
 *  - `/` — {@link FrontPage}, the endpoint list.
 *  - `/d/:endpointId` — {@link DevicePage}, a thin shell this ticket
 *    wires up but does not fill in. Ticket 008 owns the per-type
 *    dispatch (`unknown`/`relay`/`robot`) rendered inside it; this
 *    ticket's job is only to prove the route exists and reads the
 *    right endpoint via `useEndpoint(endpointId)`.
 *
 * No data router (`createBrowserRouter`) -- per `sprint.md`'s Design
 * Rationale, this arc has no loader/action needs, just component
 * routes that grow nested children later (`/d/:endpointId/console`
 * etc., sprint 6/8).
 */
import { Route, Routes } from "react-router";
import { FrontPage } from "./pages/FrontPage";
import { DevicePage } from "./pages/DevicePage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<FrontPage />} />
      <Route path="/d/:endpointId" element={<DevicePage />} />
    </Routes>
  );
}
