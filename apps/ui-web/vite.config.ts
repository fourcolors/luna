import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const allowedHosts =
  process.env["LUNA_VITE_ALLOWED_HOSTS"]
    ?.split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0) ?? []

// SolidJS web UI. Port 5174 (5173 reserved for legacy/parity comparisons
// during migration; kept as default to avoid breaking developer muscle
// memory). Additional remote dev hosts can be provided via env.
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5174,
    host: "0.0.0.0",
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  // Bun's hoisted .bun/ workspace layout serves CJS deps as raw CJS to the
  // browser by default — vite's dep crawler doesn't always force them
  // through esbuild prebundle. Two fixes here:
  //   - `entries`: pin browser entry points so the crawler doesn't pull in
  //     scripts/dev-server.ts (which has server-only deps like effect/ui-ws)
  //   - `include`: force CJS deps used transitively by ui-shared-solid
  //     (debug via solid-markdown, extend via the markdown pipeline) into
  //     the prebundle so vite serves them as ESM with proper default exports
  optimizeDeps: {
    entries: ["src/main.tsx", "index.html"],
    include: ["debug", "extend"],
  },
  preview: {
    port: 5174,
    host: "0.0.0.0",
  },
})
