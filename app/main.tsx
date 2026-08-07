import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SubtitleWorkbench } from "./SubtitleWorkbench";
import "./globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root container in index.html.");
}

createRoot(container).render(
  <StrictMode>
    <SubtitleWorkbench />
  </StrictMode>,
);
