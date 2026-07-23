// Luna Studio native shell - Phase 0: shell only, plus v1 staged-on-boot
// self-update (see update-train-spec.md decision 4). No notifications, no
// tray (see docs/superpowers/specs/2026-07-08-luna-studio-native-macos.md).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// `app.updater()` (check) + `update.download_and_install()` come from
// UpdaterExt. v1 has no restart/apply command - the staged bytes just sit
// until the OS-level bundle swap takes effect on the next launch.
use tauri_plugin_updater::UpdaterExt;

// Deep-link plumbing: Mutex holds the drained-once launch URL, Manager gives
// state/window access in setup, Emitter powers the warm studio://deep-link
// event, and DeepLinkExt exposes app.deep_link().get_current/on_open_url.
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
// Native OS notification banners (Phase 2). `app.notification().builder()...
// show()` lives on NotificationExt; PermissionState is the first-run gate the
// setup() hook checks before requesting notification permission.
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalConnection {
    url: String,
    token: String,
}

fn unquote_env_value(raw: &str) -> &str {
    let value = raw.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn local_ui_token(env_text: &str) -> Option<String> {
    for key in ["UI_WS_TOKEN", "LUNA_UI_WS_TOKEN"] {
        if let Some(value) = env_text.lines().find_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = match line.strip_prefix("export") {
                Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
                _ => line,
            };
            let (name, raw) = line.split_once('=')?;
            if name.trim() != key {
                return None;
            }
            let value = unquote_env_value(raw);
            (value.len() >= 16).then(|| value.to_owned())
        }) {
            return Some(value);
        }
    }
    None
}

/// First-run native provisioning for the local Luna server. The browser build
/// cannot call this command and keeps its manual Settings flow. The token is
/// returned only to Studio's bundled `tauri://` webview, then persisted through
/// the existing connection config path.
#[tauri::command]
fn load_local_connection() -> Result<LocalConnection, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    let env_path = std::path::PathBuf::from(home).join(".luna").join(".env");
    let env_text = std::fs::read_to_string(&env_path)
        .map_err(|e| format!("cannot read {}: {e}", env_path.display()))?;
    let token = local_ui_token(&env_text).ok_or_else(|| {
        "~/.luna/.env has no UI_WS_TOKEN or LUNA_UI_WS_TOKEN of at least 16 characters".to_string()
    })?;
    Ok(LocalConnection {
        url: "ws://127.0.0.1:4753/ui".to_string(),
        token,
    })
}

/// Raise a native OS notification banner (macOS Notification Center / Linux
/// libnotify / Windows toast). Called from the Studio webview
/// (useStudioNotifier) when a background/scheduled result lands, a suggested
/// action arrives, or the agent needs input while the user is not watching the
/// relevant thread. Thin wrapper over the notification plugin, mirroring
/// Moon's `notify` command, so the webview only needs core:default, not the
/// plugin's own notification IPC surface.
///
/// `kind` and `thread_id` are part of the pinned Phase 2 contract but unused
/// here: the banner carries no click payload, and thread routing is handled by
/// the frontend's focus-regain logic. They are kept in the signature for the
/// later click-to-route phases. `body` is truncated defensively so a long job
/// result cannot produce a wall-of-text banner. A failed `show()` (e.g. the
/// user disabled notifications in System Settings) comes back as an error
/// string instead of panicking, so the caller can log and move on.
#[tauri::command]
fn notify_thread(
    app: tauri::AppHandle,
    kind: String,
    title: String,
    body: String,
    thread_id: String,
) -> Result<(), String> {
    let _ = (kind, thread_id);
    app.notification()
        .builder()
        .title(title)
        .body(truncate_notification_body(body))
        .show()
        .map_err(|e| e.to_string())
}

/// Cap a notification body at ~140 chars on a char boundary (not a byte
/// slice - job text can be multi-byte). Takes MAX chars and peeks one
/// further to detect truncation, so a huge job output is never scanned
/// end-to-end. Appends an ellipsis when truncated. Ported verbatim from
/// apps/ui-moon-tauri/src-tauri/src/main.rs.
fn truncate_notification_body(body: String) -> String {
    const MAX: usize = 140;
    let mut chars = body.chars();
    let head: String = chars.by_ref().take(MAX).collect();
    if chars.next().is_some() {
        format!("{}…", head.trim_end())
    } else {
        body
    }
}

/// Holds the URL Studio was cold-launched with (macOS delivers it before the
/// webview can subscribe to on_open_url) so the frontend can drain it once on
/// boot. Warm links go through the studio://deep-link event instead.
#[derive(Default)]
struct LaunchDeepLink(Mutex<Option<String>>);

