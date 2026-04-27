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
import {
  UI_WS_PROTOCOL_VERSION,
  type Artifact,
  type ChatMessage,
  type ThreadView,
} from "@luna/ui-shared/core"
import {
  ArtifactPanel,
  ChatPanel,
  CodeBlock,
  ConnectionSummary,
  MarkdownView,
  ObsPanel,
  Sidebar,
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
      <h2>ConnectionSummary smoke test</h2>
      <ConnectionSummary
        status={{ kind: "open" }}
        url="ws://127.0.0.1:4753/ui"
        model="claude-sonnet-4"
        chatCap={true}
      />
      <h2>ObsPanel smoke test</h2>
      <ObsPanel
        allKinds={["sdk:start", "sdk:tool"]}
        selectedKinds={new Set()}
        toggleKind={() => {}}
        clearKinds={() => {}}
        filtered={[]}
        totalEvents={0}
        lastDrop={null}
        droppedTotal={0}
        lastPingAt={null}
      />
      <h2>ArtifactPanel smoke test</h2>
      <ArtifactPanel artifacts={SAMPLE_ARTIFACTS} />
      <h2>Sidebar smoke test</h2>
      <div style={{ display: "flex", gap: "1rem", "max-height": "400px" }}>
        <Sidebar
          threads={[SAMPLE_THREAD.summary]}
          threadViews={new Map([[SAMPLE_THREAD.summary.id, SAMPLE_THREAD]])}
          selectedId={SAMPLE_THREAD.summary.id}
          onSelect={(id) => console.log("select", id)}
          onNew={() => console.log("new thread")}
        />
        <ChatPanel
          thread={SAMPLE_THREAD}
          onSend={(id, text) => console.log("send", id, text)}
          onInterrupt={(id) => console.log("interrupt", id)}
          disabled={false}
          enterToSend={false}
        />
      </div>
    </main>
  )
}

// Static fixture for the smoke render — chunk 10 replaces this with
// store.state.threads.get(state.selectedThreadId).
const NOW = Date.now()

const SAMPLE_MESSAGES: ReadonlyArray<ChatMessage> = [
  {
    id: "m_user_1",
    seq: 1,
    ts: NOW,
    role: "user",
    text: "Hi! What's 2+2?",
    toolUses: [],
    attachments: [],
  },
  {
    id: "m_asst_1",
    seq: 2,
    ts: NOW + 1,
    role: "assistant",
    text: "**4** — that's basic arithmetic.\n\n```ts\nconst answer = 2 + 2\n```",
    toolUses: [],
    attachments: [],
  },
]

const SAMPLE_ARTIFACTS: ReadonlyArray<Artifact> = [
  {
    id: "art_1",
    source: "code-fence",
    path: null,
    lang: "ts",
    title: "answer.ts",
    content: "const answer = 2 + 2\nconsole.log(answer)\n",
  },
]

const SAMPLE_THREAD: ThreadView = {
  summary: {
    id: "thread_smoke",
    parentId: null,
    title: "Smoke test",
    tags: [],
    createdAt: NOW,
    endedAt: null,
    model: "claude-sonnet-4",
    status: "active",
    lastMessageAt: NOW + 1,
    lastMessagePreview: "**4** — that's basic arithmetic.",
  },
  messages: SAMPLE_MESSAGES,
  throughSeq: 2,
  inFlight: null,
  lastError: null,
  artifacts: [],
}
