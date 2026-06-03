// Prevent additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
// `emit_to` lives on the Emitter trait in Tauri 2 (split from Manager). HEAD
// imported only Manager, so the existing luna-config emit below did not compile.
// This one-line import is behavior-preserving and unblocks `cargo check`.
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[tauri::command]
fn get_last_thread_id() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::PathBuf::from(home).join(".luna").join(".last-thread-default");
        if let Ok(content) = std::fs::read_to_string(path) {
            let thread_id = content.trim().to_string();
            if !thread_id.is_empty() {
                return Some(thread_id);
            }
        }
    }
    None
}

// Resolve ~/.luna/moon-connection.json, the mode-600 store for the (url, token)
// pair the user typed in the settings panel. This keeps the WS token out of the
// XSS-reachable webview localStorage while matching the at-rest exposure of the
// ~/.luna/.env that already holds it.
fn connection_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    Ok(std::path::PathBuf::from(home)
        .join(".luna")
        .join("moon-connection.json"))
}

// Default profile name. `luna chat`, `luna pair`, and loadChatConfig all treat
// "stable" as the canonical default channel, so the Moon matches it: a legacy
// flat file (no `profiles`) is read AS the "stable" profile.
const DEFAULT_PROFILE: &str = "stable";

/// Read + parse moon-connection.json into a serde Value, or None if the file is
/// missing / empty / unparseable. NEVER throws — a garbage file behaves exactly
/// like "no connection" (matches the legacy load_connection contract).
fn read_connection_value() -> Option<serde_json::Value> {
    let path = connection_path().ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&contents).ok()
}

/// Normalize any on-disk shape (legacy flat OR new {activeProfile, profiles})
/// into the new structure: returns (active_profile, profiles_map).
///
/// MIGRATION RULE (backward-read-compatible, additive):
///   - `profiles` (object) + `activeProfile` (string) present -> new format,
///     used verbatim.
///   - else if legacy top-level `wsUrl`/`wsToken` present -> treat the whole
///     object as profiles.<DEFAULT_PROFILE>, activeProfile = DEFAULT_PROFILE.
///     This makes load_connection return EXACTLY what it returns today for the
///     currently-running user (zero behavior change until they switch).
///   - else (empty / garbage) -> empty profiles, activeProfile = DEFAULT_PROFILE.
///
/// This is a pure in-memory transform; it NEVER writes. The on-disk file is only
/// rewritten into the new format on the next explicit save.
fn normalize_profiles(
    value: &serde_json::Value,
) -> (String, serde_json::Map<String, serde_json::Value>) {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return (DEFAULT_PROFILE.to_string(), serde_json::Map::new()),
    };

    // New format: both keys present and well-typed.
    if let (Some(active), Some(profiles)) = (
        obj.get("activeProfile").and_then(|v| v.as_str()),
        obj.get("profiles").and_then(|v| v.as_object()),
    ) {
        return (active.to_string(), profiles.clone());
    }

    // Legacy flat format: top-level wsUrl/wsToken -> profiles.<DEFAULT_PROFILE>.
    // We carry the ORIGINAL object verbatim into the stable slot so any extra
    // keys survive and the {wsToken, wsUrl} returned matches today byte-for-byte.
    if obj.contains_key("wsUrl") || obj.contains_key("wsToken") {
        let mut profiles = serde_json::Map::new();
        profiles.insert(
            DEFAULT_PROFILE.to_string(),
            serde_json::Value::Object(obj.clone()),
        );
        return (DEFAULT_PROFILE.to_string(), profiles);
    }

    // Empty / unrecognized object: behave as "no connection".
    (DEFAULT_PROFILE.to_string(), serde_json::Map::new())
}

/// Extract the flat {wsUrl, wsToken} object for a given profile, or None if the
/// profile is absent / lacks those keys.
fn profile_connection(
    profiles: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> Option<serde_json::Value> {
    let p = profiles.get(name)?.as_object()?;
    let url = p.get("wsUrl").and_then(|v| v.as_str());
    let token = p.get("wsToken").and_then(|v| v.as_str());
    // Require at least one of the two to be present (matches legacy behavior
    // where a file with neither key returned None-ish content).
    if url.is_none() && token.is_none() {
        return None;
    }
    Some(serde_json::json!({
        "wsUrl": url.unwrap_or(""),
        "wsToken": token.unwrap_or(""),
    }))
}

/// Atomically write `body` to `path` at mode 0600, via a same-dir temp file then
/// rename(2). The running Moon holds moon-connection.json open, so we MUST NOT
/// truncate-in-place (a mid-write failure would corrupt the only creds file and
/// brick the connection). The temp is created 0600 from birth so the secret
/// never has a world-readable window. Mirrors writeAtomic0600 in pair-writers.ts.
fn write_atomic_0600(path: &std::path::Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let dir = path
        .parent()
        .ok_or_else(|| "connection path has no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {}", e))?;

    // Same-dir temp so rename(2) is atomic (same filesystem). PID + nanos keeps
    // it unique enough for a single-user desktop app.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".moon-connection.{}.{}.tmp", std::process::id(), nanos));

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("open temp failed: {}", e))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("write temp failed: {}", e))?;
        file.sync_all().map_err(|e| format!("sync temp failed: {}", e))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename failed: {}", e));
    }

    // rename preserves the temp's 0600, but re-assert explicitly so the secret is
    // only ever owner-readable regardless of any prior perms on `path`.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod failed: {}", e))?;
    Ok(())
}

