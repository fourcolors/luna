//! Connection/profile persistence: last-thread-id, ~/.luna/moon-connection.json
//! (url/token profiles), and the Phase-2 C3 client.toml resolution shim.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) and the `client_config` module path (now `crate::client_config`,
//! since this file is no longer the crate root) changed.

use crate::client_config;

#[tauri::command]
pub(crate) fn get_last_thread_id() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::PathBuf::from(home)
            .join(".luna")
            .join(".last-thread-default");
        if let Ok(content) = std::fs::read_to_string(path) {
            let thread_id = content.trim().to_string();
            if !thread_id.is_empty() {
                return Some(thread_id);
            }
        }
    }
    None
}

// Persist the active thread id to ~/.luna/.last-thread-default so a full app
// restart re-tethers to the same thread (the moon's string "re-tether" survives
// a quit/reopen, not just an in-session socket drop). Mirrors get_last_thread_id
// above; creates ~/.luna if missing. Called fire-and-forget on every successful
// thread-snapshot.
#[tauri::command]
pub(crate) fn set_last_thread_id(thread_id: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let dir = std::path::PathBuf::from(home).join(".luna");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create ~/.luna: {}", e))?;
    std::fs::write(dir.join(".last-thread-default"), thread_id.trim())
        .map_err(|e| format!("failed to write .last-thread-default: {}", e))?;
    Ok(())
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
pub(crate) const DEFAULT_PROFILE: &str = "stable";

/// Read + parse moon-connection.json into a serde Value, or None if the file is
/// missing / empty / unparseable. NEVER throws — a garbage file behaves exactly
/// like "no connection" (matches the legacy load_connection contract).
pub(crate) fn read_connection_value() -> Option<serde_json::Value> {
    let path = connection_path().ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&contents).ok()
}

/// Path-injectable variant of `read_connection_value` — reads
/// `<luna_dir>/moon-connection.json`.  Used by `load_connection_in` so the
/// integration test can drive a tempdir without touching `$HOME`.
fn read_connection_value_in(luna_dir: &std::path::Path) -> Option<serde_json::Value> {
    let path = luna_dir.join("moon-connection.json");
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&contents).ok()
}

