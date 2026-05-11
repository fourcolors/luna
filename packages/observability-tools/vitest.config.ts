/**
 * observability-tools vitest config.
 *
 * Mirrors scheduler-tools config: zod v4 ships a double-exports block with
 * a `.ts` source entry; server.deps.inline forces vite to transform it
 * through its own pipeline so the source resolves correctly.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
})