/// Drain the cold-launch deep link exactly once. Returns the raw luna:// URL
/// the first time the frontend asks, then None on every later call, so a
/// reload cannot re-route to a stale launch thread.
#[tauri::command]
fn take_launch_deep_link(state: tauri::State<LaunchDeepLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Clear ONLY the WKWebView disk + memory cache, preserving localStorage /
/// IndexedDB. WKWebView caches the `tauri://` asset responses (the embedded
/// frontend) and keeps serving them ACROSS app updates - so a user on a fresh
/// binary kept seeing a months-old frontend (none of the shipped frontend fixes
/// ran). Purging the cache forces the webview to re-fetch the new embedded
/// assets. Must run on the main thread.
///
/// Ported verbatim (mechanics unchanged) from
/// apps/ui-moon-tauri/src-tauri/src/main.rs:2979-2999.
#[cfg(target_os = "macos")]
fn clear_webview_disk_cache() {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSDate, NSSet, NSString};
    use objc2_web_kit::WKWebsiteDataStore;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // The WKWebsiteDataType* constants are NSStrings whose value equals their
    // name, so constructing them directly avoids extra feature gates. Cache types
    // only - NOT LocalStorage / IndexedDB / Cookies, so user settings survive.
    let disk = NSString::from_str("WKWebsiteDataTypeDiskCache");
    let mem = NSString::from_str("WKWebsiteDataTypeMemoryCache");
    let types = NSSet::from_retained_slice(&[disk, mem]);
    let epoch = NSDate::dateWithTimeIntervalSince1970(0.0); // clear all ages
    let done = RcBlock::new(|| eprintln!("[studio] WKWebView cache purge completed"));
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &epoch, &done) };
    eprintln!("[studio] clearing WKWebView disk/memory cache (frontend refresh)");
}

/// On the FIRST launch after an app update, purge the webview cache so the new
/// embedded frontend loads instead of the version the webview cached under the
/// old build. Tracks the last-seen version in `~/.luna/.studio-webview-version`.
/// Best-effort: any error simply skips the purge (no worse than before). Runs at
/// the very start of `setup`, before the main webview opens, so it loads fresh.
///
/// Ported verbatim (mechanics unchanged, stamp filename renamed) from
/// apps/ui-moon-tauri/src-tauri/src/main.rs:3007-3024.
fn clear_webview_cache_if_updated() {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let dir = std::path::PathBuf::from(home).join(".luna");
        let stamp = dir.join(".studio-webview-version");
        let current = env!("CARGO_PKG_VERSION");
        let last = std::fs::read_to_string(&stamp).ok();
        if last.as_deref().map(str::trim) == Some(current) {
            return; // same build → the cache is for THIS frontend, keep it
        }
        clear_webview_disk_cache();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&stamp, current);
    }
}

