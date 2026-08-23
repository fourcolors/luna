/**
 * localShell.ts - the local-shell scope controller (stack23 S19h).
 *
 * Owns which directories the agent may reach on this machine: the scope menu,
 * the full-access toggle, the per-root list, and the `local-shell-capability`
 * frame that tells the server what this client will honour.
 *
 * IT IS A SECURITY SURFACE. The frame it sends is the authority for what the
 * agent is allowed to touch; changes here change the blast radius of every
 * shell tool call. This file was originally a verbatim move from the vanilla
 * module (stack23 S19h) but has been deliberately changed: machine access
 * is now ON BY DEFAULT with persistence of the user's OFF choice, and
 * approvalMode is corrected from the false 'prompt' claim to 'auto' (Moon
 * never prompts per command — handleRequest executes directly).
 *
 * MOVING IT DELETES A GROUP C MEMBER, which is the point of S19 rather than a
 * side effect. `LunaChatHost.closeLocalShellMenu` existed only so SlashMenu -
 * already a module - could reach this vanilla const. Both are modules now, so
 * SlashMenu takes `openMenu` directly and the contract loses a member instead
 * of gaining one.
 */
// @ts-nocheck

export interface LocalShellState {
  enabled: boolean
  roots: string[]
  fullAccess: boolean
  platform: string
  clientId: string
}

export interface LocalShellCtx {
  readonly Logger: { info: (m?: unknown, ...a: unknown[]) => void; warn: (m?: unknown, ...a: unknown[]) => void; error: (m?: unknown, ...a: unknown[]) => void }
  readonly DOM: Record<string, HTMLElement | null>
  /** The LIVE State object - `State.localShell` is mutated in place. */
  readonly State: { localShell: LocalShellState; activeThreadId: string | null } | undefined
  readonly WebSocketEngine: { send: (frame: unknown) => void }
}

export function createLocalShell(ctx: LocalShellCtx) {
  const { Logger, DOM, State, WebSocketEngine } = ctx
  const LocalShell = {
    // Minimal posix path normalize for absolute paths (collapse //, ., ..).
    normalize(p) {
      const out = [];
      for (const seg of String(p).split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
      }
      return '/' + out.join('/');
    },
    withinRoot(cwd, root) {
      if (!cwd.startsWith('/') || !root.startsWith('/')) return false;
      const c = this.normalize(cwd);
      const r = this.normalize(root);
      if (r === '/') return true; // "/" contains everything
      return c === r || c.startsWith(r + '/');
    },
    // An undefined cwd means "use the client default" (roots[0]); in scope only
    // when at least one root is attached (auto-approval is opt-in).
    withinRoots(cwd, roots) {
      if (cwd == null) return roots.length > 0;
      return roots.some((r) => this.withinRoot(cwd, r));
    },
    recomputeEnabled() {
      const ls = State.localShell;
      ls.enabled = ls.fullAccess || ls.roots.length > 0;
    },
    async refreshPlatform() {
      if (!(window.__TAURI__ && window.__TAURI__.core)) return;
      try {
        State.localShell.platform = await window.__TAURI__.core.invoke('get_platform');
      } catch (e) {
        Logger.error('Failed to invoke get_platform via Tauri:', e);
      }
    },
    // Tell the server this client's current scope. Sent when a thread becomes
    // active and on every scope change. Harmless to re-send (server keys on
    // clientId); an enabled:false frame releases the server's slot.
    sendCapability() {
      if (!State.activeThreadId) return;
      const ls = State.localShell;
      WebSocketEngine.send({
        type: 'local-shell-capability',
        threadId: State.activeThreadId,
        enabled: ls.enabled,
        // Moon executes commands directly via local_shell_exec without a
      // per-command prompt UI. 'prompt' was a false claim; 'auto' is honest.
      approvalMode: 'auto',
        clientId: ls.clientId,
        platform: ls.platform,
        cwd: ls.roots[0] || '/',
        roots: ls.roots,
        fullAccess: ls.fullAccess
      });
      Logger.info(`local-shell capability sent (enabled=${ls.enabled}, fullAccess=${ls.fullAccess}, roots=${ls.roots.length})`);
    },
    // Run a server-requested command, ALWAYS replying with a result frame so the
    // server bridge never hangs on a pending request.
    async handleRequest(frame) {
      const reply = (res) => WebSocketEngine.send(Object.assign({
        type: 'local-shell-result',
        requestId: frame.requestId,
        threadId: frame.threadId
      }, res));
      const denied = (stderr) => reply({
        approved: false, exitCode: null, stdout: '', stderr, durationMs: 0, timedOut: false
      });

      const ls = State.localShell;
      if (!ls.enabled) return denied('local shell disabled');
      const approved = ls.fullAccess || this.withinRoots(frame.cwd ?? null, ls.roots);
      if (!approved) return denied('command outside attached scope');
      if (!(window.__TAURI__ && window.__TAURI__.core)) {
        return denied('local shell unavailable (no Tauri runtime)');
      }
      try {
        const r = await window.__TAURI__.core.invoke('local_shell_exec', {
          command: frame.command,
          cwd: frame.cwd ?? null,
          timeoutMs: frame.timeoutMs ?? null
        });
        reply({
          approved: true,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          durationMs: r.durationMs,
          timedOut: r.timedOut
        });
      } catch (e) {
        // exec failure (not a command non-zero exit) — still an approved attempt.
        reply({ approved: true, exitCode: null, stdout: '', stderr: 'local shell exec failed: ' + String(e), durationMs: 0, timedOut: false });
      }
    },
    toggleFullAccess() {
      const ls = State.localShell;
      ls.fullAccess = !ls.fullAccess;
      // Persist the user's choice so it survives restarts.
      // Absent or 'on' => enabled at next boot; 'off' => disabled.
      try {
        localStorage.setItem('luna_machine_access', ls.fullAccess ? 'on' : 'off');
      } catch (_) { /* sandboxed environment */ }
      this.recomputeEnabled();
      this.updateUI();
      this.sendCapability();
    },
    updateUI() {
      const ls = State.localShell;
      const anyScope = ls.fullAccess || ls.roots.length > 0;
      if (DOM.scopeBtn) DOM.scopeBtn.classList.toggle('active', anyScope);
      if (DOM.scopeFullAccess) {
        DOM.scopeFullAccess.classList.toggle('checked', ls.fullAccess);
        DOM.scopeFullAccess.setAttribute('aria-checked', String(ls.fullAccess));
      }
    },
    openMenu(open) {
      if (!DOM.scopeMenu) return;
      DOM.scopeMenu.classList.toggle('open', open);
      DOM.scopeMenu.setAttribute('aria-hidden', String(!open));
    }
  }
  return LocalShell
}
