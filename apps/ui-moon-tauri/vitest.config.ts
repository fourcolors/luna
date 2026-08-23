import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // `e2e/specs/*.spec.mjs` are WebdriverIO specs, not vitest specs. Their
    // `describe`/`it` and `browser`/`$` globals are injected by the wdio test
    // runner (`bun run e2e`), so vitest collects them, finds no `browser`, and
    // fails with `ReferenceError: browser is not defined`. Vitest's default
    // include glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) matches `.spec.mjs`, so
    // the e2e dir has to be excluded explicitly. Spread `configDefaults.exclude`
    // rather than listing paths by hand: a custom `exclude` REPLACES the
    // built-in array, and dropping it would silently re-admit node_modules/dist.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    // Repair Bun's broken `localStorage`/`sessionStorage` globals before any
    // test code runs. See test/vitest-setup.ts for the why.
    setupFiles: ['./test/vitest-setup.ts'],
  },
})
