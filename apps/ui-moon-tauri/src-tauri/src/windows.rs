//! Window/widget/panel management: the widget registry, panel + artifact
//! window spawning, native macOS window chrome, native resize, and native
//! drag-to-redock. This is the largest split-out module (moon-next split),
//! mirroring the size profile of `voice/mod.rs` — one cohesive subsystem
//! rather than many tiny files, since the widget registry, panel spawning,
//! chrome finalization, and native drag/resize gestures are tightly coupled.
//!
//! Moved verbatim out of main.rs: only visibility (`pub(crate)`) changed so
//! `main.rs` (and `updater.rs` / `lifecycle.rs`) can call into this module.

use tauri::Emitter;
use tauri::Manager;

// ── the deck: artifact widget windows (PRD Part C / W2) ──────────────────────
//
// Each pinned artifact can pop out into its own frameless, always-on-top,
// OPAQUE runtime window (WinAmp-style). Opaque rectangles need none of the
// interactive-region / click-through machinery the moon fights (§13), so these
// windows are plain. The window LABEL is a deterministic hash of the artifact
// id so it is unique, collision-resistant, valid as a Tauri label, and matches
// the `widget-*` capability glob — a label that matched no capability would get
// no IPC at all (fails closed). The REAL artifact id rides in the URL query so
// the widget page knows what to render; the label is just an opaque handle.

/// djb2 → u64; stable across processes so "focus if already open" and the
/// boot restore reconcile to the same window.
fn djb2(s: &str) -> u64 {
    let mut hash: u64 = 5381;
    for b in s.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u64::from(b));
    }
    hash
}

/// Deterministic, capability-glob-matching window label for an artifact id.
fn widget_label(artifact_id: &str) -> String {
    format!("widget-{:x}", djb2(artifact_id))
}

/// Percent-encode a query-parameter VALUE (RFC 3986 unreserved set kept raw).
/// Avoids depending on a urlencoding crate for the one place we need it.
fn encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── widget registry: SYSTEM widgets (panel-* windows) ───────────────────────
// design/widget-system.md "First-Class Widgets": one declarative table is the
// single source of truth for addressable widgets. The SAME file ships to the
// frontend (vendor/widget-registry.json) and is compiled in here — Rust is
// the enforcement point: kinds resolve ONLY to entries in this table, so no
// artifact/content input can ever become a system panel.
const WIDGET_REGISTRY_JSON: &str = include_str!("../../frontend/vendor/widget-registry.json");

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct WidgetDescriptor {
    kind: String,
    title: String,
    page: String,
    trust: String,
    #[serde(default = "default_panel_width")]
    width: f64,
    #[serde(default = "default_panel_height")]
    height: f64,
}
fn default_panel_width() -> f64 {
    360.0
}
fn default_panel_height() -> f64 {
    300.0
}

#[derive(serde::Deserialize)]
struct WidgetRegistryFile {
    widgets: Vec<WidgetDescriptor>,
}

fn widget_registry() -> &'static [WidgetDescriptor] {
    static REG: std::sync::OnceLock<Vec<WidgetDescriptor>> = std::sync::OnceLock::new();
    REG.get_or_init(|| {
        serde_json::from_str::<WidgetRegistryFile>(WIDGET_REGISTRY_JSON)
            .map(|r| r.widgets)
            .unwrap_or_default()
    })
}

pub(crate) fn registry_lookup(kind: &str) -> Option<&'static WidgetDescriptor> {
    widget_registry().iter().find(|d| d.kind == kind)
}

/// panel-* label for a registry kind. Kinds use lowercase words separated by
/// DOTS only (no dashes — pinned by a test), so dot→dash is bijective and the
/// label always matches the panel-* capability glob.
fn panel_label(kind: &str) -> String {
    format!("panel-{}", kind.replace('.', "-"))
}

/// Label for a non-singleton panel INSTANCE: the base label plus a stable
/// hash of its params (e.g. panel-flow-1a2b3c) — same params focus the same
/// window, different params open siblings. djb2, like widget_label.
fn panel_instance_label(kind: &str, params: &serde_json::Value) -> String {
    format!("{}-{:x}", panel_label(kind), djb2(&params.to_string()))
}

/// Append registry params as query parameters onto a descriptor page URL
/// (only scalar values; keys must be ASCII-alphanumeric — fail closed).
fn panel_url_with_params(page: &str, params: &serde_json::Value) -> String {
    let mut url = page.to_string();
    if let Some(obj) = params.as_object() {
        for (k, v) in obj {
            if !k.chars().all(|c| c.is_ascii_alphanumeric()) {
                continue;
            }
            let val = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            let sep = if url.contains('?') { '&' } else { '?' };
            url.push(sep);
            url.push_str(k);
            url.push('=');
            url.push_str(&encode_query_value(&val));
        }
    }
    url
}
fn panel_kind_from_label(label: &str) -> Option<String> {
    label.strip_prefix("panel-").map(|s| s.replace('-', "."))
}

/// Params recorded at `open_widget` time, keyed by instance window label.
/// An instance label carries only a HASH of its params (`panel-flow-1a2b3c`),
/// so `write_panel_layout` could never recover the params from the label
/// alone — every non-singleton panel (flow, agents, chat direct lines) was
/// persisted under a bogus kind (`flow.1a2b3c`) the boot restore's
/// `registry_lookup` could never resolve, and silently never came back.
/// Stale entries are harmless: they are only consulted for windows that are
/// currently open, and a label deterministically re-resolves to the same
/// params if the same instance reopens.
type InstanceParamsMap = std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>;

static PANEL_INSTANCE_PARAMS: std::sync::OnceLock<InstanceParamsMap> =
    std::sync::OnceLock::new();

fn instance_params_map() -> &'static InstanceParamsMap {
    PANEL_INSTANCE_PARAMS.get_or_init(Default::default)
}

fn record_instance_params(label: &str, params: &serde_json::Value) {
    if let Ok(mut m) = instance_params_map().lock() {
        m.insert(label.to_string(), params.clone());
    }
}

fn instance_params_for(label: &str) -> Option<serde_json::Value> {
    instance_params_map().lock().ok()?.get(label).cloned()
}

/// Resolve a panel window label to its registry kind plus instance params.
/// Base labels (`panel-chat`) resolve directly with no params. Instance
/// labels (`panel-flow-1a2b3c`) resolve to the base kind whose label is a
/// prefix plus the params recorded at open time. Returns `None` for labels
/// that resolve to no registry kind — the caller must not persist those
/// (the boot restore could never replay them). Pure apart from the
/// params-map read, and unit-tested.
fn panel_label_to_kind_and_params(label: &str) -> Option<(String, Option<serde_json::Value>)> {
    // A registered base label wins outright: the exact match is checked
    // before the instance scan, so a base label that is also a prefix of a
    // longer label (panel-settings vs panel-settings-face) still resolves to
    // its own kind instead of being misread as an instance of the shorter one.
    if let Some(kind) = panel_kind_from_label(label) {
        if registry_lookup(&kind).is_some() {
            return Some((kind, None));
        }
    }
    // Instance label: registered base label + "-" + hex hash of the params.
    for desc in widget_registry() {
        let base = panel_label(&desc.kind);
        let Some(rest) = label.strip_prefix(base.as_str()) else {
            continue;
        };
        let Some(hash) = rest.strip_prefix('-') else {
            continue;
        };
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        return Some((desc.kind.clone(), instance_params_for(label)));
    }
    None
}

/// Pure layout-persistence guard (testable without a webview), same shape as
/// `is_dock_label`. The launcher is a transient, summoned-on-demand
/// command palette: `write_panel_layout` records every open panel and the boot
/// restore replays everything it recorded, so persisting the palette would make
/// a single quit-with-it-open reopen it on EVERY subsequent launch. Every other
/// kind persists.
fn persists_in_layout(kind: &str) -> bool {
    kind != "launcher"
}

/// May this label participate in the dock graph and be closed by page JS?
/// widget-* (content tier) and panel-* (system tier); never the hub.
pub(crate) fn is_dock_label(label: &str) -> bool {
    label.starts_with("widget-") || label.starts_with("panel-")
}

/// ~/.luna/layout.json — positions of OPEN system panels (and nothing else:
/// pin state for content widgets stays server-side; design doc Persistence).
pub(crate) fn layout_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        std::path::PathBuf::from(home)
            .join(".luna")
            .join("layout.json"),
    )
}

/// Persist every open panel's logical rect. Listed = open; absence = closed.
/// Best-effort, last-write-wins, tiny file. NEVER called during hub-owned
/// shutdown (caller guards on the hub still existing), or quitting the app
/// would wipe the layout as the panels die one by one.
pub(crate) fn write_panel_layout(app: &tauri::AppHandle) {
    let Some(path) = layout_path() else { return };
    let mut entries = Vec::new();
    for (label, win) in app.webview_windows() {
        if !label.starts_with("panel-") {
            continue;
        }
        // Resolve through the registry, recovering instance params recorded
        // at open time. Labels that resolve to nothing are NOT persisted:
        // the boot restore replays rows via registry_lookup, so an
        // unresolvable row could never come back (previously every
        // non-singleton panel wrote a bogus "flow.1a2b3c"-style kind here
        // and was silently dropped on restart).
        let Some((kind, params)) = panel_label_to_kind_and_params(&label) else {
            continue;
        };
        if !persists_in_layout(&kind) {
            continue;
        }
        if let Some((x, y, w, h)) = window_logical_rect(&win) {
            let mut entry = serde_json::json!({
                "kind": kind, "x": x, "y": y, "w": w, "h": h
            });
            if let Some(p) = params {
                if !p.is_null() {
                    entry["params"] = p;
                }
            }
            entries.push(entry);
        }
    }
    let mut doc = serde_json::json!({ "version": 1, "panels": entries });
    // The moon orb's own position — the one window with no other home. Moon
    // OWNS orb placement now: tauri.conf.json sets no position and nothing in
    // the app ever wrote one, so placement was left to AppKit's default
    // choice, which proved non-deterministic on multi-display setups (live
    // incident: every clean launch parked the orb at x=-307, off the main
    // display, with no writer anywhere in the app). Saved on every layout
    // write and on orb drag end; restored CLAMPED on-screen at boot.
    if let Some(moon) = app.get_webview_window("main") {
        if let Some((x, y, _w, _h)) = window_logical_rect(&moon) {
            doc["moon"] = serde_json::json!({ "x": x, "y": y });
        }
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&doc).unwrap_or_default(),
    );
}

/// Build a panel window for a registry descriptor at (x, y) logical. Shared
/// by open_widget and the boot-time layout restore.
pub(crate) fn spawn_panel(
    app: &tauri::AppHandle,
    desc: &WidgetDescriptor,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    // Boot restore positions at build time → show immediately (it does not snap).
    spawn_panel_at(
        app,
        desc,
        &panel_label(&desc.kind),
        &desc.page,
        x,
        y,
        width,
        height,
    )
    .map(|w| w.label().to_string())
}

/// Spawn a panel for one boot-restore layout row. Rows with `params` replay
/// through the deterministic instance label + param URL — the same label a
/// fresh `open_widget` with those params would produce — so the restored
/// window reconciles with the live instance namespace instead of spawning a
/// sibling. Rows without params (or with unresolvable params) fall back to
/// the base panel.
pub(crate) fn spawn_panel_for_layout(
    app: &tauri::AppHandle,
    desc: &WidgetDescriptor,
    params: Option<&serde_json::Value>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    match params {
        Some(p) if !p.is_null() => {
            let label = panel_instance_label(&desc.kind, p);
            let url = panel_url_with_params(&desc.page, p);
            record_instance_params(&label, p);
            spawn_panel_at(app, desc, &label, &url, x, y, width, height)
                .map(|w| w.label().to_string())
        }
        _ => spawn_panel(app, desc, x, y, width, height),
    }
}

/// Traffic-light inset shared by the window builders and the AppKit re-apply
/// in `configure_native_window_chrome` — a single source of truth so the two
/// placements cannot drift apart.
///
/// These are WINDOW coordinates, but the thing they must line up with is the
/// CSS header inside the card — so they track the card's offset from the window
/// origin, which is `--card-inset` in vendor/moon-theme.css.
///
/// A natively-framed window (this whole module is macOS-only) collapses that
/// inset to 0 so the card fills the frame, so the offset is now just the CSS
/// header's own padding:
///   x=14 = --card-inset (0) + title-bar padding (14)
///   y=8  = --card-inset-top (0) + 8px of air under the top edge
/// which is the SAME position relative to the header as the old 36/14 pair had
/// against a 22/6 inset — the cluster does not move on screen, the card grew
/// out to meet it. If --card-inset ever becomes non-zero again for a native
/// frame, these two must move with it or the lights drift into the header
/// content (they have only 68px of reserved space).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_X: f64 = 14.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_Y: f64 = 8.0;

/// Shared frameless-card window build for panels and artifact widgets:
/// decorations/transparent/shadow/always_on_top/skip_taskbar/maximizable,
/// the macOS Overlay title-bar chrome, an optional logical top-left
/// `position` (None leaves initial placement to the OS), then build +
/// `finalize_native_window_chrome`.
fn build_card_window(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
    title: &str,
    inner_size: (f64, f64),
    min_inner_size: (f64, f64),
    position: Option<(f64, f64)>,
) -> Result<tauri::WebviewWindow, String> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App(url.to_string().into()),
    )
    .title(title)
    // Native decorations ONLY on macOS, where the Overlay block below turns
    // them into floating traffic-lights over the transparent CSS card. On
    // other platforms decorations(true) would draw a full opaque OS title bar
    // + frame around the transparent rounded card (broken chrome) — keep those
    // borderless, exactly as before this feature.
    .decorations(cfg!(target_os = "macos"))
    .transparent(true)
    // Whoever owns the frame owns the shadow.
    //
    // On macOS the window is natively decorated, so AppKit draws a real window
    // shadow that follows the actual rounded frame. The CSS halo is switched
    // off there (html[data-native-frame='true'] in moon-theme.css) because a
    // zero-inset card has no transparent margin to cast into — it would just be
    // sheared square at the window bounds.
    //
    // Elsewhere the window is borderless and the CSS card-shell halo is the
    // only depth cue, so the OS shadow stays off: it would follow the SQUARE
    // window bounds and intensify on focus, stacking a second, misaligned,
    // focus-reactive edge on the rounded card.
    .shadow(cfg!(target_os = "macos"))
    // Panels/screens do NOT float above other apps by default. The page itself
    // (vendor/moon-window-float.js, loaded by chat.html/panel.html/widget.html)
    // re-enables always-on-top at boot when the user has explicitly turned on
    // the "Always on Top" setting (luna_always_on_top === "true"). The orb
    // window (index.html) keeps its own default-on behavior independently.
    .always_on_top(false)
    .skip_taskbar(true)
    .visible(true)
    // Standard native traffic lights on every window: the green (zoom) button
    // is a real, ENABLED control everywhere, never a grayed-out disabled dot.
    // FullScreenNone (see configure_native_window_chrome) keeps a green click an
    // in-screen zoom, never a jump to a fullscreen Space.
    .maximizable(true)
    .inner_size(inner_size.0, inner_size.1)
    .min_inner_size(min_inner_size.0, min_inner_size.1);
    // Tauri/Wry owns the native controls for the full window lifetime. A static
    // builder position keeps them aligned with the CSS header without the old
    // focus/resize/hover AppKit bridge.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHT_INSET_X,
                TRAFFIC_LIGHT_INSET_Y,
            ));
    }
    if let Some((px, py)) = position {
        builder = builder.position(px, py);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    finalize_native_window_chrome(&window);
    Ok(window)
}

