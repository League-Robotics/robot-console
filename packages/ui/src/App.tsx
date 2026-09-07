/**
 * @robot-console/ui — root component.
 *
 * Ticket 010 adds the Devices tab and the shared `WsProvider` socket
 * connection, plus a minimal tab-bar shell. Later tickets add the
 * Console tab (this sprint) and Telemetry/Trace/Calibrate (later
 * sprints) as additional entries alongside "Devices" -- no placeholder
 * entries for those are added ahead of their own tickets.
 */
import { WsProvider } from "./ws/WsProvider";
import { DevicesTab } from "./components/DevicesTab";
import "./App.css";

export function App() {
  return (
    <WsProvider>
      <div className="app">
        <header className="app-header">
          <h1>robot-console</h1>
          <nav className="tab-bar" aria-label="Sections">
            <button type="button" className="tab-bar-button tab-bar-button-active" aria-current="page">
              Devices
            </button>
          </nav>
        </header>
        <main className="app-main">
          <DevicesTab />
        </main>
      </div>
    </WsProvider>
  );
}
