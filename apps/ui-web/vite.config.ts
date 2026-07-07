import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Remote dev/tailnet hosts allowed to reach the vite dev/preview server.
const allowedHosts =
  process.env["LUNA_VITE_ALLOWED_HOSTS"]
    ?.split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0) ?? []

// Luna Studio web UI — React 18 + Vite + ESM. Port 5174.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: "0.0.0.0",
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  // Pin the browser entry so vite's dep crawler never pulls in scripts/*.ts
  // (server-only deps: effect / @luna/ui-ws / node builtins that explode a
  // browser prebundle). Browser code must import only @luna/ui-shared/core
  // and @luna/ui-transport/browser, never the bare barrels.
  optimizeDeps: {
    entries: ["src/main.tsx", "index.html"],
  },
  preview: {
    port: 5174,
    host: "0.0.0.0",
  },
})
