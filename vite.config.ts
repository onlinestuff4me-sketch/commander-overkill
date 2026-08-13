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
    // 5173 is swarm-game's; keeping off it means both projects can run at once
    // and neither silently serves the other.
    port: 5174,
    strictPort: true,
  },

  build: {
    target: "es2022",
    sourcemap: true,
    // three.js is most of the bundle; a 600kB warning on every build is noise.
    chunkSizeWarningLimit: 900,
  },
}));
