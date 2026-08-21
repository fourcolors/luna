/**
 * The JobRunToolsProvider implementation — the glue between the job workers'
 * per-run tool seam (@luna/adapter-sdk `JobRunToolsProviderTag`) and the
 * request_input tool. `forRun` builds a FRESH in-process MCP server per
 * dispatch so the tool closure carries that run's identity; the worker
 * splices the returned binding into its SDK query options.
 *
 * Wiring (chat-server):
 *
 *   Layer.effect(JobRunToolsProviderTag, Effect.gen(function* () {
 *     const store = yield* JobsStoreService
 *     ...
 *     return createJobInputToolsProvider({ bridge, setRunStatus })
 *   })).pipe(Layer.provide(jobsStoreL))
 *
 * merged into the same composition that feeds PromptWorkerLayer /
 * WorkflowWorkerLayer (they read the Tag via Effect.serviceOption).
 */
import type {
  AnyZodRawShape,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { defineToolPackage } from "@luna/tools"
import type { JobRunToolsProvider } from "@luna/adapter-sdk"
import { makeJobInputTools, type JobInputToolsDeps } from "./tools.js"

export const JOB_INPUT_SERVER_NAME = "job_input"

export const JOB_INPUT_SYSTEM_PROMPT_ADDENDUM =
  "You are running as a background job with a job-input MCP server " +
  "(`job_input`) exposing the tool `mcp__job_input__request_input(prompt)`. " +
  "Use this fully qualified name exactly; do not call the bare name. When " +
  "the job genuinely cannot proceed without the operator's judgement (an " +
  "ambiguous choice, a missing parameter, a go/no-go), call request_input " +
  "with ONE clear question — it pauses this run as 'waiting', shows the " +
  "prompt in the operator's Luna client, and returns their typed answer to " +
  "you. If it returns {ok:false} (cancelled, timed out after ~5 minutes, or " +
  "no client connected), continue sensibly without the input: pick a safe " +
  "default or finish with what you have. Never use it for secrets — " +
  "credentials have their own secure-entry flow."

export const createJobInputToolsProvider = (
  deps: JobInputToolsDeps,
): JobRunToolsProvider => ({
  forRun: (run) => {
    const tools = makeJobInputTools(deps, run) as unknown as ReadonlyArray<
      SdkMcpToolDefinition<AnyZodRawShape>
    >
    const { serverName, server, systemPromptAddendum } = defineToolPackage({
      name: JOB_INPUT_SERVER_NAME,
      tools,
      addendum: JOB_INPUT_SYSTEM_PROMPT_ADDENDUM,
    })
    return {
      serverName,
      server,
      allowedTools: [`mcp__${JOB_INPUT_SERVER_NAME}__request_input`],
      systemPromptAddendum,
    }
  },
})