/// Serialize the new-format {activeProfile, profiles} object and atomically
/// persist it at mode 0600.
fn persist_profiles(
    active_profile: &str,
    profiles: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let path = connection_path()?;
    let body = serde_json::to_string(&serde_json::json!({
        "activeProfile": active_profile,
        "profiles": serde_json::Value::Object(profiles.clone()),
    }))
    .map_err(|e| format!("serialize failed: {}", e))?;
    write_atomic_0600(&path, &body)
}

#[tauri::command]
fn save_connection(
    url: String,
    token: String,
    profile: Option<String>,
) -> Result<(), String> {
    // Read + migrate the existing file so other profiles are PRESERVED. A
    // legacy flat file becomes profiles.stable transparently. Missing/garbage
    // starts from an empty profile set.
    let existing = read_connection_value();
    let (active, mut profiles) = match &existing {
        Some(v) => normalize_profiles(v),
        None => (DEFAULT_PROFILE.to_string(), serde_json::Map::new()),
    };

    // Target slot: explicit profile arg, else the active profile (so the
    // settings panel "Save" updates whatever channel is currently selected).
    let target = profile
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| active.clone());

    profiles.insert(
        target,
        serde_json::json!({ "wsUrl": url, "wsToken": token }),
    );

    // Always write the NEW format. activeProfile is unchanged here (saving creds
    // for a channel does not switch the active channel).
    persist_profiles(&active, &profiles)
}

/// Returns the flat {wsUrl, wsToken} of the ACTIVE profile — the SAME contract
/// the frontend's connect path already consumes (it reads conn.wsUrl /
/// conn.wsToken). Legacy flat files are migrated transparently in memory, so a
/// currently-running user gets byte-identical creds. NEVER writes on load.
#[tauri::command]
fn load_connection() -> Option<serde_json::Value> {
    let value = read_connection_value()?;
    let (active, profiles) = normalize_profiles(&value);
    // Return ONLY the active profile's creds. We deliberately do NOT fall back to
    // another profile when the active channel is credless: doing so would make
    // the moon silently connect to (e.g.) stable while the header shows "dev" —
    // a wrong-server bug. A credless active channel surfaces as Disconnected
    // (matching the header) until that channel is paired. Never throws.
    // (The legacy flat file always migrates to a credentialed stable profile, so
    // this never regresses the running user.)
    profile_connection(&profiles, &active)
}

/// List profiles + the active one, for the Settings UI channel switch. Returns
/// {activeProfile, profiles} in the new-format shape (migrating a legacy file in
/// memory). When there is no file, returns the default empty shape so the UI can
/// still render the channel selector. NEVER writes.
#[tauri::command]
fn load_profiles() -> serde_json::Value {
    let (active, profiles) = match read_connection_value() {
        Some(v) => normalize_profiles(&v),
        None => (DEFAULT_PROFILE.to_string(), serde_json::Map::new()),
    };
    serde_json::json!({
        "activeProfile": active,
        "profiles": serde_json::Value::Object(profiles),
    })
}