/// spawn_panel with an explicit label + url (non-singleton instances).
#[allow(clippy::too_many_arguments)]
fn spawn_panel_at(
    app: &tauri::AppHandle,
    desc: &WidgetDescriptor,
    label: &str,
    url: &str,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<tauri::WebviewWindow, String> {
    build_card_window(
        app,
        label,
        url,
        &desc.title,
        (width.unwrap_or(desc.width), height.unwrap_or(desc.height)),
        (220.0, 120.0),
        x.zip(y),
    )
}

/// Allowlisted hub actions a settings panel may request. Panels own their
/// settings; a few actions only the hub window can perform (its WS
/// reconnect, its chat thread, its wizard) — those route through here as
/// named events, NEVER as arbitrary payloads.
const HUB_EVENT_NAMES: &[&str] = &[
    "fresh-thread",
    "profile-changed",
    "connection-changed",
    "machine-access-changed",
    "open-wizard",
];

/// Pure targeting decision for `hub_event`, unit-testable without a live
/// `AppHandle`. `open_labels` is every currently-open window label
/// (`app.webview_windows()`'s keys — see `write_panel_layout` above for the
/// same enumeration precedent).
///
/// Step 1c (plan): ONLY the connection-affecting events widen.
///   - "profile-changed" / "connection-changed": every window holds its OWN
///     socket and credential, so a route switch must reach every open
///     window, not just main+panel-chat (the fan-out gap this plan closes -
///     parallel chat panels and the twelve panel kinds never heard it).
///   - "fresh-thread": UNCHANGED targeting. The chat window owns the thread
///     (Phase 4); the hub is the fallback opener when chat is closed. This
///     semantics must not move.
///   - "machine-access-changed": fans out like the connection events, and for
///     the same reason - every window carries its own LocalShell capability
///     announcement, so a machine-access flip must reach all of them.
///     (Until this arm existed the name was not even in HUB_EVENT_NAMES, so
///     the settings toggle's invoke had been silently REJECTED since it
///     shipped - wiring.ts's handler was unreachable and only the flipping
///     window ever re-read the value. Found by the #598 review.)
///   - anything else (today: "open-wizard"): UNCHANGED, hub-owned, "main" only.
fn hub_event_targets(name: &str, chat_open: bool, open_labels: &[String]) -> Vec<String> {
    match name {
        "fresh-thread" if chat_open => vec!["panel-chat".to_string()],
        "profile-changed" | "connection-changed" | "machine-access-changed" => {
            open_labels.to_vec()
        }
        _ => vec!["main".to_string()],
    }
}

/// Forward an allowlisted action to the window(s) that own it (`hub-event`
/// with a `for:` payload — the same targeted-event discipline as dock-group).
/// Most actions are hub-owned; `fresh-thread` belongs to the CHAT widget
/// (Phase 4: the chat window owns the thread). When the chat window is
/// closed, fresh-thread falls back to the hub, whose handler opens it (a
/// fresh boot lands on the thread bootstrap). `profile-changed` and
/// `connection-changed` fan out to EVERY open window (Step 1c) — see
/// `hub_event_targets`'s doc comment for the full targeting rules.
#[tauri::command]
pub(crate) fn hub_event(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !HUB_EVENT_NAMES.contains(&name.as_str()) {
        return Err(format!("unknown hub event: {name}"));
    }
    let chat_open = app.get_webview_window("panel-chat").is_some();
    let open_labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    let targets = hub_event_targets(&name, chat_open, &open_labels);
    for target in &targets {
        app.emit_to(
            tauri::EventTarget::labeled(target),
            "hub-event",
            serde_json::json!({ "for": target, "name": name }),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a SYSTEM widget by registry kind: singleton focus, panel-* label
/// namespace. A caller may provide an explicit position; otherwise macOS owns
/// initial placement. Unknown kinds are rejected; the registry is the trust
/// boundary.
#[tauri::command]
pub(crate) async fn open_widget(
    app: tauri::AppHandle,
    kind: String,
    params: Option<serde_json::Value>,
    x: Option<f64>,
    y: Option<f64>,
    // When false, show/reposition without stealing keyboard focus (drag-follow).
    // Defaults to true for normal open paths.
    focus: Option<bool>,
) -> Result<String, String> {
    let should_focus = focus.unwrap_or(true);
    let desc = registry_lookup(&kind).ok_or_else(|| format!("unknown widget kind: {kind}"))?;
    if desc.trust != "system" {
        return Err(format!("kind {kind} is not a system widget"));
    }
    let params = params.unwrap_or(serde_json::Value::Null);
    // No params → the kind's base window (one per kind). WITH params → one
    // window per DISTINCT params-set (deterministic hash label), regardless
    // of the singleton flag: open_widget('chat') is the main line, while
    // open_widget('chat', {thread}) is a Phase 8 direct line in its own
    // window — same params always focus the same instance.
    let (label, url) = if params.is_null() {
        (panel_label(&kind), desc.page.clone())
    } else {
        (
            panel_instance_label(&kind, &params),
            panel_url_with_params(&desc.page, &params),
        )
    };
    // The label only carries a hash of the params; remember the params
    // themselves so write_panel_layout can persist instance panels and the
    // boot restore can replay them (without this, every non-singleton panel
    // silently vanished on restart).
    if !params.is_null() {
        record_instance_params(&label, &params);
    }
    // Singleton (or same-params instance): already open → show (+ optional focus).
    // When the caller passes x/y (drag-out pull / re-drop), also re-place so
    // an early-spawned floater can track the pointer without a second IPC surface.
    // Mid-drag follow MUST pass focus=false or AppKit focus thrash freezes the gesture.
    if let Some(win) = app.get_webview_window(&label) {
        if let (Some(px), Some(py)) = (x, y) {
            let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(px, py)));
        }
        // A panel the user OS-minimized via the yellow traffic-light is
        // miniaturized in the Dock, and on macOS NEITHER show() NOR
        // set_focus() deminiaturizes — so every existing-window reopen path
        // (hub fresh-thread, server widget-open frames, the wizard's "Start
        // chatting", the expand fallback) left it stranded as a Dock/shelf
        // tile: alive in the AX tree, never composited. Same rule as
        // expand_out_of_moon and redock_thread: unminimize first (a no-op on
        // non-minimized windows).
        let _ = win.unminimize();
        let _ = win.show();
        if should_focus {
            let _ = win.set_focus();
        }
        return Ok(label);
    }
    // Snap-on-open: a fresh panel with no explicit position docks onto the
    // chat's edge (WinAmp-style — see the snap section below). Explicit x/y
    // (drag-out pull, layout restore) skips it: the caller placed the window.
    // The chat itself and the transient launcher never snap-on-open.
    let (x, y, snapped_open) =
        if x.is_none() && y.is_none() && kind != "chat" && kind != "launcher" {
            match open_snap_top_left(&app, desc.width, desc.height) {
                Some((sx, sy)) => (Some(sx), Some(sy), true),
                None => (x, y, false),
            }
        } else {
            (x, y, false)
        };
    let win = spawn_panel_at(&app, desc, &label, &url, x, y, None, None)?;
    if snapped_open {
        // Flush to a neighbor → become its AppKit child so anchor drags tow it.
        attach_to_flush_neighbor(&win);
    }
    if should_focus {
        let _ = win.set_focus();
    }
    let win_label = win.label().to_string();
    // A new panel is layout-relevant immediately (a crash before the first
    // Moved event must not lose it).
    write_panel_layout(&app);
    Ok(win_label)
}

/// Pop an artifact out into its own widget window (or focus it if already open).
/// Returns the window label so the caller can track it for layout persistence.
#[tauri::command]
pub(crate) async fn open_artifact_widget(
    app: tauri::AppHandle,
    artifact_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let label = widget_label(&artifact_id);
    // Already open → focus, don't spawn a duplicate. Unminimize first: on
    // macOS neither show() nor set_focus() deminiaturizes an OS-minimized
    // window (see the same rule in open_widget above).
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(label);
    }
    // A dedicated, self-contained page (NOT index.html) — keeps the widget
    // runtime isolated from the moon monolith. The real id rides in the query.
    let url = format!("widget.html?id={}", encode_query_value(&artifact_id));
    // Snap-on-open: same as open_widget — a fresh widget with no explicit
    // position docks onto the chat's edge and rides its drags.
    let (x, y, snapped_open) = if x.is_none() && y.is_none() {
        match open_snap_top_left(
            &app,
            width.unwrap_or(360.0),
            height.unwrap_or(440.0),
        ) {
            Some((sx, sy)) => (Some(sx), Some(sy), true),
            None => (x, y, false),
        }
    } else {
        (x, y, false)
    };
    let win = build_card_window(
        &app,
        &label,
        &url,
        if title.is_empty() { "Artifact" } else { &title },
        (width.unwrap_or(360.0), height.unwrap_or(440.0)),
        (220.0, 160.0),
        x.zip(y),
    )?;
    if snapped_open {
        attach_to_flush_neighbor(&win);
    }
    Ok(label)
}

/// Close a widget window by label. No-op if it is already gone.
///
/// A Tauri command capability gates only WHETHER a window may invoke the
/// command, not WHICH window the body acts on — so this command, granted to
/// widget-* windows, must enforce the per-window boundary itself: it refuses
/// any label outside the `widget-` namespace so a widget can never reach up and
/// close the main chat window (review G3). The widget.html host renders
/// sandboxed agent content, so this guard is defence-in-depth.
#[tauri::command]
pub(crate) async fn close_widget(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if !is_dock_label(&label) {
        return Ok(()); // refuse to close anything but a widget window
    }
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pure `redock-thread` payload builder (testable without a webview).
/// `view_mode` (plan Step 3): `Some(true)` when the redocking floater had
/// the verbose view enabled - the owner window's JS listener applies it
/// (enable-only, never disables an already-verbose owner). `None`/`Some(false)`
/// are both omitted-equivalent on the JS side, which only ever checks truthiness.
fn build_redock_thread_payload(
    thread_id: &str,
    draft: Option<&str>,
    from: &str,
    y_ratio: Option<f64>,
    view_mode: Option<bool>,
) -> serde_json::Value {
    serde_json::json!({
        "threadId": thread_id,
        "draft": draft,
        "from": from,
        "yRatio": y_ratio,
        "viewMode": view_mode,
    })
}

/// Redock a pinned chat floater into its owner window (issue #380).
///
/// Used by the explicit Redock button and by live drag-release when the floater
/// center is over the owner's left dock strip. Focuses the owner, emits
/// `redock-thread` with thread id + optional draft + insert hint + view mode
/// (plan Step 3), then closes the caller. Returns false (no error) when the
/// call is invalid so the page can fall back to just closing.
#[tauri::command]
pub(crate) async fn redock_thread(
    window: tauri::WebviewWindow,
    thread_id: String,
    owner_label: String,
    draft: Option<String>,
    y_ratio: Option<f64>,
    view_mode: Option<bool>,
) -> Result<bool, String> {
    let app = window.app_handle().clone();
    let caller_label = window.label().to_string();
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Ok(false);
    }
    // Only a dockable panel/widget may be closed this way; never redock into self.
    if !is_dock_label(&caller_label) || owner_label == caller_label {
        return Ok(false);
    }
    // Owner must be a real dock window (main line is panel-chat; never the hub).
    if !is_dock_label(&owner_label) {
        return Ok(false);
    }
    let owner = match app.get_webview_window(&owner_label) {
        Some(w) => w,
        None => return Ok(false),
    };
    let _ = owner.unminimize();
    let _ = owner.show();
    let _ = owner.set_focus();
    // Clear any live preview chrome before the adopt event.
    let _ = app.emit_to(
        tauri::EventTarget::labeled(&owner_label),
        "redock-preview",
        serde_json::json!({ "active": false, "threadId": thread_id, "from": caller_label }),
    );
    app.emit_to(
        tauri::EventTarget::labeled(&owner_label),
        "redock-thread",
        build_redock_thread_payload(&thread_id, draft.as_deref(), &caller_label, y_ratio, view_mode),
    )
    .map_err(|e| e.to_string())?;
    window.close().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Pure center-in-rect test (testable without a webview). `(px,py)` is the
/// floater's center; `(rx,ry,rw,rh)` the owner rect — all in the same px space.
/// Edges are inclusive so a drop exactly on the border still redocks.
fn center_in_rect(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

/// Horizontal proximity to the owner's left dock strip, in `[0, 1]`.
/// Ramps from 0 outside an approach band to 1 deep inside the strip.
fn redock_proximity(center_x: f64, owner_x: f64, strip_w: f64) -> f64 {
    let strip_right = owner_x + strip_w;
    let approach = strip_w.max(80.0); // soft band to the right of the strip
    if center_x <= strip_right {
        // Inside strip: full proximity once past the left edge.
        if center_x < owner_x {
            return 0.0;
        }
        return 1.0;
    }
    // To the right of the strip: fall off across `approach` px.
    let dist = center_x - strip_right;
    if dist >= approach {
        return 0.0;
    }
    (1.0 - dist / approach).clamp(0.0, 1.0)
}

#[cfg(test)]
mod redock_geometry_tests {
    use super::{center_in_rect, redock_proximity};

    #[test]
    fn center_in_rect_inside_outside_and_edges() {
        // Owner at (100,100), 400x300 → spans x[100,500], y[100,400].
        assert!(center_in_rect(300.0, 250.0, 100.0, 100.0, 400.0, 300.0)); // dead center
        assert!(center_in_rect(100.0, 100.0, 100.0, 100.0, 400.0, 300.0)); // top-left corner
        assert!(center_in_rect(500.0, 400.0, 100.0, 100.0, 400.0, 300.0)); // bottom-right
        assert!(!center_in_rect(99.0, 250.0, 100.0, 100.0, 400.0, 300.0)); // just left
        assert!(!center_in_rect(300.0, 401.0, 100.0, 100.0, 400.0, 300.0)); // just below
        assert!(!center_in_rect(600.0, 250.0, 100.0, 100.0, 400.0, 300.0)); // far right
    }

    #[test]
    fn redock_proximity_ramps_into_strip() {
        let owner_x = 100.0;
        let strip = 300.0;
        // Deep inside strip
        assert!((redock_proximity(200.0, owner_x, strip) - 1.0).abs() < 1e-9);
        // Far to the right of strip+approach
        assert!((redock_proximity(1000.0, owner_x, strip) - 0.0).abs() < 1e-9);
        // Just outside strip edge (strip_right = 400): mid approach
        let mid = redock_proximity(400.0 + 150.0, owner_x, strip);
        assert!(mid > 0.4 && mid < 0.6, "mid proximity was {mid}");
    }
}

/// A window's outer rect in logical points for layout persistence.
fn window_logical_rect(w: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    let sf = w.scale_factor().unwrap_or(1.0);
    // Round instead of truncating so saved positions remain stable on Retina
    // displays where a physical pixel can land at n.5 logical points.
    Some((
        (f64::from(p.x) / sf).round() as i32,
        (f64::from(p.y) / sf).round() as i32,
        (f64::from(s.width) / sf).round() as i32,
        (f64::from(s.height) / sf).round() as i32,
    ))
}
// ── On-screen position clamping ──────────────────────────────────────────────
//
// Nothing guarantees a window stays on a connected display: a display-topology
// change (or a drag that ended past the edge) can leave a window parked at a
// negative X where no display exists. For a panel that is an annoyance; for
// the moon ORB it is fatal — the orb and the widgets are mutually exclusive
// (lifecycle.rs), so an off-screen orb leaves the user with NO clickable Luna
// surface at all (reads as "Moon won't open"). The boot-time layout restore
// and every path that (re)shows the orb clamp through here.

/// Minimum logical points of a window's top-left that must stay reachable
/// inside a monitor so its title bar / body can always be grabbed.
pub(crate) const ON_SCREEN_MARGIN: f64 = 80.0;

/// Logical bounds `((x, y), (w, h))` of every connected monitor.
pub(crate) fn monitor_bounds(app: &tauri::AppHandle) -> Vec<((f64, f64), (f64, f64))> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            (
                (
                    f64::from(m.position().x) / sf,
                    f64::from(m.position().y) / sf,
                ),
                (m.size().width as f64 / sf, m.size().height as f64 / sf),
            )
        })
        .collect()
}

