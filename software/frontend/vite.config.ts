import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dev server proxies /api to the backend so `pnpm local` (backend :5180 +
// this dev server) works with zero CORS fuss. The production build is plain
// static files served by the backend itself.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  // plotter-utils is a workspace package compiled to CommonJS (dist/). Because
  // it's symlinked into the workspace (not a plain node_modules dep), Vite would
  // otherwise treat it as ESM source and miss its named exports. Pre-bundle it
  // for dev and run the CommonJS→ESM transform on it for the production build.
  optimizeDeps: { include: ["plotter-utils"] },
  build: { commonjsOptions: { include: [/utils[\\/]dist/, /node_modules/] } },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? 5180}`,
        changeOrigin: false,
      },
    },
  },
});
