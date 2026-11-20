import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { LogWindow } from "./views/LogWindow";

const logMatch = /^\/logs\/([^/]+)\/?$/.exec(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {logMatch ? <LogWindow name={decodeURIComponent(logMatch[1]!)} /> : <App />}
  </StrictMode>,
);
