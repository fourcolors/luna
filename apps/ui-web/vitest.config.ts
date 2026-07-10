import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "scripts/__tests__/**/*.test.ts",
      "src/data/**/*.test.ts",
      "src/studio/**/*.test.jsx",
    ],
    reporters: ["default"],
    testTimeout: 10_000,
  },
})
