import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { capabilityRoots, type LocalShellBridge } from "@luna/ui-ws"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 120_000
const LOCAL_SHELL_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Local shell command tool for running commands through an attached Luna terminal client when machine access is enabled.",
} as const

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
    .describe("Optional timeout in milliseconds. Default 120000, maximum 120000."),
}

export const makeLocalShellTools = (
  bridge: LocalShellBridge,
  currentThreadId: () => string | null,
) => {
  const run = defineTool({
    name: "local_shell_run",
    description:
      "Request execution of a shell command in the user's attached Luna terminal client. " +
      "The terminal client may ask the user for approval or run the command in an auto-approved attached session. " +
      "Use this only when local machine execution is needed for the current task.",
    inputSchema: runShape,
    ...LOCAL_SHELL_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_run",
              op: "local_shell.run",
              cause: "no local shell session is bound",
            }),
          )
        }
        if (args.timeout_ms !== undefined && args.timeout_ms > MAX_TIMEOUT_MS) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_run",
              op: "local_shell.run",
              cause: `timeout_ms must be less than or equal to ${MAX_TIMEOUT_MS}`,
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

        return {
          approved: result.approved,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        } as const
      }),
  })

  const listRoots = defineTool({
    name: "local_shell_list_roots",
    description:
      "List the working-directory roots the attached Luna terminal client currently exposes. " +
      "Call this before running local commands so you pass a `cwd` inside an attached root: " +
      "commands whose working directory is inside a root are auto-approved by the client, while " +
      "commands outside every root may be denied or require explicit user approval. " +
      "`fullAccess: true` means the client allows any working directory (no scope gate).",
    inputSchema: {},
    ...LOCAL_SHELL_TOOL_DISCOVERY,
    handler: () =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_list_roots",
              op: "local_shell.list_roots",
              cause: "no local shell session is bound",
            }),
          )
        }
        const capability = bridge.getCapability(threadId)
        if (capability === null || !capability.enabled) {
          return { attached: false, roots: [], fullAccess: false } as const
        }
        const scope = capabilityRoots(capability)
        return {
          attached: true,
          roots: scope.roots,
          fullAccess: scope.fullAccess,
          // Default working directory — use this as `cwd` when no root is
          // attached (roots is empty); commands there may still require approval.
          cwd: capability.cwd,
          platform: capability.platform,
        } as const
      }),
  })

  return [run, listRoots] as const
}