/// Clamp a logical top-left point onto a currently-visible display. The point
/// clamps into the monitor that CONTAINS it (multi-display setups); when no
/// monitor contains it (display unplugged, stale layout, drag past the edge),
/// it clamps into the FIRST monitor rather than staying stranded off every
/// display. An empty monitor list (headless race at boot) returns the point
/// unchanged — never invent a position.
pub(crate) fn clamp_point_to_monitors(
    monitors: &[((f64, f64), (f64, f64))],
    x: f64,
    y: f64,
) -> (f64, f64) {
    if monitors.is_empty() {
        return (x, y);
    }
    let containing = monitors
        .iter()
        .find(|((mx, my), (mw, mh))| x >= *mx && x < mx + mw && y >= *my && y < my + mh);
    let ((mx, my), (mw, mh)) = containing.unwrap_or(&monitors[0]);
    (
        x.clamp(*mx, (mx + mw - ON_SCREEN_MARGIN).max(*mx)),
        y.clamp(*my, (my + mh - ON_SCREEN_MARGIN).max(*my)),
    )
}

/// Is a logical top-left point on ANY connected monitor?
pub(crate) fn point_on_any_monitor(
    monitors: &[((f64, f64), (f64, f64))],
    x: f64,
    y: f64,
) -> bool {
    monitors
        .iter()
        .any(|((mx, my), (mw, mh))| x >= *mx && x < mx + mw && y >= *my && y < my + mh)
}

/// Move `win` back onto a visible display if its top-left is off every
/// monitor (or within the grab margin of a far edge). Best-effort: missing
/// geometry (no monitors yet, no window rect) leaves the window untouched.
pub(crate) fn ensure_window_on_visible_display(win: &tauri::WebviewWindow) {
    let monitors = monitor_bounds(win.app_handle());
    let Some((x, y, _w, _h)) = window_logical_rect(win) else {
        return;
    };
    let (cx, cy) = clamp_point_to_monitors(&monitors, f64::from(x), f64::from(y));
    if (cx - f64::from(x)).abs() >= 1.0 || (cy - f64::from(y)).abs() >= 1.0 {
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(cx, cy)));
    }
}

/// Moved-event guard for the ORB (live incident): something OUTSIDE Moon's
/// own code — a display-topology change, stale AppKit saved state after a
/// non-clean relaunch, an external mover — can park the orb with its top-left
/// off every connected display, where the user cannot click it. This guard
/// pulls it back whenever that happens, no matter who moved it.
///
/// It deliberately acts ONLY when the top-left is on NO monitor at all: a
/// user drag that intentionally hangs the orb over an edge (top-left still on
/// a display) is respected, and our own corrective `set_position` lands the
/// window ON a monitor, so the next Moved event is a no-op — the guard
/// converges instead of looping.
pub(crate) fn reclamp_if_stranded(win: &tauri::WebviewWindow) {
    let monitors = monitor_bounds(win.app_handle());
    if monitors.is_empty() {
        return;
    }
    let Some((x, y, _w, _h)) = window_logical_rect(win) else {
        return;
    };
    if point_on_any_monitor(&monitors, f64::from(x), f64::from(y)) {
        return;
    }
    let (cx, cy) = clamp_point_to_monitors(&monitors, f64::from(x), f64::from(y));
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(cx, cy)));
}

/// Opt a window out of macOS window-state restoration (Lion "Resume",
/// `~/Library/Saved Application State/`). Moon owns its own layout
/// persistence — `~/.luna/layout.json` plus the boot restore in main.rs — so
/// AppKit's saved state must never compete: after a NON-clean exit (the
/// auto-updater's relaunch, a force kill) restoration re-imposes STALE frames
/// and visibility from the previous session — an off-screen orb frame, a
/// window that exists in the AX tree but never composites — over whatever
/// Moon's own restore just did. Best-effort, like the rest of the native
/// chrome finalization.
///
/// Binding verified two ways from the Linux dev sandbox: against the
/// objc2-app-kit 0.3.2 crate source (safe `pub fn setRestorable(&self, bool)`
/// in generated/NSWindowRestoration.rs, gated on the `NSWindowRestoration` +
/// `NSResponder` features now enabled in Cargo.toml), and TYPE-CHECKED for
/// the real Apple target (`cargo check --target aarch64-apple-darwin` on an
/// isolated probe crate pinning the same versions/features, exercising this
/// exact call plus configure_orb_window's collection-behavior union and
/// activate_app's activation). A full macOS build/link and the live Stage
/// Manager behavior check still require a real Mac.
#[cfg(target_os = "macos")]
pub(crate) fn disable_window_state_restoration(window: &tauri::WebviewWindow) {
    let _ = with_appkit_main_thread(window.clone(), |win| {
        use objc2_app_kit::NSWindow;
        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            ns_win.setRestorable(false);
        }
        Ok(())
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn disable_window_state_restoration(_window: &tauri::WebviewWindow) {}

/// One-time native behavior for the moon ORB (window "main"): a floating
/// desktop companion that must never be shelved or parked by the window
/// manager. Live incident: with Stage Manager active, the orb of an
/// inactive Moon was managed into the LEFT-EDGE TILE STRIP (the
/// WindowManager-owned icon-sized tiles at x≈-307, alongside every other
/// inactive app's tiles) — the only Luna surface on screen was a shelf
/// thumbnail, unclickable as a window, which reads as "Moon won't open".
///
/// - `CanJoinAllSpaces`: the orb follows the user onto every Space/stage —
///   an always-on-top companion, like a picture-in-picture window, is
///   pointless on a Space the user is not looking at. Windows with this
///   behavior are not stage-managed into the strip.
/// - `Stationary`: Exposé / Spaces transitions leave it alone.
/// - `IgnoresCycle`: Cmd-` window cycling skips the orb (it is a launcher
///   puck, not a document window).
///
/// The widget/panel windows deliberately do NOT get this: they are normal
/// workspace windows and SHOULD be managed like any app's windows; their
/// fix is `expand_out_of_moon` focusing one of them so the app activates
/// and its stage (real, composited windows) swaps in.
#[cfg(target_os = "macos")]
pub(crate) fn configure_orb_window(window: &tauri::WebviewWindow) {
    let _ = with_appkit_main_thread(window.clone(), |win| {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            ns_win.setCollectionBehavior(
                ns_win.collectionBehavior()
                    | NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
        }
        Ok(())
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_orb_window(_window: &tauri::WebviewWindow) {}

/// Explicitly activate Moon regardless of any single window's focusability.
///
/// Under Stage Manager only the ACTIVE app's stage is composited; an
/// inactive app's windows sit as left-strip shelf tiles (live incident:
/// panel-chat AX-present with no CG surface, the orb a 121×128 tile at
/// x≈-307). tao's `set_focus` does activate the app — but it silently
/// no-ops when its target window reports not-visible at call time, and
/// expand must NEVER lose the activation to that early-return: activation
/// is the one call that swaps Moon's composited stage in. The `window`
/// argument is only a handle to reach the AppKit main thread.
#[cfg(target_os = "macos")]
pub(crate) fn activate_app(window: &tauri::WebviewWindow) {
    let _ = with_appkit_main_thread(window.clone(), |_win| {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        let Some(mtm) = MainThreadMarker::new() else {
            return Ok(());
        };
        // activateIgnoringOtherApps is soft-deprecated in favor of
        // activate(), but activate() (macOS 14 cooperative activation) may
        // decline when another app is frontmost — and expand IS the user's
        // explicit "bring Moon forward" gesture, so the assertive form is
        // the correct one here.
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        Ok(())
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn activate_app(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod clamp_tests {
    use super::{clamp_point_to_monitors, point_on_any_monitor};

    /// The live-incident topology: a 2560×1440 main display at (0,0) plus a
    /// built-in display below it. The orb was parked at (-307, 393) — off the
    /// left edge where no display exists — leaving nothing clickable.
    fn dual_monitors() -> Vec<((f64, f64), (f64, f64))> {
        vec![
            ((0.0, 0.0), (2560.0, 1440.0)),
            ((560.0, 1440.0), (1512.0, 982.0)),
        ]
    }

    #[test]
    fn point_off_the_left_edge_clamps_back_onto_the_first_monitor() {
        // The exact live incident: orb at x=-307 with no display to the left.
        let (x, y) = clamp_point_to_monitors(&dual_monitors(), -307.0, 393.0);
        assert_eq!((x, y), (0.0, 393.0));
    }

    #[test]
    fn point_inside_a_monitor_is_unchanged() {
        let (x, y) = clamp_point_to_monitors(&dual_monitors(), 650.0, 201.0);
        assert_eq!((x, y), (650.0, 201.0));
    }

    #[test]
    fn point_on_a_secondary_monitor_stays_there() {
        let (x, y) = clamp_point_to_monitors(&dual_monitors(), 800.0, 1500.0);
        assert_eq!((x, y), (800.0, 1500.0));
    }

    #[test]
    fn point_near_the_far_edge_keeps_the_grab_margin() {
        // Top-left just inside the right edge: pulled back so ≥80pt of the
        // window stays reachable (2560 − 80 = 2480).
        let (x, _) = clamp_point_to_monitors(&dual_monitors(), 2555.0, 100.0);
        assert_eq!(x, 2480.0);
    }

    #[test]
    fn point_past_the_bottom_right_of_everything_clamps_into_the_first_monitor() {
        let (x, y) = clamp_point_to_monitors(&dual_monitors(), 9000.0, 9000.0);
        assert_eq!((x, y), (2480.0, 1360.0));
    }

    #[test]
    fn empty_monitor_list_returns_the_point_unchanged() {
        // Headless race at boot: never invent (0,0) — a later show re-clamps.
        assert_eq!(
            clamp_point_to_monitors(&[], -307.0, 393.0),
            (-307.0, 393.0)
        );
    }

    // ── point_on_any_monitor: the Moved-event guard's trigger condition ──

    #[test]
    fn stranded_points_are_off_every_monitor_and_contained_points_are_not() {
        let m = dual_monitors();
        // Both live observations of the parked orb trigger the guard.
        assert!(!point_on_any_monitor(&m, -307.0, 393.0));
        assert!(!point_on_any_monitor(&m, -323.0, 386.0));
        // On-screen points — including the corrected orb position (15, 408)
        // and a point on the secondary display — must NOT trigger it, so a
        // legitimate user drag is never fought.
        assert!(point_on_any_monitor(&m, 15.0, 408.0));
        assert!(point_on_any_monitor(&m, 650.0, 201.0));
        assert!(point_on_any_monitor(&m, 800.0, 1500.0));
    }

    #[test]
    fn moved_guard_converges_because_a_clamped_stranded_point_is_on_a_monitor() {
        // The guard's no-loop invariant: clamping a stranded point always
        // lands ON a monitor, so the Moved event our own set_position fires
        // is a no-op — re-parking by an external mover can ping-pong, but
        // every cycle ends with the orb on-screen.
        let m = dual_monitors();
        let (x, y) = clamp_point_to_monitors(&m, -323.0, 386.0);
        assert!(point_on_any_monitor(&m, x, y));
        let (x2, y2) = clamp_point_to_monitors(&m, 9000.0, -500.0);
        assert!(point_on_any_monitor(&m, x2, y2));
    }
}

/// AppKit / NSWindow APIs must run on the process main thread. Tauri invokes
/// commands on a tokio worker — calling objc from there raises an NSException
/// that Rust cannot catch (`foreign exception → abort`). Dispatch through the
/// webview window's main-thread queue when we aren't already on it.
#[cfg(target_os = "macos")]
fn with_appkit_main_thread<R: Send + 'static>(
    window: tauri::WebviewWindow,
    f: impl FnOnce(&tauri::WebviewWindow) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    if unsafe { libc::pthread_main_np() != 0 } {
        return f(&window);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(&win));
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|_| "main-thread AppKit handler dropped".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn with_appkit_main_thread<R>(
    window: tauri::WebviewWindow,
    f: impl FnOnce(&tauri::WebviewWindow) -> Result<R, String>,
) -> Result<R, String> {
    f(&window)
}

/// Finish the native macOS title bar once, immediately after construction.
///
/// `TitleBarStyle::Overlay` keeps the standard AppKit buttons in the title-bar
/// hierarchy, but on transparent accessory windows they can be left hidden by
/// the initial layout pass. Explicitly revealing those existing NSButtons is a
/// one-time native-window setup — there is no webview IPC, hover choreography,
/// resize observer, or replacement control model. Every window keeps all three
/// standard AppKit buttons ENABLED: the zoom (green) button is never disabled,
/// because a disabled NSWindow zoom button renders as a gray dot instead of
/// green, which reads as broken chrome. (tao already leaves it enabled once the
/// window is built with `maximizable(true)`; this function must not re-disable
/// it.)
///
/// Zoom means ZOOM, never native fullscreen: `FullScreenNone` opts the window
/// out of the fullscreen Space, so a plain green-button click resizes within
/// the current screen. A transparent, shadowless card on a fullscreen Space
/// would sit on a black backdrop with dead transparent margins.
#[cfg(target_os = "macos")]
fn configure_native_window_chrome(window: &tauri::WebviewWindow) -> Result<(), String> {
    with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::{
            NSTitlebarSeparatorStyle, NSView, NSWindow, NSWindowButton, NSWindowCollectionBehavior,
        };

        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            ns_win.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
            ns_win.setCollectionBehavior(
                ns_win.collectionBehavior() | NSWindowCollectionBehavior::FullScreenNone,
            );

            let Some(close) = ns_win.standardWindowButton(NSWindowButton::CloseButton) else {
                return Ok(());
            };
            let Some(minimize) = ns_win.standardWindowButton(NSWindowButton::MiniaturizeButton)
            else {
                return Ok(());
            };
            let zoom = ns_win.standardWindowButton(NSWindowButton::ZoomButton);

            // Revealing a standard button makes AppKit restore the cluster's
            // default frame, so reapply the builder inset after the reveal.
            // This is the same native hierarchy Tauri/Wry configures, finalized
            // once after the transparent overlay window is actually alive.
            let Some(group) = close.superview() else {
                return Ok(());
            };
            let Some(container) = group.superview() else {
                return Ok(());
            };
            group.setHidden(false);
            group.setAlphaValue(1.0);
            container.setHidden(false);
            container.setAlphaValue(1.0);
            let close_rect = NSView::frame(&close);
            // Keep AppKit's natural inter-button spacing (never invent one).
            let spacing = {
                let raw = NSView::frame(&minimize).origin.x - close_rect.origin.x;
                if raw > 1.0 {
                    raw
                } else {
                    20.0
                }
            };
            // Title-bar container tall enough for the button + breathing room
            // above/below (matches CSS .title-bar min-height ~36).
            let btn_h = close_rect.size.height.max(12.0);
            let title_bar_height = (btn_h + TRAFFIC_LIGHT_INSET_Y * 2.0).max(36.0);
            let mut container_rect = NSView::frame(&container);
            container_rect.size.height = title_bar_height;
            container_rect.origin.y = ns_win.frame().size.height - title_bar_height;
            container.setFrame(container_rect);

            let mut buttons = vec![close, minimize];
            if let Some(zoom) = zoom {
                buttons.push(zoom);
            }
            // Vertically center the cluster in the title-bar container; x is the
            // window-content inset (builder traffic_light_position contract).
            let btn_y = ((title_bar_height - btn_h) / 2.0).max(0.0);
            for (index, button) in buttons.into_iter().enumerate() {
                button.setHidden(false);
                button.setAlphaValue(1.0);
                let mut rect = NSView::frame(&button);
                rect.origin.x = TRAFFIC_LIGHT_INSET_X + (index as f64) * spacing;
                rect.origin.y = btn_y;
                button.setFrameOrigin(rect.origin);
            }
        }
        Ok(())
    })
}

/// Wire payload for `capture_window_screenshot`: a base64-encoded PNG (no
/// `data:` prefix) of the captured window.
#[derive(serde::Serialize)]
pub(crate) struct CaptureResult {
    base64: String,
}

/// Capture a screenshot of this window via native macOS window compositing
/// (the `screencapture` CLI targeting this window's CGWindowID) — NOT DOM
/// rasterization, which silently drops this app's SVG filter/backdrop-blur
/// chrome. Best-effort: ANY failure (Screen-Recording TCC denied,
/// `screencapture` missing/erroring, empty output, etc.) returns `Err` so
/// the frontend submits the feedback note without a screenshot rather than
/// blocking it — see FeedbackEngine._captureScreenshot in chat.html.
///
/// UNVERIFIED IN CI: this crate is macOS-only for this code path and this
/// dev sandbox is Linux, so `cargo check`/`cargo build` cannot compile-check
/// this function here. `NSWindow::windowNumber()` (a standard, decades-old
/// AppKit readonly NSInteger property) is assumed to be exposed by
/// objc2-app-kit 0.3.2's generated bindings the same way `standardWindowButton`
/// etc. already are in `configure_native_window_chrome` above — but this has
/// NOT been confirmed by an actual compile. Whoever builds this on a real Mac
/// (`cargo build` / `cargo tauri build`) MUST verify this compiles; if
/// `windowNumber()` isn't the right binding name, the ObjC symbol is
/// `-[NSWindow windowNumber]` and the CGWindowID passed to `screencapture -l`
/// must match it (screencapture's `-l` flag expects the same integer
/// CGWindowListCreateImage would use for that window).
#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) async fn capture_window_screenshot(window: tauri::WebviewWindow) -> Result<CaptureResult, String> {
    let window_id = with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::NSWindow;
        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
        let number = unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            ns_win.windowNumber()
        };
        Ok(number)
    })?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = std::env::temp_dir().join(format!(
        "luna-feedback-shot-{}-{}.png",
        std::process::id(),
        nanos
    ));

    // screencapture only writes to a path (no stdout-PNG mode for -l).
    // -x: no camera shutter sound. -o: no window-shadow border.
    let output = tokio::process::Command::new("screencapture")
        .arg("-x")
        .arg("-o")
        .arg("-t")
        .arg("png")
        .arg(format!("-l{}", window_id))
        .arg(&tmp_path)
        .output()
        .await
        .map_err(|e| format!("failed to spawn screencapture: {e}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "screencapture exited with {:?} (Screen Recording permission may be denied)",
            output.status.code()
        ));
    }

    let bytes = std::fs::read(&tmp_path).map_err(|e| format!("failed to read capture: {e}"))?;
    let _ = std::fs::remove_file(&tmp_path);
    if bytes.is_empty() {
        return Err("screencapture produced an empty file".to_string());
    }

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(CaptureResult { base64: STANDARD.encode(&bytes) })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) async fn capture_window_screenshot(_window: tauri::WebviewWindow) -> Result<CaptureResult, String> {
    Err("screenshot capture is only supported on macOS".to_string())
}

/// AppKit performs one deferred title-bar layout after a transparent overlay
/// window is shown. Apply the native chrome immediately, then once more after
/// that construction-only pass so AppKit cannot restore the hidden/default
/// button frames. Focus re-applies it as a safety net: if a slow boot lets
/// the deferred pass land after the timed retry, the first click on the
/// window heals its chrome instead of leaving it without a close affordance.
/// Best-effort by design — the window is already built and visible, so a
/// chrome failure must never fail the command that opened it.
#[cfg(target_os = "macos")]
fn finalize_native_window_chrome(window: &tauri::WebviewWindow) {
    // Every panel/widget opts out of AppKit saved-state restoration: Moon's
    // own layout.json restore is the single source of truth for frames and
    // visibility (see disable_window_state_restoration's doc comment).
    disable_window_state_restoration(window);
    if let Err(e) = configure_native_window_chrome(window) {
        eprintln!(
            "[moon] native chrome setup failed for {}: {e}",
            window.label()
        );
    }
    let retry = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let _ = configure_native_window_chrome(&retry);
    });
    let on_focus = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(true)) {
            let _ = configure_native_window_chrome(&on_focus);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn finalize_native_window_chrome(_window: &tauri::WebviewWindow) {}

// ── Native-speed window resize (macOS) ──────────────────────────────────────
//
// Moon cards are borderless transparent NSWindows. tao's `startResizeDragging`
// is a NO-OP on macOS (returns NotSupported), so resize was driven by a JS
// pointermove loop that fired setPosition/setSize over IPC each frame — laggy.
//
// This drives the whole gesture in Rust, EVENT-DRIVEN (no polling pacer): on
// `begin_native_resize` we capture the anchor and install two block-based
// NSEvent monitors on the MAIN thread, then return. AppKit then delivers each
// mouse move to the LOCAL monitor (LeftMouseDragged | LeftMouseUp) — on every
// drag we read `NSEvent::mouseLocation()`, recompute the frame from the anchor,
// and call `setFrame:display:`; on mouse-up we tear down. A GLOBAL monitor
// (LeftMouseUp) catches the release when the cursor is over ANOTHER app's
// window (the local monitor never sees those), so the monitors can't get stuck.
// We deliberately do NOT run a modal `nextEventMatchingMask:` loop — that
// starves the WKWebView run loop and freezes the page. All math is in Cocoa
// screen coordinates (bottom-left origin), the native space of mouseLocation /
// frame / setFrame — no logical/physical/flip conversion.

#[cfg(target_os = "macos")]
const RESIZE_MIN_W: f64 = 220.0;
#[cfg(target_os = "macos")]
const RESIZE_MIN_H: f64 = 120.0;

/// The fixed reference captured on gesture start (main thread). Cocoa coords:
/// `l`/`r`/`b`/`t` are the window's left/right/bottom/top edges; `off_x`/`off_y`
/// are the grab offsets from the grabbed edge to the cursor (so there's no jump
/// on the first frame). `n`/`s`/`e`/`w` are the active edges.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct Anchor {
    l: f64,
    r: f64,
    b: f64,
    t: f64,
    off_x: f64,
    off_y: f64,
    n: bool,
    s: bool,
    e: bool,
    w: bool,
}

