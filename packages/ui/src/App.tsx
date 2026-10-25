import { useState } from "react";
import { BrowserRouter } from "react-router";
import { WsProvider } from "./ws/WsProvider";
import { AppHeader } from "./components/AppHeader";
import { Sidebar } from "./components/Sidebar";
import { AppRoutes } from "./router";
import "./App.css";

/** The navy rail on the left, the workspace (top bar + route) on the right. */
export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="app lg" data-nav-open={navOpen}>
      <Sidebar onNavigate={() => setNavOpen(false)} />
      {navOpen && <div className="app-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />}
      <div className="app-workspace">
        <AppHeader onOpenNav={() => setNavOpen(true)} />
        <main className="app-main">
          <AppRoutes />
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <WsProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </WsProvider>
  );
}
