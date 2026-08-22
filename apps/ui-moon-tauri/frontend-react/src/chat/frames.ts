/**
 * frames.ts - the server-frame registry and every handler on it
 * (stack23 S20b).
 *
 * 28 handlers, the pending-user-message stash helpers they share, and the
 * backend capability provider they feed. This is the layer that turns wire
 * frames into engine calls, so it depends on nearly every converted module -
 * which is exactly why it goes LAST among the movable pieces rather than
 * first.
 *
 * THE CAPABILITY PROVIDER MOVES WITH THE `hello` HANDLER, and this is the
 * direction #473 said was safe. That note warned against making
 * capabilities.js itself module-published, because chat.html constructs the
 * provider in a bare top-level `if` and a module global would be undefined
 * there. Moving the CONSUMER the other way has no such problem: vendor classic
 * scripts run before the deferred module, so `window.LunaCapabilities` is
 * already there when this factory runs.
 *
 * The provider and its catalog could not have stayed behind in any case: the
 * `hello` handler CLEARS `_backendCatalog` on every hello (server-swap safety),
 * so the handler and the state it clears are one unit.
 *
 * WHY THIS DELETES THREE HOST MEMBERS. `dispatchFrame` existed so the engines
 * could reach chat.html's registry; `backendCapabilities` and
 * `executeCapability` existed so SlashMenu could reach chat.html's provider.
 * All three are module-to-module calls now.
 */
// @ts-nocheck

export interface FramesCtx {
  readonly Logger: {
    info: (m?: unknown, ...a: unknown[]) => void
    warn: (m?: unknown, ...a: unknown[]) => void
    error: (m?: unknown, ...a: unknown[]) => void
  }
  /** The LIVE State object, never a copy. */
  readonly State: Record<string, unknown>
  readonly SPAWN_FRESH: boolean
  readonly PINNED_THREAD: string | null
  readonly winLabel: string | null
  /** Every engine a handler can reach. Passed WHOLE - handlers hand these on. */
  readonly engines: Record<string, unknown>
}

