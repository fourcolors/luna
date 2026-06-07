import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Repair Bun's broken `localStorage`/`sessionStorage` globals before any
    // test code runs. See test/vitest-setup.ts for the why.
    setupFiles: ['./test/vitest-setup.ts'],
  },
})
