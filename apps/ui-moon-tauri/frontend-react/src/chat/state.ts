/**
 * state.ts - the one mutable State object the whole chat window shares
 * (stack23 S20d).
 *
 * A PURE LEAF: the dependency extractor reports no top-level references out of
 * it at all, which is why it can be the last thing to move and still move
 * verbatim.
 *
 * IT IS CREATED PER WINDOW, NOT AS A MODULE SINGLETON. Every engine that takes
 * `State` takes THIS object by reference and mutates it in place - that is the
 * contract, and a shared module-level instance would leak one test window's
 * state into the next through a common jsdom global.
 *
 * SINGLE-WRITER DISCIPLINE (single-writer-state-mutation-discipline skill):
 * `activeThreadId` must only be written by `setActiveThread()` at user-driven
 * thread-selection call sites (row click, drag-drop, pinned-thread seed).
 * Server-driven writes (stall recovery, null-on-reconnect, thread-created ack)
 * may remain direct because they are confirmed transitions, not speculative
 * selections. Every user-driven write MUST go through `setActiveThread` so
 * the validation/ordering invariants are applied in one place and cannot be
 * skipped by a new call site.
 */
// @ts-nocheck

export function createState() {
  return {
      ws: null,
      activeThreadId: null,
      activeTurnId: null,
      // Per-thread ACTUAL config learned from server frames (thread-created /
      // thread-list summaries, thread-config acks, smart-bar model pills).
      // threadId → model id / effort level. The composer prefers these over
      // the global localStorage picks so it shows the ACTIVE thread's truth,
      // not the operator's last global selection.
      threadModels: {},
      threadEfforts: {},
      wsUrl: 'ws://127.0.0.1:4753/ui',
      wsToken: '',
      reconnectAttempts: 0,
      isManuallyClosing: false,
      pendingUserMessage: null,
      pendingFreshThread: false,
      // A transmitted new-thread request has three states: null (none),
      // "attach" (adopt its thread-created ack), or "background" (the user
      // picked another row while creation was in flight; keep the new row but
      // do not let its late ack steal selection). Only one request is allowed
      // per connection at a time because thread-created has no request id.
      threadCreateIntent: null,
      // A thread-list selects its first row ONLY when an explicit bootstrap /
      // recovery request armed this flag. Sidebar refreshes are informational
      // and must never infer selection from activeThreadId === null.
      threadListAutoSelectPending: false,
      // Set true when the connection profile changes so the next syncThread()
      // ignores the (non-server-scoped) last-thread file and lists fresh.
      skipLastThreadFile: false,
      // Per-turn inactivity watchdog handle (fix-3). null when no turn is in flight.
      turnTimeout: null,
      // Subscribe-response watchdog: armed after we (re)subscribe and expect a
      // thread-snapshot. If none arrives we treat the reattach as STALLED.
      // Cleared on snapshot/close/disconnect.
      subscribeTimeout: null,
      // Bounded retry counter for the stall self-heal. A file-sourced last-thread
      // id may point at a thread the current server no longer holds (pruned, reset,
      // or written against a different server). Each stall increments the counter;
      // once it reaches MAX_REATTACH_ROUNDS the dead state is surfaced. Reset on
      // every fresh connect() and on every successful reattach (thread-snapshot).
      reattachRound: 0,
      // When a cold-start file-sourced id is PENDING VALIDATION (waiting for the
      // thread-list response to confirm it exists), we park it here instead of
      // writing State.activeThreadId — that stays null until we know it's valid.
      // Cleared once the thread-list arrives and resolves the validation.
      pendingReattachId: null,
      // The thread id that most recently STALLED (got no snapshot after subscribe).\
      // Kept for single-tombstone detection by legacy callers; stalledIdSet is the
      // authoritative multi-tombstone accumulator used by the thread-list handler.
      stalledThreadId: null,
      // Set of ALL thread ids that stalled during this connect() session.
      // Cleared on every fresh connect(). Used by the thread-list tombstone-advance
      // path to skip every known-bad id, not just the most-recent one.
      stalledIdSet: new Set(),
      // The pinned thread id for ?thread=<id> windows (injectable for tests).
      // Set once at boot from PINNED_THREAD; tests may set m.State.pinnedThread directly.
      pinnedThread: null,
      // Tauri window label for this webview (set at boot). Used so drag-out
      // floaters can redock back to the owner (#380).
      winLabel: null,
      // True while a sidebar row is being pointer-dragged for pull-out. Defers
      // list rebuilds so the captured node is never detached mid-gesture.
      threadDragActive: false,
      // Live drag-to-redock preview on the OWNER window (from a floater).
      redockPreview: null, // { threadId, title, yRatio, over } | null
      // Session-local thread order after drag-to-redock inserts (ids[]).
      threadOrder: null,
      /** Thread ids currently open as floater windows - hidden from the owner strip (Chrome detach). */
      floatedThreadIds: Object.create(null),
      // The pending scheduleReconnect() timer.
      reconnectTimer: null,
      // Connection generation counter (fix-6). Bumped each connect(); each
      // socket's handlers capture their gen and ignore events if superseded.
      connGen: 0,
      // version-skew: true once a protocol-version mismatch banner has been
      // shown, so reconnects (which re-deliver `hello`) don't stack duplicates.
      protocolNoticeShown: false,
      // version-skew: does the connected server emit the `turn-complete` frame
      // (hello capability `turnComplete`)? It gates the grouped activity
      // timeline: with it, consecutive assistant turns merge into one timeline
      // that settles on turn-complete; WITHOUT it (older server) we fall back to
      // the pre-grouping behavior (one timeline per turn, collapse on its own
      // `assistant-done`) so the timeline never hangs on "Working on it…".
      // Defaults true; `hello` (always the first frame on connect, before any
      // chat frame) corrects it to false for an old server.
      serverSupportsTurnComplete: true,
      // PRD Part C W1: artifact persistence + panel.
      serverSupportsArtifacts: false,
      pinnedArtifacts: [],    // PinnedArtifactItem[] — from artifact-list / artifact-update
      sessionArtifacts: [],   // Artifact[] — deduped ephemeral per-turn artifacts
      artifactsPanelOpen: false,
      // PRD Part C W3: gates the /workflows command (the gallery itself is
      // the 'workflows' system panel window, not an in-chat overlay).
      serverSupportsWorkflows: false,
      // Thread sidebar (Things-3-style resizable split pane).
      threadDrawerOpen: false,  // width > 0
      sidebarWidth: 0,          // current sidebar width in px (0 = collapsed)
      lastOpenWidth: 240,       // remembered width so a toggle reopens where you left it
      threads: [],              // SessionSummary[] from thread-list — the sidebar render source
      threadSearch: '',         // live filter text for the sidebar
      // Per-thread transcript cache (threadId → { messages, throughSeq }).
      // Instant paint on switch; server re-snapshot is the authoritative refresh.
      // Plain object (not Map) so tests can JSON-roundtrip State easily.
      threadCache: Object.create(null),
      // Threads with an in-flight agentic turn (any threadId, not just active).
      // Sidebar shows a busy pulse so background work is visible while you chat elsewhere.
      busyThreads: Object.create(null),
      // Live subagent trees, threadId → SubagentNode[], written by the
      // `subagent-tree` broadcast handler in frames.ts. The sidebar nests
      // the running ones under their thread row (see threadList
      // .liveAgentsForThread), which is why the delegation no longer pops a
      // separate Agents window.
      subagentsByThread: Object.create(null),
      // Agent sidebar S4: mention menu + (S5) grouped sidebar gating.
      // Defaults false; `hello` corrects to true when the server binds an
      // agent roster. Old server → "@ " stays ordinary text, flat sidebar.
      serverSupportsAgents: false,
      // MentionAgent[] ({name, description} only — the ui-ws projection
      // guarantees no prompts/tools ever reach this array) from agent-list.
      agents: [],
      // PR2: the click-an-agent lookup — null = all threads; a name =
      // only threads that agent was involved in (visibleThreads filter).
      agentFilter: null,
      // PR2: sections are opt-in (localStorage `luna.sidebarSections`,
      // stamped by threadDrawer at construction). Default OFF — agents
      // are people you look up, not folders you file into.
      sidebarSectionsEnabled: false,
      // Model + effort switcher (§1 wire contract). effortSelection cap gates
      // whether the server accepts set-thread-config + computes efforts per model.
      // Defaults false; `hello` corrects to true when the server supports it.
      serverSupportsEffort: false,
      // The operator's persisted effort pick. Null = use server default.
      // Persisted to localStorage `luna_effort`. Only sent when the chosen
      // model's `efforts` list includes this value.
      selectedEffort: null,
      // local-shell: the machine-access scope this client advertises. roots are
      // explicitly attached folders (auto-approve set, may be empty); fullAccess
      // lets Luna run anywhere. enabled = fullAccess || roots.length > 0.
      //
      // DEFAULT ON: absent or "on" in localStorage => true; "off" => false.
      // The user's explicit OFF choice is persisted so it survives restarts.
      // Guard the read in try/catch for jsdom/test safety.
      localShell: (() => {
        let fullAccess = true;
        try {
          const stored = localStorage.getItem('luna_machine_access');
          if (stored === 'off') fullAccess = false;
          // absent or 'on' => true (the default)
        } catch (_) { /* jsdom or sandboxed environment — fall back to true */ }
        return {
          enabled: fullAccess, // roots is always [] here, so enabled === fullAccess
          roots: [] as string[],
          fullAccess,
          platform: 'unknown',
          clientId: 'moon_' + ((window.crypto && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '')
            : Math.random().toString(36).slice(2))
        };
      })()
  }
}

