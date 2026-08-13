import { defineConfig } from "vite";

/**
 * GitHub Pages serves a project site from /<repo>/, so the bundle needs that
 * prefix baked in. Local dev serves from / — hence the mode switch rather than
 * a hardcoded base that would break `npm run dev`.
 */
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/commander-overkill/" : "/",

  server: {
    // Bind to the LAN so a phone on the same Wi-Fi can open the printed URL.
    host: true,
    port: 5173,
  },

  build: {
    target: "es2022",
    sourcemap: true,
    // three.js is most of the bundle; a 600kB warning on every build is noise.
    chunkSizeWarningLimit: 900,
  },
}));
