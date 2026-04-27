import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Mirrors apps/ui-web/vite.config.ts (host + tailscale allowed hosts) so
// `bun run --filter @luna/ui-web-solid dev` is a drop-in replacement
// during the React → Solid migration. Different default port (5174) so
// both apps can run side-by-side for parity testing.
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5174,
    host: "0.0.0.0",
    allowedHosts: ["mr.tail0d96d3.ts.net", ".tail0d96d3.ts.net"],
  },
  // The dev-server scripts in apps/ui-web/scripts/ pull in heavy server-side
  // deps (effect, @luna/ui-ws, debug, etc.) that aren't browser-safe. Tell
  // vite's dep crawler to ignore them — they're invoked separately via
  // `bun run dev:server`, never bundled.
  optimizeDeps: {
    // Pin browser entry points so vite's dep crawler doesn't pull in
    // scripts/dev-server.ts and its server-side deps (effect, @luna/ui-ws).
    entries: ["src/main.tsx", "index.html"],
  },
  preview: {
    port: 5174,
    host: "0.0.0.0",
  },
})
