/**
 * Solid migration scaffold — chunk 1 of the migration plan.
 *
 * This is the empty App shell that will be filled in chunk-by-chunk:
 *   - 5: transport hook + reducer-backed createStore
 *   - 6: ChatPanel + composer
 *   - 7: Sidebar
 *   - 8: ArtifactPanel
 *   - 9: ObsPanel
 *   - 10: settings panel + connection wiring
 *
 * The React app at apps/ui-web stays the production UI until visual
 * parity is verified (chunk 11), then ui-web-solid is renamed to ui-web.
 */
import type { Component } from "solid-js"
import { UI_WS_PROTOCOL_VERSION, initialState } from "@luna/ui-shared/core"
import { CodeBlock, MarkdownView } from "@luna/ui-shared-solid"

const SAMPLE_MD = `# Hello from Solid

Some prose with \`inline code\`, then a fenced block:

\`\`\`ts
const x: number = 42
console.log("solid markdown works")
\`\`\`
`

export const App: Component = () => {
  return (
    <main style={{ padding: "2rem", "font-family": "system-ui, sans-serif" }}>
      <h1>Luna · Solid scaffold</h1>
      <p>Migration in progress. The React UI at port 5173 is still the source of truth.</p>
      <p>Wire protocol version: <code>{UI_WS_PROTOCOL_VERSION}</code></p>
      <p>Initial events count: <code>{initialState.events.length}</code></p>
      <hr />
      <h2>CodeBlock smoke test</h2>
      <CodeBlock lang="ts" source={`const sum = (a: number, b: number) => a + b`} />
      <h2>MarkdownView smoke test</h2>
      <MarkdownView text={SAMPLE_MD} />
    </main>
  )
}