/// Compute the new window frame from the fixed anchor and the current mouse
/// location (both in Cocoa screen coords). Moves the grabbed edge(s) to follow
/// the cursor, holding the opposite edge fixed, and clamps to the minimum size
/// by pulling the grabbed edge back so the fixed edge stays put. Math unchanged
/// from the old `resize_tick`.
#[cfg(target_os = "macos")]
fn resize_frame(a: Anchor, m: objc2_core_foundation::CGPoint) -> objc2_core_foundation::CGRect {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    let mut left = if a.w { m.x - a.off_x } else { a.l };
    let mut right = if a.e { m.x - a.off_x } else { a.r };
    let mut bottom = if a.s { m.y - a.off_y } else { a.b };
    let mut top = if a.n { m.y - a.off_y } else { a.t };

    // Clamp to the minimum size by moving the GRABBED edge so the fixed
    // (opposite) edge stays put.
    if right - left < RESIZE_MIN_W {
        if a.w {
            left = right - RESIZE_MIN_W;
        } else {
            right = left + RESIZE_MIN_W;
        }
    }
    if top - bottom < RESIZE_MIN_H {
        if a.s {
            bottom = top - RESIZE_MIN_H;
        } else {
            top = bottom + RESIZE_MIN_H;
        }
    }

    CGRect {
        origin: CGPoint { x: left, y: bottom },
        size: CGSize {
            width: right - left,
            height: top - bottom,
        },
    }
}

/// Holds the two live monitor tokens for one mouse gesture (native resize,
/// redock drag, pull-out drag). Lives in an `Rc<RefCell<…>>` created and used
/// ENTIRELY on the main thread (the monitors and their handler blocks only
/// ever run there, so `Rc`/`RefCell` is correct — no `Send` needed, and these
/// tokens are not Send anyway). `ended` guards the teardown so the local +
/// global monitors firing don't double-remove.
#[cfg(target_os = "macos")]
struct MouseMonitors {
    local: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    global: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    ended: bool,
}

/// Remove both monitors exactly once, under the `ended` guard. Returns false
/// when the gesture already ended — the second block to fire must not run the
/// settle a second time.
#[cfg(target_os = "macos")]
fn end_mouse_monitors(state: &std::cell::RefCell<MouseMonitors>) -> bool {
    let (local, global) = {
        let mut s = state.borrow_mut();
        if s.ended {
            return false;
        }
        s.ended = true;
        (s.local.take(), s.global.take())
    };
    unsafe {
        if let Some(tok) = local.as_ref() {
            let obj: &objc2::runtime::AnyObject = tok;
            objc2_app_kit::NSEvent::removeMonitor(obj);
        }
        if let Some(tok) = global.as_ref() {
            let obj: &objc2::runtime::AnyObject = tok;
            objc2_app_kit::NSEvent::removeMonitor(obj);
        }
    }
    true
}

/// Install the shared local+global NSEvent monitor pair for one mouse
/// gesture. MUST be called on the main thread (inside
/// `with_appkit_main_thread`): the state cell, the handler blocks, and the
/// monitor tokens all live there only — everything below is `Rc`/`RefCell`.
///
/// `on_drag` runs on each LeftMouseDragged, `on_up` runs ONCE on mouse-up,
/// after the monitors are torn down. The local monitor watches
/// LeftMouseDragged | LeftMouseUp for events delivered to our app; the global
/// monitor always ends on a LeftMouseUp delivered to ANOTHER app (the local
/// monitor never sees those — without it the monitors could get stuck when
/// the release lands off-window). When `track_global_drag` is set the global
/// mask gains LeftMouseDragged and off-app drags also dispatch to `on_drag` —
/// pull-out needs it because the local monitor starves while the cursor is
/// over another app's window; resize and redock only need the global up.
#[cfg(target_os = "macos")]
fn install_mouse_monitors<Drag, Up>(on_drag: Drag, on_up: Up, track_global_drag: bool)
where
    Drag: Fn() + 'static,
    Up: Fn() + 'static,
{
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    // Shared monitor state. Cloned into each handler block BEFORE the
    // monitors exist; the tokens are stored back in once `add*Monitor`
    // returns (chicken-and-egg: the block must be able to remove the
    // monitors, but they don't exist until after the block is built).
    let state = Rc::new(RefCell::new(MouseMonitors {
        local: None,
        global: None,
        ended: false,
    }));
    let on_drag = Rc::new(on_drag);

    // Teardown: remove BOTH monitors (once — guarded by `ended`), then run
    // the gesture's settle. Runs on the main thread (we're always called
    // from a monitor handler, which AppKit delivers on the main thread).
    let end = {
        let state = state.clone();
        let on_up = Rc::new(on_up);
        move || {
            if end_mouse_monitors(&state) {
                on_up();
            }
        }
    };

    // Local monitor: every LeftMouseDragged / LeftMouseUp delivered to our
    // app. On up (or no left button pressed) → end; else on_drag.
    // Returns the event unchanged (does NOT consume it).
    let local_block = {
        let end = end.clone();
        let on_drag = on_drag.clone();
        block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let ev = unsafe { event.as_ref() };
            let up = ev.r#type() == NSEventType::LeftMouseUp
                || NSEvent::pressedMouseButtons() & 1 == 0;
            if up {
                end();
            } else {
                on_drag();
            }
            event.as_ptr()
        })
    };

    // Global monitor: same up-test → end; else on_drag (reached only when the
    // mask includes LeftMouseDragged).
    let global_block = {
        let end = end.clone();
        let on_drag = on_drag.clone();
        block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let ev = unsafe { event.as_ref() };
            let up = ev.r#type() == NSEventType::LeftMouseUp
                || NSEvent::pressedMouseButtons() & 1 == 0;
            if up {
                end();
            } else {
                on_drag();
            }
        })
    };

    let global_mask = if track_global_drag {
        NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp
    } else {
        NSEventMask::LeftMouseUp
    };

    unsafe {
        let local: Option<Retained<AnyObject>> =
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                &local_block,
            );
        let global: Option<Retained<AnyObject>> =
            NSEvent::addGlobalMonitorForEventsMatchingMask_handler(global_mask, &global_block);
        let mut s = state.borrow_mut();
        s.local = local;
        s.global = global;
    }
}