fn main() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin: it forwards a second
        // process (e.g. one spawned by the OS to open a luna:// URL) into the
        // running instance and exits before any other plugin initializes.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchDeepLink::default())
        .invoke_handler(tauri::generate_handler![
            load_local_connection,
            take_launch_deep_link,
            notify_thread
        ])
        .setup(|app| {
            clear_webview_cache_if_updated();

            // Deep-link wiring. A cold launch (Studio not yet running) delivers
            // the luna:// URL before the webview exists, so we stash it in
            // LaunchDeepLink for the frontend to drain once via
            // take_launch_deep_link. A warm launch (Studio already open) fires
            // on_open_url, which we relay as the studio://deep-link event AND
            // also stash, so a frontend reload can still recover the last URL.
            let dl_handle = app.handle().clone();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(u) = urls.first() {
                    *app.state::<LaunchDeepLink>().0.lock().unwrap() = Some(u.to_string());
                }
            }
            app.deep_link().on_open_url(move |event| {
                if let Some(u) = event.urls().first() {
                    let url = u.to_string();
                    let _ = dl_handle.emit("studio://deep-link", &url);
                    if let Some(s) = dl_handle.try_state::<LaunchDeepLink>() {
                        if let Ok(mut g) = s.0.lock() {
                            *g = Some(url);
                        }
                    }
                }
            });

            // First-run notification permission (Phase 2). Ask once on boot so
            // the DONE / suggested / needs-input banners can actually appear.
            // On desktop the plugin reports Granted and the real gate is the OS
            // prompt at first show(); on mobile this is the actual request. Every
            // path is a soft [studio-notify] eprintln: a notification-permission
            // hiccup must never crash boot (matches the [studio-update] pattern).
            match app.notification().permission_state() {
                Ok(PermissionState::Granted) => {}
                Ok(_) => {
                    if let Err(e) = app.notification().request_permission() {
                        eprintln!("[studio-notify] request_permission failed: {e}");
                    }
                }
                Err(e) => {
                    eprintln!("[studio-notify] permission_state failed: {e}");
                }
            }

            // v1 staged-on-boot update check (design decision 4): one
            // check -> download -> install pass right after boot, held until
            // the NEXT launch - no mid-session restart, no UI (Moon's
            // banner/progress UX is a later phase). Runs on Tauri's async
            // runtime so it never blocks the window paint. Every failure
            // path is a soft `[studio-update]` eprintln: a flaky network or
            // a signature mismatch must never crash boot. On staged success
            // we write nothing extra - the existing webview-version stamp
            // (above) already handles the cache purge on the NEXT boot,
            // once the new binary is actually running.
            // Dev builds never self-update: `tauri dev` runs a debug binary
            // outside any installed .app, and a staged install over it would
            // be meaningless at best (Moon's dev config likewise drops the
            // updater entirely).
            if cfg!(debug_assertions) {
                eprintln!("[studio-update] debug build - update check skipped");
                return Ok(());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater = match handle.updater() {
                    Ok(u) => u,
                    Err(e) => {
                        eprintln!("[studio-update] updater unavailable: {e}");
                        return;
                    }
                };
                match updater.check().await {
                    Ok(None) => {
                        eprintln!("[studio-update] no update available");
                    }
                    Err(e) => {
                        eprintln!("[studio-update] check failed: {e}");
                    }
                    Ok(Some(update)) => {
                        let version = update.version.clone();
                        if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                            eprintln!("[studio-update] download/install failed: {e}");
                            return;
                        }
                        eprintln!(
                            "[studio-update] update {version} staged; takes effect on next launch"
                        );
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Luna Studio");
}

#[cfg(test)]
mod tests {
    use super::local_ui_token;
    use super::truncate_notification_body;

    #[test]
    fn notification_body_short_text_passes_through_untouched() {
        assert_eq!(
            truncate_notification_body("done: 3 items".into()),
            "done: 3 items"
        );
        assert_eq!(truncate_notification_body(String::new()), "");
    }

    #[test]
    fn notification_body_long_text_truncates_on_char_boundary_with_ellipsis() {
        // Multi-byte chars: a byte-slice truncation would panic or split a
        // char; the char-based cap must keep exactly 140 chars + ellipsis.
        let long = "é".repeat(200);
        let out = truncate_notification_body(long);
        assert_eq!(out.chars().count(), 141); // 140 kept + '…'
        assert!(out.ends_with('…'));

        // Exactly at the cap: no truncation, no ellipsis.
        let exact = "x".repeat(140);
        assert_eq!(truncate_notification_body(exact.clone()), exact);
    }

    #[test]
    fn local_token_prefers_canonical_key_and_unquotes_it() {
        let env = "LUNA_UI_WS_TOKEN=legacy-token-123456\nUI_WS_TOKEN=\"canonical-token-123456\"\n";
        assert_eq!(
            local_ui_token(env).as_deref(),
            Some("canonical-token-123456")
        );
    }

    #[test]
    fn local_token_rejects_short_or_missing_values() {
        assert_eq!(local_ui_token("UI_WS_TOKEN=short\n"), None);
        assert_eq!(local_ui_token("OTHER=value\n"), None);
    }

    #[test]
    fn local_token_parses_export_prefix_with_various_whitespace() {
        let env_space = "export UI_WS_TOKEN=space-token-123456\n";
        assert_eq!(
            local_ui_token(env_space).as_deref(),
            Some("space-token-123456")
        );

        let env_multi_space = "export   UI_WS_TOKEN=multi-space-token-123456\n";
        assert_eq!(
            local_ui_token(env_multi_space).as_deref(),
            Some("multi-space-token-123456")
        );

        let env_tab = "export\tUI_WS_TOKEN=tab-token-123456789\n";
        assert_eq!(
            local_ui_token(env_tab).as_deref(),
            Some("tab-token-123456789")
        );

        let env_legacy_export = "export LUNA_UI_WS_TOKEN=legacy-export-token-123456\n";
        assert_eq!(
            local_ui_token(env_legacy_export).as_deref(),
            Some("legacy-export-token-123456")
        );
    }

    #[test]
    fn local_token_rejects_export_key_prefix_false_matches() {
        let env = "export_UI_WS_TOKEN=false-match-token-123456\nexport_LUNA_UI_WS_TOKEN=false-match-token-123456\n";
        assert_eq!(local_ui_token(env), None);
    }

    #[test]
    fn local_token_continues_line_scan_when_candidate_under_16_chars() {
        let env = "UI_WS_TOKEN=short\nUI_WS_TOKEN=valid-second-token-123456\n";
        assert_eq!(
            local_ui_token(env).as_deref(),
            Some("valid-second-token-123456")
        );
    }

    #[test]
    fn local_token_short_primary_falls_through_or_continues_to_valid_token() {
        // Short primary key falls through to valid legacy key
        let env1 = "UI_WS_TOKEN=short\nLUNA_UI_WS_TOKEN=valid-legacy-token-123456\n";
        assert_eq!(
            local_ui_token(env1).as_deref(),
            Some("valid-legacy-token-123456")
        );

        // Short export primary key continues to valid export primary key
        let env2 = "export UI_WS_TOKEN=too_short\nexport UI_WS_TOKEN=valid-export-token-123456\n";
        assert_eq!(
            local_ui_token(env2).as_deref(),
            Some("valid-export-token-123456")
        );
    }
}
