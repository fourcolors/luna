import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Luna Moon's React 19 + Astryx frontend build.
//
// root: frontend-react/ - the four HTML shells (index/chat/panel/widget) plus
//   src/ (boot layer, state store, Astryx re-export kit) live here.
// publicDir: frontend-react/public/ (Vite's default for this root) holds
//   `vendor` and `panels` - both SYMLINKS back to the single source of truth
//   at ../frontend/{vendor,panels}, not copies, so there is nothing here to
//   drift. Vite copies publicDir verbatim (unhashed, exact filenames) to the
//   root of outDir, which is exactly what two runtime contracts require:
//     - panel.html's dynamic panel loader builds `panels/<type>.js` as a
//       plain string at runtime (`s.src = 'panels/' + type + '.js'`); Vite
//       never sees that reference statically, so the file must simply exist,
//       unhashed, at that path in the shipped bundle.
//     - vendor/ui-transport.js attaches `window.LunaTransport` as a classic
//       global script (see scripts/bundle-ui-transport.ts); chat.html's
//       PoolEngine reads that global directly, not via ESM import.
//   Every four HTML shells were mechanically updated (`="vendor/` ->
//   `="/vendor/`) so their <link>/<script> tags reference these public
//   assets via Vite's required root-absolute convention for publicDir
//   content; the dynamic `panels/` string references were left relative
//   (Vite never processes them, and relative-from-root === root-absolute
//   once the page itself is served from the dist root, which Tauri's
//   frontendDist always is).
// build.outDir: dist (resolved relative to root -> frontend-react/dist),
//   matching what src-tauri/tauri.conf.json's build.frontendDist now points
//   at.
export default defineConfig({
  root: resolve(__dirname, "frontend-react"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "frontend-react/index.html"),
        chat: resolve(__dirname, "frontend-react/chat.html"),
        panel: resolve(__dirname, "frontend-react/panel.html"),
        widget: resolve(__dirname, "frontend-react/widget.html"),
      },
    },
  },
  server: {
    port: 5175,
    host: "0.0.0.0",
  },
  // Pin the browser entries so Vite's dep crawler never pulls in anything
  // outside the four page bundles (mirrors ui-web/vite.config.ts's same
  // guard, adapted to Moon's multi-page entries).
  optimizeDeps: {
    entries: [
      "frontend-react/index.html",
      "frontend-react/chat.html",
      "frontend-react/panel.html",
      "frontend-react/widget.html",
    ],
  },
})
