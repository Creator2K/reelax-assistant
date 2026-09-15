import React from "react";
import { createRoot } from "react-dom/client";
import App, { initTheme } from "./App.jsx";
import "./styles.css";

initTheme();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
