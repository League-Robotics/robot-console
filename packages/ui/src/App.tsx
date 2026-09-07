/**
 * @robot-console/ui — root component.
 *
 * Ticket 010 adds the Devices tab and the shared `WsProvider` socket
 * connection, plus a minimal tab-bar shell. Ticket 011 adds the
 * Console tab as the second entry. Later sprints add
 * Telemetry/Trace/Calibrate as additional entries -- no placeholder
 * entries for those are added ahead of their own tickets.
 */
import { useState } from "react";
import { WsProvider } from "./ws/WsProvider";
import { DevicesTab } from "./components/DevicesTab";
import { ConsoleTab } from "./components/ConsoleTab";
import "./App.css";

type TabId = "devices" | "console";

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("devices");

  return (
    <WsProvider>
      <div className="app">
        <header className="app-header">
          <h1>robot-console</h1>
          <nav className="tab-bar" aria-label="Sections">
            <button
              type="button"
              className={
                activeTab === "devices" ? "tab-bar-button tab-bar-button-active" : "tab-bar-button"
              }
              aria-current={activeTab === "devices" ? "page" : undefined}
              onClick={() => setActiveTab("devices")}
            >
              Devices
            </button>
            <button
              type="button"
              className={
                activeTab === "console" ? "tab-bar-button tab-bar-button-active" : "tab-bar-button"
              }
              aria-current={activeTab === "console" ? "page" : undefined}
              onClick={() => setActiveTab("console")}
            >
              Console
            </button>
          </nav>
        </header>
        <main className="app-main">
          {activeTab === "devices" ? <DevicesTab /> : <ConsoleTab />}
        </main>
      </div>
    </WsProvider>
  );
}