/// Begin a native-speed resize of the calling card window. The whole gesture
/// runs in Rust (see the module comment above); the JS grip hands off here and
/// does nothing else until the pointer is released. `direction` is the grip id
/// ("n"/"s"/"e"/"w" and the diagonal combos like "ne"/"sw").
#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn begin_native_resize(window: tauri::WebviewWindow, direction: String) -> Result<(), String> {
    let has_n = direction.contains('n');
    let has_s = direction.contains('s');
    let has_e = direction.contains('e');
    let has_w = direction.contains('w');

    // Everything below is set up and lives ENTIRELY on the main thread: the
    // anchor capture, the Rc/RefCell state, the handler blocks, and the monitor
    // tokens. The closure captures only Send data (the `bool` edge flags, which
    // are Copy, and the `WebviewWindow`); the non-Send pieces are created inside
    // and never cross threads, so the closure stays `Send + 'static`.
    with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::{NSEvent, NSWindow};

        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;

        // Capture the anchor: window frame + cursor, both in Cocoa screen
        // coords, plus grab offsets so frame 0 doesn't jump.
        let anchor = unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            let f = ns_win.frame();
            let l = f.origin.x;
            let b = f.origin.y;
            let r = l + f.size.width;
            let t = b + f.size.height;
            let m = NSEvent::mouseLocation();
            let off_x = if has_w {
                m.x - l
            } else if has_e {
                m.x - r
            } else {
                0.0
            };
            let off_y = if has_n {
                m.y - t
            } else if has_s {
                m.y - b
            } else {
                0.0
            };
            Anchor {
                l,
                r,
                b,
                t,
                off_x,
                off_y,
                n: has_n,
                s: has_s,
                e: has_e,
                w: has_w,
            }
        };

        let win = win.clone();
        let app = win.app_handle().clone();
        install_mouse_monitors(
            // Drag: recompute the frame from the fixed anchor and apply it.
            move || {
                let m = NSEvent::mouseLocation();
                let frame = resize_frame(anchor, m);
                unsafe {
                    let ns_win: &NSWindow = &*ns_win_ptr.cast();
                    ns_win.setFrame_display(frame, true);
                }
            },
            // Up: notify JS the resize ended so it always resets the cursor
            // override and __LUNA_NATIVE_RESIZING__ — the webview never sees a
            // pointerup when the button is released outside the window. Then
            // persist layout.
            move || {
                let _ = win.emit("luna-resize-ended", ());
                write_panel_layout(&app);
            },
            false,
        );

        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn begin_native_resize(_window: tauri::WebviewWindow, _direction: String) -> Result<(), String> {
    // No native path off macOS — the JS grip falls back to the emulated loop.
    Ok(())
}

// ── Native drag-to-redock (macOS) ─────────────────────────────────────────────
//
// Redock-capable floaters MUST keep AppKit `startDragging` for window motion —
// a JS setPosition/setSize loop was tried and felt glitchy (same class of lag
// `begin_native_resize` was written to eliminate). Instead:
//
//   1. JS arms `begin_redock_drag` then calls `startDragging` (native move).
//   2. Rust installs NSEvent monitors (same pattern as native resize).
//   3. On LeftMouseDragged: pure geometry probe + throttled emit to owner
//      (insert gap) and to the floater (CSS scale only — never setSize).
//   4. On LeftMouseUp: emit `redock-drag-ended` so JS can redock with draft.
//
// No IPC from JS on the hot path. No modal event loop. Cocoa screen coords.

/// Throttle for `redock_preview_emitter`: coarse deltas keep JS sticky-insert
/// + FLIP owning the feel instead of flooding the owner with sub-pixel
/// yRatio churn.
#[cfg(target_os = "macos")]
struct RedockThrottle {
    last_over: bool,
    last_prox: f64,
    last_y: f64,
}

/// Build the shared per-drag preview emitter for the redock strip gestures
/// (`begin_redock_drag` and `begin_native_pullout_drag`): throttled
/// `redock-preview` to the owner + `redock-self-preview` to the floater, fed
/// by each gesture's own Cocoa geometry step. `from_label` is the dragged
/// window's own label.
#[cfg(target_os = "macos")]
fn redock_preview_emitter(
    app: tauri::AppHandle,
    floater: tauri::WebviewWindow,
    owner_label: String,
    thread_id: String,
    from_label: String,
    title: String,
) -> impl Fn(bool, f64, f64) + Clone {
    let throttle = std::rc::Rc::new(std::cell::RefCell::new(RedockThrottle {
        last_over: false,
        last_prox: -1.0,
        last_y: -1.0,
    }));
    move |over: bool, proximity: f64, y_ratio: f64| {
        {
            let mut s = throttle.borrow_mut();
            // Coarser thresholds: JS sticky-insert + FLIP own the feel;
            // avoid flooding the owner with sub-pixel yRatio churn.
            let prox_delta = (proximity - s.last_prox).abs();
            let y_delta = (y_ratio - s.last_y).abs();
            let changed = over != s.last_over || prox_delta > 0.06 || y_delta > 0.04;
            if !changed && s.last_prox >= 0.0 {
                return;
            }
            s.last_over = over;
            s.last_prox = proximity;
            s.last_y = y_ratio;
        }
        let _ = app.emit_to(
            tauri::EventTarget::labeled(&owner_label),
            "redock-preview",
            serde_json::json!({
                "active": true,
                "over": over,
                "proximity": proximity,
                "yRatio": y_ratio,
                "threadId": thread_id,
                "title": title,
                "from": from_label,
            }),
        );
        let _ = floater.emit(
            "redock-self-preview",
            serde_json::json!({
                "active": true,
                "over": over,
                "proximity": proximity,
            }),
        );
    }
}

/// Build the shared gesture-end settle emitter for the redock strip gestures:
/// clears the preview chrome on both windows, then emits `redock-drag-ended`
/// to the floater — the owner session still owns the pointerUp outcome; the
/// floater emit is for path parity (title-bar redock listeners). `pullout`
/// marks pull-out drags (`"pullout": true` on the ended payload).
#[cfg(target_os = "macos")]
fn redock_end_emitter(
    app: tauri::AppHandle,
    floater: tauri::WebviewWindow,
    owner_label: String,
    thread_id: String,
    from_label: String,
    pullout: bool,
) -> impl Fn(bool, f64) + Clone {
    move |over: bool, y_ratio: f64| {
        let _ = app.emit_to(
            tauri::EventTarget::labeled(&owner_label),
            "redock-preview",
            serde_json::json!({
                "active": false,
                "threadId": thread_id,
                "from": from_label,
            }),
        );
        let _ = floater.emit(
            "redock-self-preview",
            serde_json::json!({ "active": false, "over": false, "proximity": 0.0 }),
        );
        let mut payload = serde_json::json!({
            "over": over,
            "yRatio": y_ratio,
            "threadId": thread_id,
            "ownerLabel": owner_label,
        });
        if pullout {
            payload["pullout"] = serde_json::json!(true);
        }
        let _ = floater.emit("redock-drag-ended", payload);
    }
}

/// Default strip band when JS does not report live sidebar width (pt).
#[cfg(target_os = "macos")]
const REDOCK_STRIP_DEFAULT: f64 = 240.0;
/// Vertical magnet beyond owner top/bottom (Chrome-like strip feel), Cocoa pt.
#[cfg(target_os = "macos")]
const REDOCK_STRIP_MAGNET_Y: f64 = 15.0;

/// Cocoa-space hit test for redock.
///
/// - `over` uses floater **center** in the left strip band (stable while dragging).
/// - `y_ratio` uses the **mouse** Y mapped through the thread **list** band
///   (`strip_top_inset` + `strip_height` from JS), so drop order matches where
///   the cursor is - not the bottom of the pane and not the full window height.
///
/// Returns `(over, proximity, y_ratio)` with y_ratio 0 at list top, 1 at bottom.
#[cfg(target_os = "macos")]
unsafe fn redock_hit_cocoa(
    floater: &objc2_app_kit::NSWindow,
    owner: &objc2_app_kit::NSWindow,
    strip_w: f64,
    strip_top_inset: f64,
    strip_height: f64,
) -> (bool, f64, f64) {
    use objc2_app_kit::NSEvent;

    let ff = floater.frame();
    let of = owner.frame();
    let ccx = ff.origin.x + ff.size.width / 2.0;
    let ccy = ff.origin.y + ff.size.height / 2.0;
    let m = NSEvent::mouseLocation();
    let strip = strip_w
        .max(80.0)
        .min(if of.size.width > 1.0 {
            of.size.width
        } else {
            REDOCK_STRIP_DEFAULT
        });
    let magnet = REDOCK_STRIP_MAGNET_Y;
    // Accept either floater center or cursor in the strip (cursor is what the
    // user aims with when choosing a drop slot).
    let over = center_in_rect(
        ccx,
        ccy,
        of.origin.x,
        of.origin.y - magnet,
        strip,
        of.size.height + 2.0 * magnet,
    ) || center_in_rect(
        m.x,
        m.y,
        of.origin.x,
        of.origin.y - magnet,
        strip,
        of.size.height + 2.0 * magnet,
    );
    let proximity = redock_proximity(ccx, of.origin.x, strip);
    // Map mouse into the list band (webview top → list top/height, Cocoa y up).
    let owner_top = of.origin.y + of.size.height;
    let top_inset = if strip_top_inset.is_finite() && strip_top_inset >= 0.0 {
        strip_top_inset
    } else {
        0.0
    };
    let list_h = if strip_height.is_finite() && strip_height > 1.0 {
        strip_height
    } else {
        of.size.height.max(1.0)
    };
    let strip_top = owner_top - top_inset;
    let y_ratio = ((strip_top - m.y) / list_h).clamp(0.0, 1.0);
    (over, proximity, y_ratio)
}

/// Arm live redock tracking for the calling floater. Call immediately before
/// `startDragging()`. Each arm is independent; mouse-up tears monitors down.
///
/// Strip metrics from the owner webview (logical points):
/// - `strip_width` — sidebar width
/// - `strip_top_inset` — distance from window content top to the thread list top
/// - `strip_height` — thread list height (maps mouse Y → insert ratio)
#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn begin_redock_drag(
    window: tauri::WebviewWindow,
    owner_label: String,
    thread_id: String,
    title: Option<String>,
    strip_width: Option<f64>,
    strip_top_inset: Option<f64>,
    strip_height: Option<f64>,
) -> Result<(), String> {
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Ok(());
    }
    if !is_dock_label(&owner_label) {
        return Ok(());
    }
    let caller_label = window.label().to_string();
    if !is_dock_label(&caller_label) || owner_label == caller_label {
        return Ok(());
    }
    let strip_w = strip_width
        .filter(|w| w.is_finite() && *w > 40.0)
        .unwrap_or(REDOCK_STRIP_DEFAULT);
    let strip_top = strip_top_inset
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0);
    let strip_h = strip_height
        .filter(|v| v.is_finite() && *v > 1.0)
        .unwrap_or(0.0);

    with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::NSWindow;

        let floater_ptr = win.ns_window().map_err(|e| e.to_string())?;
        let app = win.app_handle().clone();
        let owner = match app.get_webview_window(&owner_label) {
            Some(w) => w,
            None => return Ok(()),
        };
        let owner_ptr = owner.ns_window().map_err(|e| e.to_string())?;

        let title = title.unwrap_or_default();

        // This gesture's distinct geometry step: the Cocoa strip hit probe.
        let hit = move || unsafe {
            let floater: &NSWindow = &*floater_ptr.cast();
            let owner_w: &NSWindow = &*owner_ptr.cast();
            redock_hit_cocoa(floater, owner_w, strip_w, strip_top, strip_h)
        };

        // Emit throttled previews while the native drag is in flight.
        let preview = redock_preview_emitter(
            app.clone(),
            win.clone(),
            owner_label.clone(),
            thread_id.clone(),
            caller_label.clone(),
            title,
        );
        let tick = {
            let hit = hit.clone();
            move || {
                let (over, proximity, y_ratio) = hit();
                preview(over, proximity, y_ratio);
            }
        };
        let end_settle = redock_end_emitter(
            app.clone(),
            win.clone(),
            owner_label.clone(),
            thread_id.clone(),
            caller_label.clone(),
            false,
        );
        let on_up = {
            let hit = hit.clone();
            move || {
                let (over, _prox, y_ratio) = hit();
                end_settle(over, y_ratio);
            }
        };

        install_mouse_monitors(tick.clone(), on_up, false);

        tick();
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn begin_redock_drag(
    _window: tauri::WebviewWindow,
    _owner_label: String,
    _thread_id: String,
    _title: Option<String>,
    _strip_width: Option<f64>,
    _strip_top_inset: Option<f64>,
    _strip_height: Option<f64>,
) -> Result<(), String> {
    Ok(())
}

// ── Native pull-out free motion (macOS) ───────────────────────────────────────
//
// Strip detach used to call open_widget/set_position every pointermove from JS
// (dual ghost + lag). Hard promote: spawn once, then Rust owns motion with the
// same NSEvent-monitor pattern as begin_native_resize — no JS IPC on the hot
// path. Redock preview uses the same strip contract as begin_redock_drag.

