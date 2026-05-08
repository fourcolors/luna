import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    testTimeout: 10_000,
    server: {
      deps: {
        // Zod v4 ships a double-exports block with a `.ts` source entry.
        // Without this, vitest's vite pipeline fails to resolve it in
        // packages that use zod (memory-tools, scheduler-tools).
        inline: [/zod/],
      },
    },
  },
})
