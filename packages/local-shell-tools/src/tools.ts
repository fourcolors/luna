import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000

const runShape = {
  command: z
    .string()
    .min(1)
    .describe("Shell command to request from the attached Luna terminal client."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional working directory for the command. Defaults to the terminal client's current directory.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Optional timeout in milliseconds. Default 30000, maximum 300000."),
  thread_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Luna thread id. Defaults to the session bound by LocalShellToolsService.",
    ),
}

export const makeLocalShellTools = (
  bridge: LocalShellBridge,
  currentThreadId: () => string | null,
) => {
  const run = defineTool({
    name: "local_shell_run",
    description:
      "Request execution of a shell command in the user's attached Luna terminal client. " +
      "The terminal client asks the user for approval before running the command. " +
      "Use this only when local machine execution is needed for the current task.",
    inputSchema: runShape,
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = args.thread_id ?? currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_run",
              op: "local_shell.run",
              cause: "no local shell session is bound and no thread_id was provided",
            }),
          )
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            bridge.request({
              threadId,
              command: args.command,
              ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
              timeoutMs: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
            }),
          catch: (cause) =>
            new ToolError({
              tool: "local_shell_run",
              op: "local_shell.run",
              cause,
            }),
        })

        if (!result.approved) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_run",
              op: "local_shell.run",
              cause: result.stderr || "local shell request denied by user",
            }),
          )
        }

        return {
          thread_id: result.threadId,
          approved: result.approved,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: result.timedOut,
        } as const
      }),
  })

  return [run] as const
}