/// Follow the floater under the mouse until button-up, while emitting redock
/// previews to the owner. Call from the owner after the first open_widget.
///
/// `grab_offset_x` / `grab_offset_y` are the cursor's distance from the
/// **top-left** of the window in logical points (y grows downward, like CSS).
/// We convert to Cocoa (bottom-left origin) every tick so the grab point stays
/// under the finger even if Tauri's initial LogicalPosition placement differed
/// from NSWindow.frame.
#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn begin_native_pullout_drag(
    app: tauri::AppHandle,
    floater_label: String,
    owner_label: String,
    thread_id: String,
    title: Option<String>,
    strip_width: Option<f64>,
    strip_top_inset: Option<f64>,
    strip_height: Option<f64>,
    grab_offset_x: Option<f64>,
    grab_offset_y: Option<f64>,
) -> Result<(), String> {
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Ok(());
    }
    if !is_dock_label(&owner_label) || !is_dock_label(&floater_label) {
        return Ok(());
    }
    if owner_label == floater_label {
        return Ok(());
    }
    let floater = match app.get_webview_window(&floater_label) {
        Some(w) => w,
        None => return Ok(()),
    };
    let strip_w = strip_width
        .filter(|w| w.is_finite() && *w > 40.0)
        .unwrap_or(REDOCK_STRIP_DEFAULT);
    let strip_top = strip_top_inset
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0);
    let strip_h = strip_height
        .filter(|v| v.is_finite() && *v > 1.0)
        .unwrap_or(0.0);
    // Default matches JS originOffset(sx-36, sy-18): hold near the top-left chrome.
    let grab_x = grab_offset_x
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(36.0);
    let grab_y = grab_offset_y
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(18.0);
    let title = title.unwrap_or_default();
    let floater_label = floater_label.clone();
    let owner_label = owner_label.clone();

    with_appkit_main_thread(floater.clone(), move |win| {
        use objc2_app_kit::{NSEvent, NSWindow};
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};

        let floater_ptr = win.ns_window().map_err(|e| e.to_string())?;
        let app = win.app_handle().clone();
        let owner = match app.get_webview_window(&owner_label) {
            Some(w) => w,
            None => return Ok(()),
        };
        let owner_ptr = owner.ns_window().map_err(|e| e.to_string())?;

        // Place the window so the grab point is under the cursor NOW (Cocoa),
        // fixing any LogicalPosition vs NSWindow.frame mismatch from open_widget.
        let place_under_cursor = move || unsafe {
            let floater_w: &NSWindow = &*floater_ptr.cast();
            let f = floater_w.frame();
            let win_w = f.size.width;
            let win_h = f.size.height;
            let m = NSEvent::mouseLocation();
            // top-left grab → Cocoa bottom-left origin:
            // origin.x = mouse.x - grab_x
            // origin.y = mouse.y - (height - grab_y)
            let origin = CGPoint {
                x: m.x - grab_x,
                y: m.y - (win_h - grab_y),
            };
            let frame = CGRect {
                origin,
                size: CGSize {
                    width: win_w,
                    height: win_h,
                },
            };
            floater_w.setFrame_display(frame, true);
        };
        place_under_cursor();

        // This gesture's distinct geometry step: place under the cursor, then
        // the same Cocoa strip hit probe as begin_redock_drag.
        let hit = move || unsafe {
            let floater_w: &NSWindow = &*floater_ptr.cast();
            let owner_w: &NSWindow = &*owner_ptr.cast();
            redock_hit_cocoa(floater_w, owner_w, strip_w, strip_top, strip_h)
        };

        let preview = redock_preview_emitter(
            app.clone(),
            win.clone(),
            owner_label.clone(),
            thread_id.clone(),
            floater_label.clone(),
            title,
        );
        let move_tick = {
            let hit = hit.clone();
            let place_under_cursor = place_under_cursor.clone();
            move || {
                place_under_cursor();
                let (over, proximity, y_ratio) = hit();
                preview(over, proximity, y_ratio);
            }
        };
        let end_settle = redock_end_emitter(
            app.clone(),
            win.clone(),
            owner_label.clone(),
            thread_id.clone(),
            floater_label.clone(),
            true,
        );
        let on_up = {
            let hit = hit.clone();
            move || {
                let (over, _prox, y_ratio) = hit();
                end_settle(over, y_ratio);
            }
        };

        // Global drag tracking: when the cursor is outside every app window
        // the local monitor may starve — still follow the pointer and still
        // end on mouse-up.
        install_mouse_monitors(move_tick.clone(), on_up, true);

        move_tick();
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn begin_native_pullout_drag(
    _app: tauri::AppHandle,
    _floater_label: String,
    _owner_label: String,
    _thread_id: String,
    _title: Option<String>,
    _strip_width: Option<f64>,
    _strip_top_inset: Option<f64>,
    _strip_height: Option<f64>,
    _grab_offset_x: Option<f64>,
    _grab_offset_y: Option<f64>,
) -> Result<(), String> {
    Ok(())
}

// ── WinAmp-style edge snap + cluster towing (macOS) ─────────────────────────
//
// Widget/panel windows magnet-snap to the edges of other dock windows, and a
// snapped window rides its parent via `NSWindow addChildWindow:ordered:` — the
// window server tows the whole cluster in the SAME transaction as the parent's
// drag, 1:1 with the cursor, zero per-frame IPC. (The same mechanism powered
// cluster towing in #229 before the geometry engine was retired in 1fdb373f;
// this re-introduction is much smaller because the graph is emergent
// GEOMETRY, not stored state.)
//
// The snap graph is never persisted: a window is attached to whichever dock
// window it is flush against. Attach points:
//   - snap-on-open: a fresh widget with no explicit position is placed flush
//     on the chat's right edge (cascading down past already-snapped siblings)
//     and attached;
//   - snap-on-release: `begin_snap_drag` (armed by moon-dock.js before every
//     startDragging) installs the shared NSEvent monitors; on mouse-up after
//     an actual drag the settle snaps the window to the nearest edge within
//     SNAP_GAP and attaches — or DETACHES it when it was released out of
//     range;
//   - boot restore: `reattach_flushed_windows` re-derives attachments from
//     the restored rects, so layout.json needs no edge bookkeeping.
// A middle-of-stack grab tows the tail (the grabbed window's own children
// ride along); a leaf grab peels off alone. A parent RESIZE re-flushes its
// children on the Resized event so stacks never open a seam. Cycles are
// refused by walking the candidate parent's NSWindow ancestor chain.

/// Max edge gap (logical pt) that still snaps flush on release.
const SNAP_GAP: f64 = 20.0;
/// How far a dropped window may already overlap the target's edge and still
/// snap flush — deeper overlap reads as "parked on top", not docking.
const SNAP_OVERLAP: f64 = 40.0;
/// Edge distance counted as "flush" when deriving an attachment from
/// geometry (open-time placement and the boot restore).
const SNAP_FLUSH: f64 = 2.0;

/// Axis-aligned rect in TOP-LEFT logical points (the `window_logical_rect`
/// family, y grows downward). Pure value type so the snap math is testable
/// without a webview.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SnapRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl SnapRect {
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

fn snap_ranges_overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    a0 < b1 && b0 < a1
}

fn snap_overlap_len(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

fn snap_rects_intersect(a: &SnapRect, b: &SnapRect) -> bool {
    a.x < b.right() && b.x < a.right() && a.y < b.bottom() && b.y < a.bottom()
}

/// If `w` is close enough to an edge of `p` to dock, return the flushed rect.
/// Four edges, WinAmp-style: beside right/left, above, below. The
/// perpendicular axis keeps the dragged coordinate when the two already
/// overlap there; otherwise it aligns to the nearer shared end (top/bottom
/// for side docks, left/right for top/bottom docks) within SNAP_GAP. When
/// several edges qualify, the smallest total move wins.
fn snap_position(w: SnapRect, p: SnapRect) -> Option<SnapRect> {
    let mut best: Option<(f64, SnapRect)> = None;
    let mut consider = |nx: f64, ny: f64| {
        let cost = (nx - w.x).abs() + (ny - w.y).abs();
        if best.is_none_or(|(c, _)| cost < c) {
            best = Some((cost, SnapRect { x: nx, y: ny, w: w.w, h: w.h }));
        }
    };
    // Side docks: W's left edge onto P's right, or W's right edge onto P's left.
    for (nx, gap) in [
        (p.right(), w.x - p.right()),
        (p.x - w.w, p.x - w.right()),
    ] {
        if !(-SNAP_OVERLAP..=SNAP_GAP).contains(&gap) {
            continue;
        }
        let ny = if snap_ranges_overlap(w.y, w.bottom(), p.y, p.bottom()) {
            w.y
        } else if (w.y - p.y).abs() <= SNAP_GAP {
            p.y
        } else if (w.bottom() - p.bottom()).abs() <= SNAP_GAP {
            p.bottom() - w.h
        } else {
            continue;
        };
        consider(nx, ny);
    }
    // Top/bottom docks: W below P (W top onto P bottom) or W above P.
    for (ny, gap) in [
        (p.bottom(), w.y - p.bottom()),
        (p.y - w.h, p.y - w.bottom()),
    ] {
        if !(-SNAP_OVERLAP..=SNAP_GAP).contains(&gap) {
            continue;
        }
        let nx = if snap_ranges_overlap(w.x, w.right(), p.x, p.right()) {
            w.x
        } else if (w.x - p.x).abs() <= SNAP_GAP {
            p.x
        } else if (w.right() - p.right()).abs() <= SNAP_GAP {
            p.right() - w.w
        } else {
            continue;
        };
        consider(nx, ny);
    }
    best.map(|(_, r)| r)
}

/// Best dock target for `w` among `others` (already filtered): the index into
/// `others` plus the flushed rect. A zero-cost hit (already flush) still
/// counts — the caller attaches on the geometry alone.
fn best_snap(w: SnapRect, others: &[(String, SnapRect)]) -> Option<(usize, SnapRect)> {
    let mut best: Option<(usize, SnapRect, f64)> = None;
    for (i, (_, p)) in others.iter().enumerate() {
        let Some(r) = snap_position(w, *p) else {
            continue;
        };
        let cost = (r.x - w.x).abs() + (r.y - w.y).abs();
        if best.is_none_or(|(_, _, c)| cost < c) {
            best = Some((i, r, cost));
        }
    }
    best.map(|(i, r, _)| (i, r))
}

/// Which dock window is `w` flush against (edge gap <= SNAP_FLUSH with real
/// overlap on the perpendicular axis)? Returns the label sharing the longest
/// edge. Drives attachment for open-time placement and the boot restore.
fn flush_parent(w: SnapRect, others: &[(String, SnapRect)]) -> Option<String> {
    let mut best: Option<(&String, f64)> = None;
    for (label, p) in others {
        let beside =
            (w.x - p.right()).abs() <= SNAP_FLUSH || (p.x - w.right()).abs() <= SNAP_FLUSH;
        let stacked =
            (w.y - p.bottom()).abs() <= SNAP_FLUSH || (p.y - w.bottom()).abs() <= SNAP_FLUSH;
        let shared = if beside {
            snap_overlap_len(w.y, w.bottom(), p.y, p.bottom())
        } else if stacked {
            snap_overlap_len(w.x, w.right(), p.x, p.right())
        } else {
            0.0
        };
        if shared <= 0.0 {
            continue;
        }
        if best.is_none_or(|(_, s)| shared > s) {
            best = Some((label, shared));
        }
    }
    best.map(|(l, _)| l.clone())
}

/// Initial snapped placement for a fresh widget against `anchor` (usually the
/// chat). Tries right / below / left / above in order; each edge cascades
/// past whatever already occupies that lane so a run of opened widgets STACKS
/// instead of piling onto one spot. The first edge whose cascaded rect fits
/// inside `monitor` wins; when nothing fits we take the right-edge cascade
/// anyway (better a clamped stack than no opinion).
fn open_snap_position(
    anchor: SnapRect,
    w: f64,
    h: f64,
    occupied: &[SnapRect],
    monitor: Option<SnapRect>,
) -> SnapRect {
    // Cascades run DOWN for side docks (a column off the anchor's flank) and
    // RIGHT for top/bottom docks (a row over/under the anchor).
    let candidates = [
        (
            SnapRect {
                x: anchor.right(),
                y: anchor.y,
                w,
                h,
            },
            false,
        ),
        (
            SnapRect {
                x: anchor.x,
                y: anchor.bottom(),
                w,
                h,
            },
            true,
        ),
        (
            SnapRect {
                x: anchor.x - w,
                y: anchor.y,
                w,
                h,
            },
            false,
        ),
        (
            SnapRect {
                x: anchor.x,
                y: anchor.y - h,
                w,
                h,
            },
            true,
        ),
    ];
    let mut fallback = None;
    for (base, slide_x) in candidates {
        let r = cascade_past(base, occupied, slide_x);
        if fallback.is_none() {
            fallback = Some(r);
        }
        let fits = match monitor {
            Some(m) => r.x >= m.x && r.y >= m.y && r.right() <= m.right() && r.bottom() <= m.bottom(),
            None => true,
        };
        if fits {
            return r;
        }
    }
    // Every lane failed the fit: take the right-edge cascade but clamp it
    // back INSIDE the monitor — a widget that partially overlaps the stack
    // is recoverable; one parked off every display is a "won't open" bug.
    let mut r = fallback.unwrap_or(candidates[0].0);
    if let Some(m) = monitor {
        if r.w <= m.w {
            r.x = r.x.clamp(m.x, m.right() - r.w);
        }
        if r.h <= m.h {
            r.y = r.y.clamp(m.y, m.bottom() - r.h);
        }
    }
    r
}

/// Slide `base` along one axis until it intersects no `occupied` rect —
/// each step clears the deepest current blocker, so the loop is bounded.
fn cascade_past(base: SnapRect, occupied: &[SnapRect], slide_x: bool) -> SnapRect {
    let mut r = base;
    for _ in 0..(occupied.len() * 2 + 1) {
        let blocker = occupied
            .iter()
            .filter(|o| snap_rects_intersect(&r, o))
            .map(|o| if slide_x { o.right() } else { o.bottom() })
            .fold(None, |acc: Option<f64>, v| Some(acc.map_or(v, |a| a.max(v))));
        match blocker {
            Some(edge) => {
                if slide_x {
                    r.x = edge;
                } else {
                    r.y = edge;
                }
            }
            None => return r,
        }
    }
    r
}

/// Re-flush `child` against whichever edge of `parent` it is nearest to: a
/// parent resize moved that edge, and the child keeps its perpendicular
/// offset so a stack stays tight instead of drifting open a seam.
fn reflush_edge(c: SnapRect, p: SnapRect) -> SnapRect {
    let mut best = (f64::MAX, c);
    for (gap, nx, ny) in [
        (c.x - p.right(), p.right(), c.y),   // child on parent's right
        (p.x - c.right(), p.x - c.w, c.y),   // on parent's left
        (c.y - p.bottom(), c.x, p.bottom()), // below parent
        (p.y - c.bottom(), c.x, p.y - c.h),  // above parent
    ] {
        if gap.abs() < best.0 {
            best = (gap.abs(), SnapRect { x: nx, y: ny, w: c.w, h: c.h });
        }
    }
    best.1
}

/// Every open dock window's rect except `exclude_label` ("" excludes none).
fn dock_rects(app: &tauri::AppHandle, exclude_label: &str) -> Vec<(String, SnapRect)> {
    app.webview_windows()
        .iter()
        .filter(|(label, _)| is_dock_label(label) && label.as_str() != exclude_label)
        .filter_map(|(label, w)| {
            window_logical_rect(w).map(|(x, y, wd, ht)| {
                (
                    label.clone(),
                    SnapRect {
                        x: x as f64,
                        y: y as f64,
                        w: wd as f64,
                        h: ht as f64,
                    },
                )
            })
        })
        .collect()
}

/// The window a freshly opened widget snaps onto: the main chat line first,
/// then any other dock window. The launcher never anchors — a transient
/// palette is a poor column root.
fn snap_anchor_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(chat) = app.get_webview_window("panel-chat") {
        return Some(chat);
    }
    let windows = app.webview_windows();
    let mut candidates: Vec<&String> = windows
        .keys()
        .filter(|l| is_dock_label(l) && l.as_str() != "panel-launcher")
        .collect();
    candidates.sort();
    candidates
        .first()
        .and_then(|l| app.get_webview_window(l))
}

/// Where a freshly spawned widget should sit, or `None` to leave placement to
/// the OS. `w`/`h` are the descriptor's logical size; the result is a
/// top-left logical position snapped to the anchor's edge with the cascade.
fn open_snap_top_left(app: &tauri::AppHandle, w: f64, h: f64) -> Option<(f64, f64)> {
    let anchor_win = snap_anchor_window(app)?;
    let (ax, ay, aw, ah) = window_logical_rect(&anchor_win)?;
    let anchor = SnapRect {
        x: ax as f64,
        y: ay as f64,
        w: aw as f64,
        h: ah as f64,
    };
    let occupied: Vec<SnapRect> = dock_rects(app, "")
        .into_iter()
        .map(|(_, r)| r)
        .collect();
    // Monitor fit is judged in the monitor containing the anchor's center —
    // snapping should never park the new widget on a different display.
    let monitors = monitor_bounds(app);
    let monitor = monitors
        .iter()
        .find(|((mx, my), (mw, mh))| {
            let cx = anchor.x + anchor.w / 2.0;
            let cy = anchor.y + anchor.h / 2.0;
            cx >= *mx && cx < mx + mw && cy >= *my && cy < my + mh
        })
        .map(|((mx, my), (mw, mh))| SnapRect {
            x: *mx,
            y: *my,
            w: *mw,
            h: *mh,
        });
    let r = open_snap_position(anchor, w, h, &occupied, monitor);
    Some((r.x, r.y))
}

