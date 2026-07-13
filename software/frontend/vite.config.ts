import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dev server proxies /api to the backend so `pnpm local` (backend :5180 +
// this dev server) works with zero CORS fuss. The production build is plain
// static files served by the backend itself.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? 5180}`,
        changeOrigin: false,
      },
    },
  },
});
