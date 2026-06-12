/**
 * Frame reducer: pure function from (state, frame) → next state.
 *
 * v2 adds chat. Each thread carries its own message list, an optional
 * in-flight assistant turn (turnId + cumulative text from delta frames),
 * and a `throughSeq` watermark so post-snapshot live frames with
 * `seq <= throughSeq` get deduped (covers reconnect-during-turn).
 *
 * Obs frames (event/drop/ping) keep working unchanged — chat is purely
 * additive and lives on a separate slice of state.
 */
import type {
  Artifact,
  ChatErrorKind,
  ChatMessage,
  ConnectorCatalogItem,
  ConnectorInstanceItem,
  ObsEvent,
  ObsEventKind,
  PinnedArtifactItem,
  ServerFrame,
  SessionSummary,
  SkillCatalogItem,
  VaultSyncWire,
  VaultWireItem,
  WorkflowGalleryItem,
  WorkflowRunItem,
} from "./wire.js"

export interface InFlightTurn {
  readonly turnId: string
  readonly text: string
}

export interface ThreadView {
  readonly summary: SessionSummary
  readonly messages: ReadonlyArray<ChatMessage>
  readonly throughSeq: number
  /** Cumulative assistant text for the in-flight turn, if any. */
  readonly inFlight: InFlightTurn | null
  readonly lastError: {
    readonly kind: ChatErrorKind
    readonly message: string
  } | null
  /** Artifacts extracted from finalized assistant turns, oldest-first. */
  readonly artifacts: ReadonlyArray<Artifact>
}

export interface UIState {
  readonly events: ReadonlyArray<ObsEvent>
  readonly seenKinds: ReadonlyArray<string>
  readonly advertisedKinds: ReadonlyArray<string>
  readonly droppedTotal: number
  readonly lastDrop: { readonly n: number; readonly since: string } | null
  readonly lastPingAt: string | null
  readonly closeReason: string | null
  /** Server-advertised capabilities. `skills` is additive/optional —
   *  absent against older servers (the Skills section hides). */
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly setup: boolean
    readonly skills?: boolean
    readonly connectors?: boolean
    readonly artifacts?: boolean
    readonly workflows?: boolean
    /** Luna Vault (V1): vault-list pushed after hello; vault mutations routed. */
    readonly vault?: boolean
    /**
     * Server accepts `set-thread-config` frames and computes the effort-validity
     * matrix per-model (advertised in `availableModels.efforts`). Clients hide
     * effort controls when absent/false. OPTIONAL/additive.
     */
    readonly effortSelection?: boolean
  }
  /**
   * Server-advertised model list (from the `hello` frame's `availableModels`
   * field). When null the server is older and did not send the field; the UI
   * falls back to its own hardcoded MODEL_OPTIONS list. When non-null (even
   * if empty) the server has explicitly taken ownership of the list.
   */
  readonly availableModels: ReadonlyArray<{
    readonly id: string
    readonly label: string
    /** Effort levels valid for this model, server-computed. Absent = no effort param. */
    readonly efforts?: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max">
  }> | null
  /** Sidebar projection — most-recently-active first (server orders). */
  readonly threadList: ReadonlyArray<SessionSummary>
  /** Per-thread state, keyed by threadId. */
  readonly threads: ReadonlyMap<string, ThreadView>
  /** Currently-selected thread (chat panel renders this). */
  readonly selectedThreadId: string | null
  /** Available accounts from the server (public info only — no secrets). */
  readonly accounts: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: string
    readonly health: string
  }>
  /** Currently-selected account id. null = use default broker rotation. */
  readonly selectedAccountId: string | null
  /**
   * Skill catalog from the server (PRD Part B) — metadata only, no bodies
   * by wire construction. Empty until a `skill-catalog` frame arrives;
   * the Skills settings section is additionally gated on
   * `capabilities.skills` so an old server shows nothing.
   */
  readonly skills: ReadonlyArray<SkillCatalogItem>
  /** Last skill-toggle failure (skill-status ok:false). Cleared by the
   *  next successful toggle or catalog refresh. */
  readonly skillError: string | null
  /** PRD Part A connector catalog + current instances (wire-safe — no
   *  tokens, no secret refs). Gated on capabilities.connectors. */
  readonly connectorCatalog: ReadonlyArray<ConnectorCatalogItem>
  readonly connectorInstances: ReadonlyArray<ConnectorInstanceItem>
  /** Last connector-status failure. Cleared on the next ok / list. */
  readonly connectorError: string | null
  /** PRD Part C (W1) — durable pinned artifacts (metadata + content,
   *  wire-safe). Most-recently-updated first. Gated on capabilities.artifacts. */
  readonly pinnedArtifacts: ReadonlyArray<PinnedArtifactItem>
  /** PRD Part C (W3) — the workflow gallery (read-only over the jobs store),
   *  + per-job run history fetched on demand. Gated on capabilities.workflows. */
  readonly workflows: ReadonlyArray<WorkflowGalleryItem>
  readonly workflowRuns: ReadonlyMap<string, ReadonlyArray<WorkflowRunItem>>
  /** Luna Vault (V1) — credential registry (metadata + opaque pointers only;
   *  never credential values). Gated on capabilities.vault. */
  readonly vaultItems: ReadonlyArray<VaultWireItem>
  /** 1Password sync state (slice V3); null when not yet received. */
  readonly vaultSync: VaultSyncWire | null
}

