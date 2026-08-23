/**
 * wire.ts - the two socket engines and the boot that ignites them
 * (stack23 S20a).
 *
 * WebSocketEngine is the original raw-socket engine; PoolEngine drives the
 * same contract through @luna/ui-transport's ConnectionManager and has been
 * the DEFAULT since #489. The swap block below monkey-patches WebSocketEngine's
 * entry points to delegate when the pool is live, which is why every caller in
 * the app can keep saying `WebSocketEngine.x()` and still reach the right one.
 *
 * THE IGNITION MOVED WITH THEM, AND IT HAD TO. `loadConnectionAndConnect()`
 * ran at chat.html's classic top level, and its SYNCHRONOUS prefix reaches
 * connect() in a plain browser - the Tauri branch awaits first, so it never
 * does. Leaving it behind would have made a module-published engine undefined
 * at exactly the moment boot needed it, in dev and in every test, while the
 * installed app looked fine. So this file owns both the wire and its start,
 * and main-chat.tsx calls boot() once everything else is constructed.
 *
 * That is BOOT OWNERSHIP moving to the module side, which is the change #467
 * and #475 kept circling. It is scoped deliberately: only the connection boot
 * moves here. The DOM event wiring, the frame handlers and State/DOM
 * themselves stay in chat.html for the next slices.
 *
 * SPAWN_FRESH / PINNED_THREAD are passed in rather than re-derived, so there
 * is exactly one place that reads `?thread=` and one interpretation of the
 * `new` sentinel.
 */
// @ts-nocheck

import {
  invokeWithTimeout,
  isUsableBearerToken,
  pickBootWsUrl,
  BOOT_INVOKE_MS,
} from "../tauriBoot"
import { buildListThreadsFrame } from "./threadList"

/** Max stall-recovery rounds before surfacing "Reattach stalled". 3 covers one
 *  tombstone advance + one validation miss + one final retry. */
const MAX_REATTACH_ROUNDS = 3

export interface WireCtx {
  readonly Logger: {
    info: (m?: unknown, ...a: unknown[]) => void
    warn: (m?: unknown, ...a: unknown[]) => void
    error: (m?: unknown, ...a: unknown[]) => void
  }
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object, never a copy. */
  readonly State: Record<string, unknown>
  /** Frame registry dispatch. The registry itself stays in chat.html until the
   *  handlers move; the engines only ever call dispatch. */
  readonly MoonFrames: { dispatch: (frame: unknown) => void }
  readonly ChatEngine: Record<string, unknown>
  readonly ChatState: Record<string, unknown>
  readonly ChatLoop: Record<string, unknown>
  readonly ComposerConfig: Record<string, unknown>
  readonly MoonBar: Record<string, unknown>
  readonly MoonFace: Record<string, unknown>
  readonly ThreadCreateState: Record<string, unknown>
  readonly ThreadDrawerEngine: Record<string, unknown>
  readonly MOON_EXPECTED_PROTOCOL_VERSION: number
  readonly SPAWN_FRESH: boolean
  readonly PINNED_THREAD: string | null
  readonly winLabel: string | null
}

