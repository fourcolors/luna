import { defineWorkspace } from "vitest/config"
import solid from "vite-plugin-solid"

/**
 * Two isolated projects (M2.6 review — the web ConnectorsPanel needed real
 * render coverage):
 *
 *  1. The existing root config, UNCHANGED — every .test.ts suite keeps its
 *     node environment + SSR transform pipeline (bun:sqlite dynamic imports
 *     stay externalized; `ws` resolves its node build).
 *
 *  2. A Solid component project: vite-plugin-solid + jsdom, scoped to
 *     packages/ui-shared-solid/test/**\/*.test.tsx ONLY. The plugin's
 *     test-mode side effects (global jsdom default + the `browser` resolve
 *     condition, which would stub out `ws`) are confined here — adding it to
 *     the root config broke 86 suites.
 */
export default defineWorkspace([
  "./vitest.config.ts",
  {
    plugins: [solid()],
    // ONE solid-js instance end-to-end: the test (render/createSignal) and the
    // component must share a reactive runtime, or signals silently stop
    // propagating (the package and the root both carry a solid-js copy).
    resolve: {
      dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
    },
    test: {
      name: "solid-components",
      environment: "jsdom",
      globals: false,
      include: ["packages/ui-shared-solid/test/**/*.test.tsx"],
      testTimeout: 10_000,
      server: {
        deps: {
          inline: [/solid-js/],
        },
      },
    },
  },
])