export const initialState: UIState = {
  events: [],
  seenKinds: [],
  advertisedKinds: [],
  droppedTotal: 0,
  lastDrop: null,
  lastPingAt: null,
  closeReason: null,
  capabilities: { chat: false, streamingDeltas: false, setup: false },
  // null = server hasn't sent availableModels yet (old server or not connected);
  // the UI falls back to its hardcoded MODEL_OPTIONS list in that case.
  availableModels: null,
  threadList: [],
  threads: new Map(),
  selectedThreadId: null,
  accounts: [],
  selectedAccountId: null,
  skills: [],
  skillError: null,
  connectorCatalog: [],
  connectorInstances: [],
  connectorError: null,
  pinnedArtifacts: [],
  workflows: [],
  workflowRuns: new Map(),
  vaultItems: [],
  vaultSync: null,
}

const MAX_RETAINED = 500

const addKindIfNew = (
  list: ReadonlyArray<string>,
  kind: string,
): ReadonlyArray<string> => (list.includes(kind) ? list : [...list, kind])

const updateThread = (
  state: UIState,
  threadId: string,
  fn: (t: ThreadView) => ThreadView,
): UIState => {
  const cur = state.threads.get(threadId)
  if (!cur) return state
  const next = new Map(state.threads)
  next.set(threadId, fn(cur))
  return { ...state, threads: next }
}

const ensureSummary = (
  state: UIState,
  threadId: string,
): SessionSummary | null => {
  const t = state.threads.get(threadId)
  if (t) return t.summary
  // The thread might be in the list but not yet expanded.
  return state.threadList.find((s) => s.id === threadId) ?? null
}

/** Reduce a `UserMessage` ClientFrame's local optimistic state — used by
 *  the App when it sends a user-message before the server's user-accepted
 *  echo lands. We just pre-extend the in-flight turn with no text yet. */
export type ChatLocalAction =
  | { readonly tag: "select-thread"; readonly threadId: string | null }
  | { readonly tag: "select-account"; readonly accountId: string | null }
  | { readonly tag: "init-thread"; readonly summary: SessionSummary }
  | {
      readonly tag: "optimistic-user"
      readonly threadId: string
      readonly text: string
    }

export type Action = ServerFrame | ChatLocalAction

const isServerFrame = (a: Action): a is ServerFrame =>
  "type" in (a as Record<string, unknown>) &&
  typeof (a as { type: unknown }).type === "string"