/// Switch the active channel and PERSIST it (new format, atomic 0600), returning
/// the now-active {wsUrl, wsToken} so the JS can reconnect with the right creds.
/// Migrates a legacy file first. If the requested profile has no creds yet, we
/// still switch (the user may have only paired the other channel) and return the
/// profile's empty creds so the UI surfaces the channel even before pairing.
#[tauri::command]
fn set_active_profile(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("profile name must not be empty".to_string());
    }
    let (_active, profiles) = match read_connection_value() {
        Some(v) => normalize_profiles(&v),
        None => (DEFAULT_PROFILE.to_string(), serde_json::Map::new()),
    };
    // Persist the new active profile, preserving all profile slots.
    persist_profiles(&name, &profiles)?;
    // Return the now-active creds (empty strings when that channel isn't paired).
    Ok(profile_connection(&profiles, &name)
        .unwrap_or_else(|| serde_json::json!({ "wsUrl": "", "wsToken": "" })))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_last_thread_id,
            save_connection,
            load_connection,
            load_profiles,
            set_active_profile
        ])
        .setup(|app| {
            // Register a universal system-wide global shortcut to toggle Luna window.
            // Attempts a self-healing fallback chain to avoid macOS key collisions.
            let shortcuts = vec![
                "CmdOrCtrl+Shift+K",
                "CmdOrCtrl+Shift+U",
                "CmdOrCtrl+Shift+Y",
                "CmdOrCtrl+Alt+Shift+L"
            ];
            
            let mut registered = false;
            for shortcut_str in shortcuts {
                if let Ok(shortcut) = shortcut_str.parse::<Shortcut>() {
                    let shortcut_clone = shortcut.clone();
                    let _ = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            if let Some(window) = app.get_webview_window("main") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
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
                eprintln!("\n==========================================================================");
                eprintln!("Warning: Failed to register system-wide global shortcuts.");
                eprintln!("On macOS, global hotkeys require Accessibility permissions.");
                eprintln!("To enable during development, ensure your Terminal/Editor is added to:");
                eprintln!("System Settings -> Privacy & Security -> Accessibility");
                eprintln!("==========================================================================\n");
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
                let env_path = std::path::PathBuf::from(&home)
                    .join(".luna")
                    .join(".env");
                if let Ok(contents) = std::fs::read_to_string(&env_path) {
                    // Determine the active profile from the (migrated) connection
                    // file so the seeded URL points at the channel the user last
                    // selected — defaulting to "stable" when there is no file.
                    let active_profile = match read_connection_value() {
                        Some(v) => normalize_profiles(&v).0,
                        None => DEFAULT_PROFILE.to_string(),
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
                        let seed_url = load_connection()
                            .and_then(|c| {
                                c.get("wsUrl")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .filter(|s| !s.is_empty())
                            })
                            .or(seed_url_from_env)
                            .unwrap_or_else(|| "ws://127.0.0.1:4753/ui".to_string());

                        // Using emit_to so only the main window receives it;
                        // emit() would broadcast to all windows.
                        let _ = app.emit_to(
                            tauri::EventTarget::labeled("main"),
                            "luna-config",
                            serde_json::json!({
                                "wsToken": token,
                                "wsUrl": seed_url
                            }),
                        );
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // THE load-bearing test: a legacy flat file must read back as the SAME
    // {wsToken, wsUrl} it returns today (zero behavior change for the running
    // user), and migration must NEVER mutate the file in memory transform.
    #[test]
    fn legacy_flat_file_reads_as_stable_profile() {
        let legacy = json!({
            "wsToken": "stok-legacy-fixture",
            "wsUrl": "ws://jax-box:4753/ui"
        });
        let (active, profiles) = normalize_profiles(&legacy);
        assert_eq!(active, "stable");
        let conn = profile_connection(&profiles, "stable").expect("stable creds present");
        assert_eq!(conn["wsUrl"], json!("ws://jax-box:4753/ui"));
        assert_eq!(
            conn["wsToken"],
            json!("stok-legacy-fixture")
        );
    }

    #[test]
    fn new_format_uses_active_profile_creds() {
        let file = json!({
            "activeProfile": "dev",
            "profiles": {
                "stable": { "wsUrl": "ws://jax-box:4753/ui", "wsToken": "stok" },
                "dev":    { "wsUrl": "ws://jax-box:5753/ui", "wsToken": "dtok" }
            }
        });
        let (active, profiles) = normalize_profiles(&file);
        assert_eq!(active, "dev");
        let conn = profile_connection(&profiles, &active).unwrap();
        assert_eq!(conn["wsUrl"], json!("ws://jax-box:5753/ui"));
        assert_eq!(conn["wsToken"], json!("dtok"));
        // The OTHER profile is preserved (not clobbered).
        let stable = profile_connection(&profiles, "stable").unwrap();
        assert_eq!(stable["wsUrl"], json!("ws://jax-box:4753/ui"));
    }

    #[test]
    fn empty_and_garbage_behave_as_no_connection() {
        // Empty object.
        let (active, profiles) = normalize_profiles(&json!({}));
        assert_eq!(active, "stable");
        assert!(profile_connection(&profiles, "stable").is_none());
        // Non-object (array) -> no connection, no panic.
        let (active2, profiles2) = normalize_profiles(&json!([1, 2, 3]));
        assert_eq!(active2, "stable");
        assert!(profiles2.is_empty());
    }

    #[test]
    fn dangling_active_profile_yields_no_active_creds() {
        // activeProfile points at a profile that isn't present (e.g. the user
        // switched to "dev" before pairing it). The active channel has NO creds,
        // so the moon must NOT silently fall back to another profile's server —
        // load_connection returns None for the active channel here.
        let file = json!({
            "activeProfile": "ghost",
            "profiles": { "stable": { "wsUrl": "ws://h/ui", "wsToken": "t" } }
        });
        let (active, profiles) = normalize_profiles(&file);
        assert_eq!(active, "ghost");
        // The active profile's creds are absent (no silent stable fallback).
        assert!(profile_connection(&profiles, &active).is_none());
        // stable's creds still exist on disk (load_profiles surfaces them so the
        // user can pick stable again), they're just not auto-used as the active.
        assert!(profile_connection(&profiles, "stable").is_some());
    }

    #[test]
    fn write_atomic_0600_round_trips_and_sets_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("luna-moon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("moon-connection.json");
        let body = r#"{"activeProfile":"stable","profiles":{}}"#;
        write_atomic_0600(&path, body).unwrap();
        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, body);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
