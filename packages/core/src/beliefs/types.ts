import type { MemoryRecord } from "@luna/memory"
import { makeRecord } from "@luna/memory"

/** Beliefs live in the operator namespace as kind:"belief" memory records. */
export const BELIEF_KIND = "belief"
export const BELIEF_NAMESPACE = "operator"
/** Max ACTIVE beliefs injected into the prompt; proposed/retired don't count. */
export const BELIEF_CAP = 20

export type BeliefStatus = "proposed" | "active" | "retired"
export type BeliefVerdict = "confirmed" | "corrected" | "rejected"

export interface BeliefValidation {
  readonly at: number
  readonly verdict: BeliefVerdict
  readonly via: "survey" | "outreach"
}

export interface BeliefOutreachRights {
  readonly enabled: boolean
  readonly minConfidence: number
}

/** Structured `content` of a belief MemoryRecord (spec §5.1). */
export interface BeliefContent {
  readonly statement: string
  readonly confidence: number // 0–1, set by Dream
  readonly status: BeliefStatus
  readonly domain: string
  readonly evidence: ReadonlyArray<string> // provenance: "session:abc#msg12"
  readonly validationHistory: ReadonlyArray<BeliefValidation> // per-belief track record
  readonly outreachRights: BeliefOutreachRights
}

/** FNV-1a 32-bit hash → stable hex id (no external dep). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Deterministic belief id from (domain, normalized statement). Trimmed,
 * whitespace-collapsed + lowercased so case- and whitespace-normalized
 * statements collide (upsert, not duplicate) — the Phase 1 "C1" idempotency
 * lesson applied to beliefs.
 */
export function deriveBeliefId(domain: string, statement: string): string {
  const norm = statement.trim().toLowerCase().replace(/\s+/g, " ")
  return `belief-${domain}-${fnv1a(`${domain} ${norm}`)}`
}

/** Construct a belief MemoryRecord. Defaults: status "proposed", no validation. */
export function makeBeliefRecord(input: {
  statement: string
  confidence: number
  domain: string
  evidence?: ReadonlyArray<string>
  status?: BeliefStatus
  outreachRights?: BeliefOutreachRights
  now?: number
}): MemoryRecord {
  const content: BeliefContent = {
    statement: input.statement,
    confidence: input.confidence,
    status: input.status ?? "proposed",
    domain: input.domain,
    evidence: input.evidence ?? [],
    validationHistory: [],
    outreachRights: input.outreachRights ?? { enabled: false, minConfidence: 0.8 },
  }
  return makeRecord({
    id: deriveBeliefId(input.domain, input.statement),
    namespace: BELIEF_NAMESPACE,
    kind: BELIEF_KIND,
    content,
    tags: [input.domain],
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}

/** Read a record's belief content (callers guarantee kind:"belief"). */
export function readBelief(rec: MemoryRecord): BeliefContent {
  return rec.content as BeliefContent
}

/** Is this record an active belief? */
export function isActiveBelief(rec: MemoryRecord): boolean {
  return rec.kind === BELIEF_KIND && readBelief(rec).status === "active"
}
