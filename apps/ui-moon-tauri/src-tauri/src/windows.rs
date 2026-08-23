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

/// Deterministic, capability-glob-matching window label for an artifact id.
/// djb2 → hex; stable across processes so "focus if already open" and restore
/// reconcile to the same window.
fn widget_label(artifact_id: &str) -> String {
    let mut hash: u64 = 5381;
    for b in artifact_id.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u64::from(b));
    }
    format!("widget-{hash:x}")
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
    #[serde(default)]
    #[allow(dead_code)]
    // all v1 panels are singletons; instance suffixes come with non-singleton kinds
    singleton: bool,
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
    let canon = params.to_string();
    let mut hash: u64 = 5381;
    for b in canon.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u64::from(b));
    }
    format!("{}-{hash:x}", panel_label(kind))
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

/// Pure layout-persistence guard (testable without a webview), same shape as
/// `is_closable_widget_label`. The launcher is a transient, summoned-on-demand
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
        let Some(kind) = panel_kind_from_label(&label) else {
            continue;
        };
        if !persists_in_layout(&kind) {
            continue;
        }
        if let Some((x, y, w, h)) = window_logical_rect(&win) {
            entries.push(serde_json::json!({
                "kind": kind, "x": x, "y": y, "w": w, "h": h
            }));
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

/// Traffic-light inset shared by the window builders and the AppKit re-apply
/// in `configure_native_window_chrome` — a single source of truth so the two
/// placements cannot drift apart.
///
/// x=36 = --card-inset (22) + title-bar padding (14) so the close light sits
/// inside the opaque header, not in the transparent halo / rounded cutout.
/// y=14 pairs with CSS .title-bar min-height 36 and --card-inset-top 6 so the
/// cluster is vertically centered with air under the top edge (was crushed at y=12 / 28px bar).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_X: f64 = 36.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET_Y: f64 = 14.0;

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
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App(url.to_string().into()),
    )
    .title(&desc.title)
    // Native decorations ONLY on macOS, where the Overlay block below turns
    // them into floating traffic-lights over the transparent CSS card. On
    // other platforms decorations(true) would draw a full opaque OS title bar
    // + frame around the transparent rounded card (broken chrome) — keep those
    // borderless, exactly as before this feature.
    .decorations(cfg!(target_os = "macos"))
    .transparent(true)
    // No native OS shadow: the CSS card-shell halo (.widget-shell box-shadow)
    // is the single, rounded-correct, focus-independent depth cue. The OS
    // shadow follows the SQUARE window bounds and intensifies on focus, which
    // stacked a second, misaligned, focus-reactive edge on the rounded card.
    .shadow(false)
    // Panels/screens do NOT float above other apps by default. The page itself
    // (vendor/moon-window-float.js, loaded by chat.html/panel.html) re-enables
    // always-on-top at boot when the user has explicitly turned on the
    // "Always on Top" setting (luna_always_on_top === "true"). The orb window
    // (index.html) keeps its own default-on behavior independently.
    .always_on_top(false)
    .skip_taskbar(true)
    .visible(true)
    // Standard native traffic lights on every window: the green (zoom) button
    // is a real, ENABLED control everywhere, never a grayed-out disabled dot.
    // FullScreenNone (see configure_native_window_chrome) keeps a green click an
    // in-screen zoom, never a jump to a fullscreen Space.
    .maximizable(true)
    .inner_size(width.unwrap_or(desc.width), height.unwrap_or(desc.height))
    .min_inner_size(220.0, 120.0);
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
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    finalize_native_window_chrome(&window);
    Ok(window)
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
    let win = spawn_panel_at(&app, desc, &label, &url, x, y, None, None)?;
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
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(if title.is_empty() { "Artifact" } else { &title })
            // Native decorations ONLY on macOS, where the Overlay block below turns
            // them into floating traffic-lights over the transparent CSS card. On
            // other platforms decorations(true) would draw a full opaque OS title bar
            // + frame around the transparent rounded card (broken chrome) — keep those
            // borderless, exactly as before this feature.
            .decorations(cfg!(target_os = "macos"))
            .transparent(true)
            // No native OS shadow — the CSS card-shell halo is the single depth cue
            // (see spawn_panel_at above for the full rationale).
            .shadow(false)
            // Artifact widgets do NOT float by default — same rule as panels above.
            // vendor/moon-window-float.js (loaded by widget.html) re-enables it at boot
            // when luna_always_on_top === "true".
            .always_on_top(false)
            .skip_taskbar(true)
            .maximizable(true)
            .inner_size(width.unwrap_or(360.0), height.unwrap_or(440.0))
            .min_inner_size(220.0, 160.0);
    // Match system panels: Tauri/Wry owns the native controls for the window
    // lifetime, including focus, hover, resize and hit testing.
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
    builder = builder.visible(true);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    finalize_native_window_chrome(&window);
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
    if !is_closable_widget_label(&label) {
        return Ok(()); // refuse to close anything but a widget window
    }
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pure label-namespace guard for `close_widget` (testable without a webview).
/// widget-* AND panel-* close; the hub never does.
fn is_closable_widget_label(label: &str) -> bool {
    is_dock_label(label)
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
    if !is_closable_widget_label(&caller_label) || owner_label == caller_label {
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
fn redock_proximity(center_x: f64, owner_x: f64, strip_w: f64, owner_w: f64) -> f64 {
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
    let _ = owner_w; // reserved for future full-window attraction
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
        assert!((redock_proximity(200.0, owner_x, strip, 800.0) - 1.0).abs() < 1e-9);
        // Far to the right of strip+approach
        assert!((redock_proximity(1000.0, owner_x, strip, 800.0) - 0.0).abs() < 1e-9);
        // Just outside strip edge (strip_right = 400): mid approach
        let mid = redock_proximity(400.0 + 150.0, owner_x, strip, 800.0);
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

/// Holds the two live monitor tokens for one resize gesture. Lives in an
/// `Rc<RefCell<…>>` created and used ENTIRELY on the main thread (the monitors
/// and their handler blocks only ever run there, so `Rc`/`RefCell` is correct —
/// no `Send` needed, and these tokens are not Send anyway). `ended` guards the
/// teardown so the local + global monitors firing don't double-remove.
#[cfg(target_os = "macos")]
struct ResizeMonitors {
    local: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    global: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    ended: bool,
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
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
        use objc2_core_foundation::CGPoint;
        use std::cell::RefCell;
        use std::ptr::NonNull;
        use std::rc::Rc;

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

        // Shared monitor state. Cloned into each handler block BEFORE the
        // monitors exist; the tokens are stored back in once `add*Monitor`
        // returns (chicken-and-egg: the block must be able to remove the
        // monitors, but they don't exist until after the block is built).
        let state = Rc::new(RefCell::new(ResizeMonitors {
            local: None,
            global: None,
            ended: false,
        }));

        // Tear down: remove BOTH monitors (once — guarded by `ended`), then run
        // the settle and persist layout. Runs on the main thread (we're always
        // called from a monitor handler, which AppKit
        // delivers on the main thread).
        let end = {
            let state = state.clone();
            let win = win.clone();
            let app = win.app_handle().clone();
            move || {
                let (local, global) = {
                    let mut s = state.borrow_mut();
                    if s.ended {
                        return;
                    }
                    s.ended = true;
                    (s.local.take(), s.global.take())
                };
                unsafe {
                    if let Some(tok) = local.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                    if let Some(tok) = global.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                }
                // Notify JS the resize ended so it always resets the cursor
                // override and __LUNA_NATIVE_RESIZING__ — the webview never sees a
                // pointerup when the button is released outside the window.
                let _ = win.emit("luna-resize-ended", ());
                write_panel_layout(&app);
            }
        };

        // Local monitor: every LeftMouseDragged / LeftMouseUp delivered to our
        // app. On up (or no left button pressed) → end; else apply the frame.
        // Returns the event unchanged (does NOT consume it).
        let local_block = {
            let end = end.clone();
            block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let ev = unsafe { event.as_ref() };
                let up = ev.r#type() == NSEventType::LeftMouseUp
                    || NSEvent::pressedMouseButtons() & 1 == 0;
                if up {
                    end();
                } else {
                    let m: CGPoint = NSEvent::mouseLocation();
                    let frame = resize_frame(anchor, m);
                    unsafe {
                        let ns_win: &NSWindow = &*ns_win_ptr.cast();
                        ns_win.setFrame_display(frame, true);
                    }
                }
                event.as_ptr()
            })
        };

        // Global monitor: LeftMouseUp delivered to ANOTHER app (the local
        // monitor never sees these). Just end — keeps the monitors from getting
        // stuck if the mouse is released over a different window.
        let global_block = {
            let end = end.clone();
            block2::RcBlock::new(move |_event: NonNull<NSEvent>| {
                end();
            })
        };

        unsafe {
            let local: Option<Retained<AnyObject>> =
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                    &local_block,
                );
            let global: Option<Retained<AnyObject>> =
                NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseUp,
                    &global_block,
                );
            let mut s = state.borrow_mut();
            s.local = local;
            s.global = global;
        }

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

