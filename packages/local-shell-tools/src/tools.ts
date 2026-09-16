import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 120_000
const LOCAL_SHELL_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Local shell command tool for running commands on an attached machine when machine access is enabled.",
} as const

/** What the tools need to know about the thread they are bound to. */
export interface LocalShellSessionRef {
  readonly threadId: string
  readonly threadTags: ReadonlyArray<string>
}

const runShape = {
  command: z
    .string()
    .min(1)
    .describe("Shell command to run on the target machine."),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which attached machine to run on, by its label (see local_shell_list_roots). " +
        "Optional ONLY when exactly one machine is attached. When more than one is " +
        "attached this is REQUIRED — there is deliberately no default, because " +
        "guessing the machine is how a destructive command lands on the wrong one.",
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional working directory for the command. Defaults to the target's own cwd. " +
        "Pass one explicitly when the command is destructive.",
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
  currentSession: () => LocalShellSessionRef | null,
) => {
  const run = defineTool({
    name: "local_shell_run",
    description:
      "Run a shell command on one of the machines attached to this thread. " +
      "Several machines can be attached at once (for example a desktop client and " +
      "the server's own container), so pass `target` with the machine's label " +
      "whenever more than one is attached. " +
      "The result carries `ranOn`, identifying the machine that actually served the " +
      "command (label, clientId, platform, effective cwd, roots, fullAccess). Read it " +
      "before concluding that a missing file or repo is absent: an unexpected " +
      "`ranOn.label` means you asked the wrong machine, not that the path is gone.",
    inputSchema: runShape,
    ...LOCAL_SHELL_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const session = currentSession()
        if (!session) {
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

        const outcome = yield* Effect.tryPromise({
          try: () =>
            bridge.request({
              threadId: session.threadId,
              threadTags: session.threadTags,
              command: args.command,
              ...(args.target !== undefined ? { target: args.target } : {}),
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

        const result = outcome.result
        return {
          approved: result.approved,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          // Which machine actually ran this. Without it, a command that ran on
          // the wrong host is indistinguishable from a missing file.
          ranOn: outcome.dispatchedTo,
        } as const
      }),
  })

  const listRoots = defineTool({
    name: "local_shell_list_roots",
    description:
      "List every machine currently attached to this thread, with the label you pass " +
      "as `target` to local_shell_run, its platform, and the working-directory roots it " +
      "exposes. Call this before running commands, especially before anything " +
      "destructive. `fullAccess: true` means that machine allows any working directory. " +
      "When two or more machines are listed, `target` is required on every run.",
    inputSchema: {},
    ...LOCAL_SHELL_TOOL_DISCOVERY,
    handler: () =>
      Effect.gen(function* () {
        const session = currentSession()
        if (!session) {
          return yield* Effect.fail(
            new ToolError({
              tool: "local_shell_list_roots",
              op: "local_shell.list_roots",
              cause: "no local shell session is bound",
            }),
          )
        }
        const targets = bridge.listTargets(session.threadTags)
        return {
          attached: targets.length > 0,
          targets,
          /** True when `target` must be supplied on every local_shell_run call. */
          targetRequired: targets.length > 1,
          /**
           * Unattended threads (forked children, channel-originated) can only
           * ever reach the server's own sandbox, never a personal machine.
           */
          unattendedThread: session.threadTags.some(
            (t) => t === "forked-from-parent" || t === "channel",
          ),
        } as const
      }),
  })

  return [run, listRoots] as const
}
