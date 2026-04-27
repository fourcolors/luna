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
import { type Component, createMemo } from "solid-js"
import { UI_WS_PROTOCOL_VERSION } from "@luna/ui-shared/core"
import {
  CodeBlock,
  MarkdownView,
  createUiStore,
  createTransport,
} from "@luna/ui-shared-solid"

const SAMPLE_MD = `# Hello from Solid

Some prose with \`inline code\`, then a fenced block:

\`\`\`ts
const x: number = 42
console.log("solid markdown works")
\`\`\`
`

export const App: Component = () => {
  // Smoke-test the new store + transport composable. Real wiring (URL,
  // token, list-threads on open, etc.) lands with chunk 10. For now we
  // just verify the primitives mount and react to status changes.
  const store = createUiStore()
  const transport = createTransport({
    onFrame: (frame) => store.dispatch(frame),
  })
  const statusLabel = createMemo(() => transport.status().kind)
  const eventCount = createMemo(() => store.state.events.length)

  return (
    <main style={{ padding: "2rem", "font-family": "system-ui, sans-serif" }}>
      <h1>Luna · Solid scaffold</h1>
      <p>Migration in progress. The React UI at port 5173 is still the source of truth.</p>
      <p>Wire protocol version: <code>{UI_WS_PROTOCOL_VERSION}</code></p>
      <p>Transport status: <code>{statusLabel()}</code></p>
      <p>Live events count: <code>{eventCount()}</code></p>
      <hr />
      <h2>CodeBlock smoke test</h2>
      <CodeBlock lang="ts" source={`const sum = (a: number, b: number) => a + b`} />
      <h2>MarkdownView smoke test</h2>
      <MarkdownView text={SAMPLE_MD} />
    </main>
  )
}
