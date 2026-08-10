/**
 * Conversation forking (#221) — staged proposals the operator can accept.
 *
 * propose-mode: agent calls fork_thread → a marker is staged (no thread yet).
 * accept: operator clicks → chat-server creates the sibling (resume-fork),
 * seeds the opening message, and opens a chat panel pinned to it.
 */

export type ForkProposalStatus = "pending" | "accepting" | "accepted" | "dismissed"

/** Wire-safe proposal (no seed body — that stays server-side until accept). */
export interface ForkProposalWire {
  readonly id: string
  readonly parentThreadId: string
  readonly title: string
  readonly summary: string
  readonly status: ForkProposalStatus
  readonly createdAt: number
  /** Set when status === "accepted". */
  readonly childThreadId?: string
}

/** Full server-side proposal including the seed text for the new thread. */
export interface ForkProposal extends ForkProposalWire {
  readonly seed: string
}

export interface ProposeForkInput {
  readonly parentThreadId: string
  readonly title: string
  readonly summary: string
  readonly seed: string
  readonly nowMs: number
}

export interface AcceptForkResult {
  readonly proposal: ForkProposal
  /** True only when this call transitioned pending → accepted. */
  readonly newlyAccepted: boolean
}

/** Tag applied to threads created by an accepted fork (fork-loop guard). */
export const FORK_CHILD_TAG = "forked-from-parent"

/** Tag applied briefly / for filtering; parent thread id stored as parentId. */
