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
            let (name, raw) = line.split_once('=')?;
            (name.trim() == key).then(|| unquote_env_value(raw).to_owned())
        }) {
            if value.len() >= 16 {
                return Some(value);
            }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchDeepLink::default())
        .invoke_handler(tauri::generate_handler![
            load_local_connection,
            take_launch_deep_link
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
}
