/**
 * router.tsx — the two-level navigation's route table (ticket 007,
 * SUC-001).
 *
 * `App.tsx` wraps this in `BrowserRouter`; this module owns only the
 * `Routes`/`Route` registration so a test can drop it inside a
 * `MemoryRouter` instead (see `src/testing/renderWithRouter.tsx`).
 *
 * Two routes today:
 *  - `/` — {@link FrontPage}, the device list.
 *  - `/d/:linkId` — {@link DevicePage}, the per-link shell. Sprint 015
 *    ticket 008 renames the route param itself from `:endpointId` to
 *    `:linkId` (matching `wsMessages.ts`'s `Snapshot`/`SnapshotLink`
 *    vocabulary, `links.id`, opaque, never parsed by the UI) and fills
 *    in the per-type dispatch (`unknown`/`relay`/`robot`) `DevicePage`
 *    renders.
 *
 * No data router (`createBrowserRouter`) -- per `sprint.md`'s Design
 * Rationale, this arc has no loader/action needs, just component
 * routes that grow nested children later (`/d/:linkId/console` etc.,
 * sprint 6/8).
 */
import { Route, Routes } from "react-router";
import { FrontPage } from "./pages/FrontPage";
import { DevicePage } from "./pages/DevicePage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<FrontPage />} />
      <Route path="/d/:linkId" element={<DevicePage />} />
    </Routes>
  );
}