#[cfg(target_os = "macos")]
unsafe fn ns_has_ancestor(
    win: &objc2_app_kit::NSWindow,
    ancestor: &objc2_app_kit::NSWindow,
) -> bool {
    let mut cur = win.parentWindow();
    while let Some(p) = cur {
        if std::ptr::eq::<objc2_app_kit::NSWindow>(&*p, ancestor) {
            return true;
        }
        cur = p.parentWindow();
    }
    false
}

/// Point `child_ns`'s parent at `parent_ns` (or detach entirely). Refuses a
/// cycle: a window can never sit under one of its own descendants. A no-op
/// when the desired parent already holds it. MUST run on the main thread.
#[cfg(target_os = "macos")]
unsafe fn set_snap_parent_ns(
    child_ns: &objc2_app_kit::NSWindow,
    parent_ns: Option<&objc2_app_kit::NSWindow>,
) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    let parent_ns = parent_ns.filter(|p| !ns_has_ancestor(p, child_ns));
    let cur = child_ns.parentWindow();
    let already = match (&cur, &parent_ns) {
        (Some(c), Some(p)) => std::ptr::eq::<NSWindow>(&**c, *p),
        (None, None) => true,
        _ => false,
    };
    if already {
        return;
    }
    if let Some(c) = cur {
        c.removeChildWindow(child_ns);
    }
    if let Some(p) = parent_ns {
        p.addChildWindow_ordered(child_ns, NSWindowOrderingMode::Above);
    }
}

/// Attach `win` to whichever dock window it is flush against (open-time
/// placement, boot restore). No-op when it lands flush to nothing.
#[cfg(target_os = "macos")]
fn attach_to_flush_neighbor(win: &tauri::WebviewWindow) {
    let app = win.app_handle().clone();
    let label = win.label().to_string();
    let Some((x, y, w, h)) = window_logical_rect(win) else {
        return;
    };
    let wr = SnapRect {
        x: x as f64,
        y: y as f64,
        w: w as f64,
        h: h as f64,
    };
    let others = dock_rects(&app, &label);
    let Some(parent_label) = flush_parent(wr, &others) else {
        return;
    };
    let Some(parent) = app.get_webview_window(&parent_label) else {
        return;
    };
    let _ = with_appkit_main_thread(win.clone(), move |w| {
        use objc2_app_kit::NSWindow;
        let wp = w.ns_window().map_err(|e| e.to_string())?;
        let pp = parent.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let cns: &NSWindow = &*wp.cast();
            let pns: &NSWindow = &*pp.cast();
            set_snap_parent_ns(cns, Some(pns));
        }
        Ok(())
    });
}

#[cfg(not(target_os = "macos"))]
fn attach_to_flush_neighbor(_win: &tauri::WebviewWindow) {}

/// Mouse-up settle for a dragged dock window: snap to the nearest qualifying
/// edge (and attach to it), or detach when released out of range. Runs on the
/// main thread from `begin_snap_drag`'s monitor teardown — never mid-drag, so
/// it can never fight AppKit's ownership of the gesture.
#[cfg(target_os = "macos")]
fn settle_snap(win: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;
    let app = win.app_handle().clone();
    let label = win.label().to_string();
    if !is_dock_label(&label) {
        return;
    }
    let Some((wx, wy, ww, wh)) = window_logical_rect(win) else {
        return;
    };
    let w = SnapRect {
        x: wx as f64,
        y: wy as f64,
        w: ww as f64,
        h: wh as f64,
    };
    let Ok(win_ptr) = win.ns_window() else {
        return;
    };
    let win_ns: &NSWindow = unsafe { &*win_ptr.cast() };
    // Candidates: every other dock window that is NOT a descendant of `win`
    // (snapping under your own child would create a cycle).
    let mut others: Vec<(String, SnapRect)> = Vec::new();
    for (l, wv) in app.webview_windows() {
        if l == label || !is_dock_label(&l) {
            continue;
        }
        let Ok(ptr) = wv.ns_window() else {
            continue;
        };
        let ns: &NSWindow = unsafe { &*ptr.cast() };
        if unsafe { ns_has_ancestor(ns, win_ns) } {
            continue;
        }
        let Some((x, y, wd, ht)) = window_logical_rect(&wv) else {
            continue;
        };
        others.push((
            l,
            SnapRect {
                x: x as f64,
                y: y as f64,
                w: wd as f64,
                h: ht as f64,
            },
        ));
    }
    let parent = match best_snap(w, &others) {
        Some((i, r)) => {
            // Refuse a snap that would park the window essentially off every
            // display (e.g. flushing to the far edge of a chat sitting at the
            // monitor's edge): it reads as "won't open" just like a stranded
            // orb. Thresholds = a grab-able strip of the title bar.
            let visible = monitor_bounds(&app).iter().any(|((mx, my), (mw, mh))| {
                snap_overlap_len(r.x, r.right(), *mx, mx + mw) >= 64.0
                    && snap_overlap_len(r.y, r.bottom(), *my, my + mh) >= 32.0
            });
            if !visible {
                None
            } else {
                // Move into the flush position only when it differs — an
                // already-flush release still attaches (geometry IS the truth).
                if (r.x - w.x).abs() >= 0.5 || (r.y - w.y).abs() >= 0.5 {
                    let _ = win.set_position(tauri::Position::Logical(
                        tauri::LogicalPosition::new(r.x, r.y),
                    ));
                }
                let Some(p) = app.get_webview_window(&others[i].0) else {
                    return;
                };
                let Ok(pp) = p.ns_window() else {
                    return;
                };
                let pns: &NSWindow = unsafe { &*pp.cast() };
                Some(pns)
            }
        }
        None => None,
    };
    unsafe {
        set_snap_parent_ns(win_ns, parent);
    }
}

// ── Persistent release watcher: the moved-set settles on every left-up ────
//
// Per-gesture IPC arming proved unreliable in practice: a large fraction of
// real title-bar presses are swallowed by the transparent NSWindow title-bar
// zone before the webview ever sees pointerdown, so no JS call can arm the
// drag — the window still drags natively, but its drop then settles nothing
// (no snap, and a snapped window dragged off never detached). Settles
// therefore key on GEOMETRY instead: every Moved event marks the window in
// MOVED_SINCE_UP, and this watcher's persistent monitors settle every marked
// window on the next left mouse-up — no matter how the drag started.

#[cfg(target_os = "macos")]
static MOVED_SINCE_UP: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// Record that a dock window's frame moved (from the Moved window event).
/// Programmatic moves also land here — harmless: their next-up settle is
/// just the geometry-derived attach/detach the model already defines.
#[cfg(target_os = "macos")]
pub(crate) fn note_dock_moved(label: &str) {
    let mut set = MOVED_SINCE_UP.lock().unwrap_or_else(|e| e.into_inner());
    set.get_or_insert_with(Default::default)
        .insert(label.to_string());
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn note_dock_moved(_label: &str) {}

#[cfg(target_os = "macos")]
fn take_moved_labels() -> Vec<String> {
    let mut set = MOVED_SINCE_UP.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(set.get_or_insert_with(Default::default))
        .into_iter()
        .collect()
}

/// Settle every dock window whose frame moved since the previous left-up.
/// Install once at setup; the monitor tokens are deliberately forgotten —
/// the watcher lives for the app lifetime. Covers EVERY drag source
/// (webview pointerdown, the native title-bar zone, programmatic drags)
/// because it keys on Moved events, not on how the gesture began.
#[cfg(target_os = "macos")]
pub(crate) fn install_snap_watcher(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    use std::rc::Rc;

    let settle = Rc::new({
        let app = app.clone();
        move || {
            for label in take_moved_labels() {
                if let Some(w) = app.get_webview_window(&label) {
                    settle_snap(&w);
                }
            }
        }
    });

    // Local monitor: releases delivered to our app (returns the event
    // unchanged — it does not consume it). Handlers run on the main thread.
    let local_block = {
        let settle = settle.clone();
        block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            settle();
            event.as_ptr()
        })
    };
    // Global monitor: releases that land over ANOTHER app — the local
    // monitor never sees those.
    let global_block = {
        let settle = settle.clone();
        block2::RcBlock::new(move |_: NonNull<NSEvent>| {
            settle();
        })
    };
    unsafe {
        let local: Option<Retained<AnyObject>> =
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseUp,
                &local_block,
            );
        let global: Option<Retained<AnyObject>> = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseUp,
            &global_block,
        );
        std::mem::forget(local);
        std::mem::forget(global);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install_snap_watcher(_app: &tauri::AppHandle) {}

/// Keep a resized window's snapped children flush: for each dock window
/// parented to `win`, re-flush it against its nearest parent edge. Driven by
/// the Resized event (which fires per native-resize tick), so a stack tracks
/// a live resize instead of opening a seam. Children keep their
/// perpendicular offset; chains hold because a towed child's own children
/// ride along natively.
#[cfg(target_os = "macos")]
pub(crate) fn reflush_snap_children(win: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;
    let app = win.app_handle().clone();
    let self_label = win.label().to_string();
    if !is_dock_label(&self_label) {
        return;
    }
    let Ok(parent_ptr) = win.ns_window() else {
        return;
    };
    let Some((px, py, pw, ph)) = window_logical_rect(win) else {
        return;
    };
    let parent_rect = SnapRect {
        x: px as f64,
        y: py as f64,
        w: pw as f64,
        h: ph as f64,
    };
    for (label, child) in app.webview_windows() {
        if label == self_label || !is_dock_label(&label) {
            continue;
        }
        let Ok(child_ptr) = child.ns_window() else {
            continue;
        };
        let is_child = unsafe {
            let cns: &NSWindow = &*child_ptr.cast();
            let pns: &NSWindow = &*parent_ptr.cast();
            cns.parentWindow()
                .is_some_and(|pp| std::ptr::eq::<NSWindow>(&*pp, pns))
        };
        if !is_child {
            continue;
        }
        let Some((x, y, w, h)) = window_logical_rect(&child) else {
            continue;
        };
        let c = SnapRect {
            x: x as f64,
            y: y as f64,
            w: w as f64,
            h: h as f64,
        };
        let r = reflush_edge(c, parent_rect);
        if (r.x - c.x).abs() >= 0.5 || (r.y - c.y).abs() >= 0.5 {
            let _ = child.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                r.x, r.y,
            )));
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reflush_snap_children(_win: &tauri::WebviewWindow) {}