export function createWire(ctx: WireCtx) {
  const {
    Logger, DOM, State, MoonFrames, ChatEngine, ChatState, ChatLoop,
    ComposerConfig, MoonBar, MoonFace, ThreadCreateState, ThreadDrawerEngine,
    MOON_EXPECTED_PROTOCOL_VERSION, SPAWN_FRESH, PINNED_THREAD, winLabel,
  } = ctx

  /**
   * The ONE place a new-thread frame is built (agent sidebar S4 dedup —
   * WebSocketEngine.sendNewThread and PoolEngine.sendNewThread used to
   * carry byte-identical copies of this logic, and the "ONE place" claim
   * on the former was already stale; anything added to one and not the
   * other half-works depending on the pool flag). Carries the operator's
   * persisted model pick, optional sticky account pin, the persisted
   * effort pick when valid for the model, and — S4 — an optional agent
   * section for the sidebar's per-section "+" (sent only when the server
   * advertises the agents capability; it validates against its roster
   * regardless, so a stale client value degrades to the general section).
   */
  const buildNewThreadFrame = (agent) => {
    const model = localStorage.getItem('luna_model') || '';
    const frame = model ? { type: 'new-thread', model } : { type: 'new-thread' };
    const accountId = localStorage.getItem('luna_account') || '';
    if (accountId) frame.accountId = accountId;
    // Include effort only when: (a) server supports effortSelection cap,
    // (b) an effort is set, and (c) the effort is valid for the chosen model.
    if (State.serverSupportsEffort) {
      const effort = localStorage.getItem('luna_effort') || '';
      if (effort && ComposerConfig.isEffortValidForCurrentModel(effort)) {
        frame.effort = effort;
      }
    }
    if (agent && State.serverSupportsAgents) frame.agent = agent;
    return frame;
  }

  const WebSocketEngine = {
    // registerCloseHook seam (design doc, Monolith Decomposition): code
    // that must run when the socket drops — secret wipes today — registers
    // here instead of living inline in the close handler.
    _closeHooks: [],
    registerCloseHook(fn) { this._closeHooks.push(fn); },

    connect() {
      if (State.ws) {
        this.disconnect();
      }
      // A (re)connect means no turn from a prior socket is in flight; settle
      // the face so a turn abandoned by a drop can't resurface as "thinking"
      // when the new socket opens (covers paths where State.ws was nulled).
      // `?.` for the same boot-order reason as updateStatus below: a first
      // connect() can precede the module, and `_busy` already defaults to false.
      MoonFace?.setBusy(false);

      // fix-6: each connect() bumps the generation. Handlers attached below
      // capture this gen; a superseded socket's late async events (which
      // cannot be detached because they were added via addEventListener) are
      // ignored once a newer connect() has incremented State.connGen.
      const myGen = ++State.connGen;
      this.clearSubscribeTimeout();   // a fresh connect owns its own subscribe watchdog
      State.threadListAutoSelectPending = false;
      State.reattachRound = 0;           // and its own bounded stall self-heal budget
      State.pendingReattachId = null;    // clear any in-flight advisory validation
      State.stalledThreadId = null;      // clear tombstone tracker
      State.stalledIdSet = new Set();    // clear multi-tombstone accumulator
      if (State.reconnectTimer) { clearTimeout(State.reconnectTimer); State.reconnectTimer = null; }

      Logger.info(`Connecting to WebSocket: ${State.wsUrl}`);
      this.updateStatus('connecting', 'Connecting...');
      State.isManuallyClosing = false;

      const fullUrl = LunaProtocol.buildWsUrl(State.wsUrl, State.wsToken);

      try {
        State.ws = new WebSocket(fullUrl);
      } catch (e) {
        // Step 1c Part 3c (opus review, plan Step 1c): NEVER log the raw
        // exception or e.message here - new WebSocket(fullUrl) embeds the
        // token-bearing URL verbatim in its thrown message (proven live by a
        // jsdom probe, see docs/next/routes-and-view-mode-plan.md's "The
        // security invariant, which is not deferrable"). Log the error NAME
        // and a redacted describeWsUrl(url) only.
        const errName = (e && e.name) ? e.name : 'Error';
        Logger.error("WebSocket creation error:", errName, LunaProtocol.describeWsUrl(State.wsUrl));
        this.updateStatus('disconnected', 'Connection Error');
        this.scheduleReconnect();
        return;
      }

      State.ws.addEventListener('open', () => {
        if (myGen !== State.connGen) return;
        Logger.info("WebSocket connected successfully");
        State.reconnectAttempts = 0;
        this.updateStatus('connected', 'Connected');
        
        // Trigger thread synchronization on connect
        this.syncThread();
      });

      State.ws.addEventListener('message', (event) => {
        if (myGen !== State.connGen) return;
        try {
          const frame = JSON.parse(event.data);
          this.handleFrame(frame);
        } catch (e) {
          Logger.warn("Malformed WebSocket frame dropped:", e);
        }
      });

      State.ws.addEventListener('close', (event) => {
        if (myGen !== State.connGen) return;            // fix-6 gen gate — MUST be first line
        Logger.warn(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
        this.updateStatus('disconnected', 'Disconnected');
        this.clearTurnTimeout();                         // fix-3 — no leaked timer across reconnects
        this.clearSubscribeTimeout();                    // socket gone → the close path owns recovery now
        ThreadCreateState.onDisconnect();                // preserve an in-flight fresh-thread intent
        // Close hooks (registerCloseHook seam): secret/Vault wipe policies
        // live with the engines that own those inputs, so they can travel
        // to whichever window hosts them after the panel split. Runs at
        // exactly the point the inline wipe block used to.
        for (const hook of this._closeHooks) {
          try { hook(); } catch (e) { Logger.warn('WS close hook failed:', e); }
        }
        if (State.activeTurnId) {                        // only decorate an actually in-flight turn
          State.activeTurnId = null;
          // State-driven equivalent of "the last rendered bubble is the
          // typing-dots placeholder" - drop the stale placeholder from
          // ChatState (not just the DOM node) so a still-pending assistant
          // turn doesn't get silently resurrected by the next render.
          if (ChatState.hasVisibleStreamingPlaceholder()) {
            ChatState.dropPendingAssistant();
            ChatEngine.appendMessage('assistant', '⚠️ Connection lost — try again.');
          }
        }
        if (!State.isManuallyClosing) {
          // The chat window does not own reconnect choreography beyond
          // scheduling the next retry (the hub handles any visual recovery).
          this.scheduleReconnect();
        }
      });

      State.ws.addEventListener('error', (event) => {
        if (myGen !== State.connGen) return;
        Logger.error("WebSocket transport error occurred");
        this.updateStatus('disconnected', 'Error');
      });
    },

    disconnect() {
      // Full teardown of connection + turn state. Clearing the watchdog here
      // (not only in the close handler) is load-bearing: on a server-switch
      // mid-turn the old socket's close event is gen-gated and returns early,
      // so the close-handler's clearTurnTimeout() never runs — without this
      // line the 90s timer leaks and later fires a false "No response" on the
      // new server. Any caller of disconnect() now cancels the timer.
      this.clearTurnTimeout();
      this.clearSubscribeTimeout();
      ThreadCreateState.onDisconnect();
      // A turn abandoned by a drop/teardown never gets a turn-complete frame;
      // settle the face here so it doesn't resurface as "thinking" on reconnect.
      MoonFace.setBusy(false);
      if (State.reconnectTimer) { clearTimeout(State.reconnectTimer); State.reconnectTimer = null; }
      if (State.ws) {
        Logger.info("Disconnecting WebSocket client manually");
        State.isManuallyClosing = true;
        try {
          State.ws.close();
        } catch (e) {
          // ignore
        }
        State.ws = null;
      }
    },


    send(frame) {
      if (State.ws && State.ws.readyState === WebSocket.OPEN) {
        try {
          State.ws.send(JSON.stringify(frame));
        } catch (e) {
          Logger.error("Failed to send frame over WebSocket:", e);
        }
      } else {
        Logger.warn("Attempted to send frame while WebSocket was not OPEN", frame);
      }
    },

    updateStatus(statusClass, text) {
      // Null-safe: a missing #connection-status must never abort connect()
      // before new WebSocket (that left the pill on HTML "Disconnected" and
      // MoonBar on default "waking up…" with zero SYN).
      if (DOM.connectionStatus) {
        DOM.connectionStatus.className = statusClass;
        DOM.connectionStatus.textContent = text;
      }
      // Mirror connection into the animated face + free-space bar mood.
      // `?.` HERE ONLY, and it is not defensive noise. This is the one path
      // that can run BEFORE the deferred module publishes MoonFace/MoonBar:
      // loadConnectionAndConnect() is a classic-top-level call whose
      // synchronous prefix reaches connect() in a plain browser (the Tauri
      // branch awaits first, so it never does). Skipping the call is the
      // IDENTITY: both controllers default to _conn 'connecting' / _busy
      // false, and their init() paints exactly that default at construction.
      // Every other reader is inside a frame handler or event callback and
      // stays unguarded, so a genuinely-early read added later still throws
      // instead of silently no-opping.
      MoonFace?.setConnection(statusClass);
      MoonBar?.setConnection(statusClass);
    },

    /**
     * VERSION-SKEW defence (client half). At hello, compare the server's
     * advertised protocol version against MOON_EXPECTED_PROTOCOL_VERSION.
     *
     * Philosophy: a desktop chat widget that REFUSES to connect over a version
     * bump is worse than one that connects with a loud warning. So we never
     * block — we WARN and keep chatting enabled. Three cases:
     *
     *   1. present + mismatch → amber 'version-warning' dot (persists while
     *      connected) + a persistent in-transcript banner. Idempotent: the
     *      State flag stops reconnects from stacking duplicate banners.
     *   2. present + match    → no-op (leave the 'connected' status untouched).
     *   3. absent (older server that predates protocolVersion) → a single soft
     *      one-line note, NOT a hard banner — don't break against old servers.
     */
    checkProtocolVersion(frame) {
      const serverVersion = frame.protocolVersion;

      // Case 3: absent — older server. Soft note only, once.
      if (serverVersion === undefined || serverVersion === null) {
        if (!State.protocolNoticeShown) {
          State.protocolNoticeShown = true;
          Logger.warn(
            `Server did not advertise a protocol version; expected v${MOON_EXPECTED_PROTOCOL_VERSION}. ` +
            `Assuming compatible (older server). Some features may differ.`
          );
          ChatEngine.appendMessage(
            'assistant',
            `ℹ️ Connected to an older server that does not report its protocol version (this app expects v${MOON_EXPECTED_PROTOCOL_VERSION}).`
          );
        }
        return;
      }

      // Case 2: match — nothing to do. Leave 'connected' as set by 'open'.
      if (serverVersion === MOON_EXPECTED_PROTOCOL_VERSION) {
        return;
      }

      // Case 1: present + MISMATCH — warn loudly, but keep chatting enabled.
      Logger.error(
        `Protocol version mismatch: this app expects v${MOON_EXPECTED_PROTOCOL_VERSION} ` +
        `but the server speaks v${serverVersion}. Update Luna Moon (or the server).`
      );
      // Persistent, hard-to-miss dot. Survives transcript wipes (snapshot/new-chat).
      this.updateStatus('version-warning', `Connected (protocol v${serverVersion} ≠ v${MOON_EXPECTED_PROTOCOL_VERSION})`);

      // Idempotent banner: skip if already shown this connection-run AND
      // it's still present in the transcript, so reconnect/hello replay
      // never stacks duplicates - but DOES reappear if the transcript was
      // wiped meanwhile (thread switch / new-chat), same as before.
      const bannerText =
        `⚠️ Version mismatch: this app expects protocol v${MOON_EXPECTED_PROTOCOL_VERSION} ` +
        `but the server speaks v${serverVersion}. Update Luna Moon (or the server). ` +
        `Some features may not work.`;
      const stillShown = ChatState.turns.some((t) =>
        t.status === 'banner' && t.segments.some((s) => s.kind === 'text' && s.raw === bannerText)
      );
      if (State.protocolNoticeShown && stillShown) {
        return;
      }
      State.protocolNoticeShown = true;
      ChatEngine.appendMessage('assistant', bannerText);
    },

    /**
     * Build identity (additive). The server's hello frame MAY carry a
     * `buildSha` (git short-SHA of the running build). When present, show it
     * as small dim text next to the connection dot; when absent (older
     * server, or a server with no git context), keep the element hidden so
     * nothing changes for older servers. Degrades gracefully.
     */
    applyBuildSha(frame) {
      const el = DOM.buildSha;
      if (!el) return;
      const sha = frame && typeof frame.buildSha === 'string' ? frame.buildSha.trim() : '';
      if (sha) {
        el.textContent = `build ${sha}`;
        el.title = `Server build: ${sha}`;
        el.hidden = false;
      } else {
        el.textContent = '';
        el.removeAttribute('title');
        el.hidden = true;
      }
    },

    /**
     * Populate the settings model switcher from the hello frame's
     * `availableModels` (additive — absent on older servers, leaving just
     * the "Server default" option). The persisted pick (luna_model) is
     * restored even when the server's list no longer carries it: silently
     * dropping it would switch the operator's model without consent, so an
     * off-list pick is kept as a "(custom)" option instead. Reconnects
     * re-deliver hello; the rebuild is idempotent.
     */
    applyAvailableModels(frame) {
      const raw = frame && Array.isArray(frame.availableModels) ? frame.availableModels : [];
      // Normalize: each entry may be a full object {id, label, efforts} (new
      // servers) or a plain id string (should not happen, but defensive).
      const models = raw
        .filter((m) => m && (typeof m === 'object' ? typeof m.id === 'string' && m.id : false))
        .map((m) => ({
          id: m.id,
          label: typeof m.label === 'string' && m.label ? m.label : m.id,
          efforts: Array.isArray(m.efforts) ? m.efforts : [],
        }));
      // Cache the FULL object list (id + label + efforts) for the
      // settings.connection PANEL (its window has no hello of its own at open
      // time; it reads this on render). Back-compat: old panel code that
      // expects a plain id string array will receive objects — the panel is
      // updated to handle both shapes (see settings-connection.js).
      // Written before the DOM guard so the cache works even after the modal.
      try {
        localStorage.setItem('luna_available_models', JSON.stringify(models));
      } catch (_) { /* quota/serialization — cosmetic cache only */ }
      // Update the settings hub model select if present (hub pages only;
      // absent in the chat window — DOM.modelSelect is undefined here).
      const el = DOM.modelSelect;
      if (el) {
        const saved = localStorage.getItem('luna_model') || '';
        el.innerHTML = '';
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = 'Server default';
        el.appendChild(defOpt);
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label;
          el.appendChild(opt);
        }
        if (saved && !Array.from(el.options).some((o) => o.value === saved)) {
          const opt = document.createElement('option');
          opt.value = saved;
          opt.textContent = `${saved} (custom)`;
          el.appendChild(opt);
        }
        el.value = saved;
      }
      // Refresh the composer config cluster with the new model list.
      ComposerConfig.applyModels(models);
    },

    /**
     * The ONE place a new-thread frame is built: carries the operator's
     * persisted model pick (settings switcher), optional sticky account pin
     * (`luna_account`), and, when the server supports effort selection, the
     * persisted effort pick — IF that effort is valid for the chosen model.
     * Old servers ignore unknown fields (additive).
     *
     * Account: null/empty = Auto (omit accountId so the broker keeps
     * same-kind failover). A set id pins the thread (sticky — disables
     * failover for that thread by design).
     */
    sendNewThread(agent) {
      if (!ThreadCreateState.begin()) return;
      this.send(buildNewThreadFrame(agent));
    },

    clearTurnTimeout() {
      if (State.turnTimeout) {
        clearTimeout(State.turnTimeout);
        State.turnTimeout = null;
      }
    },

    startTurnTimeout() {
      this.clearTurnTimeout();
      State.turnTimeout = setTimeout(() => {
        State.turnTimeout = null;
        // Self-suppress unless the pending-assistant placeholder is still
        // active. activeTurnId is set on the FIRST assistant-delta — a server
        // that hangs without ever streaming a token (the exact case this
        // watchdog exists to catch) still has activeTurnId === null but DOES
        // have a pending-assistant turn in ChatState. Once the placeholder
        // has been claimed by a real turn (assistant-delta arrived) we leave
        // any in-flight rendering alone.
        // REACHING HERE MEANS 90s OF TOTAL SILENCE. Every sign of progress -
        // delta, tool-call, tool-result, done - re-arms this timer, so there is
        // no longer a case where the turn is alive but the placeholder is gone.
        // That means the old self-suppression is not just unnecessary, it was
        // harmful: it let the watchdog clear busy and then say nothing, leaving
        // an idle face mid-turn with no explanation and no way back (the only
        // setBusy(true) in the app is at send). Clear and explain together.
        MoonFace.setBusy(false);
        State.activeTurnId = null;
        if (ChatState._findPending()) ChatState.dropPendingAssistant();
        ChatState.appendBanner('⚠️ No response from the server — try again.');
        ChatLoop.flush();
      }, 90000);
    },

    // Engine-aware connectivity predicate. Callers outside the engines MUST
    // gate on this (never on State.ws directly): under the PoolEngine dark
    // flag State.ws is never assigned, so a raw readyState check would
    // always read "offline" while the pool adapter is connected.
    isConnected() {
      return !!(State.ws && State.ws.readyState === WebSocket.OPEN);
    },

    clearSubscribeTimeout() {
      if (State.subscribeTimeout) {
        clearTimeout(State.subscribeTimeout);
        State.subscribeTimeout = null;
      }
    },

    // Armed after a (re)subscribe; if no thread-snapshot lands within the
    // window the reattach has STALLED (socket may be fine but we never got our
    // thread back — the silent failure the "+"-as-reconnect used to paper over).
    // gen-gated like the other watchdogs so a superseded socket's timer is inert.
    startSubscribeTimeout() {
      this.clearSubscribeTimeout();
      const myGen = State.connGen;
      State.subscribeTimeout = setTimeout(() => {
        State.subscribeTimeout = null;
        if (myGen !== State.connGen) return;                              // superseded connect
        if (!State.ws || State.ws.readyState !== WebSocket.OPEN) return;  // socket already down → close owns it
        Logger.warn('Subscribe timed out — no thread-snapshot; reattach stalled');
        this.onReattachStalled();
      }, 7000);
    },

    // Reattach stalled: the socket is OPEN but the thread we subscribed to
    // never produced a thread-snapshot within the watchdog window. This can
    // mean (a) the stored id is unknown to this server (pruned/reset/wrong
    // server), or (b) the thread was listed but is a "tombstone" — the server
    // returns it in list-threads but never emits a snapshot for it.
    //
    // Hardened self-heal (up to MAX_REATTACH_ROUNDS per connect):
    //   Round 1+: re-list threads. If the thread we just stalled on appears
    //             again at the top, it's a tombstone — advance to the next
    //             most-recent instead. If the list is empty or the server
    //             doesn't reply, we've exhausted our options.
    //   After MAX_REATTACH_ROUNDS: surface "Reattach stalled".
    //   PINNED_THREAD panels are exempt — they're bound to ONE thread and
    //   must never silently jump to another.
    onReattachStalled() {
      if (State.pinnedThread || PINNED_THREAD) {
        Logger.warn('Reattach stalled — pinned thread panel; not recovering');
        this.updateStatus('disconnected', 'Reattach stalled');
        return;
      }
      State.reattachRound++;
      if (State.reattachRound > MAX_REATTACH_ROUNDS) {
        Logger.warn(`Reattach stalled — budget exhausted after ${MAX_REATTACH_ROUNDS} rounds; surfacing stalled status`);
        this.updateStatus('disconnected', 'Reattach stalled');
        return;
      }
      // Record which thread just stalled so the thread-list handler can
      // detect tombstones. stalledIdSet accumulates ALL stalled ids this
      // connect; stalledThreadId is kept for single-round compat.
      if (State.activeThreadId) {
        State.stalledIdSet.add(State.activeThreadId);
        State.stalledThreadId = State.activeThreadId;
      }
      State.activeThreadId = null;          // unset so thread-list drives the next subscribe
      State.threadListAutoSelectPending = true;
      Logger.warn(`Reattach stalled (round ${State.reattachRound}/${MAX_REATTACH_ROUNDS}) — recovering via list-threads`);
      this.updateStatus('connecting', 'Recovering…');
      this.send(buildListThreadsFrame(State));
      this.startSubscribeTimeout();          // bound the recovery subscribe with the same watchdog
    },

    // Back on our thread (thread-snapshot landed): clear recovery state and
    // report connected. The window grow/retract choreography this drove in
    // the hub does not exist here.
    onReattached() {
      State.reattachRound = 0;           // success refreshes the self-heal budget
      State.stalledThreadId = null;
      State.stalledIdSet = new Set();    // clear multi-tombstone accumulator on success
      this.updateStatus('connected', 'Connected');
    },

    scheduleReconnect() {
      const delay = Math.min(1000 * Math.pow(2, State.reconnectAttempts), 16000);
      State.reconnectAttempts++;
      Logger.info(`Scheduling reconnect attempt #${State.reconnectAttempts} in ${delay}ms`);
      if (State.reconnectTimer) clearTimeout(State.reconnectTimer);
      State.reconnectTimer = setTimeout(() => {
        State.reconnectTimer = null;
        if (!State.ws || State.ws.readyState === WebSocket.CLOSED) {
          this.connect();
        }
      }, delay);
    },

    async syncThread() {
      // Phase 8 — DIRECT LINE: a ?thread=<id> URL param pins this window to
      // ONE thread for its whole life: always subscribe to it, never read
      // or write the last-thread file (that memory belongs to the MAIN
      // line), never list/auto-create.
      const pinnedId = State.pinnedThread || PINNED_THREAD;
      if (pinnedId) {
        State.activeThreadId = pinnedId;
        Logger.info(`Direct line: subscribing to pinned thread "${pinnedId}"`);
        this.send({ type: 'subscribe', threadId: pinnedId });
        this.startSubscribeTimeout();
        return;
      }
      if (State.pendingFreshThread) {
        State.pendingFreshThread = false;
        // Only mint while no thread was picked since: a row click after the
        // deferred "+ New" sets activeThreadId (newer intent wins) and the
        // fast-path resubscribe below takes over.
        if (!State.activeThreadId) {
          Logger.info('Pending new-conversation request: minting a fresh thread');
          this.sendNewThread();
          return;
        }
      }
      // Fresh-spawn panel (spawned via open_widget as ?thread=new): on the
      // FIRST connect it owns no thread yet, so mint a brand-new one — the
      // thread-created handler then adopts it (activeThreadId is null). On a
      // later RECONNECT activeThreadId is already set, so this is skipped and
      // we fall through to the normal resubscribe-to-current path below.
      if (SPAWN_FRESH && !State.activeThreadId) {
        Logger.info('Fresh-spawn panel: minting its own new thread');
        this.sendNewThread();
        return;
      }
      // The last-thread file (~/.luna/.last-thread-default) is NOT scoped per
      // server. After switching servers its thread belongs to the old server's
      // DB ("unknown thread" here), so skip it once and list fresh instead.
      const skipFile = State.skipLastThreadFile;
      State.skipLastThreadFile = false;

      // ── Fast path: in-memory thread (mid-session reconnect) ─────────────
      // State.activeThreadId was valid moments ago — re-subscribe directly
      // without a list round-trip. Only trust it when skipFile is false
      // (skipFile=true means the server changed, so the in-memory id belongs
      // to the OLD server and must be discarded).
      if (!skipFile && State.activeThreadId) {
        Logger.info(`Syncing (fast path): re-subscribing to in-memory thread "${State.activeThreadId}"`);
        this.send({ type: 'subscribe', threadId: State.activeThreadId });
        // Bug #56: a resubscribe never lists. The drawer's ONLY data source
        // is the thread-list frame (applyList), and this fast path returns
        // without ever requesting one — so a drawer that's open at boot
        // (persisted pref) or stays open across a reconnect renders
        // "No threads yet." forever even though threads exist. Nudge it
        // here; requestList() is itself a no-op when the drawer is closed.
        if (State.threadDrawerOpen) ThreadDrawerEngine.requestList();
        this.startSubscribeTimeout();
        return;
      }

      // ── Cold-start / server-switch path ──────────────────────────────────
      // Resolution order (Phase-2 last-thread):
      //   1. Per-panel/per-route slot in moon-session.json via
      //      MoonSession.resolveBootThread(winLabel) — scoped to this window
      //      and its server, so a server-switch never returns a stale id.
      //   2. Legacy global file (~/.luna/.last-thread-default) via
      //      get_last_thread_id — fallback when no route/panel context is
      //      known (current main-line live state).  The Rust side
      //      (get_panel_last_thread) transparently adopts the legacy file on
      //      first call so path 1 wins on the second cold-start automatically.
      let fileThreadId = null;
      if (!skipFile) {
        // Path 1: per-panel/per-route (Phase-2).
        // winLabel is the Tauri window label (e.g. "panel-chat") and is set
        // at boot near line 8684 — it's non-null inside Tauri.
        if (typeof MoonSession !== 'undefined' && winLabel) {
          try {
            fileThreadId = await MoonSession.resolveBootThread(winLabel);
            if (fileThreadId) {
              Logger.info(`Per-route last-thread (${winLabel}): ${fileThreadId}`);
            }
          } catch (e) {
            Logger.warn('MoonSession.resolveBootThread failed, falling back to legacy:', e && e.message || e);
          }
        }
        // Path 2: legacy global file (fallback when no route/panel context).
        if (!fileThreadId && window.__TAURI__) {
          try {
            fileThreadId = await window.__TAURI__.core.invoke('get_last_thread_id');
            Logger.info(`Legacy get_last_thread_id returned: ${fileThreadId}`);
          } catch (e) {
            Logger.error("Failed to invoke get_last_thread_id via Tauri:", e);
          }
        }
      }

      if (fileThreadId) {
        // BLIND SUBSCRIBE: subscribe directly to the stored id. The server
        // can snapshot any thread by id regardless of recency, so a valid-
        // but-old thread (beyond a capped list window) resumes correctly.
        // If the id is truly gone the subscribe watchdog fires and
        // onReattachStalled recovers via list-threads → most-recent / fresh.
        State.activeThreadId = fileThreadId;
        Logger.info(`Syncing (direct): subscribing to stored id "${fileThreadId}"`);
        this.send({ type: 'subscribe', threadId: fileThreadId });
        // Bug #56: same gap as the fast path above — a direct/blind
        // subscribe never lists, so a drawer that's already open (typical
        // cold app boot with a persisted open pref) stays empty forever.
        if (State.threadDrawerOpen) ThreadDrawerEngine.requestList();
      } else {
        // No known thread → list threads (subscribes to most-recent or mints fresh).
        Logger.info("No known thread; listing threads instead");
        State.threadListAutoSelectPending = true;
        this.send(buildListThreadsFrame(State));
      }
      this.startSubscribeTimeout();
    },

    handleFrame(frame) {
      Logger.info(`Received frame type: "${frame.type}"`, frame);
      // Dispatch via the vendor frame registry. Unknown frame types are
      // ignored — exactly the old switch's missing-default behavior.
      MoonFrames.dispatch(frame);
    }
  }

  const PoolEngine = {
    // ── Internal state ──────────────────────────────────────────────────
    _gen: null,           // PoolEngineHelper.createGenCounter() — lazily created
    _adapter: null,       // LunaWsAdapter instance (acquired from ConnectionManager)
    _handle: null,        // ConnectionManager RouteHandle (for release)
    _routeKey: null,      // route key this engine is bound to
    _routeLabel: null,    // route LABEL this engine is bound to (Step 2 indicator - never the key)
    _routeEndpointDisplay: null, // Step 3: LunaProtocol.describeWsUrl(endpoint), captured
                                  // ONCE at the same point as _routeLabel below - the view-mode
                                  // seam's endpointDisplay field reads THIS, never a raw URL.
    _dispatch: null,      // gated dispatch fn for this routeKey
    _unsubFrames: null,   // unsubscribe fn from adapter.subscribeFrames
    _unsubConn: null,     // unsubscribe fn from adapter.subscribeConnection
    _isConnected: false,  // true once adapter reaches 'ready'
    // STRUCTURAL FIX (plan Step 4 review, chat-only blocker): the last
    // `connected` value _paintRouteIndicator actually PAINTED - mutated
    // ONLY inside that function, never anywhere else. _repaintRouteIndicator
    // (below, in the ViewMode block) reads THIS instead of _isConnected, so
    // a toggle can never disagree with what the chip is already showing,
    // no matter what future staleness _isConnected develops (the root fix
    // above closes the ONE known cause; this closes the whole class).
    _lastPaintedConnected: false,
    _closeHooks: [],      // mirrors WebSocketEngine._closeHooks seam
    _hooksArmed: false,   // true after first 'ready'; cleared by _fireDisconnect

    registerCloseHook(fn) { this._closeHooks.push(fn); },

    isConnected() { return this._isConnected; },

    // connect() — acquire a LunaWsAdapter via ConnectionManager for the
    // resolved route and wire up frame + connection subscriptions.
    // Mirrors WebSocketEngine.connect() gen-bumping, watchdog resets, etc.
    async connect() {
      // (1) Bump generation — supersedes any prior adapter callbacks
      if (!this._gen) this._gen = PoolEngineHelper.createGenCounter();
      const myGen = this._gen.bump();

      this.clearSubscribeTimeout();
      this.clearTurnTimeout();
      // F5 (opus review): a pending top-level retry (_scheduleRetry, from a
      // PRIOR failed attempt - e.g. an earlier "not-paired:" refusal) must not
      // survive into this fresh connect(). loadConnectionAndConnect() calls
      // connect() directly, never disconnect() first, so without this clear a
      // user who just paired the route in Settings (hub_event('profile-changed')
      // -> loadConnectionAndConnect() -> connect() establishes the connection)
      // can have the STALE timer fire moments later, calling connect() a
      // second time and tearing down the connection their pairing just built.
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      // (4) Fresh connect resets the bounded stall self-heal budget (mirrors
      // WebSocketEngine.connect — refresh reattachRound + the tombstone set so
      // a reconnect gets a full recovery budget, not a stale one).
      State.reattachRound = 0;
      State.pendingReattachId = null;
      State.stalledIdSet = new Set();
      State.threadListAutoSelectPending = false;

      // `?.` for the same boot-order reason as updateStatus below: a first
      // connect() can precede the module, and `_busy` already defaults to false.
      MoonFace?.setBusy(false);
      this.updateStatus('connecting', 'Connecting…');
      // Arm close hooks HERE, at the start of the attempt, not on 'ready'.
      // The shipped hook wipes a typed-but-unsent secret, and a secret typed
      // while a connection was still coming up is exactly as sensitive as one
      // typed against a live socket. WebSocketEngine fires its hooks from the
      // raw close handler with no arming condition at all, so a connection
      // that never established still wipes there; arming at attempt start is
      // how this engine matches that conservative behavior while keeping the
      // exactly-once-per-attempt guard that stops recovering→down sequences
      // double-firing (stack23 S18b).
      this._hooksArmed = true;

      // Resolve the route via MoonSession (C2) → build a ConnectionManager
      // route entry from State.wsUrl / State.wsToken as fallback.
      // routeLabel (Step 2, plan's route indicator): captured ONLY when a
      // real client.toml route resolved - stays undefined on the fallback
      // paths below, which fabricate routeKey = 'legacy' with no real route
      // model behind it. The indicator renders THIS, never routeKey - a
      // synthesized key is not a label, and rendering it would violate the
      // plan's "never render a raw routeKey" constraint the moment a window
      // fell back to the legacy path.
      let routeKey, routeLabel, endpoints, tokenRef, tokenResolveError;
      try {
        // Prefer the C2 route system when available — bounded so a hung
        // list_routes/load_route invoke cannot strand dial forever.
        const bootRoute = await Promise.race([
          MoonSession.resolveBootRoute(null),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`boot-timeout: resolveBootRoute exceeded ${BOOT_INVOKE_MS}ms`)),
              BOOT_INVOKE_MS,
            ),
          ),
        ]);
        if (bootRoute && Array.isArray(bootRoute.endpoints) && bootRoute.endpoints.length > 0) {
          routeKey = bootRoute.key || bootRoute.routeKey || 'default';
          routeLabel = bootRoute.label || null;
          endpoints = bootRoute.endpoints;

          // Step 1b (docs/next/routes-and-view-mode-plan.md): token
          // resolution is keyed by the route being connected, in ONE place
          // (connection.rs's resolve_route_token) - retiring the 1b0
          // stand-in that substituted State.wsToken for the "legacy"
          // sentinel. That stand-in only worked because connect() always
          // resolves with panelId=null (the default route), the same key
          // State.wsToken happened to already be resolved for; a real
          // per-panel route would have silently used the WRONG profile's
          // token. resolve_route_token resolves EXACTLY this route's token,
          // whichever route that is - and returns a Result, so an
          // unresolved sentinel is a real Err, not a client-side guess.
          try {
            const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
            if (invoke) {
              tokenRef = await invokeWithTimeout(invoke, 'resolve_route_token', { routeKey });
            } else if (isUsableBearerToken(State.wsToken) || State.wsToken === '') {
              tokenRef = State.wsToken;
            } else {
              tokenResolveError = 'not-paired: no Tauri invoke for resolve_route_token';
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Only a hung invoke (boot-timeout) falls back to an already-resolved
            // State.wsToken so dial is not stranded forever. store-read: and
            // durable taxonomy errors keep the existing #529 refuse/retry path.
            if (
              msg.startsWith('boot-timeout:')
              && (isUsableBearerToken(State.wsToken) || State.wsToken === '')
            ) {
              Logger.warn('[PoolEngine] resolve_route_token timed out; using State.wsToken:', msg);
              tokenRef = State.wsToken;
            } else {
              tokenResolveError = msg;
            }
          }
        } else {
          // Fallback: synthesize a route from the legacy State.wsUrl/wsToken
          routeKey = 'legacy';
          endpoints = [State.wsUrl];
          tokenRef = State.wsToken;
        }
      } catch (e) {
        Logger.warn('[PoolEngine] resolveBootRoute failed, using legacy URL:', e);
        routeKey = 'legacy';
        endpoints = [State.wsUrl];
        tokenRef = State.wsToken;
      }

      // (1) Gen gate: if we were superseded while awaiting route resolution, bail
      if (!this._gen.gate(myGen)) {
        Logger.info('[PoolEngine] connect() superseded during route resolution — bailing');
        return;
      }

      // resolve_route_token rejected: refuse to dial rather than ship broken
      // auth (#528), and refuse HONESTLY, not by leaving a stale adapter
      // attached. send() below gates only on `this._adapter &&
      // this._isConnected`; if either were left set from a prior successful
      // connect, a message typed here would still go out over that OLD
      // adapter while every reply came back on the OLD gen - which the
      // frame-dispatch gate (myGen, bumped above) now rejects. That is a
      // zombie half-connection: messages vanish, the turn hangs at
      // "thinking" forever, and the status pill claims disconnected. Tearing
      // the adapter down and reporting disconnected is the only state that
      // is not a lie about what just happened.
      if (tokenResolveError) {
        // #529: the error taxonomy's prefix decides whether a retry can
        // help. "store-read:" means client.toml or moon-connection.json
        // could not be read THIS attempt (transient I/O, or a concurrent
        // pairing flow mid-write) - a fresh read on the NEXT connect() can
        // succeed, so schedule the existing top-level backoff instead of a
        // terminal refusal. Every other cause (route-missing, not-paired,
        // unresolvable-scheme, route-config-invalid) is a durable problem a
        // bare retry cannot fix - the user (or Settings) has to act first.
        const retryable = tokenResolveError.startsWith('store-read:');
        const notPaired = tokenResolveError.startsWith('not-paired:');
        Logger.error(
          '[PoolEngine] route token resolution failed; refusing to dial - '
            + (retryable ? 'will retry' : 'pair this route in Settings'),
        );
        this._teardownAdapter();
        this._isConnected = false;
        // Step 2: this ATTEMPT failed before this._routeLabel/_paintRouteIndicator's
        // usual assignment point below ever ran - repaint with the OLD label
        // (whatever this window's socket actually held before this attempt,
        // possibly none) so a re-resolution failure never blanks the
        // indicator or invents the never-reached NEW route's label.
        this._paintRouteIndicator(this._routeLabel, false);
        this._fireDisconnect('route-unresolved');
        this._updateObservability();
        if (retryable) {
          this.updateStatus('connecting', 'Reconnecting…');
          this._scheduleRetry();
        } else {
          State.reconnectAttempts = 0;
          this.updateStatus('disconnected', notPaired ? 'Route not paired' : 'Route unavailable');
        }
        return;
      }

      // F2 (opus review): defense in depth for the FALLBACK branches above
      // (bootRoute null - either no client.toml at all, or resolveBootRoute
      // itself failed). Those branches take tokenRef straight from
      // State.wsToken with NO resolver in between - the Rust resolver above
      // can never return a sentinel or scheme ref, but connection.rs's
      // load_connection_in (which populates State.wsToken, in
      // loadConnectionAndConnect, BEFORE connect() runs) returns its own
      // tokenRef VERBATIM when ITS resolution fails, so State.wsToken can
      // legitimately BE the raw "legacy" sentinel or an unresolved
      // env:/file:/op:// ref here. This is the same #528 bug class reached
      // through a different door - a value-based guard, not a route-based
      // one, since this path never went through the resolver at all.
      const isSentinel = tokenRef === 'legacy';
      const isSchemeRef = typeof tokenRef === 'string'
        && (tokenRef.startsWith('env:') || tokenRef.startsWith('file:') || tokenRef.startsWith('op://'));
      if (isSentinel || isSchemeRef) {
        Logger.error(
          '[PoolEngine] fallback route token is unresolved ('
            + (isSentinel ? 'sentinel' : 'scheme ref')
            + '); refusing to dial - pair this route in Settings',
        );
        this._teardownAdapter();
        this._isConnected = false;
        // Step 2: same reasoning as the tokenResolveError branch above.
        this._paintRouteIndicator(this._routeLabel, false);
        this._fireDisconnect('route-unresolved');
        this._updateObservability();
        State.reconnectAttempts = 0;
        this.updateStatus('disconnected', isSentinel ? 'Route not paired' : 'Route unavailable');
        return;
      }

      // Tear down any prior adapter before replacing it
      this._teardownAdapter();

      this._routeKey = routeKey;
      this._routeLabel = routeLabel || null;
      // Step 3 (plan's view-mode seam): redact the endpoint HERE, at capture
      // time, from the raw `endpoints[0]` this attempt is about to dial -
      // never later, and never from a raw URL held anywhere else. This is
      // what makes the seam's endpointDisplay field structurally incapable
      // of leaking a token-bearing URL: nothing downstream of this line ever
      // sees the raw value again, only this already-redacted string.
      this._routeEndpointDisplay = (endpoints && endpoints[0])
        ? (typeof LunaProtocol !== 'undefined' && LunaProtocol && typeof LunaProtocol.describeWsUrl === 'function'
            ? LunaProtocol.describeWsUrl(endpoints[0])
            : String(endpoints[0]).split('?')[0])
        : null;
      // ROOT FIX (plan Step 4 review, chat-only blocker): _teardownAdapter()
      // above does not touch _isConnected (the staleness flagged since Step
      // 1b) - without this line, _isConnected still held the PREVIOUS
      // route's `true` all the way from here until acquire() resolves or
      // fails below. Any reader consulting _isConnected during that window
      // (not just the repaint helper further down this file) would see a
      // live connection that no longer exists. Setting it here, at the
      // exact point the new route's identity is claimed, retires that for
      // every reader, not only the one this review found.
      this._isConnected = false;
      // Step 2 (plan's route indicator): paint the NEW route's label with a
      // disconnected mark BEFORE dialing - this is the point that satisfies
      // "switching to a route whose endpoint never accepts a connection...
      // reads exactly [the new label] before any connection has succeeded":
      // we are past route resolution and the refusal guards above, but the
      // adapter has not been acquired yet (that happens below).
      this._paintRouteIndicator(this._routeLabel, false);
      // Build a gated dispatch function for this routeKey (C9-partial)
      this._dispatch = PoolEngineHelper.makeGatedDispatch(routeKey, (tagged) => {
        // Strip the __routeKey tag before handing to MoonFrames so
        // existing handlers never see an unexpected field
        const clean = Object.assign({}, tagged);
        delete clean.__routeKey;
        Logger.info(`[PoolEngine] Received frame type: "${clean.type}"`, clean);
        // Observability: track last frame type for agent-browser inspection
        if (window.__poolEngineState) {
          window.__poolEngineState.lastFrameType = clean.type;
        }
        MoonFrames.dispatch(clean);
      });

      // Acquire an adapter from ConnectionManager
      const LT = window.LunaTransport;
      if (!LT || !LT.ConnectionManager || !LT.selectAdapter) {
        Logger.error('[PoolEngine] window.LunaTransport not available — falling back');
        this.updateStatus('disconnected', 'Transport unavailable');
        return;
      }

      // Build a single-route ConnectionManager for this window's route.
      //
      // No TokenResolver is injected here, and none is needed: by this point
      // `tokenRef` is ALREADY the fully-resolved bearer (a literal token, or
      // "" for tokenRef "none") - connection.rs's resolve_route_token (Step
      // 1b, docs/next/routes-and-view-mode-plan.md) did the resolving above,
      // in the ONE place it happens, and returned an Err (handled above,
      // before this line is ever reached) for anything it could not resolve
      // - including the "legacy" sentinel (#528) and env:/file:/op:// scheme
      // refs, which Phase 3 will resolve server-side rather than client-side.
      // What remains for Phase 3 is NOT this seam: it's giving the Rust side
      // the ability to resolve scheme refs at all (today they hit
      // "unresolvable-scheme:" unconditionally) and, if a client-side
      // resolver ever becomes the right shape for that, wiring an adapter-
      // level TokenResolver here. Until then this seam stays unused on
      // purpose - injecting LT.unconfiguredBrowserTokenResolver would throw
      // on the already-resolved literal tokenRef this code now always hands
      // the adapter, breaking every live connection for no benefit.
      const routeMap = new Map([[routeKey, { routeKey, endpoints, tokenRef }]]);
      // Custom adapter factory rather than the bare LT.selectAdapter, which
      // hardcodes reconnectOpts to undefined and so would leave the adapter
      // on its own defaults (base 500ms, cap 15s) (stack23 S18b delta 1).
      //
      // Moon's connection contract is base 1000ms doubling to a 16s cap -
      // the ladder ws-contract.test.ts pins as
      // [1000,2000,4000,8000,16000,16000]. Matching it here is what lets the
      // pooled engine satisfy that contract instead of forcing the pin down
      // to a range.
      //
      // JITTER IS DELIBERATELY LEFT ON (adapter default, 200ms). It is what
      // stops every client reconnecting in lockstep after a server restart,
      // and WebSocketEngine's un-jittered ladder is the WEAKER behavior here,
      // not the target. So the observable schedule is the exact ladder plus a
      // bounded 0-200ms spread, which the contract asserts as an envelope.
      // `reconnectOpts.jitterMs` exists for tests that need determinism.
      //
      // maxAttempts stays on the adapter default (6): after those the adapter
      // publishes 'down' and PoolEngine's own _scheduleRetry takes over, so
      // retry is unbounded overall through that two-layer handoff.
      const manager = new LT.ConnectionManager(routeMap, (route) =>
        new LT.LunaWsAdapter(route, undefined, undefined, {
          baseMs: 1000,
          maxMs: 16000,
        }));

      try {
        this._handle = await manager.acquire(routeKey);
      } catch (e) {
        // (1) Gen gate check after async acquire
        if (!this._gen.gate(myGen)) return;
        Logger.error('[PoolEngine] acquire failed:', e);
        this.updateStatus('disconnected', 'Connection Error');
        // Close hooks MUST run on this path too (stack23 S18b). A socket can
        // open, take a typed secret, and drop before the handshake completes
        // — acquire() then rejects and the connection-state subscription was
        // never wired, so _onConnectionState can never fire for this attempt.
        // Without this call the secret-wipe policy would silently not run for
        // exactly the connections most likely to be flaky. WebSocketEngine has
        // no equivalent hole because it attaches its close listener to the
        // socket synchronously.
        this._fireDisconnect('acquire-failed');
        // (2) The adapter's internal backoff handles reconnect; but if acquire
        // itself threw (before the adapter was running), schedule a manual retry
        this._scheduleRetry();
        return;
      }

      // (1) Gen gate after acquire
      if (!this._gen.gate(myGen)) {
        // Superseded — release the handle we just acquired
        this._handle.release().catch(() => {});
        this._handle = null;
        return;
      }

      this._adapter = this._handle.adapter;

      // Wire frame subscription — every raw frame gets tagged + gated
      this._unsubFrames = this._adapter.subscribeFrames((rawFrame) => {
        // (1) Gen gate: ignore frames from superseded acquires
        if (!this._gen || !this._gen.gate(myGen)) return;
        if (this._dispatch) this._dispatch(rawFrame);
      });

      // Wire connection-state subscription
      this._unsubConn = this._adapter.subscribeConnection((connState) => {
        // (1) Gen gate
        if (!this._gen || !this._gen.gate(myGen)) return;
        this._onConnectionState(connState, myGen);
      });

      // The adapter already attached (acquire calls attach internally) →
      // we're 'ready'; fake the initial ready notification to trigger syncThread
      this._isConnected = true;
      this._hooksArmed = true;   // arm close hooks — we're now connected
      State.reconnectAttempts = 0;
      this.updateStatus('connected', 'Connected');
      // Step 2: a GENUINE connect success for THIS window's socket - the
      // only thing that may clear a latched failure (see _paintRouteIndicator).
      this._paintRouteIndicator(this._routeLabel, true);

      // (6) Trigger thread synchronization on connect (same as WebSocketEngine)
      this.syncThread();

      // Expose observability
      window.__activeEngine = 'pool';
      this._updateObservability();
    },

    // Handle connection-state changes from the adapter
    _onConnectionState(connState, myGen) {
      const mapped = PoolEngineHelper.mapAdapterConnState(connState);
      Logger.info(`[PoolEngine] adapter state → ${connState.status}`, connState);

      if (connState.status === 'ready') {
        this._isConnected = true;
        this._hooksArmed = true;   // re-arm close hooks on reconnect
        State.reconnectAttempts = 0;
        this.updateStatus('connected', 'Connected');
        // Step 2: genuine reconnect success - clears a latched failure.
        this._paintRouteIndicator(this._routeLabel, true);
        // (6) Snapshot-on-reconnect: re-sync the thread whenever the
        // adapter transitions back to 'ready' after a reconnect. NOTE: this
        // relies on subscribeConnection having NO state-replay and attach()
        // publishing 'connecting'/'ready' synchronously inside acquire()
        // (before PoolEngine subscribes), so the initial 'ready' reaches
        // zero subscribers and only genuine reconnect 'ready' events trigger
        // this branch. If C6a's adapter ever adds connection-state replay,
        // this becomes a double-subscribe-on-boot.
        this.syncThread();

      } else if (connState.status === 'recovering') {
        // (2) Adapter is auto-reconnecting (its own backoff handles timing).
        // Surface the UI status; we do NOT call scheduleReconnect ourselves
        // — that would double-reconnect. The adapter drives it.
        this._isConnected = false;
        this.clearSubscribeTimeout(); // socket gone → close path owns recovery
        this.clearTurnTimeout();      // fix-3 equivalent
        MoonFace.setBusy(false);
        this.updateStatus('connecting', 'Reconnecting…');
        // Step 2: the socket dropped - the indicator LATCHES to disconnected
        // (still naming the same route) until a genuine reconnect succeeds.
        this._paintRouteIndicator(this._routeLabel, false);
        this._fireDisconnect('recovering');

      } else if (connState.status === 'down') {
        // (2) Adapter gave up reconnecting (hit max attempts). Surface the
        // dead state; offer a manual retry by re-calling connect().
        this._isConnected = false;
        this.updateStatus('disconnected', mapped.text);
        this._paintRouteIndicator(this._routeLabel, false);
        this.clearSubscribeTimeout();
        this.clearTurnTimeout();
        MoonFace.setBusy(false);
        this._fireDisconnect('down');
        // (2) Schedule a top-level outer retry (this is an ADDITIONAL reconnect
        // loop layered on top of the adapter's own exhausted backoff, not the
        // same loop as WebSocketEngine.scheduleReconnect).
        this._scheduleRetry();

      } else if (connState.status === 'auth-failed') {
        this._isConnected = false;
        this.updateStatus('disconnected', 'Auth failed');
        this._paintRouteIndicator(this._routeLabel, false);
        this._fireDisconnect('auth-failed');

      } else {
        this.updateStatus(mapped.statusClass, mapped.text);
      }

      this._updateObservability();
    },

    // _fireDisconnect — run close hooks + clean up a stuck typing indicator.
    // Double-fire guard: _hooksArmed is set at CONNECT-ATTEMPT start (and
    // re-set on each 'ready'); cleared atomically here so recovering→down
    // sequences fire hooks exactly once per attempt.
    _fireDisconnect(reason) {
      if (!this._hooksArmed) return; // not connected since last disconnect — skip
      this._hooksArmed = false;
      ThreadCreateState.onDisconnect();
      for (const hook of this._closeHooks) {
        try { hook(); } catch (e) { Logger.warn('[PoolEngine] close hook failed:', e); }
      }
      if (State.activeTurnId) {
        State.activeTurnId = null;
        // State-driven equivalent of "the last rendered bubble is the
        // typing-dots placeholder" - drop the stale placeholder from
        // ChatState (not just the DOM node) so a still-pending assistant
        // turn doesn't get silently resurrected by the next render.
        if (ChatState.hasVisibleStreamingPlaceholder()) {
          ChatState.dropPendingAssistant();
          ChatEngine.appendMessage('assistant', '⚠️ Connection lost — try again.');
        }
      }
    },

    // (2) Schedule a top-level retry via a simple exponential backoff.
    // Used only when the adapter itself has given up (status 'down') or when
    // acquire() throws synchronously. The adapter's internal retries are
    // separate from this top-level reconnect cycle.
    _retryTimer: null,
    _scheduleRetry() {
      if (this._retryTimer) return; // already pending
      const delay = Math.min(1000 * Math.pow(2, State.reconnectAttempts), 16000);
      State.reconnectAttempts++;
      Logger.info(`[PoolEngine] Scheduling top-level retry #${State.reconnectAttempts} in ${delay}ms`);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this.connect();
      }, delay);
    },

    disconnect() {
      this.clearTurnTimeout();
      this.clearSubscribeTimeout();
      ThreadCreateState.onDisconnect();
      MoonFace.setBusy(false);
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this._teardownAdapter();
      this._isConnected = false;
      // F3 (opus review): a deliberate disconnect() tears the socket down
      // without going through _onConnectionState, so without this the chip
      // could stay green over a socket this engine itself just closed - the
      // route LABEL is unchanged (still this window's last route), only the
      // state flips.
      this._paintRouteIndicator(this._routeLabel, false);
      this._updateObservability();
    },

    _teardownAdapter() {
      if (this._unsubFrames) { this._unsubFrames(); this._unsubFrames = null; }
      if (this._unsubConn)   { this._unsubConn();   this._unsubConn = null; }
      if (this._handle) {
        this._handle.release().catch(() => {});
        this._handle = null;
      }
      this._adapter = null;
    },

    send(frame) {
      if (this._adapter && this._isConnected) {
        try {
          this._adapter.sendFrame(frame);
        } catch (e) {
          Logger.error('[PoolEngine] Failed to send frame:', e);
        }
      } else {
        Logger.warn('[PoolEngine] Attempted to send frame while not connected', frame);
      }
    },

    updateStatus(statusClass, text) {
      // Identical contract to WebSocketEngine.updateStatus (null-safe so a
      // missing pill never aborts dial before new WebSocket).
      if (DOM.connectionStatus) {
        DOM.connectionStatus.className = statusClass;
        DOM.connectionStatus.textContent = text;
      }
      // `?.` HERE ONLY, and it is not defensive noise. This is the one path
      // that can run BEFORE the deferred module publishes MoonFace/MoonBar:
      // loadConnectionAndConnect() is a classic-top-level call whose
      // synchronous prefix reaches connect() in a plain browser (the Tauri
      // branch awaits first, so it never does). Skipping the call is the
      // IDENTITY: both controllers default to _conn 'connecting' / _busy
      // false, and their init() paints exactly that default at construction.
      // Every other reader is inside a frame handler or event callback and
      // stays unguarded, so a genuinely-early read added later still throws
      // instead of silently no-opping.
      MoonFace?.setConnection(statusClass);
      MoonBar?.setConnection(statusClass);
    },

    // ── Route indicator (plan Step 2) ───────────────────────────────────
    //
    // F2 (opus review): implemented on PoolEngine ONLY. WebSocketEngine
    // (the legacy raw-socket engine, forced on with luna_pool_engine='0')
    // has no _paintRouteIndicator and never touches DOM.routeIndicator - the
    // chip stays permanently hidden under that flag. This is deliberate,
    // not a gap that slipped through: the flag is an escape hatch that
    // predates the route model entirely (it exists to bypass PoolEngine
    // wholesale, not to opt out of one feature of it), and it is not the
    // default or a shipped user-facing toggle. A permanently hidden chip
    // under the legacy engine is expected behavior, not a bug.
    //
    // SOURCE OF TRUTH: this window's OWN connection state, captured at
    // connect time - never the hub-event broadcast. This function is called
    // ONLY from the small set of deliberate call sites above that represent
    // a REAL transition of THIS window's own socket (route resolved and
    // about to dial, genuine open/hello success, genuine drop/down/
    // auth-failed) - it is DELIBERATELY NEVER wired into updateStatus's
    // general-purpose status-pill writes above. That is what makes the
    // latch requirement hold by construction rather than by policing every
    // updateStatus call site: an unrelated updateStatus('connected', ...)
    // write from anywhere else in this file cannot repaint the indicator,
    // because nothing routes it here.
    //
    // LATCH: `connected: false` always applies immediately (a failure must
    // always be visible - an indicator that vanishes on disconnect is worse
    // than none). `connected: true` is the ONLY thing that can move the
    // indicator OUT of a disconnected/failed state - so once a failure
    // paints, only a genuine reconnect of THIS socket (this function called
    // again with connected: true, from one of the real-success call sites
    // above) clears it.
    //
    // LABEL, NEVER KEY: `label` is the route's LABEL (bootRoute.label),
    // never routeKey - the fallback path fabricates routeKey = 'legacy'
    // with no real route model behind it, and rendering that key would be
    // exactly the raw-routeKey leak the plan's ground truth forbids. A null
    // label (no route model resolved) hides the chip entirely - "just the
    // connection state" per the plan, which the existing #connection-status
    // pill already carries; this chip adds nothing to show in that case.
    // VERBOSE FORM (plan Step 4): when ViewMode is enabled, the SAME writer
    // additionally renders the seam's endpointDisplay (already redacted -
    // never a raw URL, see ViewMode.seam()'s own doc comment) alongside the
    // label and the connected/disconnected word this call is ALREADY
    // painting via `connected` - never re-derived from anywhere else, so
    // verbose text and the className it sits beside can never disagree.
    // This is still the ONLY writer of DOM.routeIndicator; ViewMode's
    // toggle()/enable()/disable() (below) call THIS function again with the
    // CURRENT _routeLabel/_isConnected to force an immediate re-render on a
    // toggle or a redock-applied enable() - they never invent a new
    // connected value, so the latch (only a genuine reconnect may claim
    // `connected: true`) holds exactly as it did before this step: toggling
    // verbose mode changes how the current truth is DISPLAYED, never what
    // that truth IS.
    //
    // TEXT WRITES DOM.routeIndicatorText, NOT DOM.routeIndicator, ITSELF:
    // #route-indicator is display:flex (it inherits .chat-meta span's
    // flex+::before-dot layout), and text-overflow:ellipsis does not
    // reliably render on a flex container's own text in WebKit - confirmed
    // live via a real headless render during this step's screenshot gate
    // (the box clipped correctly at max-width but showed no "…" at all).
    // #route-indicator-text is a plain (non-flex) inline child the ellipsis
    // rule actually applies to; see chat.html's CSS comment on it.
    _paintRouteIndicator(label, connected) {
      // Set BEFORE the DOM-existence guard, mirroring panel.html's
      // currentConnected - "last painted" tracks the truth this call is
      // communicating, not whether a DOM write happened to succeed.
      this._lastPaintedConnected = connected;
      if (!DOM.routeIndicator) return;
      DOM.routeIndicator.hidden = !label;
      const textEl = DOM.routeIndicatorText || DOM.routeIndicator;
      if (label && ViewMode.isEnabled()) {
        const endpointDisplay = this._routeEndpointDisplay;
        const parts = [label];
        if (endpointDisplay) parts.push(endpointDisplay);
        parts.push(connected ? 'Connected' : 'Disconnected');
        textEl.textContent = parts.join(' - ');
      } else {
        textEl.textContent = label || '';
      }
      DOM.routeIndicator.className = connected ? 'connected' : 'disconnected';
    },

    // ── Turn watchdog (behavior 5) ─────────────────────────────────────
    // Identical to WebSocketEngine's implementation — 90s inactivity guard.
    clearTurnTimeout() {
      if (State.turnTimeout) {
        clearTimeout(State.turnTimeout);
        State.turnTimeout = null;
      }
    },

    startTurnTimeout() {
      this.clearTurnTimeout();
      State.turnTimeout = setTimeout(() => {
        State.turnTimeout = null;
        // Same contract as WebSocketEngine's watchdog: progress re-arms this
        // timer, so firing means real silence - clear busy AND say so.
        MoonFace.setBusy(false);
        State.activeTurnId = null;
        if (ChatState._findPending()) ChatState.dropPendingAssistant();
        ChatState.appendBanner('⚠️ No response from the server — try again.');
        ChatLoop.flush();
      }, 90000);
    },

    // ── Subscribe watchdog (behavior 3) ───────────────────────────────
    // Armed after (re)subscribe; fires onReattachStalled if no thread-snapshot
    // arrives within 7 s. Gen-gated like WebSocketEngine's version.
    clearSubscribeTimeout() {
      if (State.subscribeTimeout) {
        clearTimeout(State.subscribeTimeout);
        State.subscribeTimeout = null;
      }
    },

    startSubscribeTimeout() {
      this.clearSubscribeTimeout();
      const myGen = this._gen ? this._gen.current : 0;
      State.subscribeTimeout = setTimeout(() => {
        State.subscribeTimeout = null;
        if (!this._gen || !this._gen.gate(myGen)) return; // superseded
        if (!this._isConnected) return;                    // socket already down
        Logger.warn('[PoolEngine] Subscribe timed out — no thread-snapshot; reattach stalled');
        this.onReattachStalled();
      }, 7000);
    },

    // ── Reattach self-heal (behavior 4, #170) ─────────────────────────
    // Mirrors WebSocketEngine.onReattachStalled / onReattached exactly.
    onReattachStalled() {
      if (State.pinnedThread || PINNED_THREAD) {
        Logger.warn('[PoolEngine] Reattach stalled — pinned thread panel; not recovering');
        this.updateStatus('disconnected', 'Reattach stalled');
        return;
      }
      State.reattachRound++;
      if (State.reattachRound > MAX_REATTACH_ROUNDS) {
        Logger.warn(`[PoolEngine] Reattach stalled — budget exhausted after ${MAX_REATTACH_ROUNDS} rounds`);
        this.updateStatus('disconnected', 'Reattach stalled');
        return;
      }
      if (State.activeThreadId) {
        State.stalledIdSet.add(State.activeThreadId);
        State.stalledThreadId = State.activeThreadId;
      }
      State.activeThreadId = null;
      State.threadListAutoSelectPending = true;
      Logger.warn(`[PoolEngine] Reattach stalled (round ${State.reattachRound}/${MAX_REATTACH_ROUNDS}) — recovering via list-threads`);
      this.updateStatus('connecting', 'Recovering…');
      this.send(buildListThreadsFrame(State));
      this.startSubscribeTimeout();
    },

    onReattached() {
      State.reattachRound = 0;
      State.stalledThreadId = null;
      State.stalledIdSet = new Set();
      this.updateStatus('connected', 'Connected');
    },

    // ── Thread synchronization (behaviors 3, 6) ───────────────────────
    // Mirrors WebSocketEngine.syncThread exactly — same subscribe / list-threads
    // / new-thread logic, same subscribe watchdog arming.
    async syncThread() {
      const pinnedId = State.pinnedThread || PINNED_THREAD;
      if (pinnedId) {
        State.activeThreadId = pinnedId;
        Logger.info(`[PoolEngine] Direct line: subscribing to pinned thread "${pinnedId}"`);
        this.send({ type: 'subscribe', threadId: pinnedId });
        this.startSubscribeTimeout();
        return;
      }
      if (State.pendingFreshThread) {
        State.pendingFreshThread = false;
        if (!State.activeThreadId) {
          Logger.info('[PoolEngine] Pending new-conversation request: minting a fresh thread');
          this.sendNewThread();
          return;
        }
      }
      if (SPAWN_FRESH && !State.activeThreadId) {
        Logger.info('[PoolEngine] Fresh-spawn panel: minting its own new thread');
        this.sendNewThread();
        return;
      }
      const skipFile = State.skipLastThreadFile;
      State.skipLastThreadFile = false;

      // Fast path: in-memory thread (mid-session reconnect).
      if (!skipFile && State.activeThreadId) {
        Logger.info(`[PoolEngine] Syncing (fast path): re-subscribing to in-memory thread "${State.activeThreadId}"`);
        this.send({ type: 'subscribe', threadId: State.activeThreadId });
        // Bug #56 (mirrors WebSocketEngine.syncThread above): a resubscribe
        // never lists, so a drawer already open at boot/reconnect stays
        // empty forever without this nudge.
        if (State.threadDrawerOpen) ThreadDrawerEngine.requestList();
        this.startSubscribeTimeout();
        return;
      }

      // Cold-start: read per-panel/per-route last-thread (Phase-2) then fall
      // back to the legacy global file.  Blind-subscribe directly; the
      // subscribe watchdog + onReattachStalled handles a gone id.
      let fileThreadId = null;
      if (!skipFile) {
        // Path 1: per-panel/per-route slot (Phase-2).
        if (typeof MoonSession !== 'undefined' && winLabel) {
          try {
            fileThreadId = await MoonSession.resolveBootThread(winLabel);
            if (fileThreadId) {
              Logger.info(`[PoolEngine] Per-route last-thread (${winLabel}): ${fileThreadId}`);
            }
          } catch (e) {
            Logger.warn('[PoolEngine] resolveBootThread failed, falling back to legacy:', e && e.message || e);
          }
        }
        // Path 2: legacy global file fallback.
        if (!fileThreadId && window.__TAURI__) {
          try {
            fileThreadId = await window.__TAURI__.core.invoke('get_last_thread_id');
            Logger.info(`[PoolEngine] Legacy get_last_thread_id returned: ${fileThreadId}`);
          } catch (e) {
            Logger.error('[PoolEngine] Failed to invoke get_last_thread_id via Tauri:', e);
          }
        }
      }

      if (fileThreadId) {
        State.activeThreadId = fileThreadId;
        Logger.info(`[PoolEngine] Syncing (direct): subscribing to stored id "${fileThreadId}"`);
        this.send({ type: 'subscribe', threadId: fileThreadId });
        // Bug #56 (mirrors WebSocketEngine.syncThread above).
        if (State.threadDrawerOpen) ThreadDrawerEngine.requestList();
      } else {
        Logger.info('[PoolEngine] No known thread; listing threads instead');
        State.threadListAutoSelectPending = true;
        this.send(buildListThreadsFrame(State));
      }
      this.startSubscribeTimeout();
    },

    // ── Helpers mirroring WebSocketEngine seams ────────────────────────
    // Same shared builder as WebSocketEngine.sendNewThread (S4 dedup) —
    // the two copies used to drift-risk every added field.
    sendNewThread(agent) {
      if (!ThreadCreateState.begin()) return;
      this.send(buildNewThreadFrame(agent));
    },

    checkProtocolVersion(frame) { WebSocketEngine.checkProtocolVersion(frame); },
    applyBuildSha(frame)        { WebSocketEngine.applyBuildSha(frame); },
    applyAvailableModels(frame) { WebSocketEngine.applyAvailableModels(frame); },

    handleFrame(frame) {
      // Called from __MoonInternals.handleFrame in tests — route via gated dispatch
      if (this._dispatch) {
        this._dispatch(frame);
      } else {
        Logger.info(`[PoolEngine] Received frame type: "${frame.type}" (no dispatch)`, frame);
        MoonFrames.dispatch(frame);
      }
    },

    // Observability (hook exposed on window.__poolEngineState)
    _updateObservability() {
      if (typeof window === 'undefined') return;
      window.__activeEngine = 'pool';
      window.__poolEngineState = {
        connected: this._isConnected,
        routeKey: this._routeKey,
        lastFrameType: window.__poolEngineState && window.__poolEngineState.lastFrameType || null,
        gen: this._gen ? this._gen.current : 0,
      };
    },
  }

  // ── View mode (plan Step 3): per-window, ephemeral, in-memory only ─────
  //
  // NEVER persisted - no client.toml key, no moon-session.json key, no
  // localStorage key. localStorage is this codebase's habitual trap for
  // exactly this shape of flag (see the luna_model/luna_effort writes at
  // wire.ts:349,381,386,1157,1160 above): every Moon window shares one
  // `tauri://` origin, so a one-line localStorage.setItem would make this
  // global AND persistent, silently failing the per-window and
  // reopen-resets scenarios while passing every scenario that only names
  // the JSON stores. `_enabled` is a plain closure variable instead - reset
  // to false on every fresh createWire() call (one per window boot), which
  // is what makes "close and reopen -> off" true by construction rather
  // than by any explicit clear.
  //
  // Toggling never touches the socket - neither enable() nor disable() nor
  // toggle() calls PoolEngine.connect()/disconnect(), so "no reconnection
  // occurs" also holds by construction, not by omission.
  let _viewModeEnabled = false;

  // Step 4: every state change re-invokes PoolEngine._paintRouteIndicator
  // (the ONLY writer of DOM.routeIndicator) with the CURRENT
  // _routeLabel/_lastPaintedConnected - never a new value this function
  // invents - so a click-to-toggle or a redock-applied enable() re-renders
  // the ALREADY-painted chip immediately, without becoming a second writer
  // and without ever moving the latch itself (see _paintRouteIndicator's
  // own doc comment for why passing through the current painted state
  // cannot fake a reconnect).
  //
  // READS _lastPaintedConnected, NOT _isConnected (review finding, chat-only
  // blocker): _isConnected can be STALE during the pre-dial window -
  // _teardownAdapter() does not reset it, so from the moment a new route's
  // identity is claimed until acquire() resolves or fails, it still holds
  // the PREVIOUS route's true. Toggling verbose (or a redock's enable())
  // during exactly that window - scenario 5's hung-switch case - would
  // repaint (newLabel, stale true): "Connected" over a route this window's
  // socket was never actually on. _lastPaintedConnected cannot go stale the
  // same way: it is set INSIDE _paintRouteIndicator itself, at the same
  // instant as every real paint, so it is structurally never behind what
  // the chip is currently showing - independent of whatever _isConnected
  // is doing.
  function _repaintRouteIndicator() {
    PoolEngine._paintRouteIndicator(PoolEngine._routeLabel, PoolEngine._lastPaintedConnected);
  }

  const ViewMode = {
    isEnabled() { return _viewModeEnabled; },
    enable() { _viewModeEnabled = true; _repaintRouteIndicator(); },
    disable() { _viewModeEnabled = false; _repaintRouteIndicator(); },
    toggle() { _viewModeEnabled = !_viewModeEnabled; _repaintRouteIndicator(); return _viewModeEnabled; },

    // THE SEAM (plan Step 3): the ONLY surface a display consumer (Step 4's
    // verbose indicator form) may read route/connection state through.
    // Every field here is either a plain boolean/string with no credential
    // shape (`enabled`, `connectionState`) or a value ALREADY redacted at
    // capture time inside PoolEngine.connect() (`endpointDisplay`, via
    // LunaProtocol.describeWsUrl - see the _routeEndpointDisplay capture
    // site above), never redacted here and never read from a raw URL. There
    // is no raw-URL field on the object this returns, so a consumer cannot
    // bypass redaction by omission - the seam is structurally incapable of
    // handing back the thing it is supposed to hide.
    seam() {
      return {
        enabled: _viewModeEnabled,
        routeLabel: PoolEngine._routeLabel,
        connectionState: PoolEngine._isConnected,
        endpointDisplay: PoolEngine._routeEndpointDisplay,
      };
    },
  }

  const FORCE_LEGACY_WS_ENGINE = (() => {
    try {
      if (typeof window !== 'undefined' && window.__LUNA_POOL_ENGINE === false) return true;
      return typeof localStorage !== 'undefined' && localStorage.getItem('luna_pool_engine') === '0';
    } catch (_) {
      return false;   // storage unavailable is not a reason to change engines
    }
  })();
  const USE_POOL_ENGINE = (typeof PoolEngineHelper !== 'undefined') && !FORCE_LEGACY_WS_ENGINE;

  // When pool engine is active, patch WebSocketEngine entry points so they
  // delegate to PoolEngine. All 23 WebSocketEngine call sites are redirected
  // to PoolEngine by patching WebSocketEngine methods directly — delegation
  // flows through the patched WebSocketEngine methods, not through an
  // ActiveEngine reference.
  //
  // To keep ALL 23 send() sites unchanged we make WebSocketEngine.send
  // forward to PoolEngine.send when the pool flag is active. Similarly
  // for connect(). The original implementations remain untouched at their
  // original property locations; we just add a thin delegation wrapper.
  if (USE_POOL_ENGINE) {
    // Save originals under a different key so they're still callable
    WebSocketEngine._legacyConnect = WebSocketEngine.connect.bind(WebSocketEngine);
    WebSocketEngine._legacySend    = WebSocketEngine.send.bind(WebSocketEngine);

    // SYNCTHREAD PARITY (stack23 S18b). PoolEngine shipped its OWN 77-line
    // syncThread, while WebSocketEngine's is 116 lines - and the difference
    // was not stylistic: the pool version had no `get_panel_last_thread`
    // path, so a panel window would lose its per-panel thread memory on
    // boot. Twenty-seven chat-window.test.ts scenarios pinned that gap.
    //
    // Rather than port ~40 lines into a third copy of the same
    // thread-resolution state machine, PoolEngine reuses the legacy one
    // VERBATIM with `this` bound to itself. That is sound because
    // WebSocketEngine.syncThread contains ZERO direct `WebSocketEngine.*`
    // references - it only calls `this.send`, `this.sendNewThread` and
    // `this.startSubscribeTimeout`, all of which PoolEngine implements - so
    // every send routes through the pool path while resolution stays
    // identical. Same pattern as checkProtocolVersion/applyBuildSha/
    // applyAvailableModels, which already delegate the other way.
    //
    // The reference is captured BEFORE the override two lines below, or the
    // two would call each other forever.
    const legacySyncThread = WebSocketEngine.syncThread;
    PoolEngine.syncThread = function() { return legacySyncThread.call(PoolEngine); };

    // Override connect and send to delegate to PoolEngine
    WebSocketEngine.connect = function() { return PoolEngine.connect(); };
    WebSocketEngine.send    = function(frame) { return PoolEngine.send(frame); };

    // Also delegate the other entry points called from frame handlers
    // and from ChatEngine / outside code:
    WebSocketEngine.disconnect        = function() { return PoolEngine.disconnect(); };
    WebSocketEngine.clearTurnTimeout  = function() { return PoolEngine.clearTurnTimeout(); };
    WebSocketEngine.startTurnTimeout  = function() { return PoolEngine.startTurnTimeout(); };
    WebSocketEngine.clearSubscribeTimeout = function() { return PoolEngine.clearSubscribeTimeout(); };
    WebSocketEngine.startSubscribeTimeout = function() { return PoolEngine.startSubscribeTimeout(); };
    WebSocketEngine.isConnected       = function() { return PoolEngine.isConnected(); };
    WebSocketEngine.sendNewThread     = function(agent) { return PoolEngine.sendNewThread(agent); };
    WebSocketEngine.syncThread        = function() { return PoolEngine.syncThread(); };
    WebSocketEngine.onReattachStalled = function() { return PoolEngine.onReattachStalled(); };
    WebSocketEngine.onReattached      = function() { return PoolEngine.onReattached(); };
    WebSocketEngine.handleFrame       = function(frame) { return PoolEngine.handleFrame(frame); };

    // Register the close hook seam on PoolEngine too (WebSocketEngine.registerCloseHook
    // is called from line 5671 — after this block — so we redirect it)
    WebSocketEngine.registerCloseHook = function(fn) { PoolEngine.registerCloseHook(fn); };

    Logger.info('[PoolEngine] DARK FLAG ACTIVE — using PoolEngine (pool path enabled)');
    window.__activeEngine = 'pool';
    window.__poolEngineState = { connected: false, routeKey: null, lastFrameType: null, gen: 0 };
  } else {
    window.__activeEngine = 'legacy';
    window.__poolEngineState = null;
  }

  async function loadConnectionAndConnect() {
    let loadedUrl = null;
    let loadedToken = null;

    // ── Step 0: one-time migration from moon-connection.json → client.toml ─
    // Runs before resolveBootRoute (inside PoolEngine.connect) so client.toml
    // exists when C2 reads it. Idempotent: Rust returns early when client.toml
    // already exists. BOUNDED: a hung migrate must not block dial forever
    // (Round-3 Mac: zero SYN while MoonBar stayed on default "waking up…").
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        await invokeWithTimeout(
          (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
          'migrate_legacy_connection',
        );
      }
    } catch (e) {
      Logger.warn('[boot] legacy migration skipped:', e);
    }

    if (window.__TAURI__ && window.__TAURI__.core) {
      try {
        const conn = await invokeWithTimeout(
          (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
          'load_connection',
        );
        if (conn) {
          // File keys are camelCase (wsUrl/wsToken), matching save_connection.
          if (typeof conn.wsUrl === 'string' && conn.wsUrl) loadedUrl = conn.wsUrl;
          if (typeof conn.wsToken === 'string') loadedToken = conn.wsToken;
        }
      } catch (e) {
        Logger.error('Failed to invoke load_connection via Tauri:', e);
      }
    } else {
      // Plain browser (frontend dev): degrade to localStorage.
      const savedWsToken = localStorage.getItem('luna_ws_token');
      if (savedWsToken !== null) loadedToken = savedWsToken;
    }

    // URL: prefer the value from the secure file, then the legacy bare key
    // (read-only after C2 — writes removed from index.html), then default.
    // Route-keyed resolution (MoonSession.resolveBootRoute) is the hub's
    // concern; the chat window reads the URL the hub persisted via
    // moon-connection.json / load_connection. pickBootWsUrl keeps jax-box
    // (or any cached luna_ws_url) when load_connection times out.
    State.wsUrl = pickBootWsUrl(loadedUrl);
    // Pass tokenRef through verbatim (including "legacy" / scheme refs) so
    // PoolEngine's F2 guard can refuse dial rather than shipping a sentinel
    // as a bearer. Only a missing token becomes "".
    State.wsToken = loadedToken !== null ? loadedToken : '';

    // Establish the initial WebSocket connection!
    WebSocketEngine.connect();
  }

  return {
    WebSocketEngine,
    PoolEngine,
    USE_POOL_ENGINE,
    ViewMode,
    /** Ignition. Called by main-chat.tsx AFTER every collaborator exists -
     *  which is the whole reason it is a function here and a bare statement
     *  in chat.html before this slice. */
    boot: () => loadConnectionAndConnect(),
    /**
     * Exposed so wiring.ts's hub-event listener (profile-changed /
     * connection-changed) can re-read the secure connection file and
     * reconnect on a route switch. wiring.ts's installWiring() runs BEFORE
     * this function does (bootChat.ts's construction order), so it cannot
     * receive this as a constructor param - it looks it up late via the
     * BARE window.loadConnectionAndConnect global instead (assignBridge sets
     * that unconditionally, production included), bridged by bootChat.ts
     * right after this object is returned. Without this, a real profile
     * switch left the chat window's hub-event handler calling a bare,
     * unresolvable identifier (ReferenceError, silently swallowed by its own
     * .catch) - the window never actually reconnected. NEVER read this back
     * through window.__MoonInternals.loadConnectionAndConnect - that object
     * is a test-only observability mirror (chat-harness.ts pre-creates it;
     * production never does), and reading through it here was itself a
     * production-breaking bug found while auditing plan Step 3.
     */
    loadConnectionAndConnect,
  }
}
