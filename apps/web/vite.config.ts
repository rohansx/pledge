import { defineConfig } from "vite";

export default defineConfig({
  // In production the same host routes /api to the API service; in dev, proxy it.
  server: { proxy: { "/api": "http://localhost:8080" } },
});
