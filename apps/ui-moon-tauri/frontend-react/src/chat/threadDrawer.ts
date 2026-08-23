/**
 * threadDrawer.ts - the left-edge thread switcher (stack23 S19j).
 *
 * A Things-3-style resizable split-pane sidebar that pushes the chat over.
 * Renders the thread-list frame - the SAME frame the reattach handler
 * consumes, hooked additively and never replacing that load-bearing handler.
 * A row click opens that thread in THIS window; dragging the divider opens,
 * resizes, or collapses the pane.
 *
 * FOUR THINGS MOVE TOGETHER BECAUSE THEY ARE A CYCLE, NOT A PREFERENCE.
 * ThreadCache calls ThreadDrawerEngine.render, and the drawer calls
 * ThreadCache.isBusy/get/paint straight back. That mutual reference is what
 * #484 recorded when an earlier attempt tried to move ThreadCache alone and
 * had to be reverted: a module cannot reach a chat.html-private const, so
 * neither half can leave without the other. ThreadCreateState and
 * moonDragDebugNote come along as drawer-private collaborators.
 *
 * IT IS THE LARGEST SINGLE MOVE IN THE CONVERSION and deliberately still a
 * MOVE. The obvious temptation with 740 lines of DOM-building is to rewrite
 * the list as React while it is open on the table. That would fork rendering,
 * drag-and-drop, persistence and the reattach hook all at once, with no way to
 * tell a regression from an intended change. The rewrite is its own slice,
 * after this one is proven identical.
 *
 * IT IS NOW VERBATIM, ALL OF IT. S19j moved this with exactly one changed
 * line: `wireThreadRow` used to pass `typeof winLabel !== 'undefined' ?
 * winLabel : null`, and I rewrote it to read `State.winLabel`, reasoning that
 * the old guard would silently yield null in a module and cost the drag its
 * owner label.
 *
 * THAT REASONING WAS SOUND AND THE LINE WAS STILL POINTLESS. The `winLabel`
 * dep was destructured by threadDrag.ts and never read - passing
 * "XXX-GARBAGE-XXX" changed nothing anywhere. The drag's owner label has
 * always come from `State.winLabel`, read directly at the point of use. The
 * dead parameter is deleted, so this move is now character-identical, and the
 * one line that actually carries the owner label finally has a test
 * (thread-drag-detach.test.ts).
 */
// @ts-nocheck

const MOON_DRAG_DEBUG_MAX = 96;
export function moonDragDebugNote(kind, data) {
  try {
    if (!window.__moonDragDebug) {
      window.__moonDragDebug = {
        version: 1,
        events: [],
        last: null,
        lastFloater: null,
        lastAction: null,
        lastOutcome: null,
      };
    }
    const dbg = window.__moonDragDebug;
    const entry = {
      t: Date.now(),
      kind: kind,
      data: data || null,
    };
    dbg.events.push(entry);
    if (dbg.events.length > MOON_DRAG_DEBUG_MAX) {
      dbg.events.splice(0, dbg.events.length - MOON_DRAG_DEBUG_MAX);
    }
    dbg.last = entry;
    if (data && data.action) dbg.lastAction = data.action;
    if (data && data.outcome) dbg.lastOutcome = data.outcome;
    if (kind === 'floater' && data) dbg.lastFloater = data;
    if (data && data.session) dbg.session = data.session;
  } catch (_) { /* never throw from debug */ }
}

export interface ThreadDrawerCtx {
  readonly Logger: { info: (m?: unknown, ...a: unknown[]) => void; warn: (m?: unknown, ...a: unknown[]) => void; error: (m?: unknown, ...a: unknown[]) => void }
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object, never a copy. */
  readonly State: Record<string, unknown> | undefined
  readonly WebSocketEngine: {
    send: (frame: unknown) => void
    isConnected: () => boolean
    clearTurnTimeout: () => void
    startSubscribeTimeout: () => void
    /** Agent sidebar S5: the section header's "+" (optional agent). */
    sendNewThread: (agent?: string) => void
  }
  readonly ChatState: Record<string, unknown>
  readonly ChatLoop: Record<string, unknown>
  readonly MoonFace: { setBusy: (b: unknown) => void }
  readonly ThreadListLogic: unknown
  readonly ThreadStrip: unknown
  readonly ThreadCacheLogic: unknown
  readonly ThreadCreateLogic: unknown
  readonly ThreadDrag: unknown
  readonly formatRelTime: (ts: number, now?: number) => string
  /** Called after the viewed thread changes. Late-bound on purpose: the
   *  suggestion engine is constructed after this one, so the drawer holds a
   *  callback rather than the engine. */
  readonly onThreadSwitch?: (threadId: string) => void
  readonly LunaThreadDrag: unknown
}

/**
 * Builds the drawer, its cache, and the create-intent adapter as ONE unit -
 * they reference each other, so they cannot be constructed separately.
 */
