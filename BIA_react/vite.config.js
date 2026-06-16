import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // data/ holds runtime state the backend rewrites (master.json, config.json).
    // Don't let those writes trigger dev-server reloads.
    watch: {
      ignored: ["**/data/**"],
    },
  },
});
