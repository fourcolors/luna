import { Effect, Layer } from "effect"
import {
  AccountBroker,
  BulletinError,
  BulletinWriter,
  bulletinWithinCap,
  composeBulletinPrompt,
  estimateBulletinTokens,
  BULLETIN_TOKEN_HARD_CAP,
  type BulletinWriterApi,
  type BulletinWriterArgs,
} from "@luna/core"
import { SDKClient } from "./sdk-client.js"
import { runBrokeredReasonerTurn, type BrokeredTurnResult } from "./brokered-turn.js"

/**
 * SDK-backed bulletin writer (BULLETIN.md): one brokered single-turn call
 * that rewrites the rolling digest from the previous digest plus the recent
 * activity snapshot. Mirrors MemoryRerankerDefault's plumbing; the prompt
 * itself lives in @luna/core so the bench generator exercises the identical
 * composition the production holder uses.
 *
 * Env:
 *   LUNA_BULLETIN_MODEL       model alias for the writer (default "haiku")
 *   LUNA_BULLETIN_TIMEOUT_MS  per-call ceiling (default 60000; digest
 *                             writing is a background job, not a request)
 */
export const DEFAULT_BULLETIN_TIMEOUT_MS = 60_000

export function resolveBulletinModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env["LUNA_BULLETIN_MODEL"]?.trim() || "haiku"
}

function resolveBulletinTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["LUNA_BULLETIN_TIMEOUT_MS"]?.trim()
  const n = raw ? Number(raw) : DEFAULT_BULLETIN_TIMEOUT_MS
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BULLETIN_TIMEOUT_MS
}

/** Strip a stray markdown code fence if the model wrapped its output in one
 * despite instructions; anything beyond that is returned verbatim. */
export function unwrapDigestText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(trimmed)
  return (fenced ? fenced[1]! : trimmed).trim()
}

export const BulletinWriterDefault: Layer.Layer<
  BulletinWriter,
  never,
  SDKClient | AccountBroker
> = Layer.effect(
  BulletinWriter,
  Effect.gen(function* () {
    const sdk = yield* SDKClient
    const broker = yield* AccountBroker
    const model = resolveBulletinModel()
    const defaultTimeoutMs = resolveBulletinTimeoutMs()
    const pathToClaudeCodeExecutable =
      process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || undefined

    const callOnce = (
      prompt: string,
      timeoutMs: number,
    ): Effect.Effect<string, BulletinError> =>
      Effect.gen(function* () {
        const turn: BrokeredTurnResult = yield* runBrokeredReasonerTurn({
          sdk,
          broker,
          model,
          prompt,
          baseOptions: {
            maxTurns: 1,
            ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
          },
          timeoutMs,
          errors: {
            acquire: (cause) =>
              new BulletinError({
                op: "acquire",
                message: `failed to acquire account: ${String(cause)}`,
                cause,
              }),
            timeout: (ms) =>
              new BulletinError({
                op: "timeout",
                message: `bulletin write timed out after ${ms}ms`,
              }),
            streamError: (cause) =>
              new BulletinError({
                op: "stream",
                message: `bulletin SDK stream error: ${String(cause)}`,
                cause,
              }),
            empty: () =>
              new BulletinError({
                op: "empty",
                message: "bulletin SDK stream produced no result message",
              }),
          },
        })
        const text = unwrapDigestText(turn.text)
        // Reject empty/whitespace output at the source: an empty digest
        // trivially passes the cap check and would silently ERASE the
        // previous digest from the holder (Codex review of #342).
        if (text.length === 0) {
          return yield* Effect.fail(
            new BulletinError({
              op: "empty",
              message: "bulletin writer returned an empty digest",
            }),
          )
        }
        return text
      })

    const write: BulletinWriterApi["write"] = (args: BulletinWriterArgs) =>
      Effect.gen(function* () {
        const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
        const prompt = composeBulletinPrompt(args.nowIso, args.previousBulletin, args.activity)
        const first = yield* callOnce(prompt, timeoutMs)
        if (bulletinWithinCap(first)) return first
        // One corrective retry with explicit feedback, then fail closed: the
        // holder keeps serving the previous digest rather than injecting an
        // over-budget one into every session.
        const retry = yield* callOnce(
          `${prompt}\n\nYour previous attempt was ~${estimateBulletinTokens(first)} tokens, OVER the ${BULLETIN_TOKEN_HARD_CAP}-token limit. Rewrite the digest far more tersely; keep the same structure and rules.`,
          timeoutMs,
        )
        if (bulletinWithinCap(retry)) return retry
        return yield* Effect.fail(
          new BulletinError({
            op: "too-long",
            message: `digest exceeded the ${BULLETIN_TOKEN_HARD_CAP}-token cap after a corrective retry (~${estimateBulletinTokens(retry)} tokens)`,
          }),
        )
      })

    return { write } satisfies BulletinWriterApi
  }),
)