export type ChatWindowState = ReturnType<typeof createState>

/**
 * setActiveThread — the SINGLE WRITER for user-driven thread selection.
 *
 * Every call site that switches threads in response to a user action (row
 * click, drag-drop, pinned-thread initial seed) MUST call this instead of
 * assigning State.activeThreadId directly. Centralising the write here means:
 *
 *   1. The ordering invariants (clear pendingFreshThread, clear
 *      threadListAutoSelectPending) are ALWAYS applied — no call site can
 *      forget them.
 *   2. Same-thread clicks short-circuit before reaching any downstream
 *      subscribe/paint path, so no spurious re-renders fire.
 *   3. A single breakpoint / log line here catches every user-driven
 *      thread transition.
 *
 * Server-driven writes (null-on-stall, null-on-reconnect, thread-created ack,
 * thread-archived, syncThread fast-path) remain direct: they are confirmed
 * server transitions, not speculative user selections, and routing them here
 * would conflate two distinct lifecycles.
 *
 * @param State   The per-window state object (passed by reference).
 * @param id      The thread id to switch to. Must be a non-empty string.
 * @param reason  Short label for log/debug attribution (e.g. "row-click").
 * @returns       true if the switch was applied, false if it was a no-op
 *                (same thread already active or invalid id).
 */
