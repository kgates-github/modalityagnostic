import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev-server port (see devUrl in src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't let Vite watch the Rust build, the Python side, or the venv.
      ignored: ["**/src-tauri/**", "**/sidecar/**", "**/venv/**", "**/process_artifacts/**"],
    },
  },
});