/// Re-derive every attachment from restored geometry: each dock window
/// flush against a neighbor becomes its AppKit child. Called once after the
/// boot layout restore, so a saved stack tows again without any snap state
/// in layout.json. Order-independent: cycles are refused by the ancestor
/// walk inside set_snap_parent_ns.
#[cfg(target_os = "macos")]
pub(crate) fn reattach_flushed_windows(app: &tauri::AppHandle) {
    let rects = dock_rects(app, "");
    for (label, win) in app.webview_windows() {
        if !is_dock_label(&label) {
            continue;
        }
        let Some((x, y, w, h)) = window_logical_rect(&win) else {
            continue;
        };
        let wr = SnapRect {
            x: x as f64,
            y: y as f64,
            w: w as f64,
            h: h as f64,
        };
        let others: Vec<(String, SnapRect)> = rects
            .iter()
            .filter(|(l, _)| *l != label)
            .cloned()
            .collect();
        if flush_parent(wr, &others).is_some() {
            attach_to_flush_neighbor(&win);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reattach_flushed_windows(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_parses_and_contains_settings_updates_as_system() {
        let reg = widget_registry();
        assert!(
            !reg.is_empty(),
            "bundled registry must parse (a broken JSON would silently disable every panel)"
        );
        let upd = registry_lookup("settings.updates").expect("settings.updates registered");
        assert_eq!(upd.trust, "system");
        assert!(
            upd.page.starts_with("panel.html?type="),
            "system kinds resolve only to shipped pages"
        );
    }

    #[test]
    fn registry_kinds_use_dots_only_so_labels_roundtrip() {
        for d in widget_registry() {
            assert!(
                !d.kind.contains('-') && d.kind.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.'),
                "kind {} must be lowercase dot-separated (dashes would break label↔kind bijectivity)",
                d.kind
            );
            let label = panel_label(&d.kind);
            assert!(
                label.starts_with("panel-"),
                "must match the panel-* capability glob"
            );
            assert_eq!(
                panel_kind_from_label(&label).as_deref(),
                Some(d.kind.as_str())
            );
        }
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert!(registry_lookup("settings.nope").is_none());
        assert!(registry_lookup("widget-abc").is_none());
    }

    // ── hub_event_targets (Step 1c fan-out) ──────────────────────────────────
    // The five HUB_EVENT_NAMES x chat_open true/false x a label set spanning
    // main, panel-chat, a parallel chat instance (panel-chat-abc123), and a
    // non-chat panel (panel-vault) - the exact gap this plan closes (Step 0's
    // "What is missing" #2: parallel chat panels and the twelve panel kinds
    // never heard hub_event at all).

    fn open_label_set() -> Vec<String> {
        vec![
            "main".to_string(),
            "panel-chat".to_string(),
            "panel-chat-abc123".to_string(),
            "panel-vault".to_string(),
        ]
    }

    #[test]
    fn hub_event_targets_machine_access_changed_reaches_every_open_window() {
        // Every window announces its own LocalShell capability, so a
        // machine-access flip must fan out exactly like the connection events.
        // This name was MISSING from HUB_EVENT_NAMES until the #598 review -
        // the settings toggle's invoke was silently rejected - so this test is
        // the tripwire against that regression.
        let labels = open_label_set();
        for chat_open in [true, false] {
            let targets = hub_event_targets("machine-access-changed", chat_open, &labels);
            assert_eq!(
                targets, labels,
                "machine-access-changed must fan out to every open window (chat_open={chat_open})"
            );
        }
    }

    #[test]
    fn hub_event_targets_profile_changed_reaches_every_open_window_regardless_of_chat_open() {
        let labels = open_label_set();
        for chat_open in [true, false] {
            let targets = hub_event_targets("profile-changed", chat_open, &labels);
            assert_eq!(
                targets, labels,
                "profile-changed must fan out to every open window (chat_open={chat_open})"
            );
        }
    }

    #[test]
    fn hub_event_targets_connection_changed_reaches_every_open_window_regardless_of_chat_open() {
        let labels = open_label_set();
        for chat_open in [true, false] {
            let targets = hub_event_targets("connection-changed", chat_open, &labels);
            assert_eq!(
                targets, labels,
                "connection-changed must fan out to every open window (chat_open={chat_open})"
            );
        }
    }

    #[test]
    fn hub_event_targets_fresh_thread_targeting_is_unchanged_by_the_fan_out_widen() {
        let labels = open_label_set();
        // Chat open: goes to panel-chat ONLY (never the parallel instance or
        // any other window) - this semantics must NOT move.
        assert_eq!(
            hub_event_targets("fresh-thread", true, &labels),
            vec!["panel-chat".to_string()]
        );
        // Chat closed: falls back to the hub, same as before Step 1c.
        assert_eq!(
            hub_event_targets("fresh-thread", false, &labels),
            vec!["main".to_string()]
        );
    }

    #[test]
    fn hub_event_targets_open_wizard_targeting_is_unchanged_by_the_fan_out_widen() {
        let labels = open_label_set();
        for chat_open in [true, false] {
            assert_eq!(
                hub_event_targets("open-wizard", chat_open, &labels),
                vec!["main".to_string()],
                "open-wizard stays hub-owned, main only (chat_open={chat_open})"
            );
        }
    }

    #[test]
    fn hub_event_targets_widens_correctly_even_with_only_main_open() {
        // No panels open at all - profile-changed/connection-changed must
        // still just target whatever IS open (main alone), never invent a
        // window that doesn't exist.
        let labels = vec!["main".to_string()];
        assert_eq!(hub_event_targets("profile-changed", false, &labels), labels);
        assert_eq!(hub_event_targets("connection-changed", false, &labels), labels);
    }

    #[test]
    fn dock_namespace_admits_widget_and_panel_but_never_the_hub() {
        assert!(is_dock_label("widget-abc123"));
        assert!(is_dock_label("panel-settings-updates"));
        assert!(!is_dock_label("main"));
        assert!(!is_dock_label("settings"));
        assert!(is_dock_label("panel-settings-updates"));
        assert!(!is_dock_label("main"));
    }

    // ── the deck: widget window label + query encoding (PRD W2) ──────────────

    #[test]
    fn widget_label_is_deterministic_prefixed_and_glob_matching() {
        let a = widget_label("msg-1:0");
        let b = widget_label("msg-1:0");
        assert_eq!(
            a, b,
            "same id → same label (focus-if-open + restore rely on it)"
        );
        assert!(
            a.starts_with("widget-"),
            "must match the widget-* capability glob"
        );
        // Valid Tauri label charset (alphanumeric + - _ : /): hash is hex.
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "label {a} must be a valid window label"
        );
    }

    #[test]
    fn widget_label_distinguishes_ids_that_sanitize_alike() {
        // A naive sanitizer (`:` → `_`) would collide these; the hash must not.
        assert_ne!(widget_label("m:1"), widget_label("m_1"));
        assert_ne!(widget_label("a:b"), widget_label("a:c"));
    }

    #[test]
    fn encode_query_value_keeps_unreserved_and_percent_encodes_the_rest() {
        assert_eq!(encode_query_value("msg-1_0.x~"), "msg-1_0.x~");
        // ':' and '/' and ' ' and '&' must be encoded so they cannot break the
        // query string the widget page parses.
        assert_eq!(encode_query_value("a:b/c d&e"), "a%3Ab%2Fc%20d%26e");
    }

    #[test]
    fn launcher_never_persists_into_the_saved_layout() {
        // Transient command palette: recording it would make the boot restore
        // reopen it on every launch after one quit-with-it-open.
        assert!(!persists_in_layout("launcher"));
        // Every genuine panel kind still round-trips through layout.json.
        assert!(persists_in_layout("chat"));
        assert!(persists_in_layout("settings"));
        assert!(persists_in_layout("settings.voice"));
        assert!(persists_in_layout("now"));
    }

    #[test]
    fn close_widget_refuses_to_close_non_widget_windows() {
        // The per-window boundary the widgets capability documents: a widget may
        // only close widget-* windows, NEVER the main chat window (review G3).
        assert!(is_dock_label("widget-deadbeef"));
        assert!(is_dock_label(&widget_label("anything")));
        assert!(!is_dock_label("main"));
        assert!(!is_dock_label("setup"));
        assert!(!is_dock_label(""));
    }

    // ── build_redock_thread_payload (plan Step 3: view mode rides redock) ───

    #[test]
    fn redock_thread_payload_carries_view_mode_true() {
        let payload = build_redock_thread_payload("t-1", Some("draft text"), "widget-abc", Some(0.5), Some(true));
        assert_eq!(payload["threadId"], "t-1");
        assert_eq!(payload["draft"], "draft text");
        assert_eq!(payload["from"], "widget-abc");
        assert_eq!(payload["yRatio"], 0.5);
        assert_eq!(payload["viewMode"], true);
    }

    #[test]
    fn redock_thread_payload_carries_view_mode_false_and_none_distinctly_but_both_falsy() {
        let explicit_false = build_redock_thread_payload("t-2", None, "widget-def", None, Some(false));
        assert_eq!(explicit_false["viewMode"], false);

        let absent = build_redock_thread_payload("t-3", None, "widget-ghi", None, None);
        assert!(absent["viewMode"].is_null());
        // Both are JSON-falsy - the JS listener's `if (p.viewMode)` check treats
        // them identically (never enables), which is the whole point: an
        // explicit false and "the floater never said" must behave the same.
    }

    #[test]
    fn redock_thread_payload_omits_nothing_present_before_view_mode_was_added() {
        // Regression fence: adding viewMode must never disturb the four
        // pre-existing fields' shape or values.
        let payload = build_redock_thread_payload("t-4", Some("hi"), "widget-jkl", Some(0.25), None);
        assert_eq!(
            payload,
            serde_json::json!({
                "threadId": "t-4",
                "draft": "hi",
                "from": "widget-jkl",
                "yRatio": 0.25,
                "viewMode": null,
            })
        );
    }

    // ── layout persistence: instance labels (issue: non-singleton panels
    // silently never restored) ─────────────────────────────────────────────
    //
    // Before the fix, write_panel_layout derived the kind with
    // panel_kind_from_label alone, so an instance window (panel-flow-1a2b3c)
    // was persisted as kind "flow.1a2b3c" — which registry_lookup can never
    // resolve, so the boot restore skipped it and the panel never came back.

    #[test]
    fn instance_label_resolves_to_base_kind_with_recorded_params() {
        // The exact pre-fix failure: a flow inspector opened via
        // open_widget("flow", {jobId}) must persist as kind "flow" WITH its
        // params, not as the unresolvable kind "flow.<hash>".
        let params = serde_json::json!({"jobId": "job-42"});
        let label = panel_instance_label("flow", &params);
        record_instance_params(&label, &params);
        let (kind, restored) =
            panel_label_to_kind_and_params(&label).expect("instance label must resolve");
        assert_eq!(kind, "flow");
        assert_eq!(restored.as_ref(), Some(&params));
    }

    #[test]
    fn chat_direct_line_instance_resolves_with_thread_param() {
        // open_widget("chat", {thread}) — the Phase 8 direct line — is the
        // other live instance path; its thread param must survive the round
        // trip so the exact direct line restores.
        let params = serde_json::json!({"thread": "thread-abc"});
        let label = panel_instance_label("chat", &params);
        record_instance_params(&label, &params);
        let (kind, restored) =
            panel_label_to_kind_and_params(&label).expect("instance label must resolve");
        assert_eq!(kind, "chat");
        assert_eq!(restored.as_ref(), Some(&params));
    }

    #[test]
    fn base_label_resolves_without_params() {
        let (kind, params) =
            panel_label_to_kind_and_params("panel-chat").expect("base label must resolve");
        assert_eq!(kind, "chat");
        assert!(params.is_none());
        // Dotted kind round-trips through the dash label form.
        let (kind, _) = panel_label_to_kind_and_params("panel-settings-updates")
            .expect("dotted base label must resolve");
        assert_eq!(kind, "settings.updates");
    }

    #[test]
    fn unresolvable_labels_are_not_persisted() {
        // Unknown kinds (base or instance-shaped) and non-panel windows must
        // resolve to None so write_panel_layout skips them instead of
        // writing rows the boot restore could never replay.
        assert!(panel_label_to_kind_and_params("panel-nope").is_none());
        assert!(panel_label_to_kind_and_params("panel-nope-1a2b3c").is_none());
        assert!(panel_label_to_kind_and_params("main").is_none());
        assert!(panel_label_to_kind_and_params("widget-deadbeef").is_none());
    }

    #[test]
    fn instance_label_without_recorded_params_degrades_to_kind_only() {
        // Params recorded at open_widget time live in-process; if the record
        // is missing (poisoned lock, label from an older build), the row
        // still persists under the resolvable base kind so the panel restores
        // as its base window instead of being dropped entirely.
        let params = serde_json::json!({"jobId": "job-unrecorded-99"});
        let label = panel_instance_label("agents", &params);
        // Deliberately NOT recording: simulates the missing-record edge.
        let (kind, restored) =
            panel_label_to_kind_and_params(&label).expect("must still resolve the kind");
        assert_eq!(kind, "agents");
        assert!(restored.is_none());
        assert!(registry_lookup(&kind).is_some());
    }

    // ── WinAmp snap geometry (pure, no webview) ────────────────────────────

    fn r(x: f64, y: f64, w: f64, h: f64) -> SnapRect {
        SnapRect { x, y, w, h }
    }

    #[test]
    fn snaps_flush_to_the_right_edge_keeping_vertical_position() {
        // Chat at (100,100) 400x500; widget dropped 12pt right of its edge,
        // overlapping vertically → snaps flush, y unchanged.
        let chat = r(100.0, 100.0, 400.0, 500.0);
        let w = r(512.0, 160.0, 300.0, 400.0);
        let s = snap_position(w, chat).expect("within SNAP_GAP must snap");
        assert_eq!(s, r(500.0, 160.0, 300.0, 400.0));
    }

    #[test]
    fn snaps_to_the_left_and_below_edges() {
        let chat = r(400.0, 200.0, 500.0, 400.0);
        // Widget's right edge 8pt left of the chat's left edge.
        let left = snap_position(r(85.0, 250.0, 300.0, 300.0), chat).unwrap();
        assert_eq!(left, r(100.0, 250.0, 300.0, 300.0));
        // Widget's top edge 15pt below the chat's bottom.
        let below = snap_position(r(420.0, 615.0, 300.0, 200.0), chat).unwrap();
        assert_eq!(below, r(420.0, 600.0, 300.0, 200.0));
    }

    #[test]
    fn aligns_to_the_nearest_shared_end_when_ranges_do_not_overlap() {
        let chat = r(100.0, 100.0, 400.0, 400.0);
        // Widget dropped right of chat, just above its top: vertical ranges
        // don't overlap but tops are within SNAP_GAP → align to the top end.
        let s = snap_position(r(508.0, 82.0, 300.0, 12.0), chat).unwrap();
        assert_eq!(s, r(500.0, 100.0, 300.0, 12.0));
    }

    #[test]
    fn refuses_when_every_edge_is_out_of_range() {
        let chat = r(100.0, 100.0, 400.0, 400.0);
        // 21pt past SNAP_GAP on every axis.
        assert!(snap_position(r(600.0, 100.0, 300.0, 300.0), chat).is_none());
        // Fully parked on top: deeper than SNAP_OVERLAP on every edge.
        assert!(snap_position(r(150.0, 150.0, 200.0, 200.0), chat).is_none());
    }

    #[test]
    fn small_overlap_still_snaps_flush() {
        let chat = r(100.0, 100.0, 400.0, 400.0);
        // Widget's left edge 30pt INSIDE the chat's right edge.
        let s = snap_position(r(470.0, 150.0, 300.0, 300.0), chat).unwrap();
        assert_eq!(s, r(500.0, 150.0, 300.0, 300.0));
    }

    #[test]
    fn best_snap_picks_the_cheapest_target() {
        let chat = r(0.0, 0.0, 400.0, 500.0);
        let other = r(400.0, 600.0, 300.0, 200.0);
        let others = vec![
            ("panel-chat".to_string(), chat),
            ("panel-settings".to_string(), other),
        ];
        // Almost flush with `other`'s left edge and 12pt from chat's bottom:
        // whichever is actually closer wins.
        let w = r(95.0, 605.0, 300.0, 300.0);
        let (i, s) = best_snap(w, &others).expect("a snap target exists");
        assert_eq!(others[i].0, "panel-settings");
        assert_eq!(s, r(100.0, 605.0, 300.0, 300.0));
    }

    #[test]
    fn flush_parent_names_the_longest_shared_edge() {
        let chat = r(0.0, 0.0, 400.0, 500.0);
        let stacked = r(400.0, 0.0, 300.0, 300.0); // flush on chat's right, full overlap
        let corner = r(0.0, 500.0, 100.0, 50.0); // flush under chat, only 100pt shared
        let others = vec![
            ("panel-chat".to_string(), chat),
            ("widget-b".to_string(), corner),
        ];
        assert_eq!(
            flush_parent(stacked, &others).as_deref(),
            Some("panel-chat")
        );
        // A window touching nobody reports no parent.
        assert!(flush_parent(r(900.0, 900.0, 100.0, 100.0), &others).is_none());
    }

    #[test]
    fn open_snap_cascades_down_the_right_edge_column() {
        let chat = r(100.0, 100.0, 400.0, 500.0);
        let monitor = Some(r(0.0, 0.0, 2000.0, 1200.0));
        // First widget lands flush on the right edge, top-aligned.
        let first = open_snap_position(chat, 300.0, 300.0, &[], monitor);
        assert_eq!(first, r(500.0, 100.0, 300.0, 300.0));
        // Second cascades beneath the first instead of covering it.
        let second = open_snap_position(chat, 300.0, 300.0, &[first], monitor);
        assert_eq!(second, r(500.0, 400.0, 300.0, 300.0));
    }

    #[test]
    fn open_snap_falls_to_an_edge_that_fits_the_monitor() {
        // Chat hard against the monitor's right edge: the right lane cannot
        // fit, so the next edge (below) wins.
        let chat = r(700.0, 100.0, 400.0, 400.0);
        let monitor = Some(r(0.0, 0.0, 1100.0, 1200.0));
        let s = open_snap_position(chat, 300.0, 300.0, &[], monitor);
        assert_eq!(s, r(700.0, 500.0, 300.0, 300.0));
    }

    #[test]
    fn open_snap_fallback_clamps_back_onto_the_monitor() {
        // Anchor fills the monitor so every lane fails the fit — the fallback
        // must still land on-screen rather than off the right/bottom edge.
        let chat = r(0.0, 0.0, 1100.0, 1150.0);
        let monitor = Some(r(0.0, 0.0, 1100.0, 1200.0));
        let s = open_snap_position(chat, 300.0, 300.0, &[], monitor);
        assert!(s.x >= 0.0 && s.y >= 0.0 && s.right() <= 1100.0 && s.bottom() <= 1200.0);
    }

    #[test]
    fn reflush_keeps_the_child_on_its_edge_after_a_resize() {
        let chat_before = r(100.0, 100.0, 400.0, 500.0);
        let child = r(500.0, 150.0, 300.0, 300.0);
        // Sanity: flush before the resize.
        assert_eq!(reflush_edge(child, chat_before), child);
        // Chat grows 100pt wider to the right: the child re-flushes to the
        // new right edge at the same y.
        let chat_after = r(100.0, 100.0, 500.0, 500.0);
        assert_eq!(reflush_edge(child, chat_after), r(600.0, 150.0, 300.0, 300.0));
    }
}
