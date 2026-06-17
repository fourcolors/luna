import { EventEmitter } from "node:events"
import type { ClientFrame, ServerFrame, MemorySearchResultFrame, MemorySearchErrorFrame, ClientInfo } from "@luna/ui-ws"
import type { LunaWsClient } from "./ws-client.js"
import { parseSlashCommand, type SlashCommand } from "./slash.js"
import type { PendingSurvey, SurveyItem, SurveyVerdict } from "@luna/core"

/** The operator's per-item answers collected by the SurveyModal. */
export type SurveyAnswers = {
  /** The selected 1–5 Likert score for the task_quality item (null = not answered). */
  readonly likert: number | null
  /** Per-belief answers keyed by beliefId. */
  readonly beliefAnswers: Record<string, "confirmed" | "corrected" | "rejected">
}

/**
 * Pure verdict-assembly function (extracted so it can be unit-tested without
 * rendering). Maps SurveyAnswers + items + issuedAt → SurveyVerdict[].
 *
 * task_quality: score = (n-1)/4 (D-LOCK-4; 1→0.0 … 5→1.0).
 * belief_validation: maps confirmed/corrected/rejected to `verdict` field.
 * Every verdict stamps at=issuedAt (D-LOCK-5 idempotency anchor).
 * Unanswered items (null likert, missing beliefAnswer) are omitted.
 */
export const buildSurveyVerdicts = (
  items: ReadonlyArray<SurveyItem>,
  answers: SurveyAnswers,
  issuedAt: number,
): ReadonlyArray<SurveyVerdict> => {
  const out: SurveyVerdict[] = []
  for (const item of items) {
    if (item.kind === "task_quality") {
      const n = answers.likert
      if (n !== null) {
        out.push({
          itemId: item.id,
          kind: "task_quality",
          ref: item.ref,
          score: (n - 1) / 4,
          via: "survey",
          at: issuedAt,
        })
      }
    } else if (item.kind === "belief_validation" && item.beliefId !== undefined) {
      const ans = answers.beliefAnswers[item.beliefId]
      if (ans !== undefined) {
        out.push({
          itemId: item.id,
          kind: "belief_validation",
          ref: item.ref,
          beliefId: item.beliefId,
          verdict: ans,
          via: "survey",
          at: issuedAt,
        })
      }
    }
  }
  return out
}

type AssistantTurnState = {
  readonly turnId: string
  readonly text: string
  readonly done: boolean
}

type SessionErrorEvent = {
  readonly message: string
  readonly kind?: string
  readonly turnId: string | null
  readonly silent?: boolean
}

export type LunaHeadlessEvents = {
  rawFrame: (frame: ServerFrame) => void
  threadChange: (threadId: string) => void
  ready: () => void
  userMessageSent: () => void
  assistantDelta: (turn: AssistantTurnState) => void
  assistantDone: (turn: AssistantTurnState) => void
  assistantError: (event: SessionErrorEvent) => void
  threadList: (threads: ReadonlyArray<{ id: string; title: string | null; status: string }>) => void
  localShellRequest: (frame: Extract<ServerFrame, { type: "local-shell-request" }>) => void
  localShellStatus: (message: string, accepted: boolean) => void
  fatal: (reason: string) => void
  helpText: (text: string) => void
  info: (text: string) => void
  errorText: (text: string) => void
  toolCall: (e: { toolCallId: string; name: string; input: unknown; turnId: string }) => void
  toolResult: (e: { toolCallId: string; status: "ok" | "error"; output: string; truncated: boolean }) => void
  /** Phase 3 D3: server-pushed survey check-in is due; populate the modal. */
  survey: (pending: PendingSurvey) => void
}

export type LunaHeadlessConfig = {
  readonly client: LunaWsClient
  readonly profileName: string
  readonly model: string
  readonly initialThreadId?: string | null
  readonly autoResumedThreadId?: string | null
  readonly newThread?: boolean
  readonly saveLastThread: (threadId: string) => void
  readonly clearLastThread: () => void
  /**
   * Optional client identity stamped on every user-message frame. Lets the
   * server (and Luna) see which surface the operator is typing through.
   */
  readonly clientInfo?: ClientInfo
}

export class LunaHeadlessSession extends EventEmitter {
  private readonly client: LunaWsClient
  private readonly profileName: string
  private readonly model: string
  private currentThreadId: string | null
  private pendingAutoResumedThreadId: string | null
  private readonly pendingUserMessages: string[] = []
  private readonly assistantTextByTurn = new Map<string, string>()
  private quitting = false
  private fatalMessage: string | null = null
  private readonly saveLastThread: (threadId: string) => void
  private readonly clearLastThread: () => void
  private readonly clientInfo: ClientInfo | undefined