export const reduce = (state: UIState, action: Action): UIState => {
  if (!isServerFrame(action)) {
    switch (action.tag) {
      case "select-thread":
        return { ...state, selectedThreadId: action.threadId }
      case "select-account":
        return { ...state, selectedAccountId: action.accountId }
      case "init-thread": {
        // Insert a placeholder ThreadView for a freshly-created thread
        // so the chat panel can render immediately even before the
        // first thread-snapshot arrives.
        if (state.threads.has(action.summary.id)) return state
        const next = new Map(state.threads)
        next.set(action.summary.id, {
          summary: action.summary,
          messages: [],
          throughSeq: -1,
          inFlight: null,
          lastError: null,
          artifacts: [],
        })
        const list = [
          action.summary,
          ...state.threadList.filter((s) => s.id !== action.summary.id),
        ]
        return { ...state, threads: next, threadList: list }
      }
      case "optimistic-user":
        // No-op visual marker for now — real "user-accepted" frame will
        // append the actual ChatMessage. Future: pending bubble.
        return state
    }
  }

  const frame = action
  switch (frame.type) {
    case "hello":
      return {
        ...state,
        advertisedKinds: frame.kinds,
        capabilities: frame.capabilities,
        // Capture server-advertised models when present. null means the server
        // is older and omitted the field; the UI falls back to its hardcoded
        // list. undefined → null so UIState's type stays non-nullable-optional.
        availableModels: frame.availableModels ?? null,
        closeReason: null,
      }
    case "event": {
      const next = [frame.event, ...state.events].slice(0, MAX_RETAINED)
      return {
        ...state,
        events: next,
        seenKinds: addKindIfNew(state.seenKinds, frame.event.kind),
      }
    }
    case "drop":
      return {
        ...state,
        droppedTotal: state.droppedTotal + frame.n,
        lastDrop: { n: frame.n, since: frame.since },
      }
    case "ping":
      return { ...state, lastPingAt: frame.ts }
    case "bye":
      return { ...state, closeReason: frame.reason }
    case "thread-list":
      return { ...state, threadList: frame.threads }
    case "thread-created": {
      // Server auto-subscribes; we'll get a thread-snapshot next.
      const next = new Map(state.threads)
      next.set(frame.thread.id, {
        summary: frame.thread,
        messages: [],
        throughSeq: -1,
        inFlight: null,
        lastError: null,
        artifacts: [],
      })
      const list = [
        frame.thread,
        ...state.threadList.filter((s) => s.id !== frame.thread.id),
      ]
      return {
        ...state,
        threads: next,
        threadList: list,
        selectedThreadId: frame.thread.id,
      }
    }
    case "thread-snapshot": {
      const summary = ensureSummary(state, frame.threadId)
      const placeholder: SessionSummary = summary ?? {
        id: frame.threadId,
        parentId: null,
        title: null,
        tags: [],
        createdAt: 0,
        endedAt: null,
        model: "",
        status: "active",
        lastMessageAt: null,
        lastMessagePreview: null,
      }
      const next = new Map(state.threads)
      const cur = state.threads.get(frame.threadId)
      next.set(frame.threadId, {
        summary: cur?.summary ?? placeholder,
        messages: frame.messages,
        throughSeq: frame.throughSeq,
        inFlight: cur?.inFlight ?? null,
        lastError: cur?.lastError ?? null,
        artifacts: cur?.artifacts ?? [],
      })
      return { ...state, threads: next }
    }
    case "user-accepted":
      return updateThread(state, frame.threadId, (t) => {
        if (frame.seq <= t.throughSeq) return t // dedupe
        return {
          ...t,
          messages: [...t.messages, frame.message],
          throughSeq: Math.max(t.throughSeq, frame.seq),
          lastError: null,
        }
      })
    case "assistant-delta":
      return updateThread(state, frame.threadId, (t) => ({
        ...t,
        inFlight: { turnId: frame.turnId, text: frame.text },
      }))
    case "assistant-done":
      return updateThread(state, frame.threadId, (t) => {
        if (frame.seq <= t.throughSeq) {
          return { ...t, inFlight: null }
        }
        return {
          ...t,
          messages: [...t.messages, frame.message],
          throughSeq: Math.max(t.throughSeq, frame.seq),
          inFlight: null,
        }
      })
    case "assistant-error":
      return updateThread(state, frame.threadId, (t) => ({
        ...t,
        inFlight: null,
        lastError: frame.error,
      }))
    case "artifacts-extracted":
      return updateThread(state, frame.threadId, (t) => {
        // Replace any prior artifacts for this messageId (idempotent
        // under reconnect-during-extraction) and append new ones.
        const filtered = t.artifacts.filter(
          (a) => !a.id.startsWith(frame.messageId + ":"),
        )
        return { ...t, artifacts: [...filtered, ...frame.artifacts] }
      })
    case "account-list": {
      return {
        ...state,
        accounts: frame.accounts,
        // selectedAccountId intentionally NOT changed here.
        // null = "Auto" (broker picks). User must explicitly select an account.
        // On reconnect, user's prior selection is preserved as-is.
      }
    }
    case "skill-catalog":
      // Server-authored catalog replaces wholesale (sent after hello and
      // re-sent after each successful toggle) — same idiom as account-list.
      return { ...state, skills: frame.skills, skillError: null }
    case "skill-status": {
      // ok:true → reflect the confirmed state on the matching row (the
      // refreshed catalog usually follows, but this keeps the UI correct
      // even if that frame is dropped) and clear any stale error.
      // ok:false → keep rows untouched (no optimistic flip to revert) and
      // surface the short server-provided reason.
      if (!frame.ok) {
        return { ...state, skillError: frame.message ?? "skill toggle failed" }
      }
      return {
        ...state,
        skillError: null,
        skills: state.skills.map((s) =>
          s.id === frame.id ? { ...s, enabled: frame.enabled } : s,
        ),
      }
    }
    case "connector-catalog":
      return { ...state, connectorCatalog: frame.connectors }
    case "connector-list":
      // Server-authored, broadcast on every change — replace wholesale and
      // clear any stale error (a successful op produced this list).
      return { ...state, connectorInstances: frame.instances, connectorError: null }
    case "connector-status":
      return frame.ok
        ? { ...state, connectorError: null }
        : { ...state, connectorError: frame.message ?? "connector request failed" }
    case "artifact-list":
      // Server-authored, broadcast on every pin/unpin/update — replace
      // wholesale (most-recently-updated first, ordered server-side).
      return { ...state, pinnedArtifacts: frame.artifacts }
    case "artifact-update": {
      // A single artifact gained a new version. Replace it in place if
      // present, else prepend (a pin we hadn't yet seen). Keep newest first.
      const others = state.pinnedArtifacts.filter(
        (a) => a.id !== frame.artifact.id,
      )
      return { ...state, pinnedArtifacts: [frame.artifact, ...others] }
    }
    case "workflow-list":
      // Server-authored, read-only gallery — replace wholesale.
      return { ...state, workflows: frame.workflows }
    case "workflow-runs": {
      // Run history for one job — keyed by jobId, replaced on each fetch.
      const next = new Map(state.workflowRuns)
      next.set(frame.jobId, frame.runs)
      return { ...state, workflowRuns: next }
    }
    case "pty-output":
      // pty output is consumed by the setup terminal directly off the
      // transport (streamy frame), not folded into store state.
      return state
    case "turn-complete":
      // End-of-agentic-turn marker. ui-web renders from seq-keyed finalized
      // messages, so the "whole turn is over" signal carries no new state for
      // it — only the moon's grouped activity timeline needs it. No-op here.
      return state
    case "connector-oauth-redirect":
      // The consent URL is consumed by the Moon directly off the transport
      // (it opens the browser + binds the loopback); the web client can't
      // bind a loopback, so this frame carries no store state here.
      return state
    case "vault-list":
      // Server-authoritative registry (metadata + pointers only; no values).
      // Sent after hello + after every successful mutation — replace wholesale.
      return {
        ...state,
        vaultItems: frame.items,
        vaultSync: frame.sync ?? null,
      }
    case "vault-status":
      // Mutation ack — consumed by the UI's pending-request tracker, not
      // folded into persistent store state (the fresh vault-list that follows
      // a successful mutation already updates the list).
      return state
    case "thread-config":
      // Ack for set-thread-config. The store has no model/effort state today
      // (that lives in cfg().model/cfg().effort in App.tsx). The UI layer
      // reads applied/deferred/rejected from this frame directly. No-op here.
      return state
    default: {
      // Exhaustiveness guard: when every ServerFrame member has a matching
      // case arm, TypeScript narrows `frame` to `never` here. Adding a new
      // ServerFrame member WITHOUT a matching case becomes a compile-time
      // error on the assignment below. The `return state` keeps runtime
      // forward-compat: a newer server CAN send unknown frame types and the
      // store stays intact. The `void` suppresses "variable unused" lints.
      const _exhaustive: never = frame satisfies never
      void _exhaustive
      return state
    }
  }
}

export const filterEvents = (
  events: ReadonlyArray<ObsEvent>,
  selectedKinds: ReadonlySet<string>,
): ReadonlyArray<ObsEvent> => {
  if (selectedKinds.size === 0) return events
  return events.filter((e) => selectedKinds.has(e.kind))
}

export type { ObsEventKind }
