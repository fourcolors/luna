/**
 * ObsEvent runtime schemas (Phase 14 follow-up; advisor pre-flight for UI WS).
 *
 * Why: §16 ObsEvent shapes are TS-only — no runtime validation at emit().
 * Producer drift (e.g. `tool` vs `toolName`, `status: "ok"` vs `"success"`)
 * passes TS at literal sites that bypass exhaustive structural checks
 * (e.g. broad `as ObsEvent` casts) and would leak into any wire protocol
 * built on top of `subscribeEvents`. We validate at the emit boundary so
 * the WS adapter (and JSONL sink) only see well-formed events.
 *
 * Policy on validation failure:
 *   - emit() does NOT fail the caller (observability must never poison the
 *     host — same rule as JSONL write failures).
 *   - The malformed event is DROPPED.
 *   - A synthetic `Error` event tagged `errorTag: "ObsSchemaViolation"` is
 *     published in its place so the violation is visible to subscribers and
 *     persisted to the JSONL sink.
 *
 * The schemas mirror types.ts exactly. Keep in sync — when types change,
 * change schemas in the same commit.
 */
import { Schema } from "effect"

const Level = Schema.Literal("info", "warn", "error")

const Base = {
  ts: Schema.String,
  level: Level,
} as const

export const SessionStartSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("SessionStart"),
  sessionId: Schema.String,
  model: Schema.String,
  optionsDigest: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
})

export const SessionEndSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("SessionEnd"),
  sessionId: Schema.String,
  durationMs: Schema.Number,
})

export const ToolCallSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("ToolCall"),
  sessionId: Schema.optional(Schema.String),
  toolName: Schema.String,
  inputDigest: Schema.optional(Schema.String),
  durationMs: Schema.Number,
  status: Schema.Literal("success", "error", "permission_denied"),
})

export const HookFireSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("HookFire"),
  event: Schema.String,
  matcher: Schema.optional(Schema.String),
  decision: Schema.String,
})

export const PermissionDecisionSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("PermissionDecision"),
  tool: Schema.String,
  decision: Schema.String,
  rulePath: Schema.String,
})

export const TeammateStartSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("TeammateStart"),
  team: Schema.String,
  teammate: Schema.String,
})

export const TeammateIdleSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("TeammateIdle"),
  team: Schema.String,
  teammate: Schema.String,
  idleMs: Schema.Number,
})

export const TeammateStopSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("TeammateStop"),
  team: Schema.String,
  teammate: Schema.String,
  reason: Schema.String,
})

export const WorkflowTransitionSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("WorkflowTransition"),
  workflowId: Schema.String,
  from: Schema.String,
  to: Schema.String,
})

export const AccountSwitchSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("AccountSwitch"),
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
})

export const CostAccruedSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("CostAccrued"),
  sessionId: Schema.optional(Schema.String),
  teamName: Schema.optional(Schema.String),
  workflowId: Schema.optional(Schema.String),
  tokensIn: Schema.Number,
  tokensOut: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  estimatedUsd: Schema.Number,
})

const RetrievalCallBase = {
  ...Base,
  kind: Schema.Literal("RetrievalCall"),
  sessionId: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  mode: Schema.Literal("vec", "hybrid", "bm25", "hybrid-terms"),
  candidateCount: Schema.Number,
  topScore: Schema.optional(Schema.Number),
  durationMs: Schema.Number,
  status: Schema.Literal("success", "error"),
} as const

// Reranker widening (Phase 3 production reranker, PR #332 bench): a rerank
// stage has no embedder of its own to report, so it can't satisfy the
// embedder-field guardrail the plain-retrieval variant enforces below. Rather
// than weaken that guardrail for everyone (a genuine retrieval event missing
// its embedder identity IS a bug), RetrievalCall is a discriminated union of
// two shapes:
//   - the event MemoryRouter.search() itself emits (embedder fields
//     required, byte-identical to before this widening),
//   - the SEPARATE rerank-stage event memory_search / recallForTurn emit
//     after the underlying retrieval already logged its own event above
//     (reranked: true; no embedder fields; rerank stats required instead).
// An object satisfying NEITHER variant (e.g. missing embedderModel and not
// marked reranked: true) is correctly rejected - this preserves the
// pre-existing "rejects RetrievalCall missing embedderModel" guardrail.
const RetrievalCallSchema = Schema.Union(
  Schema.Struct({
    ...RetrievalCallBase,
    queryDigest: Schema.String,
    embedderProvider: Schema.String,
    embedderModel: Schema.String,
    embedderDimension: Schema.Number,
    reranked: Schema.optional(Schema.Literal(false)),
  }),
  Schema.Struct({
    ...RetrievalCallBase,
    queryDigest: Schema.optional(Schema.String),
    reranked: Schema.Literal(true),
    rerankMs: Schema.Number,
    kept: Schema.Number,
    dropped: Schema.Number,
  }),
)

export const ErrorEventSchema = Schema.Struct({
  ...Base,
  kind: Schema.Literal("Error"),
  errorTag: Schema.String,
  message: Schema.String,
  context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})

export const ObsEventSchema = Schema.Union(
  SessionStartSchema,
  SessionEndSchema,
  ToolCallSchema,
  HookFireSchema,
  PermissionDecisionSchema,
  TeammateStartSchema,
  TeammateIdleSchema,
  TeammateStopSchema,
  WorkflowTransitionSchema,
  AccountSwitchSchema,
  CostAccruedSchema,
  RetrievalCallSchema,
  ErrorEventSchema,
)

/**
 * Decode (validate) an unknown payload as an ObsEvent.
 * Returns Either<ObsEvent, ParseError>. We use Either to avoid a hard
 * dependency on Effect at the validation site — the caller (emit) decides
 * what to do with the failure.
 */
export const decodeObsEvent = Schema.decodeUnknownEither(ObsEventSchema)
