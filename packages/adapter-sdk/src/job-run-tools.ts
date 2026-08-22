/**
 * JobRunToolsProvider — optional injection point for per-RUN tool wiring on
 * the Phase-12b job workers (widget-system.md Phase 5).
 *
 * Mirrors chat-service's `ThreadToolsProviderTag`: the app (chat-server)
 * provides a factory that, given a claimed run's identity, returns an SDK
 * MCP server + the allow-list + a system-prompt addendum to splice into the
 * worker's `query()` options. Both job workers (prompt + workflow's prompt
 * steps) resolve it via `Effect.serviceOption`, so omitting it leaves the
 * workers' prior tool-free behavior intact — tests, boot smokes, and older
 * compositions need no change, and the workers' Layer requirements do not
 * grow.
 *
 * The first (and so far only) provider is @luna/job-input-tools'
 * `request_input`: the binding's tool flips the run running→waiting, asks
 * the connected operator a question through the ui-ws JobInputBridge, and
 * flips back — which is why the factory is PER-RUN (the tool closure must
 * carry the claimed run's `runId`).
 *
 * Why the Tag lives HERE and not in the tools package: adapter-sdk must not
 * depend on @luna/ui-ws (ui-ws → chat-service → adapter-sdk would cycle).
 * The structural binding keeps this package's surface SDK-only; the tools
 * package depends on adapter-sdk for the Tag, never the reverse.
 */
import { Context } from "effect"
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk"

/** The run identity handed to the factory — matches `WorkerContext` plus
 *  the human label the client shows ("Daily brief", not "job_abc123"). */
export interface JobRunIdentity {
  readonly jobId: string
  readonly runId: number
  readonly jobName: string
}

/** One run's tool wiring, ready to splice into the SDK `Options`. */
export interface JobRunToolsBinding {
  /** MCP server name (key under `Options.mcpServers`). */
  readonly serverName: string
  /** The in-process SDK MCP server instance for THIS run. */
  readonly server: McpServerConfig
  /** Fully-qualified tool names to append to `Options.allowedTools`. */
  readonly allowedTools: ReadonlyArray<string>
  /** Prose telling the model the tool exists — prepended to the system text. */
  readonly systemPromptAddendum: string
}

export interface JobRunToolsProvider {
  /** Build the tool wiring for one claimed run. Called once per dispatch. */
  readonly forRun: (run: JobRunIdentity) => JobRunToolsBinding
}

export const JobRunToolsProviderTag = Context.Service<JobRunToolsProvider>(
  "luna/JobRunToolsProvider",
)
