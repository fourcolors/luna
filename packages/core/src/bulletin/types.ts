import { Context, Data, Effect } from "effect"

/**
 * The hot-tier bulletin (see packages/memory/bench/BULLETIN.md): a
 * token-budgeted rolling digest of recent thread activity, injected into
 * active sessions alongside beliefs. This module owns the TYPES and the pure
 * composition core; the SDK-backed writer lives in @luna/adapter-sdk
 * (BulletinWriterDefault), mirroring the MemoryReranker/DreamReasoner split.
 */

/** One message of recent activity, already reduced to plain text. */
export interface BulletinMessage {
  readonly ts: string
  readonly role: string
  readonly text: string
}

/** One thread's recent activity, as seen by the bulletin writer. */
export interface BulletinThreadActivity {
  readonly id: string
  readonly title: string
  readonly lastMessageAt: string
  readonly messages: ReadonlyArray<BulletinMessage>
}

/** The full snapshot handed to the writer: eligible threads only (never
 * archived or hidden - eligibility is the CALLER's contract, enforced where
 * threads are listed, and re-checked nowhere else). */
export type BulletinActivitySnapshot = ReadonlyArray<BulletinThreadActivity>

export class BulletinError extends Data.TaggedError("BulletinError")<{
  readonly op: "acquire" | "timeout" | "stream" | "empty" | "too-long"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface BulletinWriterArgs {
  readonly nowIso: string
  readonly previousBulletin: string | null
  readonly activity: BulletinActivitySnapshot
  readonly timeoutMs?: number
}

export interface BulletinWriterApi {
  /** Produce the updated digest text (plain markdown-ish text, no fences).
   * Implementations MUST return text that passes validateBulletinLength. */
  readonly write: (args: BulletinWriterArgs) => Effect.Effect<string, BulletinError>
}

export class BulletinWriter extends Context.Service<BulletinWriter, BulletinWriterApi>()("luna/BulletinWriter") {}