/// Path-injectable variant of `client_config::load_client_config_pub` — parses
/// `<luna_dir>/client.toml`.  Returns `None` when the file is absent (clean
/// fall-through to the legacy path), `Err(reason)` when present but invalid.
fn load_client_config_in(
    luna_dir: &std::path::Path,
) -> Option<Result<client_config::ClientConfig, String>> {
    let path = luna_dir.join("client.toml");
    if !path.exists() {
        return None;
    }
    let contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return Some(Err(format!("cannot read client.toml: {e}"))),
    };
    Some(client_config::parse_client_config(&contents))
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
pub(crate) fn normalize_profiles(
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
    let tmp = dir.join(format!(
        ".moon-connection.{}.{}.tmp",
        std::process::id(),
        nanos
    ));

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
        file.sync_all()
            .map_err(|e| format!("sync temp failed: {}", e))?;
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
pub(crate) fn save_connection(
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

/// Inner implementation of `load_connection` that operates on an explicit
/// `luna_dir` so the integration test can drive a tempdir without mutating
/// `$HOME` (a shared process global that makes tests flaky and non-parallel).
///
/// The public `#[tauri::command]` wrapper calls this with `~/.luna`.
///
/// # "legacy" sentinel resolution
/// After `migrate_legacy_connection` runs, `client.toml` contains
/// `tokenRef = "legacy"` as a placeholder.  The real WS token still lives in
/// `moon-connection.json`.  When `ws_token == "legacy"` this function reads the
/// real token from `moon-connection.json` for that route's profile and returns
/// it — while keeping `ws_url` from `client.toml` (authoritative for routing).
///
/// If the sentinel cannot be resolved (moon-connection.json absent, profile not
/// found, or token empty) the sentinel is returned as-is so the frontend shows
/// Disconnected — the correct UX for a genuinely uncredentialled channel.
///
/// A `tokenRef` that is NOT "legacy" (e.g. `env:VAR`, `file:path`, `op://…`)
/// is returned unchanged; those refs are Phase-3's concern.
fn load_connection_in(luna_dir: &std::path::Path) -> Option<serde_json::Value> {
    // C3 forward path: client.toml present → read route config.
    // client.toml ABSENT → fall through to legacy path (pre-migration users).
    // client.toml PRESENT but invalid → surface the error rather than silently
    // falling back to legacy creds (which would connect to the wrong server).
    if let Some(result) = load_client_config_in(luna_dir) {
        match result {
            Err(reason) => {
                // client.toml is present but malformed — DO NOT fall back to
                // legacy; surface the error so the frontend can show it.
                eprintln!("error: [luna] client.toml invalid: {reason}");
                return Some(serde_json::json!({
                    "error": format!("client.toml invalid: {reason}"),
                }));
            }
            Ok(cfg) => {
                if let Some(entry) = cfg.route.get(&cfg.default) {
                    let ws_url = entry.endpoints.first().cloned().unwrap_or_default();
                    let ws_token = if entry.token_ref == "legacy" {
                        // Resolve the "legacy" sentinel: the real token lives in
                        // moon-connection.json under a profile keyed by cfg.default.
                        // URL stays from client.toml (authoritative for routing).
                        let resolved = read_connection_value_in(luna_dir).and_then(|v| {
                            let (_, profiles) = normalize_profiles(&v);
                            profile_connection(&profiles, &cfg.default).and_then(|c| {
                                c["wsToken"]
                                    .as_str()
                                    .filter(|t| !t.is_empty())
                                    .map(|t| t.to_string())
                            })
                        });
                        // Fall through to the sentinel when resolution fails so the
                        // frontend surfaces Disconnected rather than silently breaking.
                        resolved.unwrap_or_else(|| entry.token_ref.clone())
                    } else {
                        // Non-"legacy" ref (env:, file:, op://…) returned unchanged.
                        entry.token_ref.clone()
                    };
                    return Some(serde_json::json!({
                        "wsUrl": ws_url,
                        "wsToken": ws_token,
                    }));
                }
            }
        }
    }

    // Legacy path: moon-connection.json (unchanged from pre-C3).
    let value = read_connection_value_in(luna_dir)?;
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

/// Returns the flat {wsUrl, wsToken} of the ACTIVE profile — the SAME contract
/// the frontend's connect path already consumes (it reads conn.wsUrl /
/// conn.wsToken). Legacy flat files are migrated transparently in memory, so a
/// currently-running user gets byte-identical creds. NEVER writes on load.
///
/// # Phase-2 C3 backward-compat shim
/// When `~/.luna/client.toml` is present this command delegates to the route
/// module and re-maps the result into the legacy `{wsUrl, wsToken}` shape that
/// the current chat.html JS expects.  `endpoints[0]` becomes `wsUrl`.
///
/// When `tokenRef` is the migration sentinel `"legacy"` the real token is
/// resolved from `moon-connection.json` (see `load_connection_in`).  Any other
/// `tokenRef` string (e.g. `env:VAR`) is returned raw — Phase-3 resolves those.
///
/// When `client.toml` is absent the pre-C3 `moon-connection.json` path is used
/// unchanged — zero behaviour change for users who have not yet migrated.
#[tauri::command]
pub(crate) fn load_connection() -> Option<serde_json::Value> {
    let luna_dir = std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".luna"))?;
    load_connection_in(&luna_dir)
}

/// List profiles + the active one, for the Settings UI channel switch. Returns
/// {activeProfile, profiles} in the new-format shape (migrating a legacy file in
/// memory). When there is no file, returns the default empty shape so the UI can
/// still render the channel selector. NEVER writes.
#[tauri::command]
pub(crate) fn load_profiles() -> serde_json::Value {
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
pub(crate) fn set_active_profile(name: String) -> Result<serde_json::Value, String> {
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
        assert_eq!(conn["wsToken"], json!("stok-legacy-fixture"));
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

    // END-TO-END toggle persistence: the exact chain the Settings dropdown
    // invokes (set_active_profile -> persist_profiles -> connection_path/$HOME).
    // The pure-function tests above never touch this because the #[tauri::command]
    // fns are HOME-dependent — so we redirect HOME to a temp dir and drive the
    // real command. This is the test that decides whether the reported
    // "in-app channel toggle doesn't persist" is a code bug.
    #[test]
    fn set_active_profile_persists_to_disk_and_preserves_both_channels() {
        let orig_home = std::env::var("HOME").ok();
        let dir = std::env::temp_dir().join(format!("luna-moon-toggle-{}", std::process::id()));
        let luna = dir.join(".luna");
        std::fs::create_dir_all(&luna).unwrap();
        std::env::set_var("HOME", &dir);

        // Seed a realistic moon-connection.json: active=stable, BOTH channels paired.
        let seed = r#"{"activeProfile":"stable","profiles":{"stable":{"wsUrl":"ws://jax-box:4753/ui","wsToken":"stok"},"dev":{"wsUrl":"ws://jax-box:5753/ui","wsToken":"dtok"}}}"#;
        std::fs::write(luna.join("moon-connection.json"), seed).unwrap();

        // Toggle stable -> dev (what the dropdown `change` handler invokes).
        let creds = set_active_profile("dev".to_string()).expect("switch to dev ok");
        assert_eq!(
            creds["wsToken"],
            json!("dtok"),
            "returns the now-active dev creds"
        );

        // The file on disk must now read activeProfile=dev with BOTH profiles intact.
        let after = read_connection_value().expect("file present after toggle");
        let (active, profiles) = normalize_profiles(&after);
        assert_eq!(
            active, "dev",
            "activeProfile PERSISTED to disk after toggle"
        );
        assert!(
            profile_connection(&profiles, "stable").is_some(),
            "stable creds preserved"
        );
        assert!(
            profile_connection(&profiles, "dev").is_some(),
            "dev creds preserved"
        );

        // Toggle back dev -> stable; must flip on disk again with no creds lost.
        set_active_profile("stable".to_string()).expect("switch back ok");
        let back = read_connection_value().unwrap();
        let (active2, profiles2) = normalize_profiles(&back);
        assert_eq!(
            active2, "stable",
            "activeProfile flips back to stable on disk"
        );
        assert!(
            profile_connection(&profiles2, "dev").is_some(),
            "dev creds still preserved"
        );

        // Restore HOME so we don't disturb any other (parallel) test.
        match orig_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
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

    // ── load_connection_in integration tests ────────────────────────────────
    //
    // These are the tests that would have caught the C3/C10 interaction bug:
    // migrate_legacy_connection writes tokenRef="legacy" but the old
    // load_connection returned it raw → frontend sent "legacy" as bearer →
    // server rejected → Disconnected on every 0.0.43 boot.
    //
    // All tests use a tempdir so they never touch the real ~/.luna and are
    // safe to run in parallel.

    fn with_tmp_luna_dir<F: FnOnce(std::path::PathBuf)>(f: F) {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna = dir.path().join(".luna");
        std::fs::create_dir_all(&luna).expect("mkdir .luna");
        f(luna);
        // dir drops here → cleaned up automatically
    }

    /// THE headline regression test.
    ///
    /// Reproduces the exact 0.0.43 boot sequence:
    ///   1. moon-connection.json exists with a real 64-char token.
    ///   2. migrate_legacy_to_client_toml_in runs → creates client.toml with
    ///      tokenRef = "legacy".
    ///   3. load_connection_in is called → MUST return the real token, NOT "legacy".
    #[test]
    fn load_connection_resolves_legacy_sentinel_to_real_moon_connection_token() {
        with_tmp_luna_dir(|luna_dir| {
            let real_token = "a".repeat(64); // 64-char stand-in for a real WS token
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": {
                    "stable": {
                        "wsUrl": "ws://host:4753/ui",
                        "wsToken": real_token
                    }
                }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), &moon_conn)
                .expect("write moon-connection.json");

            // Run the real migration (same function the boot sequence calls).
            client_config::migrate_legacy_to_client_toml_in(&luna_dir)
                .expect("migration must succeed");

            // Verify the migration produced a client.toml with tokenRef="legacy".
            let toml_contents =
                std::fs::read_to_string(luna_dir.join("client.toml")).expect("client.toml");
            assert!(
                toml_contents.contains(r#"tokenRef = "legacy""#),
                "migration must write tokenRef = \"legacy\"; got:\n{toml_contents}"
            );

            // THE CRITICAL ASSERTION: load_connection_in must resolve the sentinel.
            let result = load_connection_in(&luna_dir)
                .expect("must return Some (not None) when creds exist");

            let ws_token = result["wsToken"]
                .as_str()
                .expect("wsToken must be a string");
            assert_eq!(
                ws_token,
                "a".repeat(64).as_str(),
                "wsToken must be the REAL token from moon-connection.json, not the \"legacy\" sentinel"
            );

            // wsUrl must come from client.toml (route's endpoints[0]).
            let ws_url = result["wsUrl"].as_str().expect("wsUrl must be a string");
            assert_eq!(
                ws_url, "ws://host:4753/ui",
                "wsUrl must be the route endpoint from client.toml"
            );

            // Sanity: the returned token must NOT be the sentinel string.
            assert_ne!(
                ws_token, "legacy",
                "REGRESSION: returned \"legacy\" as the bearer token — server will reject it"
            );
        });
    }

    /// (a) client.toml with a non-"legacy" tokenRef is returned as-is.
    ///     Phase-3 resolves env:/file:/op:// refs; load_connection must not mangle them.
    #[test]
    fn load_connection_returns_non_legacy_token_ref_unchanged() {
        with_tmp_luna_dir(|luna_dir| {
            let client_toml = r#"kind = "bootstrap"
fileFormatVersion = 3
default = "stable"

[route.stable]
endpoints = ["ws://host:4753/ui"]
label = "stable"
tokenRef = "env:LUNA_WS_TOKEN"
"#;
            std::fs::write(luna_dir.join("client.toml"), client_toml).expect("write client.toml");

            let result =
                load_connection_in(&luna_dir).expect("must return Some when client.toml is valid");
            assert_eq!(
                result["wsToken"].as_str(),
                Some("env:LUNA_WS_TOKEN"),
                "non-legacy tokenRef must be returned verbatim (Phase-3 resolves it)"
            );
            assert_eq!(result["wsUrl"].as_str(), Some("ws://host:4753/ui"));
        });
    }

    /// (b) No client.toml → legacy path — returns the active profile's real creds
    ///     from moon-connection.json verbatim.
    #[test]
    fn load_connection_no_client_toml_returns_active_profile_creds() {
        with_tmp_luna_dir(|luna_dir| {
            let moon_conn = r#"{"activeProfile":"stable","profiles":{"stable":{"wsUrl":"ws://jax:4753/ui","wsToken":"real-token-xyz"}}}"#;
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn)
                .expect("write moon-connection.json");

            let result =
                load_connection_in(&luna_dir).expect("must return Some when creds present");
            assert_eq!(result["wsToken"].as_str(), Some("real-token-xyz"));
            assert_eq!(result["wsUrl"].as_str(), Some("ws://jax:4753/ui"));
        });
    }

    /// (c) client.toml with tokenRef="legacy" but moon-connection.json is missing →
    ///     returns the sentinel as-is so the frontend shows Disconnected (graceful
    ///     degradation, no panic).
    #[test]
    fn load_connection_legacy_sentinel_with_missing_moon_connection_returns_sentinel() {
        with_tmp_luna_dir(|luna_dir| {
            let client_toml = r#"kind = "bootstrap"
fileFormatVersion = 3
default = "stable"

[route.stable]
endpoints = ["ws://host:4753/ui"]
label = "stable"
tokenRef = "legacy"
"#;
            std::fs::write(luna_dir.join("client.toml"), client_toml).expect("write client.toml");
            // No moon-connection.json in the tempdir.

            let result = load_connection_in(&luna_dir)
                .expect("must return Some (not panic) when resolution fails");
            // Falls through to the sentinel — frontend shows Disconnected, which is
            // correct for a channel with no credentials.
            assert_eq!(
                result["wsToken"].as_str(),
                Some("legacy"),
                "must degrade to sentinel (not panic) when moon-connection.json is absent"
            );
            // wsUrl still comes from client.toml.
            assert_eq!(result["wsUrl"].as_str(), Some("ws://host:4753/ui"));
        });
    }
}
