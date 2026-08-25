import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { SecretRequestBridge } from "@luna/ui-ws"
import { describeDestination, type SecretDestination } from "./register-secret.js"

/** How long the operator has to type the secret before the request fails. */
const SECRET_INPUT_TIMEOUT_MS = 300_000

const SECRET_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Securely collect a secret (API key, 1Password service-account token, password) from the operator via a protected input field in the Luna client, without the value passing through the chat transcript or this model's context.",
} as const

const requestSecretShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Short instruction shown above the secure input field, e.g. " +
        "'Paste your 1Password service-account token (starts with ops_)'. " +
        "Do NOT ask for the secret in your chat message — this field collects it.",
    ),
  destination_kind: z
    .enum(["op-token", "env-secret"])
    .describe(
      "Where the secret is stored. 'op-token': a 1Password service-account " +
        "token for a registered account label (provide `label`). 'env-secret': " +
        "a value stored under the environment-variable NAME `var_name`, which " +
        "an account's secret_ref `env:<var_name>` then resolves. The BACKING " +
        "STORE is chosen by the server's storage tier, NOT always .env: an OS " +
        "keychain (macOS) or Luna's encrypted vault at ~/.luna/vault/secrets.enc " +
        "(typical on Linux) takes precedence over plaintext ~/.luna/.env. Do not " +
        "assume the value is greppable in .env — external scripts that read .env " +
        "directly will NOT see it.",
    ),
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Required for 'op-token': the account label the token is for (must " +
        "already be in the server's LUNA_OP_ACCOUNTS), e.g. 'primary'.",
    ),
  var_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Required for 'env-secret': the environment-variable name to store under, " +
        "e.g. 'OPENAI_API_KEY'. The account ref becomes 'env:<var_name>'.",
    ),
}

export const makeSecretTools = (
  bridge: SecretRequestBridge,
  currentThreadId: () => string | null,
) => {
  const requestSecret = defineTool({
    name: "request_secret",
    description:
      "Securely collect a secret from the operator. This opens a protected " +
      "input field in the operator's Luna client; the operator types the " +
      "secret there and it is stored server-side at the destination you name. " +
      "The secret value NEVER enters the chat transcript, the tool result, or " +
      "your context — you only learn whether it was stored. The stored secret " +
      "activates after a brief server restart at the end of this turn, so do " +
      "NOT rely on it being usable within the same turn. Use this whenever you " +
      "need the operator to provide a credential (never ask them to paste a " +
      "secret into the chat).",
    inputSchema: requestSecretShape,
    ...SECRET_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "request_secret",
              op: "secret.request",
              cause: "no chat session is bound",
            }),
          )
        }

        let destination: SecretDestination
        if (args.destination_kind === "op-token") {
          if (args.label === undefined || args.label.trim() === "") {
            return yield* Effect.fail(
              new ToolError({
                tool: "request_secret",
                op: "secret.request",
                cause: "destination_kind 'op-token' requires a `label`",
              }),
            )
          }
          destination = { kind: "op-token", label: args.label }
        } else if (args.destination_kind === "env-secret") {
          if (args.var_name === undefined || args.var_name.trim() === "") {
            return yield* Effect.fail(
              new ToolError({
                tool: "request_secret",
                op: "secret.request",
                cause: "destination_kind 'env-secret' requires a `var_name`",
              }),
            )
          }
          destination = { kind: "env-secret", varName: args.var_name }
        } else {
          // Exhaustiveness: reject an unknown kind rather than silently
          // misclassifying it (the enum may grow before this branch does).
          return yield* Effect.fail(
            new ToolError({
              tool: "request_secret",
              op: "secret.request",
              cause: `unsupported destination_kind "${String(args.destination_kind)}"`,
            }),
          )
        }

        // The bridge sends the secure-input request, awaits the operator's
        // value, stores it via the injected persist, and resolves with ONLY
        // {ok,message}. The secret value never returns to this handler.
        const result = yield* Effect.tryPromise({
          try: () =>
            bridge.request({
              threadId,
              destination,
              prompt: args.prompt,
              destinationLabel: describeDestination(destination),
              timeoutMs: SECRET_INPUT_TIMEOUT_MS,
            }),
          catch: (cause) =>
            new ToolError({
              tool: "request_secret",
              op: "secret.request",
              cause,
            }),
        })

        return { ok: result.ok, message: result.message } as const
      }),
  })

  return [requestSecret] as const
}
