/**
 * mergeCapabilities — combine capabilities from multiple sources (UI-owned + each
 * bound backend) into the single list a panel's menu shows. Pure and total: it never
 * throws and never mutates its inputs. Kind-agnostic — the slash menu / skills panel
 * filter the result by kind afterward.
 *
 * Collision policy: key on (kind, id); the highest-precedence source wins (UI-owned is
 * given the top precedence, so it wins over any backend); equal precedence breaks by
 * source ascending; an exact duplicate keeps the first-seen. Every loser is surfaced in
 * `dropped` (no silent gaps), never discarded silently.
 */

import type { CapabilityDescriptor } from "./descriptor.js"

export interface CapabilitySource {
  /** Stable source identifier, also the chip the UI badges with: "ui", "luna", "hermes", … */
  readonly source: string
  /** Higher wins a collision. UI-owned is given the top value so it beats every backend. */
  readonly precedence: number
  readonly capabilities: readonly CapabilityDescriptor[]
}

/** A descriptor tagged with the source it survived from — what the UI renders + badges. */
export interface MergedCapability {
  readonly source: string
  readonly capability: CapabilityDescriptor
}

/** A capability that lost a collision — surfaced, never silently dropped. */
export interface DroppedCapability {
  readonly source: string
  readonly capability: CapabilityDescriptor
  /** The (kind, id) key it collided on. */
  readonly key: string
  /** The source that beat it, so the UI/log can explain the shadowing. */
  readonly winningSource: string
}

export interface MergedCapabilities {
  readonly merged: readonly MergedCapability[]
  readonly dropped: readonly DroppedCapability[]
}

// NUL separator: cannot occur in a kind/id, so (kind,id) keys never falsely collide.
// String.fromCharCode(0) keeps the source pure ASCII (no raw NUL byte embedded in the file).
const NUL = String.fromCharCode(0)
const keyOf = (c: CapabilityDescriptor): string => `${c.kind}${NUL}${c.id}`
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

interface Candidate {
  readonly source: string
  readonly precedence: number
  readonly capability: CapabilityDescriptor
}

// Non-finite precedence (NaN/±Infinity from a malformed source) ranks lowest, so the
// tie-break stays deterministic and total regardless of input order.
const rank = (p: number): number => (Number.isFinite(p) ? p : -Infinity)

/** Does the challenger beat the incumbent? Higher precedence, else source ascending; exact tie keeps incumbent. */
const challengerWins = (incumbent: Candidate, challenger: Candidate): boolean => {
  const ci = rank(incumbent.precedence)
  const cc = rank(challenger.precedence)
  if (cc !== ci) return cc > ci
  return challenger.source < incumbent.source
}

export function mergeCapabilities(sources: readonly CapabilitySource[]): MergedCapabilities {
  const winners = new Map<string, Candidate>()
  const dropped: DroppedCapability[] = []

  for (const src of sources) {
    for (const capability of src.capabilities) {
      const key = keyOf(capability)
      const challenger: Candidate = { source: src.source, precedence: src.precedence, capability }
      const incumbent = winners.get(key)
      if (incumbent === undefined) {
        winners.set(key, challenger)
        continue
      }
      if (challengerWins(incumbent, challenger)) {
        dropped.push({ source: incumbent.source, capability: incumbent.capability, key, winningSource: challenger.source })
        winners.set(key, challenger)
      } else {
        dropped.push({ source: challenger.source, capability: challenger.capability, key, winningSource: incumbent.source })
      }
    }
  }

  const merged: MergedCapability[] = [...winners.values()]
    .map((c) => ({ source: c.source, capability: c.capability }))
    .sort((a, b) => cmp(a.capability.kind, b.capability.kind) || cmp(a.capability.id, b.capability.id))

  dropped.sort(
    (a, b) =>
      cmp(a.capability.kind, b.capability.kind) ||
      cmp(a.capability.id, b.capability.id) ||
      cmp(a.source, b.source),
  )

  return { merged: Object.freeze(merged), dropped: Object.freeze(dropped) }
}
