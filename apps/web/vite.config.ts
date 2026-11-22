import { defineConfig } from "vite";

export default defineConfig({
  // In production the same host routes /api to the API service; in dev, proxy it.
  // PLEDGE_API_URL points the dev server at another API, such as the deployed one.
  server: { proxy: { "/api": { target: process.env.PLEDGE_API_URL ?? "http://localhost:8080", changeOrigin: true } } },
});
