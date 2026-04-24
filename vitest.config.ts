import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    testTimeout: 10_000,
  },
})
