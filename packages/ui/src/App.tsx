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
 */
import { BrowserRouter } from "react-router";
import { WsProvider } from "./ws/WsProvider";
import { AppRoutes } from "./router";
import "./App.css";

export function App() {
  return (
    <WsProvider>
      <BrowserRouter>
        <div className="app">
          <header className="app-header">
            <h1>robot-console</h1>
          </header>
          <main className="app-main">
            <AppRoutes />
          </main>
        </div>
      </BrowserRouter>
    </WsProvider>
  );
}
