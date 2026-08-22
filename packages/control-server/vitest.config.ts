import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 10_000,
  },
})