export function createThreadDrawer(ctx: ThreadDrawerCtx) {
  const {
    Logger, DOM, State, WebSocketEngine, ChatState, ChatLoop, MoonFace,
    ThreadListLogic, ThreadStrip, ThreadCacheLogic, ThreadCreateLogic,
    ThreadDrag, formatRelTime, LunaThreadDrag, onThreadSwitch,
  } = ctx

  const ThreadCache = {
    _ctx() {
      return {
        state: State,
        chatState: typeof ChatState !== 'undefined' ? ChatState : null,
        chatLoop: typeof ChatLoop !== 'undefined' ? ChatLoop : null,
        requestRender: () => ThreadDrawerEngine.render(),
      };
    },
    put(threadId, messages, throughSeq) { return ThreadCacheLogic.put(this._ctx(), threadId, messages, throughSeq); },
    get(threadId) { return ThreadCacheLogic.get(this._ctx(), threadId); },
    paint(threadId) { return ThreadCacheLogic.paint(this._ctx(), threadId); },
    clear(threadId) { return ThreadCacheLogic.clear(this._ctx(), threadId); },
    markBusy(threadId) { return ThreadCacheLogic.markBusy(this._ctx(), threadId); },
    clearBusy(threadId) { return ThreadCacheLogic.clearBusy(this._ctx(), threadId); },
    isBusy(threadId) { return ThreadCacheLogic.isBusy(this._ctx(), threadId); },
  }

  const ThreadCreateState = {
    begin() { return ThreadCreateLogic.begin(State); },
    moveToBackground() { return ThreadCreateLogic.moveToBackground(State); },
    settle() { return ThreadCreateLogic.settle(State); },
    fail() { return ThreadCreateLogic.fail(State); },
    onDisconnect() { return ThreadCreateLogic.onDisconnect(State); },
  }

  const ThreadDrawerEngine = {
    // --- open / close / resize (Things-3-style split pane) ------------------
    MIN_W: 190,        // narrowest resting open width
    MAX_FRAC: 0.7,     // sidebar may take at most this fraction of the window
    COLLAPSE_AT: 120,  // release below this → snap collapsed

    _maxWidth() {
      // Cap by the chat panel's own border-box width (its padding-left IS the
      // sidebar, so the border-box already spans the full available width),
      // not window.innerWidth - the panel need not fill the whole window.
      let avail = 0;
      try { if (DOM.chatPanel) avail = DOM.chatPanel.getBoundingClientRect().width; } catch (_) {}
      if (!(avail > 0)) avail = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 560;
      return Math.max(this.MIN_W, Math.round(avail * this.MAX_FRAC));
    },

    // Apply a raw width to the split (live during a drag). --sidebar-w drives
    // both the sidebar's width AND #chat-panel's padding-left (the push). Pure
    // DISPLAY: it never persists and never touches the remembered PREFERRED
    // width. Refreshes the list the first time it opens.
    _applyWidth(w) {
      const prev = State.sidebarWidth;
      w = Math.max(0, Math.round(w));
      State.sidebarWidth = w;
      State.threadDrawerOpen = w > 0;
      if (DOM.chatPanel) {
        DOM.chatPanel.style.setProperty('--sidebar-w', w + 'px');
        DOM.chatPanel.classList.toggle('sidebar-collapsed', w === 0);
      }
      if (DOM.threadDrawer) DOM.threadDrawer.setAttribute('aria-hidden', w > 0 ? 'false' : 'true');
      // Keep the title-bar toggle in lockstep with the drawer it controls.
      // _applyWidth is the ONE chokepoint every open/close path funnels
      // through (click, drag-to-zero, restore-on-boot, reclamp), so the button
      // cannot drift out of sync with the panel the way a click-site-only
      // update would. aria-expanded is the actual disclosure contract; the
      // label flips so the control always names what the NEXT press does.
      if (DOM.toggleThreads) {
        const drawerOpen = w > 0;
        const label = drawerOpen ? 'Hide threads' : 'Show threads';
        DOM.toggleThreads.classList.toggle('is-open', drawerOpen);
        DOM.toggleThreads.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
        DOM.toggleThreads.setAttribute('aria-label', label);
        DOM.toggleThreads.setAttribute('title', label);
      }
      if (DOM.threadDivider) {
        DOM.threadDivider.setAttribute('aria-valuenow', String(w));
        DOM.threadDivider.setAttribute('aria-valuemax', String(this._maxWidth()));
      }
      if (w > 0 && prev === 0) { this.requestList(); this.render(); }
    },

    // Persist the user's PREFERRED open width plus an open/collapsed flag.
    // lastOpenWidth is the un-clamped width the user chose; a transient window
    // shrink clamps the DISPLAY (reclampWidth) but never this stored value, so
    // growing the window back restores toward the width they actually picked.
    _persistPrefs() {
      try {
        if (State.lastOpenWidth > 0) localStorage.setItem('luna.sidebar.w', String(State.lastOpenWidth));
        localStorage.setItem('luna.sidebar.open', State.sidebarWidth > 0 ? '1' : '0');
      } catch (_) {}
    },

    // Snap to a resting width (0, or MIN_W..max) from an EXPLICIT user gesture
    // (divider release, keyboard). A resting OPEN width becomes the remembered
    // PREFERRED width; a sub-threshold value snaps collapsed without touching it.
    setSidebarWidth(w) {
      if (w < this.COLLAPSE_AT) w = 0;
      else w = Math.min(Math.max(w, this.MIN_W), this._maxWidth());
      if (w > 0) State.lastOpenWidth = w;
      this._applyWidth(w);
      this._persistPrefs();
    },

    // Re-clamp the open sidebar against the current max (e.g. after the window
    // shrinks) for DISPLAY only — the PREFERRED width is left intact so a later
    // grow restores it, and nothing is persisted. When collapsed just refresh
    // the divider's aria-valuemax for AT.
    reclampWidth() {
      if (State.sidebarWidth > 0) this._applyWidth(Math.min(State.lastOpenWidth || State.sidebarWidth, this._maxWidth()));
      else if (DOM.threadDivider) DOM.threadDivider.setAttribute('aria-valuemax', String(this._maxWidth()));
    },

    togglePanel() {
      if (this.isPinnedWindow()) return;
      if (State.sidebarWidth > 0) this.closePanel();
      else this.openPanel();
    },

    // Open to the remembered PREFERRED width, clamped to fit the current panel
    // (never overwriting the preferred value, so a big preference survives a
    // small window). Persists the open flag.
    openPanel() {
      if (this.isPinnedWindow()) return;   // pinned pop-outs are single-thread; no switcher
      this._applyWidth(Math.min(State.lastOpenWidth || 240, this._maxWidth()));
      this._persistPrefs();
    },

    closePanel() { this._applyWidth(0); this._persistPrefs(); },

    // Drag the divider (or its collapsed grabber) to open / resize / collapse;
    // a click without a drag toggles. Width = cursor X minus the panel's left.
    wireDivider(el) {
      if (!el) return;
      const self = this;
      let startX = 0, moved = false, pid = null, panelLeft = 0;
      const onMove = (e) => {
        if (!moved && Math.abs(e.clientX - startX) > 3) {
          moved = true;
          el.classList.add('dragging');
          if (DOM.chatPanel) DOM.chatPanel.classList.add('sidebar-resizing');
        }
        if (moved) self._applyWidth(Math.min(Math.max(0, e.clientX - panelLeft), self._maxWidth()));
      };
      const cleanup = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
        try { if (pid != null) el.releasePointerCapture(pid); } catch (_) {}
        el.classList.remove('dragging');
        if (DOM.chatPanel) DOM.chatPanel.classList.remove('sidebar-resizing');
        pid = null;
      };
      const onUp = () => { const wasDrag = moved; cleanup(); wasDrag ? self.setSidebarWidth(State.sidebarWidth) : self.togglePanel(); };
      const onCancel = () => { cleanup(); self.setSidebarWidth(State.sidebarWidth); };
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || self.isPinnedWindow()) return;
        startX = e.clientX; moved = false; pid = e.pointerId;
        panelLeft = DOM.chatPanel ? DOM.chatPanel.getBoundingClientRect().left : 0;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        // preventDefault below suppresses the default focus, so focus the
        // divider explicitly — click-then-Arrow/Home/End must work without Tab.
        try { el.focus(); } catch (_) {}
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onCancel);
        e.preventDefault();
      });
      // Keyboard resize/toggle for the focused divider (role=separator).
      el.addEventListener('keydown', (e) => {
        if (self.isPinnedWindow()) return;
        const STEP = 24, cur = State.sidebarWidth;
        switch (e.key) {
          case 'ArrowRight': self.setSidebarWidth(cur === 0 ? self.MIN_W : cur + STEP); break;
          case 'ArrowLeft':  self.setSidebarWidth(cur - STEP); break;
          case 'Home':       self.setSidebarWidth(0); break;
          case 'End':        self.setSidebarWidth(self._maxWidth()); break;
          case 'Enter': case ' ': case 'Spacebar': self.togglePanel(); break;
          default: return;
        }
        e.preventDefault();
      });
    },

    // Restore the persisted split at boot: the PREFERRED width plus an
    // open/collapsed flag. Collapsed by default on first run (grabber shown).
    // The preferred width is kept un-clamped so a later grow can restore it;
    // only the DISPLAY is clamped to the current panel cap.
    initSidebar() {
      if (this.isPinnedWindow()) {
        if (DOM.threadDivider) DOM.threadDivider.hidden = true;
        return;
      }
      let pref = 0, openRaw = null;
      try {
        const s = localStorage.getItem('luna.sidebar.w');
        if (s != null) pref = parseInt(s, 10) || 0;
        openRaw = localStorage.getItem('luna.sidebar.open');
      } catch (_) {}
      if (pref > 0) State.lastOpenWidth = pref;
      // An absent flag (fresh install, or pre-flag persistence where the stored
      // width was 0 when collapsed) infers open from a saved positive width;
      // otherwise honour the explicit '1'/'0'.
      const open = openRaw === null ? pref > 0 : openRaw === '1';
      if (open && State.lastOpenWidth > 0) this._applyWidth(Math.min(State.lastOpenWidth, this._maxWidth()));
      else this._applyWidth(0);
      if (DOM.chatPanel) DOM.chatPanel.classList.toggle('sidebar-collapsed', State.sidebarWidth === 0);
    },

    // A ?thread=<id> window is pinned to one thread forever — the switcher is
    // contradictory there, so it's disabled + its toggle hidden at boot.
    isPinnedWindow() { return !!State.pinnedThread; },

    requestList() {
      if (State.threadDrawerOpen && WebSocketEngine.isConnected()) {
        // Shared builder (codex finding 6): this is the drawer's COMMON
        // refresh path and must carry the same grouped-mode limit as
        // wire.ts's recovery paths.
        WebSocketEngine.send(ThreadListLogic.buildListThreadsFrame(State));
      }
    },

    // --- data ---------------------------------------------------------------
    /**
     * Insert (or refresh) ONE locally-known thread, by id.
     *
     * The server deliberately hides never-typed-in threads from `thread-list`:
     * listThreads queries with `hasUserMessage: true`, whose predicate requires
     * a top-level user message (packages/core/src/session/session-store-sqlite
     * .ts) - "a thread is not a conversation until the user types". A thread you
     * just minted therefore CANNOT come back in a list until you send a first
     * message, so the drawer has to carry it locally in the meantime. The web
     * client already does exactly this (packages/ui-shared/src/reducer.ts's
     * `thread-created` case prepends the summary), and Moon was the odd one out.
     *
     * Upsert-by-id, never blind-prepend: once the server's list legitimately
     * contains the thread, this must not leave a duplicate behind.
     *
     * NO pin-at-top: `ThreadListLogic.threadTimestamp` already falls back
     * lastMessageAt -> updatedAt -> createdAt, and a fresh summary's createdAt
     * is now, so it sorts first on its own. Forcing position here would misplace
     * an OLD thread that legitimately fell off the server's page.
     */
    upsertThread(summary) {
      if (!summary || !summary.id) return;
      const rest = (Array.isArray(State.threads) ? State.threads : [])
        .filter((t) => t && t.id !== summary.id);
      State.threads = [summary, ...rest];
      this.render();
    },

    // Fed by the thread-list frame (see the augmented handler below). Renders
    // regardless of active-thread state; the reattach logic stays untouched.
    applyList(list) {
      const incoming = Array.isArray(list) ? list.slice() : [];
      // MEMBERSHIP-PRESERVING, deliberately narrow. `thread-list` is still the
      // drawer's data source for everything it contains; this only keeps the
      // ACTIVE thread from being wiped while the server is legitimately still
      // hiding it (see upsertThread above for why it is hidden). Without this,
      // the very next list - the drawer opening, a reconnect nudge - would
      // erase the row the user is literally typing into.
      //
      // Scope notes:
      //  - active-only. A non-active locally-known thread absent from the list
      //    is a thread the user abandoned; it drops, matching the server.
      //  - membership only, no reordering: the carried row sorts by its own
      //    real recency, exactly as if the server had sent it.
      //  - cannot resurrect an archived thread: the `thread-archived` handler
      //    nulls State.activeThreadId synchronously, before any refreshed list
      //    can arrive, so there is no active id left to match.
      const activeId = State.activeThreadId;
      if (activeId && !incoming.some((t) => t && t.id === activeId)) {
        const carried = (Array.isArray(State.threads) ? State.threads : [])
          .find((t) => t && t.id === activeId);
        if (carried) incoming.push(carried);
      }
      State.threads = incoming;
      this.render();
    },

    setSearch(q) { State.threadSearch = q || ''; this.render(); },

    // Pure selection/ordering logic lives in src/chat/threadList.ts
    // (stack23 S17). These three delegate to the forward-declared
    // `ThreadListLogic` (== window.ThreadListLogic for a classic script),
    // which main-chat.tsx assigns. Safe for the same reason every other
    // module bridge is: each is called from an event handler or a frame
    // handler, never at this script's own top level.
    _ts(t) { return ThreadListLogic.threadTimestamp(t); },

    _visibleThreads() { return ThreadListLogic.visibleThreads(State); },

    // --- render -------------------------------------------------------------
    render() {
      // A row drag-out holds pointer capture on a live DOM node. Rebuilding
      // the list mid-gesture detaches that node and silently aborts the pull.
      // This guard stays HERE, not in the module, because it also sets the
      // deferred-repaint flag the drag path consumes when the gesture ends.
      if (State.threadDragActive) {
        this._renderPendingDuringDrag = true;
        return;
      }
      const rows = this._visibleThreads();
      const preview = State.redockPreview;
      // Row building lives in src/chat/threadStrip.ts (stack23 S17c). The
      // render/_wireRow CYCLE IS PRESERVED: the module hands each freshly
      // built row to `wireRow` below before it is attached, exactly as the
      // inline `_renderRow` did, so the drag machinery is untouched.
      ThreadStrip.renderThreadStrip({
        listEl: DOM.threadDrawerList,
        emptyEl: DOM.threadDrawerEmpty,
        drawerEl: DOM.threadDrawer,
        rows,
        search: State.threadSearch || '',
        activeThreadId: State.activeThreadId,
        preview,
        insertAt: preview && preview.over
          ? this._insertIndexForRatio(rows.length, preview.yRatio)
          : -1,
        isBusy: (id) => ThreadCache.isBusy(id),
        relTime: (t) => this._relTime(t),
        wireRow: (row, t) => this._wireRow(row, t),
        makeInsertGap: (p) => this._makeInsertGap(p),
        onRowKeyActivate: (id, inNewWindow) => {
          if (inNewWindow) this.openInNewWindow(id);
          else this.onRowClick(id);
        },
        onPopOut: (id) => this.openInNewWindow(id),
        // Agent sidebar S5: search mode flattens; rows wear their section.
        tagAgents: !!(State.threadSearch || '').trim() && State.serverSupportsAgents === true,
        // Sections when there is something to group by (see
        // shouldGroupThreads); undefined = the exact pre-S5 flat path.
        grouped: ThreadListLogic.shouldGroupThreads(State)
          ? this._buildGrouped(rows)
          : undefined,
      });
    },

    // --- agent sections (S5) ------------------------------------------------

    /** Section list for the grouped render: headers derive from threads ∪
     *  roster; collapse is per-agent in localStorage, but the section
     *  holding the ACTIVE thread renders forced-open (non-persistent) so a
     *  thread switch can never land the selection inside a hidden row. */
    _buildGrouped(rows) {
      const collapsed = this._collapsedAgents();
      const sections = ThreadListLogic
        .groupByAgent(rows, State.agents)
        .map((s) => ({
          ...s,
          collapsed:
            collapsed.has(s.agentName === null ? '' : s.agentName) &&
            !s.rows.some((t) => t && t.id === State.activeThreadId),
          busy: s.rows.some((t) => t && ThreadCache.isBusy(t.id) && t.id !== State.activeThreadId),
        }));
      return {
        sections,
        onToggle: (name) => this.toggleSection(name),
        onNewThread: (name) => this.newThreadForAgent(name),
      };
    },

    COLLAPSED_AGENTS_KEY: 'luna.sidebarCollapsedAgents',

    /** Collapsed section keys ('' = the general section). */
    _collapsedAgents() {
      try {
        const raw = localStorage.getItem(this.COLLAPSED_AGENTS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
      } catch (_) {
        return new Set();
      }
    },

    _persistCollapsed(set) {
      try {
        localStorage.setItem(this.COLLAPSED_AGENTS_KEY, JSON.stringify(Array.from(set)));
      } catch (_) { /* private mode */ }
    },

    toggleSection(agentName) {
      const key = agentName === null ? '' : agentName;
      const set = this._collapsedAgents();
      if (set.has(key)) set.delete(key);
      else set.add(key);
      this._persistCollapsed(set);
      this.render();
    },

    /** The section header's "+": expand the section (the thread-created row
     *  must be visible) and mint a thread pre-filed to this agent through
     *  the same shared new-thread builder every other create uses. */
    newThreadForAgent(agentName) {
      const set = this._collapsedAgents();
      if (set.delete(agentName)) this._persistCollapsed(set);
      WebSocketEngine.sendNewThread(agentName);
      this.render();
    },

    _insertIndexForRatio(n, yRatio) { return ThreadListLogic.insertIndexForRatio(n, yRatio); },

    /**
     * Live strip geometry for native redock (logical points, webview top-left).
     * Rust maps mouse Y through stripTopInset + stripHeight so drop order
     * matches the cursor, not the full window / floater center.
     */
    measureStripMetrics() {
      let metrics = { stripWidth: 240, stripTopInset: 80, stripHeight: 400 };
      try {
        const list = DOM.threadDrawerList || DOM.threadDrawer;
        if (list) {
          const r = list.getBoundingClientRect();
          metrics = {
            stripWidth: Math.max(80, r.width || 240),
            stripTopInset: Math.max(0, r.top || 0),
            stripHeight: Math.max(40, r.height || 400),
          };
        }
      } catch (_) { /* defaults */ }
      // Publish for floater title-bar redock (other webview reads localStorage).
      try {
        window.__moonStripMetrics = metrics;
        localStorage.setItem('luna.moonStripMetrics', JSON.stringify(metrics));
      } catch (_) { /* private mode */ }
      return metrics;
    },

    _makeInsertGap(preview) {
      const gap = document.createElement('div');
      gap.className = 'thread-row-insert-gap';
      gap.setAttribute('aria-hidden', 'true');
      const title = (preview && preview.title && String(preview.title).trim())
        || 'Drop to redock';
      const previewText = (preview && preview.preview && String(preview.preview).trim())
        || 'Release to place here';
      gap.innerHTML =
        '<div class="thread-row-insert-gap-inner">' +
          '<div class="thread-row-insert-preview">' +
            '<span class="thread-row-dot" aria-hidden="true"></span>' +
            '<span class="thread-row-info">' +
              '<span class="thread-row-title"></span>' +
              '<span class="thread-row-preview"></span>' +
            '</span>' +
          '</div>' +
        '</div>';
      const titleEl = gap.querySelector('.thread-row-title');
      const prevEl = gap.querySelector('.thread-row-preview');
      if (titleEl) titleEl.textContent = title;
      if (prevEl) prevEl.textContent = previewText;
      gap.dataset.label = title;
      return gap;
    },

    _updateInsertGapContent(gap, preview) {
      if (!gap || !preview) return;
      const title = (preview.title && String(preview.title).trim()) || 'Drop to redock';
      const previewText = (preview.preview && String(preview.preview).trim())
        || 'Release to place here';
      const titleEl = gap.querySelector('.thread-row-title');
      const prevEl = gap.querySelector('.thread-row-preview');
      if (titleEl) titleEl.textContent = title;
      if (prevEl) prevEl.textContent = previewText;
      gap.dataset.label = title;
    },

    /**
     * Owner window: live preview while a floater is dragged over the dock.
     * One insert-slot node + FLIP on neighbors — no full list rebuild.
     */
    applyRedockPreview(payload) {
      if (!payload || payload.active === false) {
        // Keep lastInsertIndex for the imminent redock-thread event (cleared
        // after adopt). Still tear down live chrome.
        if (State.redockPreview && State.redockPreview.over) {
          State._lastRedockInsert = {
            threadId: State.redockPreview.threadId,
            insertIndex: State.redockPreview.insertIndex,
            yRatio: State.redockPreview.yRatio,
          };
        }
        State.redockPreview = null;
        if (DOM.threadDrawer) DOM.threadDrawer.classList.remove('redock-target');
        if (DOM.threadDrawerList) DOM.threadDrawerList.classList.remove('redocking');
        this._closeInsertGap();
        this._clearRedockSource();
        return;
      }
      // Open the sidebar so the insert gap is visible (once).
      if (!State.threadDrawerOpen || State.sidebarWidth === 0) {
        try { this.openPanel(); } catch (_) { /* best-effort */ }
      }
      try { this.measureStripMetrics(); } catch (_) { /* best-effort */ }
      const yRatio = typeof payload.yRatio === 'number' ? payload.yRatio : 0.5;
      // Count visible rows (floated source already excluded).
      const n = this._visibleThreads().length;
      const insertIndex = this._insertIndexForRatio(n, yRatio);
      // Resolve title/preview for the fake thread from the thread list if possible.
      let title = payload.title || null;
      let previewText = null;
      if (payload.threadId && Array.isArray(State.threads)) {
        const t = State.threads.find((x) => x && x.id === payload.threadId);
        if (t) {
          if (!title) title = (t.title && String(t.title).trim()) || null;
          previewText = (t.lastMessagePreview && String(t.lastMessagePreview).trim()) || null;
        }
      }
      const next = {
        threadId: payload.threadId || null,
        title,
        preview: previewText,
        yRatio,
        over: !!payload.over,
        insertIndex,
      };
      State.redockPreview = next;
      if (next.over) {
        State._lastRedockInsert = {
          threadId: next.threadId,
          insertIndex: next.insertIndex,
          yRatio: next.yRatio,
        };
      }
      if (DOM.threadDrawer) DOM.threadDrawer.classList.toggle('redock-target', !!next.over);
      if (DOM.threadDrawerList) DOM.threadDrawerList.classList.add('redocking');
      this._placeInsertGap(next);
      this._markRedockSource(next.threadId);
    },

    _clearInsertGap() {
      const list = DOM.threadDrawerList;
      if (!list) return;
      list.querySelectorAll('.thread-row-insert-gap').forEach((n) => n.remove());
      list.classList.remove('redocking');
    },

    /** Soft-close the slot (animate shut) then remove. */
    _closeInsertGap() {
      const list = DOM.threadDrawerList;
      if (!list) return;
      const gap = list.querySelector('.thread-row-insert-gap');
      if (!gap) {
        list.classList.remove('redocking');
        return;
      }
      gap.classList.remove('active');
      const finish = () => {
        try { if (gap.parentNode) gap.remove(); } catch (_) {}
        try { list.classList.remove('redocking'); } catch (_) {}
      };
      // Prefer transition end; fall back so we never leave a ghost node.
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        finish();
      };
      gap.addEventListener('transitionend', once, { once: true });
      setTimeout(once, 320);
    },

    _clearRedockSource() {
      const list = DOM.threadDrawerList;
      if (!list) return;
      list.querySelectorAll('.thread-row.redock-source').forEach((n) => {
        n.classList.remove('redock-source');
      });
    },

    _markRedockSource(threadId) {
      const list = DOM.threadDrawerList;
      if (!list) return;
      list.querySelectorAll('.thread-row').forEach((row) => {
        const on = !!(threadId && row.dataset.threadId === threadId);
        row.classList.toggle('redock-source', on);
      });
    },

    /**
     * FLIP: capture Y of rows, move the slot, invert transforms, play forward
     * so neighbors ease out of the way instead of jumping.
     */
    _flipRows(list, mutate) {
      if (!list || typeof mutate !== 'function') {
        try { mutate && mutate(); } catch (_) {}
        return;
      }
      const rows = Array.from(list.querySelectorAll('.thread-row:not(.floated-away)'));
      const first = new Map();
      rows.forEach((el) => {
        try { first.set(el, el.getBoundingClientRect().top); } catch (_) {}
      });
      mutate();
      // Double-rAF so layout commits before we measure last.
      const play = () => {
        rows.forEach((el) => {
          if (!first.has(el)) return;
          let lastTop = 0;
          try { lastTop = el.getBoundingClientRect().top; } catch (_) { return; }
          const dy = first.get(el) - lastTop;
          if (Math.abs(dy) < 0.5) return;
          el.style.transition = 'none';
          el.style.transform = 'translateY(' + dy + 'px)';
          // Force reflow then animate to identity.
          void el.offsetWidth;
          el.style.transition = '';
          el.style.transform = '';
        });
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(play));
      } else {
        setTimeout(play, 16);
      }
    },

    _placeInsertGap(preview) {
      const list = DOM.threadDrawerList;
      if (!list) return;
      if (!preview || !preview.over) {
        this._closeInsertGap();
        return;
      }
      const rows = Array.from(list.querySelectorAll('.thread-row:not(.floated-away)'));
      const at = typeof preview.insertIndex === 'number' && Number.isFinite(preview.insertIndex)
        ? Math.max(0, Math.min(rows.length, preview.insertIndex))
        : this._insertIndexForRatio(rows.length, preview.yRatio);
      let gap = list.querySelector('.thread-row-insert-gap');
      const wasActive = !!(gap && gap.classList.contains('active'));
      const prevAt = gap ? Number(gap.dataset.atIndex) : -1;
      const before = rows[at] || null;

      const moveNode = () => {
        if (!gap) {
          gap = this._makeInsertGap(preview);
          if (before) list.insertBefore(gap, before);
          else list.appendChild(gap);
          // Open on next frame so 0fr→1fr actually animates.
          requestAnimationFrame(() => {
            try { gap.classList.add('active'); } catch (_) {}
          });
        } else {
          this._updateInsertGapContent(gap, preview);
          // Only relocate when the slot index changes.
          if (prevAt !== at) {
            if (before) list.insertBefore(gap, before);
            else list.appendChild(gap);
          }
          if (!wasActive) {
            requestAnimationFrame(() => {
              try { gap.classList.add('active'); } catch (_) {}
            });
          } else {
            gap.classList.add('active');
          }
        }
        if (gap) gap.dataset.atIndex = String(at);
      };

      // FLIP neighbors when the slot opens or jumps to a new index.
      if (!gap || !wasActive || prevAt !== at) {
        this._flipRows(list, moveNode);
      } else {
        moveNode();
      }
    },

    /**
     * RETIRED (agent sidebar S5, Mr. Cobb's ruling 2026-08-22: "we don't
     * need reorder threads anymore, just recent"). A redock drop's position
     * used to pin a session-local order via State.threadOrder; now the drop
     * re-docks the thread and it sorts by recency like every other row —
     * the insert-gap preview remains a purely visual affordance. Kept as a
     * callee (threadDrag.ts calls it on drop) so the drag machinery is
     * untouched; it now just clears any legacy order so visibleThreads'
     * rank branch can never resurrect stale positions mid-session.
     */
    adoptAtIndex(threadId, insertIndex) {
      void threadId; void insertIndex;
      State.threadOrder = null;
    },

    // _renderRow moved to src/chat/threadStrip.ts (stack23 S17c) - see
    // render() above for the ctx it is called with, and that module's doc
    // for why the row list stays imperative rather than becoming React.

    _relTime(t) {
      const ms = this._ts(t);
      if (!ms) return '';
      try { if (typeof formatRelTime === 'function') return formatRelTime(ms); } catch (_) { /* fall through */ }
      return new Date(ms).toLocaleDateString();
    },

    // --- click vs drag-out gesture -----------------------------------------
    // Chrome-tab session: Attached (strip) vs Detached (floater follows pointer).
    // Never scale the floater webview (breaks native traffic lights).
    // Mid-drag open_widget uses focus:false so focus does not thrash.
    // The click-vs-drag-out gesture moved VERBATIM to
    // src/chat/threadDrag.ts (stack23 S17f) - 430 lines, exactly one of
    // which changed (`const self = this` became `const self = engine`).
    // See that module's doc for why a structural proof stands in for the
    // behavioural one here, and note that S17's hands-on detach/redock
    // exercise is still the gate that matters for it.
    //
    // `this` is handed over because the body both reads and WRITES engine
    // state (_ghost, _renderPendingDuringDrag); the six globals it closes
    // over are passed alongside so the body itself needed no edits.
    _wireRow(row, t) {
      ThreadDrag.wireThreadRow(this, row, t, {
        State,
        DOM,
        Logger,
        moonDragDebugNote,
        LunaThreadDrag,
      });
    },

    /**
     * Phase C: write a short-lived ThreadCache seed so a detaching floater
     * can paint transcript before the first WS snapshot.
     * Uses localStorage (shared across Tauri WebviewWindows). sessionStorage
     * is isolated per top-level browsing context and would never be visible
     * to the floater - see LunaThreadDrag.writeThreadSeed.
     */
    _seedFloaterCache(threadId) {
      if (!threadId) return;
      const entry = ThreadCache.get(threadId);
      if (!entry || !Array.isArray(entry.messages)) return;
      try {
        if (window.LunaThreadDrag && typeof window.LunaThreadDrag.writeThreadSeed === 'function') {
          window.LunaThreadDrag.writeThreadSeed(localStorage, threadId, entry);
        }
      } catch (_) { /* private mode / quota */ }
    },

    _makeGhost(t) {
      const g = document.createElement('div');
      g.className = 'thread-drag-ghost';
      const chrome = document.createElement('div');
      chrome.className = 'thread-drag-ghost-chrome';
      chrome.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('span');
        d.className = 'thread-drag-ghost-dot';
        chrome.appendChild(d);
      }
      const title = document.createElement('div');
      title.className = 'thread-drag-ghost-title';
      title.textContent = (t.title && String(t.title).trim()) || 'Untitled thread';
      const preview = document.createElement('div');
      preview.className = 'thread-drag-ghost-preview';
      preview.textContent =
        (t.lastMessagePreview && String(t.lastMessagePreview).trim()) || this._relTime(t) || 'Open conversation';
      g.appendChild(chrome);
      g.appendChild(title);
      g.appendChild(preview);
      document.body.appendChild(g);
      return g;
    },

    _closeFloater(label) {
      if (!label) return;
      try {
        if (window.__TAURI__ && window.__TAURI__.core) {
          window.__TAURI__.core.invoke('close_widget', { label }).catch(() => {});
        }
      } catch (_) { /* best-effort */ }
    },

    /**
     * Open a Phase 8 direct-line window pinned to this thread.
     * Different threads can generate in parallel - server already supports
     * concurrent runtimes; this is the multi-window surface.
     * Optional screenX/screenY place the floater under a drag-out drop (#380).
     * redockTo tells the floater which owner to fold back into on Redock.
     * Returns the invoke Promise (label) when Tauri is available.
     */
    /**
     * @param {string} id
     * @param {number} [screenX]
     * @param {number} [screenY]
     * @param {{ focus?: boolean }} [opts] focus defaults true; false during drag-follow
     */
    openInNewWindow(id, screenX, screenY, opts) {
      if (!id) return Promise.resolve(null);
      if (!(window.__TAURI__ && window.__TAURI__.core)) {
        Logger.warn('[ThreadDrawer] openInNewWindow requires Tauri');
        return Promise.resolve(null);
      }
      const params = { thread: id };
      // Prefer State.winLabel (set at boot); fall back for early calls.
      const owner = State.winLabel || null;
      if (owner) params.redockTo = owner;
      // View mode (plan Step 3), the detach direction: a verbose SOURCE
      // window's thread, dragged out into a new floating window, boots that
      // floater verbose too - wiring.ts reads this back as INITIAL_VIEW_MODE.
      // Read the BARE window.ViewMode global (assignBridge always sets it,
      // production included), not window.__MoonInternals.ViewMode - see
      // wiring.ts's currentViewModeEnabled doc for why that distinction is
      // load-bearing here. Omitted entirely when not verbose, so the
      // existing param-set pins below stay exactly as they were.
      const vm = window.ViewMode;
      if (vm && typeof vm.isEnabled === 'function' && vm.isEnabled()) {
        params.viewMode = true;
      }
      const args = { kind: 'chat', params };
      if (typeof screenX === 'number' && Number.isFinite(screenX)) {
        args.x = Math.round(screenX);
      }
      if (typeof screenY === 'number' && Number.isFinite(screenY)) {
        args.y = Math.round(screenY);
      }
      // Mid-drag follow must not steal focus (causes freeze / stuck feel).
      if (opts && opts.focus === false) args.focus = false;
      return window.__TAURI__.core
        .invoke('open_widget', args)
        .then((label) => {
          // Explicit pop (⤢) also leaves the strip until redock / close.
          if (!(opts && opts.keepInStrip)) {
            if (!State.floatedThreadIds) State.floatedThreadIds = Object.create(null);
            State.floatedThreadIds[id] = label || true;
            try {
              if (!State.threadDragActive) this.render();
            } catch (_) { /* best-effort */ }
          }
          return label;
        })
        .catch((e) => {
          Logger.warn('open_widget chat window failed:', e);
          throw e;
        });
    },

    /** Called when a floater folds back or is closed so the strip regains the row. */
    clearFloatedThread(threadId, opts) {
      if (!threadId || !State.floatedThreadIds) return;
      delete State.floatedThreadIds[threadId];
      if (!(opts && opts.skipRender)) {
        try { this.render(); } catch (_) {}
      }
    },

    /**
     * Adopt a redocked thread at the best-known insert index (last live
     * preview under the cursor, else yRatio, else top). Plays a soft land.
     */
    adoptRedockedThread(threadId, yRatio) {
      if (!threadId) return;
      const last = State._lastRedockInsert;
      let at = null;
      if (last && last.threadId === threadId && typeof last.insertIndex === 'number') {
        at = last.insertIndex;
      } else if (typeof yRatio === 'number' && Number.isFinite(yRatio)) {
        // Floated id is still excluded from visible until clearFloatedThread.
        const n = this._visibleThreads().length;
        at = this._insertIndexForRatio(n, yRatio);
      } else {
        at = 0;
      }
      this.clearFloatedThread(threadId, { skipRender: true });
      this.adoptAtIndex(threadId, at);
      State._lastRedockInsert = null;
      try { this.render(); } catch (_) {}
      this.onRowClick(threadId);
      // Soft land on the adopted row.
      try {
        const list = DOM.threadDrawerList;
        if (list) {
          const row = Array.from(list.querySelectorAll('.thread-row')).find(
            (el) => el.dataset && el.dataset.threadId === threadId,
          );
          if (row) {
            row.classList.add('just-landed');
            setTimeout(() => {
              try { row.classList.remove('just-landed'); } catch (_) {}
            }, 480);
          }
        }
      } catch (_) { /* missing row */ }
    },

    // --- open thread in THIS window (row click) ----------------------------
    onRowClick(id) {
      if (!id) return;
      // Split-pane: clicking a thread switches it in place and LEAVES the
      // sidebar open (Things-3 behavior), just moving the active highlight.
      if (id === State.activeThreadId) return;    // already here
      State.pendingFreshThread = false;           // newer intent beats a deferred "+ New"
      State.threadListAutoSelectPending = false;  // newer explicit selection beats list recovery
      ThreadCreateState.moveToBackground();       // a late create ack must not steal selection
      State.activeThreadId = id;
      State.activeTurnId = null;
      State.pendingUserMessage = null;
      try { WebSocketEngine.clearTurnTimeout(); } catch (_) {}
      // Instant paint from per-thread cache when available (ChatGPT-style).
      // Server re-snapshot is still sent below — it is the authoritative
      // refresh. Without the cache, the transcript flashes empty on every
      // switch (and used to stay empty on A→B→A due to subscribe no-op).
      const painted = ThreadCache.paint(id);
      if (!painted) {
        // Force an immediate blank render (not just a state reset) so the
        // old thread's transcript doesn't linger on screen until whatever
        // async path (the snapshot re-subscribe below) next flushes.
        try { ChatState.reset(); ChatLoop.flush(); } catch (_) {}
      }
      // Face follows the viewed thread only; background busy shows on the
      // sidebar row, not the moon face.
      try {
        // Force a clean false->true edge. setBusy is edge-triggered, so a switch
        // between two threads that are BOTH in flight would no-op and the new
        // thread would inherit the old one's 45s long-turn clock - escalating to
        // three rings seconds after you land, or never escalating at all.
        MoonFace.setBusy(false);
        MoonFace.setBusy(!!State.busyThreads[id]);
      } catch (_) {}
      // The suggestion chip is per-thread, and SuggestedActionsEngine.refresh()
      // already implements that correctly - it was simply never called on a
      // switch. The server only pushes a set-frame when the new thread HAS
      // actions, so moving to one with none left the old chip, and the happy
      // face, up for a thread that never proposed anything.
      try { onThreadSwitch?.(id); } catch (_) {}
      if (WebSocketEngine.isConnected()) {
        WebSocketEngine.send({ type: 'subscribe', threadId: id });
        WebSocketEngine.startSubscribeTimeout();
      } else {
        Logger.warn('[ThreadDrawer] not connected; queued switch to ' + id);
      }
      this.render();
    },
  }

  return { ThreadDrawerEngine, ThreadCache, ThreadCreateState }
}
