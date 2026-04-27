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
})
