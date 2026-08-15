// Prevent additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
// `emit_to` lives on the Emitter trait in Tauri 2 (split from Manager). HEAD
// imported only Manager, so the existing luna-config emit below did not compile.
// This one-line import is behavior-preserving and unblocks `cargo check`.
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
// The voice controller is constructed here (setup()) and driven by the
// command wrappers in voice_commands.rs, so both modules need the type.
#[cfg(feature = "voice")]
use luna_moon_ui_lib::voice::VoiceController;

mod connection;
mod lifecycle;
mod notify;
mod oauth;
mod shell;
mod updater;
mod voice_commands;
mod windows;

// ── Phase-2 C3: client route config + session state ──────────────────────────
//
// Reads ~/.luna/client.toml (bootstrap route config) and manages per-panel
// route state in ~/.luna/moon-session.json.  Token resolution is deferred to
// Phase-3.  The existing `load_connection` command is shimmed to delegate to
// `load_route(default)` so the current single-connection boot keeps working.
mod client_config;

fn main() {
    // `mut` only needed when the optional wdio-e2e plugin is registered below.
    #[cfg_attr(not(feature = "wdio-e2e"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        // Hub-owns-exit lifecycle (widget-system.md Phase 0): the moon hub is
        // the owning window — when it is destroyed, every other window
        // (widget-*/panel-*) closes with it, and Tauri's natural
        // last-window-closed exit fires. The reverse never holds: closing a
        // widget leaves the hub (and the app) alive.
        .on_window_event(|window, event| {
            // Orb off-screen guard (live incident): something outside Moon's
            // own code (display-topology change, stale AppKit saved state,
            // an external mover) can park the orb off every display — and an
            // unclickable orb is an unopenable Moon. Whenever the orb lands
            // with its top-left on NO monitor, pull it back on-screen. The
            // guard only fires for fully-stranded positions, so it never
            // fights a legitimate drag and converges after its own move.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Moved(_)) {
                // The event handler receives a plain Window; the clamp helpers
                // work on the WebviewWindow, so resolve it via the app handle.
                if let Some(moon) = window.app_handle().get_webview_window("main") {
                    windows::reclamp_if_stranded(&moon);
                }
                // Persist the orb's (possibly just-corrected) position so the
                // NEXT launch restores it deterministically — Moon owns orb
                // placement; AppKit's default choice is never trusted again
                // (see write_panel_layout's "moon" entry + the boot restore).
                windows::write_panel_layout(window.app_handle());
            }
            // Layout persistence (panel-* only): positions settle on Moved
            // (macOS fires it at drag END) and Resized; the Destroyed arm
            // below records removals. Guarded against hub-owned shutdown
            // inside write paths via the main-window check.
            if window.label().starts_with("panel-")
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                )
                && window.app_handle().get_webview_window("main").is_some()
            {
                windows::write_panel_layout(window.app_handle());
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle();
                if window.label() == "main" {
                    for (label, win) in app.webview_windows() {
                        if label != "main" {
                            // destroy(), not close(): close() emits
                            // CloseRequested first, which page JS can
                            // intercept — a widget with an "unsaved
                            // changes" guard would survive the hub and
                            // float orphaned forever. destroy() is the
                            // hard guarantee the invariant claims.
                            let _ = win.destroy();
                        }
                    }
                } else if window.label().starts_with("panel-")
                    && app.get_webview_window("main").is_some()
                {
                    // A panel the USER closed leaves the layout (absence =
                    // closed). Hub-owned shutdown skips this (main is
                    // already gone) so quitting never wipes the layout.
                    windows::write_panel_layout(app);
                }
                // Don't strand the user with nothing on screen: while the
                // workspace is EXPANDED the moon is hidden, so closing (×) the
                // LAST widget would leave an empty desktop. When a widget is
                // destroyed and none remain while the orb is hidden, bring the
                // moon back (the workspace has collapsed by attrition). Skipped
                // during hub-owned shutdown — main is already gone, so the
                // get_webview_window("main") guard fails closed.
                if windows::is_dock_label(window.label()) {
                    if let Some(moon) = app.get_webview_window("main") {
                        let any_widget_left = app
                            .webview_windows()
                            .keys()
                            .any(|l| l != window.label() && windows::is_dock_label(l));
                        if !any_widget_left && !moon.is_visible().unwrap_or(true) {
                            // The orb becomes the ONLY Luna surface — never
                            // reveal it parked off every display.
                            windows::ensure_window_on_visible_display(&moon);
                            let _ = moon.show();
                            let _ = moon.set_focus();
                            let _ =
                                app.emit_to(tauri::EventTarget::labeled("main"), "moon-absorb", ());
                        }
                    }
                }
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // PRD A §09: open the system browser for the connector OAuth hop.
        .plugin(tauri_plugin_opener::init())
        // Native OS notifications (drives the `notify` command).
        .plugin(tauri_plugin_notification::init())
        // PRD A §09: the client-brokered OAuth loopback state.
        .manage(oauth::OauthLoopback::default())
        // Staged-update flow: live phase + the verified, held archive bytes so
        // apply_update installs without a second network round-trip.
        .manage(updater::UpdateManager::default());

    // E2E: embedded WebDriver HTTP server for WebdriverIO on macOS (no WKWebView
    // system driver). Opt-in via Cargo feature `wdio-e2e` only — never default.
    #[cfg(feature = "wdio-e2e")]
    {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    // generate_handler! is a single macro invocation, so the voice commands
    // need a second cfg'd arm rather than inline cfg attributes on entries.
    // The connector OAuth commands (oauth_loopback_* / open_external_url)
    // are in BOTH arms.
    #[cfg(feature = "voice")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        connection::get_last_thread_id,
        connection::set_last_thread_id,
        connection::save_connection,
        connection::load_connection,
        connection::load_profiles,
        connection::set_active_profile,
        // Step 1b: route-keyed token resolution, the ONE place it happens
        // (docs/next/routes-and-view-mode-plan.md, closes #529).
        connection::resolve_route_token,
        // Phase-2 C3: route config + panel session state.
        client_config::load_route,
        client_config::list_routes,
        client_config::set_default_route,
        client_config::get_panel_route,
        client_config::set_panel_route,
        // Phase-2 last-thread (per-panel/per-route).
        client_config::get_panel_last_thread,
        client_config::set_panel_last_thread,
        // Phase-2 C10: legacy migration.
        client_config::migrate_legacy_connection,
        shell::local_shell_exec,
        shell::get_platform,
        notify::notify,
        updater::check_for_update,
        updater::start_update_download,
        updater::apply_update,
        updater::update_state,
        updater::take_pending_update,
        oauth::oauth_loopback_start,
        oauth::oauth_loopback_wait,
        oauth::oauth_loopback_cancel,
        oauth::open_external_url,
        windows::open_artifact_widget,
        windows::open_widget,
        windows::hub_event,
        windows::close_widget,
        windows::redock_thread,
        windows::begin_redock_drag,
        windows::begin_native_pullout_drag,
        lifecycle::collapse_to_moon,
        lifecycle::expand_from_moon,
        windows::begin_native_resize,
        windows::capture_window_screenshot,
        voice_commands::voice_status,
        voice_commands::voice_set_mode,
        voice_commands::voice_ptt_down,
        voice_commands::voice_ptt_up,
        voice_commands::speak_text,
        voice_commands::voice_stop_speaking,
        voice_commands::voice_list_voices,
        voice_commands::voice_set_voice,
        voice_commands::voice_set_config,
        voice_commands::voice_ensure_model
    ]);
    #[cfg(not(feature = "voice"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        connection::get_last_thread_id,
        connection::set_last_thread_id,
        connection::save_connection,
        connection::load_connection,
        connection::load_profiles,
        connection::set_active_profile,
        // Step 1b: route-keyed token resolution, the ONE place it happens
        // (docs/next/routes-and-view-mode-plan.md, closes #529).
        connection::resolve_route_token,
        // Phase-2 C3: route config + panel session state.
        client_config::load_route,
        client_config::list_routes,
        client_config::set_default_route,
        client_config::get_panel_route,
        client_config::set_panel_route,
        // Phase-2 last-thread (per-panel/per-route).
        client_config::get_panel_last_thread,
        client_config::set_panel_last_thread,
        // Phase-2 C10: legacy migration.
        client_config::migrate_legacy_connection,
        shell::local_shell_exec,
        shell::get_platform,
        notify::notify,
        updater::check_for_update,
        updater::start_update_download,
        updater::apply_update,
        updater::update_state,
        updater::take_pending_update,
        oauth::oauth_loopback_start,
        oauth::oauth_loopback_wait,
        oauth::oauth_loopback_cancel,
        oauth::open_external_url,
        windows::open_artifact_widget,
        windows::open_widget,
        windows::hub_event,
        windows::close_widget,
        windows::redock_thread,
        windows::begin_redock_drag,
        windows::begin_native_pullout_drag,
        lifecycle::collapse_to_moon,
        lifecycle::expand_from_moon,
        windows::begin_native_resize,
        windows::capture_window_screenshot
    ]);

    builder
        .setup(|app| {
            // FIRST: if this is the first launch after an app update, purge the
            // WKWebView cache so the new embedded frontend loads (WKWebView
            // otherwise serves the tauri:// assets it cached under the old build).
            // Runs before any panel webview opens on demand, so panels load fresh.
            lifecycle::clear_webview_cache_if_updated();

            // Restore open system panels from ~/.luna/layout.json (design doc
            // Persistence): positions clamped onto a visible monitor so a
            // display change can't strand a panel off-screen (the shared
            // clamp in windows.rs; the orb below uses the same one).
            {
                let handle = app.handle().clone();
                let monitors = windows::monitor_bounds(&handle);
                // Rows the file LISTED vs windows that actually SPAWNED: a
                // stale layout (unknown kind, spawn failure) must never leave
                // the user with only the orb — see the fallback below.
                let mut listed = 0usize;
                let mut spawned = 0usize;
                // The orb's own saved position (write_panel_layout's "moon"
                // entry) — applied clamped further below, after the panels.
                let mut saved_moon: Option<(f64, f64)> = None;
                if let Some(path) = windows::layout_path() {
                    if let Ok(raw) = std::fs::read_to_string(&path) {
                        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
                            saved_moon = doc["moon"]["x"]
                                .as_f64()
                                .zip(doc["moon"]["y"].as_f64());
                            // Restore each panel independently at its saved,
                            // clamped rect. No dock graph is reconstructed.
                            for p in doc["panels"].as_array().unwrap_or(&Vec::new()) {
                                let Some(kind) = p["kind"].as_str() else {
                                    continue;
                                };
                                listed += 1;
                                let Some(desc) = windows::registry_lookup(kind) else {
                                    continue;
                                };
                                let (x, y) = windows::clamp_point_to_monitors(
                                    &monitors,
                                    p["x"].as_f64().unwrap_or(180.0),
                                    p["y"].as_f64().unwrap_or(160.0),
                                );
                                let w = p["w"].as_f64().filter(|v| *v >= 220.0);
                                let h = p["h"].as_f64().filter(|v| *v >= 120.0);
                                if let Ok(label) =
                                    windows::spawn_panel(&handle, desc, Some(x), Some(y), w, h)
                                {
                                    // Restore must produce a VISIBLE window,
                                    // not an AX-only ghost: if anything (e.g.
                                    // AppKit saved state applied on relaunch)
                                    // left the fresh window un-ordered-in,
                                    // show() it again — idempotent otherwise.
                                    if let Some(w) = handle.get_webview_window(&label) {
                                        if !w.is_visible().unwrap_or(true) {
                                            let _ = w.show();
                                        }
                                    }
                                    spawned += 1;
                                }
                            }
                        }
                    }
                }
                // The layout listed panels but restore produced NONE (stale
                // kinds, spawn errors): open the chat as the default widget
                // so the workspace the user expects actually exists — a stale
                // layout row must never strand them with only the orb.
                if listed > 0 && spawned == 0 {
                    if let Some(desc) = windows::registry_lookup("chat") {
                        let _ = windows::spawn_panel(&handle, desc, None, None, None, None);
                    }
                }
                // The orb itself. Opt it out of AppKit saved-state
                // restoration (which re-imposes stale frames/visibility after
                // a non-clean relaunch, e.g. the auto-updater's); apply
                // Moon's OWN saved orb position — clamped, so a stale saved
                // point from a changed display arrangement still lands
                // on-screen; then the stranded-check covers the no-saved-
                // position case (first launch / pre-"moon"-entry layout
                // file), where AppKit's default placement proved able to
                // park the orb off every display (live incident: x=-307 on
                // every clean launch, written by nothing in the app).
                // Panels/widgets get the same restoration opt-out in
                // finalize_native_window_chrome.
                if let Some(moon) = app.get_webview_window("main") {
                    windows::disable_window_state_restoration(&moon);
                    if let Some((sx, sy)) = saved_moon {
                        let (cx, cy) = windows::clamp_point_to_monitors(&monitors, sx, sy);
                        let _ = moon.set_position(tauri::Position::Logical(
                            tauri::LogicalPosition::new(cx, cy),
                        ));
                    }
                    windows::ensure_window_on_visible_display(&moon);
                }
            }
            // Voice pipeline controller (lazy: no mic/model touched until the
            // first non-off voice_set_mode). The AppHandle doubles as the
            // event sink — events land on the main window via emit_to.
            #[cfg(feature = "voice")]
            {
                let sink: std::sync::Arc<dyn luna_moon_ui_lib::voice::EventSink> =
                    std::sync::Arc::new(app.handle().clone());
                app.manage(VoiceController::production(sink));
            }
            // Register a universal system-wide global shortcut to toggle Luna window.
            // Attempts a self-healing fallback chain to avoid macOS key collisions.
            let shortcuts = vec![
                "CmdOrCtrl+Shift+K",
                "CmdOrCtrl+Shift+U",
                "CmdOrCtrl+Shift+Y",
                "CmdOrCtrl+Alt+Shift+L",
            ];

            let mut registered = false;
            for shortcut_str in shortcuts {
                if let Ok(shortcut) = shortcut_str.parse::<Shortcut>() {
                    let shortcut_clone = shortcut;
                    let _ = app
                        .global_shortcut()
                        .on_shortcut(shortcut, |app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                // Collapse ⟷ expand toggle (same gesture as the moon
                                // click / a widget's minimize): when the orb is
                                // showing we're collapsed → expand; otherwise we're
                                // expanded → collapse back into the moon.
                                // No hub window → mid-teardown; never blind-act on
                                // orphans (a missing hub would read as "collapsed").
                                let Some(hub) = app.get_webview_window("main") else {
                                    return;
                                };
                                if hub.is_visible().unwrap_or(false) {
                                    lifecycle::expand_out_of_moon(app);
                                } else {
                                    lifecycle::collapse_into_moon(app);
                                }
                            }
                        });

                    if app.global_shortcut().register(shortcut_clone).is_ok() {
                        println!("Successfully registered global hotkey: {}", shortcut_str);
                        registered = true;
                        break;
                    }
                }
            }

            if !registered {
                eprintln!(
                    "\n=========================================================================="
                );
                eprintln!("Warning: Failed to register system-wide global shortcuts.");
                eprintln!("On macOS, global hotkeys require Accessibility permissions.");
                eprintln!("To enable during development, ensure your Terminal/Editor is added to:");
                eprintln!("System Settings -> Privacy & Security -> Accessibility");
                eprintln!(
                    "==========================================================================\n"
                );
            }

            // Seed the UI WebSocket token from ~/.luna/.env into the frontend via
            // a "luna-config" Tauri event. This bridges the gap between the
            // installer (which writes UI_WS_TOKEN to ~/.luna/.env) and the widget.
            // The JS listener persists the seeded token via the save_connection
            // command (mode-600 ~/.luna/moon-connection.json — NOT localStorage,
            // which is XSS-reachable) so subsequent launches don't need a re-emit.
            // The wsUrl is also sent so a future installer could point moon at a
            // different server address without a UI_WS_TOKEN= prefix.
            //
            // We emit after the window is created rather than before show(), so the
            // JS event listener has time to register. If the event arrives before
            // the listener is registered (race), localStorage will be empty on that
            // launch and the user can paste the token into settings — subsequent
            // launches will use the cached value regardless.
            if let Ok(home) = std::env::var("HOME") {
                let env_path = std::path::PathBuf::from(&home).join(".luna").join(".env");
                if let Ok(contents) = std::fs::read_to_string(&env_path) {
                    // Determine the active profile from the (migrated) connection
                    // file so the seeded URL points at the channel the user last
                    // selected — defaulting to "stable" when there is no file.
                    let active_profile = match connection::read_connection_value() {
                        Some(v) => connection::normalize_profiles(&v).0,
                        None => connection::DEFAULT_PROFILE.to_string(),
                    };

                    // Profile-aware URL key: LUNA_<ACTIVEPROFILE>_WS_URL (e.g.
                    // LUNA_STABLE_WS_URL). Mirrors profileEnvPrefix() in config.ts
                    // — uppercase, hyphens become underscores. The token stays the
                    // generic UI_WS_TOKEN (single canonical UI token per box).
                    let url_key = format!(
                        "LUNA_{}_WS_URL",
                        active_profile.to_uppercase().replace('-', "_")
                    );

                    let mut seed_token: Option<String> = None;
                    let mut seed_url_from_env: Option<String> = None;
                    for line in contents.lines() {
                        if let Some(token) = line.strip_prefix("UI_WS_TOKEN=") {
                            let token = token.trim().to_string();
                            if !token.is_empty() {
                                seed_token = Some(token);
                            }
                        } else if let Some(url) = line.strip_prefix(&format!("{}=", url_key)) {
                            let url = url.trim().to_string();
                            if !url.is_empty() {
                                seed_url_from_env = Some(url);
                            }
                        }
                    }

                    if let Some(token) = seed_token {
                        // URL precedence: the active profile's saved wsUrl (so a
                        // previously-paired channel keeps its address) -> the
                        // profile-aware .env URL -> loopback as a last resort.
                        // Never hardcode loopback as the ONLY option.
                        let seed_url = connection::load_connection()
                            .and_then(|c| {
                                c.get("wsUrl")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .filter(|s| !s.is_empty())
                            })
                            .or_else(|| seed_url_from_env.clone())
                            .unwrap_or_else(|| "ws://127.0.0.1:4753/ui".to_string());

                        // Step 1c Part 3d: write the store DIRECTLY when this
                        // profile lacks credentials, instead of sending the raw
                        // token across the webview boundary - no URL redactor
                        // can reach a sibling JSON field, so wsToken must never
                        // be a field on the emitted event at all.
                        let luna_dir = std::path::PathBuf::from(&home).join(".luna");
                        match connection::seed_connection_from_env_in(
                            &luna_dir,
                            &active_profile,
                            &seed_url,
                            &token,
                        ) {
                            Ok(true) => eprintln!(
                                "info: [luna] seeded moon-connection.json for profile {active_profile:?} from ~/.luna/.env"
                            ),
                            Ok(false) => { /* already credentialed - nothing to seed */ }
                            Err(e) => eprintln!(
                                "warn: [luna] failed to seed connection from ~/.luna/.env: {e}"
                            ),
                        }

                        // Using emit_to so only the main window receives it;
                        // emit() would broadcast to all windows. The payload
                        // carries ONLY wsUrl (plus a seeded flag) - the
                        // consumer re-reads the now-seeded store via
                        // load_connection, matching every other connect path.
                        let _ = app.emit_to(
                            tauri::EventTarget::labeled("main"),
                            "luna-config",
                            serde_json::json!({
                                "wsUrl": seed_url,
                                "seeded": true
                            }),
                        );
                    }
                }
            }

            // Background update discovery. The whole point of the staged flow is
            // that updates arrive QUIETLY — the user shouldn't have to press a
            // button. We sleep ~8s first so the check never competes with boot
            // (window paint, socket connect, layout restore), then re-check every
            // ~6h for the life of the process. `auto_download = true` means a
            // found update downloads + stages itself; nothing restarts until the
            // user presses "Restart to update". tokio::time is already a direct
            // dep, so this runs on Tauri's async runtime with no new crates.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    loop {
                        // A transient check error (offline, rate-limited, bad
                        // JSON) must never kill the loop — run_update_check has
                        // already emitted update://error for the surfaces; here
                        // we just swallow it and try again next cycle.
                        if let Err(e) = updater::run_update_check(handle.clone(), true).await {
                            eprintln!("background update check failed: {e}");
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
