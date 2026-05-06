/**
 * memory-tools vitest config.
 *
 * Zod v4 ships a double-exports block: the first entry resolves to
 * `./src/index.ts` (source) which vitest/vite can't handle without a
 * TypeScript transform pass. server.deps.inline forces vite to
 * transform zod through its own pipeline so the `.ts` source resolves
 * correctly. This matches the approach used by other Effect+Zod test
 * suites in the monorepo.
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
