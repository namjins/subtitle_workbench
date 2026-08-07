import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Subtitle Workbench ships as a local-first desktop/CLI product, so the UI is a
// plain static single-page app. The local bridge (tools/local_bridge_server.mjs)
// serves the build output from its own origin, which keeps every request
// same-origin and lets a future desktop shell load the same bundle unchanged.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
