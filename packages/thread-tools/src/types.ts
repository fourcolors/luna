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
  /**
   * True for an agent-created thread (`create_thread`): the server accepts it
   * immediately and the client viewing the parent thread switches to the new
   * chat. Absent for an ordinary fork marker the operator must click.
   */
  readonly autoOpen?: boolean
}

/**
 * How a proposal entered the store. "propose" = fork_thread marker, waits for
 * the operator. "create" = create_thread, accepted by the server at once.
 */
export type ForkProposalMode = "propose" | "create"

/** Full server-side proposal including the seed text for the new thread. */
export interface ForkProposal extends ForkProposalWire {
  readonly seed: string
  readonly mode: ForkProposalMode
}

export interface ProposeForkInput {
  readonly parentThreadId: string
  readonly title: string
  readonly summary: string
  readonly seed: string
  readonly nowMs: number
  /** Default "propose". */
  readonly mode?: ForkProposalMode
}

export interface AcceptForkResult {
  readonly proposal: ForkProposal
  /** True only when this call transitioned pending → accepted. */
  readonly newlyAccepted: boolean
}

/** Tag applied to threads created by an accepted fork (fork-loop guard). */
export const FORK_CHILD_TAG = "forked-from-parent"

/** Tag applied to a fresh thread the agent made with `create_thread`. */
export const AGENT_CREATED_TAG = "agent-created"

/** Tag applied briefly / for filtering; parent thread id stored as parentId. */