/// Shared monitor tokens for one redock-drag gesture (main thread only).
#[cfg(target_os = "macos")]
struct RedockMonitors {
    local: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    global: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    ended: bool,
    last_over: bool,
    last_prox: f64,
    last_y: f64,
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
    let proximity = redock_proximity(ccx, of.origin.x, strip, of.size.width);
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
    if !is_closable_widget_label(&caller_label) || owner_label == caller_label {
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
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
        use std::cell::RefCell;
        use std::ptr::NonNull;
        use std::rc::Rc;

        let floater_ptr = win.ns_window().map_err(|e| e.to_string())?;
        let app = win.app_handle().clone();
        let owner = match app.get_webview_window(&owner_label) {
            Some(w) => w,
            None => return Ok(()),
        };
        let owner_ptr = owner.ns_window().map_err(|e| e.to_string())?;

        let state = Rc::new(RefCell::new(RedockMonitors {
            local: None,
            global: None,
            ended: false,
            last_over: false,
            last_prox: -1.0,
            last_y: -1.0,
        }));

        let title = title.unwrap_or_default();

        // Emit throttled previews while the native drag is in flight.
        let tick = {
            let owner_label = owner_label.clone();
            let thread_id = thread_id.clone();
            let caller_label = caller_label.clone();
            let title = title.clone();
            let app = app.clone();
            let win = win.clone();
            let state = state.clone();
            move || {
                let (over, proximity, y_ratio) = unsafe {
                    let floater: &NSWindow = &*floater_ptr.cast();
                    let owner_w: &NSWindow = &*owner_ptr.cast();
                    redock_hit_cocoa(floater, owner_w, strip_w, strip_top, strip_h)
                };
                {
                    let mut s = state.borrow_mut();
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
                        "from": caller_label,
                    }),
                );
                let _ = win.emit(
                    "redock-self-preview",
                    serde_json::json!({
                        "active": true,
                        "over": over,
                        "proximity": proximity,
                    }),
                );
            }
        };

        let end = {
            let state = state.clone();
            let app = app.clone();
            let win = win.clone();
            let owner_label = owner_label.clone();
            let thread_id = thread_id.clone();
            let caller_label = caller_label.clone();
            move || {
                let (local, global) = {
                    let mut s = state.borrow_mut();
                    if s.ended {
                        return;
                    }
                    s.ended = true;
                    (s.local.take(), s.global.take())
                };
                unsafe {
                    if let Some(tok) = local.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                    if let Some(tok) = global.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                }
                let (over, _prox, y_ratio) = unsafe {
                    let floater: &NSWindow = &*floater_ptr.cast();
                    let owner_w: &NSWindow = &*owner_ptr.cast();
                    redock_hit_cocoa(floater, owner_w, strip_w, strip_top, strip_h)
                };
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(&owner_label),
                    "redock-preview",
                    serde_json::json!({
                        "active": false,
                        "threadId": thread_id,
                        "from": caller_label,
                    }),
                );
                let _ = win.emit(
                    "redock-self-preview",
                    serde_json::json!({ "active": false, "over": false, "proximity": 0.0 }),
                );
                let _ = win.emit(
                    "redock-drag-ended",
                    serde_json::json!({
                        "over": over,
                        "yRatio": y_ratio,
                        "threadId": thread_id,
                        "ownerLabel": owner_label,
                    }),
                );
            }
        };

        let local_block = {
            let end = end.clone();
            let tick = tick.clone();
            block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let ev = unsafe { event.as_ref() };
                let up = ev.r#type() == NSEventType::LeftMouseUp
                    || NSEvent::pressedMouseButtons() & 1 == 0;
                if up {
                    end();
                } else {
                    tick();
                }
                event.as_ptr()
            })
        };

        let global_block = {
            let end = end.clone();
            block2::RcBlock::new(move |_event: NonNull<NSEvent>| {
                end();
            })
        };

        unsafe {
            let local: Option<Retained<AnyObject>> =
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                    &local_block,
                );
            let global: Option<Retained<AnyObject>> =
                NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseUp,
                    &global_block,
                );
            let mut s = state.borrow_mut();
            s.local = local;
            s.global = global;
        }

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
    if !is_dock_label(&owner_label) || !is_closable_widget_label(&floater_label) {
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
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSWindow};
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        use std::cell::RefCell;
        use std::ptr::NonNull;
        use std::rc::Rc;

        let floater_ptr = win.ns_window().map_err(|e| e.to_string())?;
        let app = win.app_handle().clone();
        let owner = match app.get_webview_window(&owner_label) {
            Some(w) => w,
            None => return Ok(()),
        };
        let owner_ptr = owner.ns_window().map_err(|e| e.to_string())?;

        // Place the window so the grab point is under the cursor NOW (Cocoa),
        // fixing any LogicalPosition vs NSWindow.frame mismatch from open_widget.
        let place_under_cursor = {
            let floater_ptr = floater_ptr;
            move || unsafe {
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
            }
        };
        place_under_cursor();

        let state = Rc::new(RefCell::new(RedockMonitors {
            local: None,
            global: None,
            ended: false,
            last_over: false,
            last_prox: -1.0,
            last_y: -1.0,
        }));

        let move_tick = {
            let floater_ptr = floater_ptr;
            let owner_ptr = owner_ptr;
            let owner_label = owner_label.clone();
            let thread_id = thread_id.clone();
            let floater_label = floater_label.clone();
            let title = title.clone();
            let app = app.clone();
            let win = win.clone();
            let state = state.clone();
            let place_under_cursor = place_under_cursor;
            move || {
                place_under_cursor();
                let (over, proximity, y_ratio) = unsafe {
                    let floater_w: &NSWindow = &*floater_ptr.cast();
                    let owner_w: &NSWindow = &*owner_ptr.cast();
                    redock_hit_cocoa(floater_w, owner_w, strip_w, strip_top, strip_h)
                };
                {
                    let mut s = state.borrow_mut();
                    // Match begin_redock_drag: coarser so sticky insert + FLIP own feel.
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
                        "from": floater_label,
                    }),
                );
                let _ = win.emit(
                    "redock-self-preview",
                    serde_json::json!({
                        "active": true,
                        "over": over,
                        "proximity": proximity,
                    }),
                );
            }
        };

        let end = {
            let state = state.clone();
            let app = app.clone();
            let win = win.clone();
            let owner_label = owner_label.clone();
            let thread_id = thread_id.clone();
            let floater_label = floater_label.clone();
            move || {
                let (local, global) = {
                    let mut s = state.borrow_mut();
                    if s.ended {
                        return;
                    }
                    s.ended = true;
                    (s.local.take(), s.global.take())
                };
                unsafe {
                    if let Some(tok) = local.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                    if let Some(tok) = global.as_ref() {
                        let obj: &AnyObject = tok;
                        NSEvent::removeMonitor(obj);
                    }
                }
                let (over, _prox, y_ratio) = unsafe {
                    let floater_w: &NSWindow = &*floater_ptr.cast();
                    let owner_w: &NSWindow = &*owner_ptr.cast();
                    redock_hit_cocoa(floater_w, owner_w, strip_w, strip_top, strip_h)
                };
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(&owner_label),
                    "redock-preview",
                    serde_json::json!({
                        "active": false,
                        "threadId": thread_id,
                        "from": floater_label,
                    }),
                );
                let _ = win.emit(
                    "redock-self-preview",
                    serde_json::json!({ "active": false, "over": false, "proximity": 0.0 }),
                );
                // Owner session still owns pointerUp outcome; emit for floater
                // path parity (title-bar redock listeners).
                let _ = win.emit(
                    "redock-drag-ended",
                    serde_json::json!({
                        "over": over,
                        "yRatio": y_ratio,
                        "threadId": thread_id,
                        "ownerLabel": owner_label,
                        "pullout": true,
                    }),
                );
            }
        };

        let local_block = {
            let end = end.clone();
            let move_tick = move_tick.clone();
            block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let ev = unsafe { event.as_ref() };
                let up = ev.r#type() == NSEventType::LeftMouseUp
                    || NSEvent::pressedMouseButtons() & 1 == 0;
                if up {
                    end();
                } else {
                    move_tick();
                }
                event.as_ptr()
            })
        };

        // Global: when the cursor is outside every app window the local monitor
        // may starve — still follow the pointer and still end on mouse-up.
        let global_block = {
            let end = end.clone();
            let move_tick = move_tick.clone();
            block2::RcBlock::new(move |event: NonNull<NSEvent>| {
                let ev = unsafe { event.as_ref() };
                let up = ev.r#type() == NSEventType::LeftMouseUp
                    || NSEvent::pressedMouseButtons() & 1 == 0;
                if up {
                    end();
                } else {
                    move_tick();
                }
            })
        };

        unsafe {
            let local: Option<Retained<AnyObject>> =
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                    &local_block,
                );
            let global: Option<Retained<AnyObject>> =
                NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
                    NSEventMask::LeftMouseDragged | NSEventMask::LeftMouseUp,
                    &global_block,
                );
            let mut s = state.borrow_mut();
            s.local = local;
            s.global = global;
        }

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
        assert!(upd.singleton, "settings panels are singletons");
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
        assert!(is_closable_widget_label("panel-settings-updates"));
        assert!(!is_closable_widget_label("main"));
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
        assert!(is_closable_widget_label("widget-deadbeef"));
        assert!(is_closable_widget_label(&widget_label("anything")));
        assert!(!is_closable_widget_label("main"));
        assert!(!is_closable_widget_label("setup"));
        assert!(!is_closable_widget_label(""));
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
}