  constructor(cfg: LunaHeadlessConfig) {
    super()
    this.client = cfg.client
    this.profileName = cfg.profileName
    this.model = cfg.model
    this.currentThreadId = cfg.initialThreadId ?? null
    this.pendingAutoResumedThreadId = cfg.autoResumedThreadId ?? null
    this.saveLastThread = cfg.saveLastThread
    this.clearLastThread = cfg.clearLastThread
    this.clientInfo = cfg.clientInfo
    if (cfg.newThread === true) {
      this.client.send({ type: "new-thread", model: this.model })
    } else if (this.currentThreadId !== null) {
      this.client.send({ type: "subscribe", threadId: this.currentThreadId })
    }
  }

  override on<K extends keyof LunaHeadlessEvents>(event: K, listener: LunaHeadlessEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override emit<K extends keyof LunaHeadlessEvents>(event: K, ...args: Parameters<LunaHeadlessEvents[K]>): boolean {
    return super.emit(event, ...(args as unknown[]))
  }

  get threadId(): string | null { return this.currentThreadId }
  get fatalReason(): string | null { return this.fatalMessage }

  /**
   * Send the operator's survey answers. Stamps every verdict's `at` to
   * `issuedAt` (D-LOCK-5 — the server re-pins it too, defence-in-depth).
   * `surveyId` echoes the SurveyRequestFrame.surveyId for correlation.
   */
  sendSurveyResponse(
    surveyId: string,
    issuedAt: number,
    verdicts: ReadonlyArray<SurveyVerdict>,
  ): void {
    this.client.send({
      type: "survey-response",
      surveyId,
      issuedAt,
      verdicts: verdicts.map((v) => ({ ...v, at: issuedAt })),
    })
  }

  /**
   * Dismiss (no-op): close the survey modal WITHOUT sending any frame.
   * Per Execution Correction #1: dismiss = client-side no-op. The survey
   * re-surfaces on the next connection-time due-check. No snooze frame.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  dismissSurvey(): void {
    // Intentional no-op: nothing is sent; the unanswered survey re-surfaces
    // on the next connection-time due-check (D-LOCK-6 revised).
  }

  sendUser(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (this.currentThreadId === null) {
      this.pendingUserMessages.push(text)
      return
    }
    this.client.send({
      type: "user-message",
      threadId: this.currentThreadId,
      text,
      ...(this.clientInfo !== undefined ? { client: this.clientInfo } : {}),
    })
    this.emit("userMessageSent")
  }

  // Timeout for memory-search requests. Without it, a server that drops
  // the request silently (e.g., older build that doesn't recognize the
  // frame) leaves the panel hung in "loading" forever. 5s matches the
  // user's "instant info" expectation for a sidebar query.
  static readonly MEMORY_SEARCH_TIMEOUT_MS = 5000

  searchMemory(args: {
    readonly queryText: string
    readonly topK?: number
    readonly timeoutMs?: number
  }): Promise<MemorySearchResultFrame | MemorySearchErrorFrame> {
    return new Promise((resolve) => {
      const timeoutMs = args.timeoutMs ?? LunaHeadlessSession.MEMORY_SEARCH_TIMEOUT_MS
      let settled = false

      const finish = (frame: MemorySearchResultFrame | MemorySearchErrorFrame): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off("rawFrame", onFrame)
        resolve(frame)
      }

      const onFrame = (frame: ServerFrame): void => {
        if (
          (frame.type === "memory-search-result" ||
            frame.type === "memory-search-error") &&
          frame.queryText === args.queryText
        ) {
          finish(frame)
        }
      }

      const timer = setTimeout(() => {
        finish({
          type: "memory-search-error",
          queryText: args.queryText,
          message: `memory search timed out after ${timeoutMs}ms (server did not respond)`,
          kind: "internal",
        })
      }, timeoutMs)

      this.on("rawFrame", onFrame)
      this.client.send({
        type: "memory-search-request",
        queryText: args.queryText,
        ...(args.topK !== undefined ? { topK: args.topK } : {}),
      })
    })
  }

  dispatchSlash(line: string): SlashCommand {
    const cmd = parseSlashCommand(line)
    switch (cmd.type) {
      case "help":
        this.emit("helpText", "")
        break
      case "threads":
        this.client.send({ type: "list-threads", limit: 50 })
        break
      case "new-thread":
        this.resetThread()
        this.client.send({ type: "new-thread", model: this.model })
        break
      case "switch-thread":
        this.bindThread(cmd.threadId)
        this.client.send({ type: "subscribe", threadId: cmd.threadId })
        break
      case "interrupt":
        if (this.currentThreadId !== null) {
          this.client.send({ type: "interrupt", threadId: this.currentThreadId })
        }
        break
      case "quit":
        this.quitting = true
        break
      case "message":
        this.sendUser(cmd.text)
        break
      case "copy":
      case "select":
      case "local-shell":
      case "local-shell-status":
      case "local-shell-attach":
      case "local-shell-detach":
      case "local-shell-full-access":
      case "error":
        // Forwarded to caller — local-shell semantics still live in chat/app.ts
        // for v1; Phase 2 moves them inside the headless session.
        break
    }
    return cmd
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        if (this.quitting) return
        const frame = await this.client.nextFrame()
        this.handleFrame(frame)
        if (this.fatalMessage !== null) return
      }
    } catch (error) {
      if (!this.quitting) {
        this.fatalMessage = error instanceof Error ? error.message : String(error)
        this.emit("fatal", this.fatalMessage)
      }
    }
  }

  beginQuit(): void {
    this.quitting = true
  }

  private bindThread(threadId: string): void {
    const changed = this.currentThreadId !== threadId
    this.currentThreadId = threadId
    this.pendingAutoResumedThreadId = null
    if (changed) {
      try { this.saveLastThread(threadId) } catch { /* best-effort */ }
      this.emit("threadChange", threadId)
    }
    this.flushPending()
  }

  private resetThread(): void {
    this.currentThreadId = null
  }

  private flushPending(): void {
    if (this.currentThreadId === null) return
    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()
      if (text !== undefined) {
        this.client.send({
          type: "user-message",
          threadId: this.currentThreadId,
          text,
          ...(this.clientInfo !== undefined ? { client: this.clientInfo } : {}),
        })
        this.emit("userMessageSent")
      }
    }
  }

  private handleFrame(frame: ServerFrame): void {
    this.emit("rawFrame", frame)
    switch (frame.type) {
      case "hello":
      case "event":
      case "drop":
      case "account-list":
      case "artifacts-extracted":
        return
      case "ping":
        this.client.send({ type: "pong", ts: frame.ts })
        return
      case "bye":
        this.fatalMessage = frame.reason
        this.emit("fatal", frame.reason)
        return
      case "thread-created":
        this.bindThread(frame.thread.id)
        this.client.send({ type: "subscribe", threadId: frame.thread.id })
        this.emit("ready")
        return
      case "thread-snapshot":
        this.bindThread(frame.threadId)
        this.emit("ready")
        return
      case "user-accepted":
        this.bindThread(frame.threadId)
        return
      case "assistant-delta": {
        this.assistantTextByTurn.set(frame.turnId, frame.text)
        this.emit("assistantDelta", { turnId: frame.turnId, text: frame.text, done: false })
        return
      }
      case "assistant-done": {
        const text = this.assistantTextByTurn.get(frame.turnId) ?? ""
        this.assistantTextByTurn.delete(frame.turnId)
        this.emit("assistantDone", { turnId: frame.turnId, text, done: true })
        return
      }
      case "assistant-error": {
        if (
          frame.error.kind === "unknown-thread" &&
          this.pendingAutoResumedThreadId !== null &&
          frame.threadId === this.pendingAutoResumedThreadId
        ) {
          const staleId = this.pendingAutoResumedThreadId
          try { this.clearLastThread() } catch { /* best-effort */ }
          this.pendingAutoResumedThreadId = null
          this.resetThread()
          this.client.send({ type: "new-thread", model: this.model })
          if (frame.turnId !== null) {
            this.emit("assistantError", {
              message: `resumed thread ${staleId} no longer exists`,
              kind: "unknown-thread",
              turnId: frame.turnId,
              silent: true,
            })
          }
          this.emit("info", `luna: resumed thread ${staleId} no longer exists — starting a new one`)
          return
        }
        this.emit("assistantError", {
          message: frame.error.message,
          kind: frame.error.kind,
          turnId: frame.turnId,
        })
        return
      }
      case "thread-list":
        this.emit("threadList", frame.threads)
        return
      case "local-shell-status":
        this.emit("localShellStatus", frame.message, frame.accepted)
        return
      case "local-shell-request":
        this.emit("localShellRequest", frame)
        return
      case "tool-call":
        this.emit("toolCall", {
          toolCallId: frame.toolCallId, name: frame.name,
          input: frame.input, turnId: frame.turnId,
        })
        return
      case "tool-result":
        this.emit("toolResult", {
          toolCallId: frame.toolCallId, status: frame.status,
          output: frame.output, truncated: frame.truncated,
        })
        return
      case "survey-request":
        // Phase 3 D3: server-pushed check-in. Emit the PendingSurvey payload
        // (issuedAt + items) so the TUI can show the modal. D-LOCK-8: this
        // case is added manually (no exhaustiveness guard on the switch).
        this.emit("survey", { issuedAt: frame.issuedAt, items: frame.items })
        return
    }
  }
}
