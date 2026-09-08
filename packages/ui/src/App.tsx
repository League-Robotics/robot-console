/**
 * @robot-console/ui — root component.
 *
 * Ticket 007 replaces the flat Devices/Console tab-bar shell (tickets
 * 010/011, sprint 1) with the two-level navigation `sprint.md` calls
 * for: a `BrowserRouter` mounted here, and the actual route table in
 * `router.tsx` (`/` the front page, `/d/:endpointId` the per-device
 * page). See `sprint.md`'s Architecture section for the full
 * navigation design and Step 6's router decision. `server.ts` already
 * serves `index.html` for any unmatched GET, so no host change is
 * needed for client-side routes to be bookmarkable/refreshable.
 *
 * Ticket 012-004 replaces the static `<h1>`-only header with the
 * route-aware `AppHeader` (back-to-devices link + Flash menu, see its
 * own doc comment), mounted here as a sibling of `<AppRoutes />` so it
 * renders above every route, including states `<AppRoutes />` itself
 * never reaches (e.g. an unmatched path).
 */
import { BrowserRouter } from "react-router";
import { WsProvider } from "./ws/WsProvider";
import { AppHeader } from "./components/AppHeader";
import { AppRoutes } from "./router";
import "./App.css";

export function App() {
  return (
    <WsProvider>
      <BrowserRouter>
        <div className="app">
          <AppHeader />
          <main className="app-main">
            <AppRoutes />
          </main>
        </div>
      </BrowserRouter>
    </WsProvider>
  );
}