export function setActiveThread(
  State: ChatWindowState,
  id: string,
  reason: string
): boolean {
  if (!id) return false;
  if (id === State.activeThreadId) return false;   // already here — no re-render race
  // Newer explicit selection beats any deferred intents that might race it.
  State.pendingFreshThread = false;
  State.threadListAutoSelectPending = false;
  State.activeThreadId = id;
  return true;
}

/**
 * clearActiveThread — user-intent transition AWAY from all threads (new
 * conversation, connection reset that must not pre-select).
 *
 * Symmetric with setActiveThread. Call this at the moment the user fires
 * "new conversation" so that optimistic UI (blank composer, no thread
 * highlight) paints before the server round-trip completes. The caller is
 * responsible for clearing ChatState / sending new-thread; this function
 * owns only the state slot.
 *
 * WHY NOT overload setActiveThread with null: a null argument is ambiguous
 * — callers that mean "go somewhere" and callers that mean "abandon the
 * thread entirely" look identical at the call site. Naming the intent
 * explicitly makes code-search grep for clearActiveThread unambiguous, and
 * the allowlist fence test can distinguish the two patterns.
 *
 * @param State   The per-window state object (passed by reference).
 * @param reason  Short label for log/debug attribution (e.g. "new-conversation").
 */
export function clearActiveThread(
  State: ChatWindowState,
  reason: string
): void {
  State.activeThreadId = null;
  State.activeTurnId = null;
}