export function createFrames(ctx: FramesCtx) {
  const { Logger, State, SPAWN_FRESH, PINNED_THREAD, winLabel } = ctx
  const {
    ArtifactsEngine, ChatEngine, ChatLoop, ChatState, ComposerConfig,
    FeedbackEngine, LocalShell, MoonClient, MoonFace, Notifier, PoolEngine,
    ResultToasts, SecretPromptEngine, SmartBarEngine, SuggestedActionsEngine,
    SurveyEngine, ThreadCache, ThreadCreateState, ThreadDrawerEngine,
    VoiceEngine, WebSocketEngine,
  } = ctx.engines

  const MoonFrames = LunaWS.createFrameRegistry();

  // CHAT frame set only (Phase 4): skill-*/connector-*/vault-*/
  // register-op-token-status ride the settings PANELS' own connections, and
  // event/obs + widget-open stay with the HUB. This window ignores them.

  MoonFrames.register('hello', (frame) => {
    // authenticated successfully. The chat flow (syncThread →
    // list-threads/subscribe) is kicked off by the socket 'open'
    // handler, NOT here — so this version check is purely additive and
    // does not gate or regress the existing hello behavior.
    WebSocketEngine.checkProtocolVersion(frame);
    // Additive: show the server's build short-SHA when advertised.
    WebSocketEngine.applyBuildSha(frame);
    // Additive: cache the advertised model ids for the settings.connection
    // panel (localStorage luna_available_models — the panel window has no
    // hello of its own at open time).
    WebSocketEngine.applyAvailableModels(frame);
    // Capability gates, normalized by vendor/moon-protocol.js (absent
    // flags coerce to false so older servers degrade instead of throwing).
    const caps = LunaProtocol.parseHelloCapabilities(frame);
    // Backend-advertised commands gate: clear any PREVIOUS server's catalog on EVERY
    // hello (a hello means a (re)connect or machine swap). A command-capable server
    // re-populates _backendCatalog from the capability-catalog frame that follows;
    // a server without the layer simply leaves it null. (Clearing only on the absent
    // flag would let server A's commands keep rendering after a swap to a different
    // command-capable server B until B's catalog arrives — or forever if it never does.)
    _backendCatalog = null;
    // version-skew: gate the grouped activity timeline on the server
    // advertising the `turn-complete` frame. An older server omits this
    // capability → fall back to per-turn timelines that collapse on
    // their own `assistant-done` (else the grouped timeline, which only
    // settles on turn-complete, would hang on "Working on it…").
    State.serverSupportsTurnComplete = caps.turnComplete;
    // PRD Part C W1: additive gating for the Artifacts panel.
    State.serverSupportsArtifacts = caps.artifacts;
    ArtifactsEngine.applyCapability(State.serverSupportsArtifacts);
    // PRD Part C W3: additive gating for the /workflows command (the
    // gallery itself is the 'workflows' system panel window).
    State.serverSupportsWorkflows = caps.workflows;
    // Model + effort switcher: server advertises effort selection support.
    // applyAvailableModels (called above) has already refreshed the model
    // list in ComposerConfig; now apply the effort capability gate.
    State.serverSupportsEffort = caps.effortSelection;
    ComposerConfig.applyCapability(State.serverSupportsEffort);
    // Point-at-the-UI feedback: server advertises a feedbackSink. When
    // absent/false the button stays hidden and no feedback-submit is sent.
    State.serverSupportsFeedback = caps.feedback;
    FeedbackEngine.applyCapability(State.serverSupportsFeedback);
    // Suggested actions: raw-fallback pattern (flag added after
    // parseHelloCapabilities was written; do not rely on caps.suggestedActions).
    const hasSuggestedActions = !!(frame && frame.capabilities && frame.capabilities.suggestedActions);
    SuggestedActionsEngine.applyCapability(hasSuggestedActions);
    // (skills/connectors/vault capability gating + the widget-directory
    // announce are HUB concerns — the launchers and panels live there.)
  });

  // Account switcher: server pushes `account-list` after hello (public
  // summaries only — never secrets). Populates the composer account pill.
  // Does NOT auto-select (null/Auto keeps broker failover). Preserves
  // luna_account across reconnects (ui-shared account-switcher contract).
  MoonFrames.register('account-list', (frame) => {
    ComposerConfig.applyAccounts(frame && frame.accounts);
  });







  // ── Backend-advertised capabilities ──────────────────────────────────
  // A CapabilityProvider (from @luna/capabilities) backed by the WS frame channel:
  // it decodes inbound `capability-catalog` frames (untrusted -> validated) into
  // _backendCatalog, and routes executor:'server' commands via `capability-execute`.
  let _backendCatalog = null;
  let _capProvider = null;
  if (window.LunaCapabilities && window.LunaCapabilities.createFrameCapabilityProvider) {
    _capProvider = window.LunaCapabilities.createFrameCapabilityProvider({
      send: (f) => WebSocketEngine.send(f),
      onFrame: (handler) => {
        MoonFrames.register('capability-catalog', handler);
        MoonFrames.register('capability-execute-result', handler);
        return () => {};
      },
    }, { context: () => (State.activeThreadId ? { threadId: State.activeThreadId } : {}) });
    _capProvider.subscribe((snap) => {
      _backendCatalog = snap.ok ? snap.catalog : null;
      if (snap.ok && snap.rejected && snap.rejected.length) {
        console.warn('[capabilities] rejected backend descriptors', snap.rejected);
      }
    });
  }

  MoonFrames.register('artifact-list', (frame) => {
    // Full replacement list of pinned artifacts from the server.
    ArtifactsEngine.applyPinned(frame.artifacts || []);
  });

  MoonFrames.register('artifact-update', (frame) => {
    // Single pinned artifact was created or updated.
    ArtifactsEngine.applyUpdate(frame.artifact);
  });

  MoonFrames.register('artifacts-extracted', (frame) => {
    // Ephemeral per-turn artifacts (code fences / tool writes).
    ArtifactsEngine.applySession(frame);
  });

  // (workflow-list / workflow-runs frames are consumed by the 'workflows'
  // and 'flow' panel windows, not the chat window — unregistered frame
  // types are ignored by MoonFrames.dispatch.)

  MoonFrames.register('thread-config', (frame) => {
    // Server ack for a set-thread-config client frame. Reconcile applied /
    // deferred / rejected fields in the composer config cluster.
    ComposerConfig.reconcileThreadConfig(frame);
  });

  MoonFrames.register('thread-list', (frame) => {
    const threads = frame.threads || [];

    // Record every thread's server-reported model/effort so the composer
    // can show the ACTIVE thread's truth when the operator switches around.
    for (const t of threads) {
      if (t) ComposerConfig.recordThreadConfig(t.id, t.model, t.effort);
    }

    // Feed the thread drawer FIRST — additive, and independent of the reattach
    // early-return below (this same frame is the drawer's only data source).
    // Guarded so a drawer error can never break reattach self-heal.
    try { ThreadDrawerEngine.applyList(threads); } catch (_) { /* drawer never blocks reattach */ }

    // Only a list explicitly requested for bootstrap/recovery may select a
    // thread. Sidebar refreshes can race with new-thread and are data-only.
    const shouldAutoSelect = State.threadListAutoSelectPending;
    State.threadListAutoSelectPending = false;
    if (!shouldAutoSelect) return;

    // ── Tombstone-advance: stall self-heal round ──────────────────────────
    // onReattachStalled() cleared activeThreadId and added the stalled id(s)
    // to stalledIdSet. Pick the first thread NOT in that set so we skip every
    // known-bad thread, not just the most-recent one. This handles the case of
    // multiple adjacent tombstones: [A(bad), B(bad), C(good)] converges to C
    // rather than oscillating between A and B.
    if (State.activeThreadId) {
      // Already subscribed — this is an informational list (e.g. thread-archived
      // refresh). Don't re-subscribe.
      return;
    }

    if (threads.length > 0) {
      // Find first thread not in the stalled set (skip all known tombstones).
      const target = threads.find((t) => !State.stalledIdSet.has(t.id)) || threads[threads.length - 1];
      if (State.stalledIdSet.size > 0) {
        Logger.info(`Tombstone-advance: skipping ${State.stalledIdSet.size} stalled id(s), subscribing to "${target.id}"`);
      }
      State.stalledThreadId = null;   // consumed
      State.activeThreadId = target.id;
      Logger.info(`No active thread; auto-subscribing to thread "${target.id}"`);
      WebSocketEngine.send({ type: 'subscribe', threadId: target.id });
      // Reflect the now-active thread's model/effort (recorded above).
      ComposerConfig.refreshComposer();
    } else {
      // No threads exist — mint a fresh one.
      State.stalledThreadId = null;
      Logger.info("No threads exist on the server; creating a brand new thread");
      WebSocketEngine.sendNewThread();
    }
  });

  MoonFrames.register('thread-archived', (frame) => {
    // Server archived a thread (e.g. auto-archive). If it was our active
    // thread, clear it and refresh so we pick up another.
    Logger.info(`Thread archived: ${frame.threadId}`);
    if (frame.threadId === State.activeThreadId) {
      State.threadListAutoSelectPending = true;
      WebSocketEngine.send({ type: 'list-threads' });
      State.activeThreadId = null;
    }
    // Refresh the sidebar list if it's open.
    try {
      if (State.threadDrawerOpen && frame.threadId !== State.activeThreadId) ThreadDrawerEngine.requestList();
    } catch (_) { /* sidebar refresh is best-effort */ }
  });

  // Attempt to deliver a message the composer stashed in
  // `State.pendingUserMessage` for a thread that didn't exist yet at
  // submit time (new-thread mint) or wasn't confirmed live yet (a
  // reconnect mid-mint).
  //
  // History: the old code nulled the stash and fired send after a blind
  // 100ms setTimeout - a drop inside that window silently lost the first
  // message (M41). Flush is now connection-gated and snapshot-retried.
  //
  // Binding (Devin review on #351): the stash carries an optional
  // `threadId` stamped when `thread-created` arrives. Flush only sends when
  // that target matches the caller's threadId so a reconnect that re-points
  // activeThreadId at an older thread cannot misdeliver the first message.
  // Unbound stashes (mint not yet acked) refuse snapshot flush entirely.
  //
  // Clear-after-send (Copilot review): the stash is only cleared once the
  // frame has been handed to an OPEN socket; if send fails, restore it.
  function flushPendingUserMessage(threadId) {
    if (!State.pendingUserMessage) return;
    if (!threadId) return;
    const pending = State.pendingUserMessage;
    // Bound target: only deliver to that exact thread.
    if (pending.threadId && pending.threadId !== threadId) {
      Logger.warn(
        `flushPendingUserMessage: stash bound to "${pending.threadId}", not "${threadId}"; keeping queued`,
      );
      return;
    }
    // Unbound stash must not ride a random snapshot (reconnect last-thread).
    if (!pending.threadId) {
      Logger.warn(
        `flushPendingUserMessage: stash has no target thread yet; keeping queued until thread-created binds it`,
      );
      return;
    }
    // Still require the bound thread to be the viewed one (user didn't leave).
    if (threadId !== State.activeThreadId) return;
    // ENGINE-AWARE ONLY (#500). This used to re-check `State.ws` on top of
    // the predicate, which PoolEngine never assigns - so under the default
    // engine the second clause was always false and a stashed message could
    // never drain, no matter how healthy the connection was.
    if (!WebSocketEngine.isConnected()) {
      Logger.warn(
        `flushPendingUserMessage: not connected yet for "${threadId}"; keeping queued for retry`,
      );
      return;
    }
    const frame = {
      type: 'user-message',
      threadId: pending.threadId,
      text: pending.text,
      client: MoonClient.CLIENT_INFO,
      ...(pending.attachments ? { attachments: pending.attachments } : {}),
    };
    try {
      // Through the ENGINE, not the raw socket: `State.ws` is null under
      // PoolEngine, so this line used to be an unreachable TypeError waiting
      // behind the guard above (#500).
      WebSocketEngine.send(frame);
    } catch (e) {
      Logger.error('flushPendingUserMessage: send failed; restoring stash', e);
      return;
    }
    // Only clear after a successful handoff to the live socket.
    State.pendingUserMessage = null;
  }

  /** Stamp the mint target onto a queued first message (if any). */
  function bindPendingUserMessage(threadId) {
    if (!threadId || !State.pendingUserMessage) return;
    if (!State.pendingUserMessage.threadId) {
      State.pendingUserMessage.threadId = threadId;
    }
  }

  MoonFrames.register('thread-created', (frame) => {
    // Record the summary's model/effort as the thread's truth (the server
    // clamps/normalizes at creation, so this is authoritative).
    if (frame.thread) {
      ComposerConfig.recordThreadConfig(frame.thread.id, frame.thread.model, frame.thread.effort);
    }
    // thread-created is the acknowledgement for this connection's one
    // in-flight create request. If the user selected another row after the
    // request, settle it without stealing that newer selection.
    const shouldAttach = ThreadCreateState.settle();
    if (shouldAttach) {
      const createdThreadId = frame.thread.id;
      State.activeThreadId = createdThreadId;
      Logger.info(`Auto-subscribing to newly created thread "${createdThreadId}"`);
      WebSocketEngine.send({ type: 'subscribe', threadId: createdThreadId });
      WebSocketEngine.startSubscribeTimeout();
      // Now that this thread is active, reflect ITS model/effort in the
      // composer (recorded above, before activeThreadId was set).
      ComposerConfig.refreshComposer();
      // Surface the brand-new thread in the drawer.
      //
      // This used to call requestList(), which could NEVER work: the server
      // hides threads with no top-level user message from `thread-list`
      // (chat-service's `hasUserMessage: true`), so the refetch provably came
      // back without the thread that had just been created, and applyList's
      // wholesale replace then left the drawer with no row for it at all.
      // Insert the summary the server just handed us instead - the same thing
      // the web client's reducer already does on this frame.
      //
      // Unconditional, NOT gated on threadDrawerOpen: the drawer must be
      // correct when it is next opened, not only while it happens to be open.
      // Only on the attach branch - a create the user already moved on from is
      // an abandoned empty probe, and letting it drop matches the server.
      try { ThreadDrawerEngine.upsertThread(frame.thread); } catch (_) { /* best-effort */ }

      // Bind the stash to THIS mint so a later snapshot for another thread
      // cannot steal it, then attempt an immediate flush.
      bindPendingUserMessage(createdThreadId);
      flushPendingUserMessage(createdThreadId);
    } else if (frame && frame.thread && frame.thread.id) {
      // User already moved on, but still bind so a later intentional open of
      // this thread can flush (and never into a stranger).
      bindPendingUserMessage(frame.thread.id);
    }
  });

  MoonFrames.register('thread-create-error', (frame) => {
    // The server already converted the full defect into a short safe message.
    // Do not run reattach recovery or list/select an old thread: creation and
    // subscription are distinct phases, and no thread id exists to recover.
    if (!ThreadCreateState.fail()) return;
    WebSocketEngine.clearTurnTimeout();
    State.activeTurnId = null;
    ChatState.dropPendingAssistant();
    MoonFace.setBusy(false);
    ChatEngine.appendMessage(
      'assistant',
      `⚠️ ${frame && frame.message ? frame.message : 'Could not create the thread. Please try again.'}`
    );
  });

  MoonFrames.register('thread-snapshot', (frame) => {
    // Always refresh the per-thread cache — even a late snapshot for a
    // non-active thread keeps switch-back instant (and correct after a
    // background turn finished while we were elsewhere).
    if (frame && frame.threadId) {
      ThreadCache.put(frame.threadId, frame.messages || [], frame.throughSeq);
    }
    // This connection may still have forwarders for previously viewed
    // threads. A late snapshot must never replace the transcript for the
    // newly selected/created thread (or the fresh surface while no id exists).
    if (frame && frame.threadId && frame.threadId !== State.activeThreadId) return;
    // A first-message send may have been deferred (thread-created arrived
    // while this connection wasn't open yet, or a reconnect happened
    // before the flush above fired). This is the next proof this
    // connection can deliver to `frame.threadId` -- retry any stashed
    // message now instead of relying on a timer.
    flushPendingUserMessage(frame.threadId);
    // Whole-history replay from the server. Build state from scratch and
    // flush a single render - MessageList.tsx reconciles the entire
    // chat-messages container against the chat model in one pass.
    WebSocketEngine.clearSubscribeTimeout();        // reattach SUCCEEDED — we're back on a thread
    ChatState.reset();
    ChatState.loadHistory(frame.messages || []);
    if (ChatState.turns.length === 0) {
      ChatState.appendBanner('This thread is empty. Type a message below to start chatting!');
    }
    ChatLoop.flush();
    LocalShell.sendCapability();
    // Restart-survival: persist the thread we just landed on so reopening
    // the app resumes it. The snapshot proves this thread is valid
    // on the CURRENT server, so it's always safe to remember. Fire-and-
    // forget; never blocks or throws into the UI.
    // Only the MAIN line owns the restart-resume memory. A fresh-spawn side
    // panel (?thread=new) or a Phase 8 direct line (?thread=<id>) must NOT
    // overwrite it — otherwise reopening the app would resume the side/pinned
    // thread instead of the main conversation.
    if (window.__TAURI__ && State.activeThreadId && !SPAWN_FRESH && !PINNED_THREAD) {
      // Phase-2 last-thread: write per-panel/per-route slot (moon-session.json)
      // when this window has a panel label (Tauri context).  set_panel_last_thread
      // dual-writes the legacy file too, so set_last_thread_id is redundant when
      // the per-panel path succeeds — but we keep the legacy call as a safety net
      // for one release, and as the ONLY write when winLabel is unavailable.
      const _threadId = State.activeThreadId;
      if (typeof MoonSession !== 'undefined' && winLabel) {
        MoonSession.setPanelLastThread(winLabel, _threadId)
          .catch((e) => Logger.warn('setPanelLastThread failed (non-fatal):', e));
      } else {
        // No route context — fall back to the legacy global write only.
        window.__TAURI__.core.invoke('set_last_thread_id', { threadId: _threadId })
          .catch((e) => Logger.warn('set_last_thread_id failed (non-fatal):', e));
      }
    }
    WebSocketEngine.onReattached();   // clear the grace timer + retract the string (if it was out)
  });

  MoonFrames.register('local-shell-request', (frame) => {
    LocalShell.handleRequest(frame);
  });

  MoonFrames.register('assistant-delta', (frame) => {
    // Any thread with live deltas is "busy" for the sidebar pulse —
    // including background threads you switched away from.
    if (frame && frame.threadId) ThreadCache.markBusy(frame.threadId);
    // Thread isolation: drop deltas for any thread that isn't in view. A
    // mid-stream thread switch would otherwise stream the OLD thread's
    // tokens into the NEW thread until its snapshot lands.
    if (frame && frame.threadId && State.activeThreadId && frame.threadId !== State.activeThreadId) return;
    // Append delta to the active assistant turn. The reducer creates
    // a fresh text segment if the last segment is a closed text or a
    // tool card; otherwise it extends the in-progress text segment.
    // The renderer paints the result on the next animation frame.
    State.activeTurnId = frame.turnId;
    WebSocketEngine.startTurnTimeout();
    ChatState.applyDelta(frame.turnId, frame.text || '');
    ChatLoop.schedule();
    // Spoken replies: feed the (cumulative) delta to the voice
    // sentence pipeline. No-ops unless voice is on + speakReplies.
    VoiceEngine.onAssistantDelta(frame.turnId, frame.text || '');
  });

  MoonFrames.register('assistant-done', (frame) => {
    // Thread isolation: only finalize/flush into the thread in view. The
    // background-delivery case below still notifies for ANY thread, but
    // renders only when the delivered message belongs to the active thread.
    const sameThread = !frame.threadId || !State.activeThreadId || frame.threadId === State.activeThreadId;
    // #124: a background-delivered result arrives as a complete assistant-done
    // with NO preceding deltas (so there is no in-flight turn to finish).
    // Detect it by the delivery marker and push a complete turn directly.
    if (frame.message && frame.message.delivery) {
      if (frame.threadId) ThreadCache.clearBusy(frame.threadId);
      if (sameThread) {
        WebSocketEngine.clearTurnTimeout();
        State.activeTurnId = null;
        ChatState.appendDelivered(frame.message);
        ChatLoop.flush();
      }
      // Raise an OS notification even for a non-active thread: this result
      // arrived from a background/scheduled task, so the user is likely not
      // watching (and may be on a different thread entirely).
      Notifier.notifyDelivered(frame.message);
      return;
    }
    if (!sameThread) return;   // streamed done for another thread -> ignore
    // Finalize the active turn. flush() forces an immediate render so a
    // still-pending rAF frame can't overwrite the closed state.
    WebSocketEngine.clearTurnTimeout();
    const doneTurnId = frame.turnId || State.activeTurnId;
    State.activeTurnId = null;
    ChatState.finishTurn(
      doneTurnId,
      frame.message ? frame.message.text : null,
      frame.message ? frame.message.ts : undefined,
    );
    ChatLoop.flush();
    // Spoken replies: this message ended — flush its sentence
    // remainder (per message, so intermediate agentic steps speak too).
    VoiceEngine.onAssistantDone(doneTurnId);
  });

  MoonFrames.register('assistant-error', (frame) => {
    if (frame && frame.threadId) ThreadCache.clearBusy(frame.threadId);
    if (frame && frame.threadId && State.activeThreadId && frame.threadId !== State.activeThreadId) return;
    WebSocketEngine.clearTurnTimeout();
    const errTurnId = frame.turnId || State.activeTurnId;
    State.activeTurnId = null;
    ChatState.failTurn(errTurnId, frame.error && frame.error.message);
    ChatLoop.flush();
    MoonFace.setBusy(false);   // turn ended (error) → face stops thinking
  });

  MoonFrames.register('turn-complete', (frame) => {
    // Whole agentic turn ended — clear busy for this thread whether or not
    // it is in view (background work finished).
    if (frame && frame.threadId) ThreadCache.clearBusy(frame.threadId);
    if (frame && frame.threadId && State.activeThreadId && frame.threadId !== State.activeThreadId) return;
    // The whole agentic turn ended (SDK `result`). Settle the trailing
    // assistant run so its grouped activity timeline auto-collapses to
    // the "Worked for N steps" pill. This is the ONLY end-of-turn
    // signal — per-message `assistant-done` fires once per intermediate
    // step and can't distinguish a tool step from the final answer.
    WebSocketEngine.clearTurnTimeout();
    ChatState.markRunSettled();
    ChatLoop.flush();
    MoonFace.setBusy(false);   // whole turn ended → face stops thinking
    // Spoken replies: safety flush — anything still buffered for any
    // message in this turn gets spoken now.
    VoiceEngine.onTurnComplete();
  });

  MoonFrames.register('smart-bar', (frame) => {
    // Server-pushed context item list. SmartBarEngine renders kind="info"
    // pills above the composer row and hides the bar when empty.
    SmartBarEngine.applyFrame(frame);
    // The model pill carries the thread's CURRENT model (server-side truth,
    // re-pushed after an applied set-thread-config). Feed it into the
    // composer's per-thread map so labels track live switches.
    const items = Array.isArray(frame.items) ? frame.items : [];
    const modelItem = items.find((it) => it && it.id === 'model');
    if (modelItem && typeof modelItem.value === 'string' && frame.threadId) {
      ComposerConfig.recordThreadConfig(frame.threadId, modelItem.value, null);
    }
  });

  MoonFrames.register('tool-call', (frame) => {
    if (frame && frame.threadId && State.activeThreadId && frame.threadId !== State.activeThreadId) return;
    // Tool the assistant is invoking. Reducer appends a tool segment
    // to the active turn (closing any open text segment first).
    // parentToolUseId is present when the activity occurred inside a subagent.
    ChatState.applyToolCall(frame.turnId, frame.toolCallId, frame.name, frame.input, frame.parentToolUseId);
    ChatLoop.schedule();
  });

  MoonFrames.register('tool-result', (frame) => {
    if (frame && frame.threadId && State.activeThreadId && frame.threadId !== State.activeThreadId) return;
    // Pair with the previously-emitted tool-call by toolCallId.
    ChatState.applyToolResult(
      frame.toolCallId,
      frame.status === 'ok',
      frame.output,
      frame.truncated
    );
    ChatLoop.schedule();
  });

  MoonFrames.register('survey-request', (frame) => {
    // Phase 3 D3: alignment check-in pushed by the server. Hand to
    // SurveyEngine which paints the docked user-ask-panel; the user
    // submits with a Submit click (sends `survey-response`) or
    // dismisses (client-side no-op — resurfaces next connection).
    SurveyEngine.show(frame);
  });

  MoonFrames.register('user-accepted', (frame) => {
    // The user message was accepted by the server. Remove typing indicator when streaming starts
  });


  MoonFrames.register('secret-request', (frame) => {
    // Agent-summoned secure secret entry. SecretPromptEngine paints the
    // docked secret-prompt-panel; the user submits (sends `secret-result`
    // with the secret) or cancels (sends `secret-result` cancelled:true).
    SecretPromptEngine.show(frame);
  });

  MoonFrames.register('secret-status', (frame) => {
    // Server ack for a submitted secret. Never carries the secret.
    SecretPromptEngine.handleStatus(frame);
  });

  MoonFrames.register('feedback-ack', (frame) => {
    // Server ack for a submitted feedback note (unicast, echoes requestId).
    FeedbackEngine.handleAck(frame);
  });

  MoonFrames.register('suggested-action-set', (frame) => {
    // Full replacement set for a thread. SuggestedActionsEngine stores per-
    // thread and only shows the chip when the active thread has proposed actions.
    SuggestedActionsEngine.applySet(frame);
  });

  MoonFrames.register('suggested-action-update', (frame) => {
    // Single action delta (status change or new action). Upsert into store.
    SuggestedActionsEngine.applyUpdate(frame);
  });

  // #124: background-result toast. A "Luna finished X" notification BROADCAST
  // to every window (not scoped to one thread's subscribers), so a finished
  // background/job result surfaces even when its thread is not on screen.
  // Self-contained: lazily mounts its own #result-toasts container, auto-
  // dismisses after ~6.5s, and click-to-dismiss. Exposed on __MoonInternals
  // for screenshot/agent-browser harnesses.
  // ResultToasts arrives through ctx.engines now (S20b). Its chat.html
  // forward-declaration came along inside this span and is gone: the handler
  // below no longer needs a late-bound global, because the instance is handed
  // to this factory before any frame can arrive.

  MoonFrames.register('result-delivered', (frame) => {
    ResultToasts.show(frame);
  });

  return {
    /** What the engines call for every inbound frame. */
    dispatch: (frame) => MoonFrames.dispatch(frame),
    /** SYNCHRONOUS snapshot of the backend catalog, for SlashMenu's per-keystroke
     *  buildCommands. Deliberately not the provider's async list(). */
    backendCapabilities: () => (_backendCatalog && _backendCatalog.capabilities) || [],
    executeCapability: (req) => (
      _capProvider
        ? _capProvider.execute(req)
        // Capability layer absent (no window.LunaCapabilities). The
        // CapabilityProvider port is async-total, so speak its vocabulary
        // rather than leak this conditional to callers as a null.
        : Promise.resolve({ ok: false, error: 'capability layer unavailable', reason: 'unavailable' })
    ),
    /** Test hook only. */
    MoonFrames,
  }
}
