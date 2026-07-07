// settings-panel.jsx — React port of the old ui-web (Solid) App.tsx
// SettingsBody (L714-974): connection rows (URL/token/model/account/
// enter-to-send/connect-disconnect/restart) + appearance. This is the ONLY
// connect UI in Studio — it must render (and be usable) while disconnected,
// which is why every read here comes from ctx.config (local, persisted)
// rather than server-derived state.
//
// Skills / Connectors / Vault sections from the old SettingsBody are OUT OF
// SCOPE for this port (separate panels own that surface in Studio); so are
// the old Font/Text-size controls (Studio has no --font-chat system).
//
// Idiom translation from Solid: createSignal -> useState, For -> .map,
// Show -> && / early return, class -> className, onInput -> onChange.
import React, { useMemo, useState } from "react";
import { AccountSwitcher } from "./account-switcher.jsx";

/** Hardcoded fallback model list — used until the server's `hello` frame
 *  advertises `availableModels` (older servers never send it). Ported
 *  verbatim from the old App.tsx (L99-106). */
const MODEL_OPTIONS = [
  { value: "claude-opus-4-8", label: "Opus 4.8 — most capable (default)" },
  { value: "claude-opus-4-7", label: "Opus 4.7 — prior gen" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 — fastest" },
  { value: "claude-opus-4-6", label: "Opus 4.6 — prior gen" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5 — prior gen" },
];

const APPEARANCE_THEMES = ["light", "dark"];
const APPEARANCE_CHROME = [
  { value: "wash", label: "soft wash" },
  { value: "ink", label: "ink outline" },
];
// Palette swatch hexes shown per option — Studio's LUNA_PALETTES names
// (dawn/meadow/tide), matched by ctx.tweaks.palette. Kept local (not
// imported from luna-mini-apps.jsx) so this panel has no import-order
// dependency on the mini-apps module; the main thread's ctx.setTweak is the
// single source of truth for which name wins.
const PALETTE_SWATCHES = {
  dawn: ["#e8a7b0", "#f2c29a", "#c9b6d9"],
  meadow: ["#b5c9a3", "#ecd9a0", "#aac9cf"],
  tide: ["#a9b8dc", "#93c2c4", "#d9b3bd"],
};

export function SettingsPanel({ ctx }) {
  const { config, updateConfig, connected, status, selectAccount, connect, disconnect, restartServer } = ctx;
  const [restarting, setRestarting] = useState(false);

  const isConnecting = status?.kind === "connecting";

  /**
   * The active model list for the dropdown. When the server has sent an
   * `availableModels` list (post-hello) we use that — so an operator's
   * LUNA_UI_MODELS override and any non-Anthropic models are surfaced. On
   * older servers that omit the field (null) we fall back to the hardcoded
   * MODEL_OPTIONS list. Ported from L687-693.
   */
  const activeModelOptions = useMemo(() => {
    const serverModels = ctx.state.availableModels;
    if (serverModels !== null) {
      return serverModels.map((m) => ({ value: m.id, label: m.label }));
    }
    return MODEL_OPTIONS;
  }, [ctx.state.availableModels]);

  /**
   * True when the persisted model id isn't in the active list — either the
   * user typed a custom model id, or a server-advertised list dropped the
   * previously-persisted model. Ported from L702-704. NOTE (ported as-is):
   * picking "Custom…" from the dropdown alone does not flip this to true —
   * the handler below intentionally no-ops on that value, matching the
   * original's behavior byte-for-byte. The only way into custom mode is a
   * model value that's already outside the known list.
   */
  const isCustomModel = useMemo(
    () => !activeModelOptions.some((o) => o.value === config.model),
    [activeModelOptions, config.model],
  );

  const onRestart = async () => {
    setRestarting(true);
    try {
      await restartServer();
      // Disconnect — the server is going down. The reconnect attempt below
      // picks it back up once launchd respawns it.
      disconnect();
    } catch {
      // Server may have gone down before responding to the restart call —
      // that's the expected happy path, not a failure to surface.
      disconnect();
    } finally {
      setTimeout(() => {
        setRestarting(false);
        connect();
      }, 3000);
    }
  };

  return (
    <div className="stg-wrap">
      <div className="stg-row">
        <label className="stg-field">
          <span>URL</span>
          <input
            className="stg-input"
            value={config.url}
            onChange={(e) => updateConfig({ url: e.target.value })}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        <label className="stg-field">
          <span>Token</span>
          <input
            className="stg-input"
            type="password"
            value={config.token}
            onChange={(e) => updateConfig({ token: e.target.value })}
            placeholder="≥16 chars"
          />
        </label>
        <label className="stg-field">
          <span>Model</span>
          <select
            className="stg-input"
            value={isCustomModel ? "__custom" : config.model}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom") return;
              updateConfig({ model: v });
            }}
          >
            {activeModelOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            <option value="__custom">Custom…</option>
          </select>
        </label>
        {isCustomModel && (
          <label className="stg-field">
            <span>Model ID</span>
            <input
              className="stg-input"
              value={config.model}
              onChange={(e) => updateConfig({ model: e.target.value })}
              spellCheck={false}
              placeholder="claude-…"
            />
          </label>
        )}
        <AccountSwitcher
          accounts={ctx.state.accounts}
          selectedId={ctx.state.selectedAccountId}
          onSelect={selectAccount}
          disabled={!connected}
        />
        <label className="stg-toggle" title="When on, plain Enter sends; Shift+Enter inserts a newline">
          <input
            type="checkbox"
            checked={config.enterToSend}
            onChange={(e) => updateConfig({ enterToSend: e.target.checked })}
          />
          <span>Enter to send</span>
        </label>
        {connected || isConnecting ? (
          <button type="button" className="ghost-btn" onClick={disconnect}>Disconnect</button>
        ) : (
          <button
            type="button"
            className="ghost-btn"
            onClick={connect}
            disabled={!config.token || config.token.length < 16}
          >
            Connect
          </button>
        )}
        <button
          type="button"
          className="ghost-btn"
          disabled={restarting}
          title="Restart the Luna chat server (launchd auto-respawns)"
          onClick={onRestart}
        >
          {restarting ? "⟳ Restarting…" : "↺ Restart Server"}
        </button>
      </div>

      {/* Appearance — palette, theme, chrome, grain. Purely client-side via
          ctx.tweaks/ctx.setTweak, never gated on `connected`: this panel is
          the first-run surface, so appearance must work before any
          connection exists. Font/size controls are out of scope (Studio has
          no --font-chat system). */}
      <div className="stg-row">
        <div className="section-label">Appearance</div>
        <div className="swatch-row">
          {Object.entries(PALETTE_SWATCHES).map(([name, colors]) => (
            <button
              key={name}
              type="button"
              className={"swatch" + (ctx.tweaks.palette === name ? " active" : "")}
              title={name}
              aria-label={name}
              onClick={() => ctx.setTweak("palette", name)}
            >
              {colors.map((hex) => <span key={hex} style={{ background: hex }} />)}
            </button>
          ))}
        </div>
        <div className="chip-row">
          {APPEARANCE_THEMES.map((th) => (
            <button
              key={th}
              type="button"
              className={"chip" + (ctx.tweaks.theme === th ? " active" : "")}
              onClick={() => ctx.setTweak("theme", th)}
            >
              {th}
            </button>
          ))}
          {APPEARANCE_CHROME.map((c) => (
            <button
              key={c.value}
              type="button"
              className={"chip" + (ctx.tweaks.chrome === c.value ? " active" : "")}
              onClick={() => ctx.setTweak("chrome", c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="stg-toggle" title="Add a subtle paper texture to the canvas">
          <input
            type="checkbox"
            checked={ctx.tweaks.grain}
            onChange={(e) => ctx.setTweak("grain", e.target.checked)}
          />
          <span>Paper grain</span>
        </label>
      </div>
    </div>
  );
}
