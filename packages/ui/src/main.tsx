import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("robot-console: #root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
