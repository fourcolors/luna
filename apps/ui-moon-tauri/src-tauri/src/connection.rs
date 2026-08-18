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

/// Inner implementation of `save_connection` that accepts an explicit
/// `luna_dir` so tests can drive a tempdir without mutating `$HOME`.
///
/// #532 fold-in: when moon-connection.json exists but is UNPARSEABLE (as
/// opposed to simply absent), `normalize_profiles` on garbage starts from an
/// empty profile set - a plain save would silently DISCARD every other
/// profile's credentials with no trace they ever existed. Back the corrupt
/// file up (mode 0600, same atomic-write discipline as the store itself)
/// BEFORE persisting the fresh store, and log to stderr, so pairing genuinely
/// fixes a garbled store instead of quietly destroying data alongside it.
/// This closes #532's data-loss half; the distinct-pill half stays open.
///
/// Unified write (pair/Save parity): after moon-connection.json, also upsert
/// `~/.luna/.env` (`LUNA_<PROFILE>_WS_URL` + `_UI_WS_TOKEN`) and — when
/// `client.toml` already exists — `route.<profile>.endpoints[0]`. When
/// `activate` is true, also set moon-connection `activeProfile` and
/// client.toml `default` to the target profile. Order is load-bearing: creds
/// first, then the dial URL Moon reads from client.toml last, so a mid-write
/// failure leaves Moon on the old host rather than half-switched.
fn save_connection_in(
    luna_dir: &std::path::Path,
    url: &str,
    token: &str,
    profile: Option<&str>,
    activate: bool,
) -> Result<(), String> {
    let path = luna_dir.join("moon-connection.json");

    // Read + migrate the existing file so other profiles are PRESERVED. A
    // legacy flat file becomes profiles.stable transparently. Absent starts
    // from an empty profile set. Present-but-unparseable ALSO starts from an
    // empty profile set, but only after backing the original bytes up.
    let raw_contents = std::fs::read_to_string(&path).ok();
    let had_file = raw_contents.is_some();
    let (active, mut profiles) = match &raw_contents {
        None => (DEFAULT_PROFILE.to_string(), serde_json::Map::new()),
        Some(contents) => match serde_json::from_str::<serde_json::Value>(contents) {
            Ok(v) => normalize_profiles(&v),
            Err(parse_err) => {
                // F4 (opus review): nanos, not seconds - two corrupt saves
                // landing within the same second would otherwise collide and
                // the second backup would silently overwrite the first,
                // destroying evidence of the FIRST garbled store. Reuses
                // write_atomic_0600's own pid+nanos temp-name idiom above.
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let backup_path = luna_dir.join(format!(
                    "moon-connection.json.corrupt-{}-{}",
                    std::process::id(),
                    nanos
                ));
                match write_atomic_0600(&backup_path, contents) {
                    Ok(()) => eprintln!(
                        "warn: [luna] moon-connection.json was unparseable ({parse_err}); backed up the original to {}",
                        backup_path.display()
                    ),
                    Err(backup_err) => eprintln!(
                        "warn: [luna] moon-connection.json was unparseable ({parse_err}) AND its backup failed ({backup_err}); proceeding anyway (Save must not be blocked by a garbled store)"
                    ),
                }
                (DEFAULT_PROFILE.to_string(), serde_json::Map::new())
            }
        },
    };

    // Target slot: explicit profile arg, else the active profile (so the
    // settings panel "Save" updates whatever channel is currently selected).
    let target = profile
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.to_string())
        .unwrap_or_else(|| active.clone());

    profiles.insert(
        target.clone(),
        serde_json::json!({ "wsUrl": url, "wsToken": token }),
    );

    // Activate only when asked (or first-ever file) — mirrors luna pair's
    // --activate contract so pairing/saving a non-active channel never
    // hijacks the running Moon.
    let next_active = if !had_file || activate {
        target.clone()
    } else {
        active
    };

    let body = serde_json::to_string(&serde_json::json!({
        "activeProfile": next_active,
        "profiles": serde_json::Value::Object(profiles),
    }))
    .map_err(|e| format!("serialize failed: {}", e))?;
    write_atomic_0600(&path, &body)?;

    // CLI parity: luna chat reads ~/.luna/.env, not moon-connection.json.
    upsert_env_keys_in(luna_dir, &target, url, token)?;

    // Moon dials client.toml endpoints[0] after C3 — rewrite it here so a
    // retarget actually moves the socket (migration is idempotent once the
    // file exists, so this is the ONLY ongoing writer for endpoints).
    client_config::upsert_route_endpoint_in(luna_dir, &target, url, activate)?;

    Ok(())
}

/// `LUNA_<PROFILE>_WS_URL` / `_UI_WS_TOKEN` — same mapping as agent-cli
/// `profileEnvPrefix` (`LUNA_` + uppercased profile with `-` → `_`).
fn profile_env_prefix(profile: &str) -> String {
    let upper = profile.to_uppercase().replace('-', "_");
    format!("LUNA_{upper}")
}

/// Replace-or-append KEY=value lines in `<luna_dir>/.env` (atomic 0600).
fn upsert_env_line_in(luna_dir: &std::path::Path, key: &str, value: &str) -> Result<(), String> {
    let path = luna_dir.join(".env");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let prefix = format!("{key}=");
    let new_line = format!("{key}={value}");
    let mut replaced = false;
    let mut out: Vec<String> = existing
        .lines()
        .map(|line| {
            if !replaced && line.starts_with(&prefix) {
                replaced = true;
                new_line.clone()
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        out.push(new_line);
    }
    let contents = format!("{}\n", out.join("\n"));
    write_atomic_0600(&path, &contents)
}

fn upsert_env_keys_in(
    luna_dir: &std::path::Path,
    profile: &str,
    url: &str,
    token: &str,
) -> Result<(), String> {
    let prefix = profile_env_prefix(profile);
    upsert_env_line_in(luna_dir, &format!("{prefix}_WS_URL"), url)?;
    upsert_env_line_in(luna_dir, &format!("{prefix}_UI_WS_TOKEN"), token)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_connection(
    url: String,
    token: String,
    profile: Option<String>,
    activate: Option<bool>,
) -> Result<(), String> {
    let luna_dir = std::env::var("HOME")
        .map_err(|e| format!("HOME not set: {e}"))
        .map(|h| std::path::PathBuf::from(h).join(".luna"))?;
    save_connection_in(
        &luna_dir,
        &url,
        &token,
        profile.as_deref(),
        activate.unwrap_or(false),
    )
}

/// Step 1c Part 3d: seed `moon-connection.json` directly from a `~/.luna/.env`
/// `UI_WS_TOKEN`, INSTEAD of sending the raw token across the webview
/// boundary via the `luna-config` event (no URL redactor can reach a sibling
/// JSON field, so that field is a live sink for as long as it exists - see
/// docs/next/routes-and-view-mode-plan.md's "The security invariant, which is
/// not deferrable"). Called from main.rs's setup, BEFORE the event fires.
///
/// Only writes when `active_profile` genuinely LACKS credentials (no entry,
/// or an entry with an empty/missing `wsToken`) - never overwrites a
/// genuinely-paired profile with a stale or wrong .env seed. Returns whether
/// it actually seeded, so the caller can log accordingly; the write itself
/// reuses `save_connection_in`'s atomic-0600 + corrupt-store-backup machinery
/// (#532 fold-in), so a garbled store gets the same protection here.
pub(crate) fn seed_connection_from_env_in(
    luna_dir: &std::path::Path,
    active_profile: &str,
    url: &str,
    token: &str,
) -> Result<bool, String> {
    let existing = read_connection_value_in(luna_dir);
    let profiles = match &existing {
        Some(v) => normalize_profiles(v).1,
        None => serde_json::Map::new(),
    };

    let already_credentialed = profile_connection(&profiles, active_profile)
        .and_then(|c| {
            c.get("wsToken")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
        })
        .unwrap_or(false);
    if already_credentialed {
        return Ok(false);
    }

    // Seed must not hijack activeProfile / client.toml default — only fill
    // the missing creds slot (activate=false).
    save_connection_in(luna_dir, url, token, Some(active_profile), false)?;
    Ok(true)
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

/// Pure resolution logic once the caller already has `token_ref` for the
/// route and (lazily, only when `token_ref == "legacy"`) the parsed
/// moon-connection.json profiles. Split out from `resolve_route_token_in` so
/// every arm of the error taxonomy below is unit-testable without touching a
/// filesystem - the same pattern `normalize_profiles`/`profile_connection`
/// already use in this module.
///
/// # Error taxonomy (stable prefixes so callers can branch - closes #529)
/// - "not-paired:" - `token_ref == "legacy"` but `profiles` has no entry for
///   `route_key`, or that entry's `wsToken` is empty.
/// - "unresolvable-scheme:" - `token_ref` starts with "env:", "file:", or
///   "op://" (Phase 3 resolves these; dialing them as a literal bearer is
///   the #528 bug class - see packages/ui-transport/src/token-resolver.ts).
/// - "route-config-invalid:" - `token_ref` is empty. `parse_client_config`
///   already rejects an empty-after-trim `tokenRef` at parse time (see
///   client_config.rs), so this arm is unreachable through the normal
///   file-reading path today; it stays as defense in depth against a
///   `ClientConfig` ever being constructed some other way, and is
///   unit-tested directly here rather than via a file fixture.
///
/// # "none" and literal tokens (token-resolver.ts:43-48)
/// `token_ref == "none"` resolves to `Ok("")` - the ONE intentional empty
/// result, matching the documented transport contract. Any other non-empty,
/// non-scheme-prefixed `token_ref` is returned as-is (backward compat: some
/// migrated routes carry an already-resolved literal token).
///
/// # No trimming, deliberately
/// Neither this function nor `profile_connection` trims whitespace from a
/// resolved token - a route paired with a whitespace-only `wsToken` resolves
/// `Ok` here (see the parity test below). This is existing behavior
/// preserved, not endorsed.
fn resolve_token_ref(
    token_ref: &str,
    route_key: &str,
    profiles: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
    if token_ref.is_empty() {
        return Err(format!(
            "route-config-invalid: route {route_key:?} has an empty tokenRef"
        ));
    }
    if token_ref == "legacy" {
        let token = profile_connection(profiles, route_key).and_then(|c| {
            c["wsToken"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string())
        });
        return token.ok_or_else(|| {
            format!("not-paired: route {route_key:?} has no token paired in moon-connection.json")
        });
    }
    if token_ref == "none" {
        return Ok(String::new());
    }
    if token_ref.starts_with("env:") || token_ref.starts_with("file:") || token_ref.starts_with("op://") {
        return Err(format!(
            "unresolvable-scheme: route {route_key:?} uses tokenRef {token_ref:?} (Phase 3 resolves scheme refs)"
        ));
    }
    // Backward compat: any other non-empty tokenRef is an already-resolved
    // literal token, returned verbatim.
    Ok(token_ref.to_string())
}

/// Outcome of reading `<luna_dir>/moon-connection.json` for the "legacy"
/// sentinel resolution path, distinguishing WHY a read failed (F1, opus
/// review on plan Step 1b) - mirrors `load_client_config_in`'s
/// `Option<Result<_, String>>` shape one level finer, because two of the
/// three failure modes here mean something DIFFERENT to a caller than a
/// generic read error does:
///   - `Absent` (`io::ErrorKind::NotFound`): no credential store exists at
///     all, so the route CANNOT have a paired token - this is a "not-paired:"
///     fact about pairing state, not a transient I/O condition. Every write
///     to this file goes through `write_atomic_0600` (temp file + atomic
///     rename), so there is no half-written or transiently-absent window a
///     retry could cross; an absent file stays absent until pairing writes
///     it, and no retry changes that.
///   - `Invalid` (JSON parse failure): the store exists but is garbage.
///     Also "not-paired:", not "store-read:" - `save_connection` starts
///     from an EMPTY profile set when the existing file fails to parse (see
///     its call through `read_connection_value`/`normalize_profiles`), so
///     pairing genuinely FIXES this by rewriting the file, exactly like the
///     absent case; a retry with no user action in between would not.
///   - `Io` (a real `std::io::Error` other than `NotFound` - permissions,
///     a transient filesystem failure): THIS is "store-read:", the
///     RETRYABLE class - a fresh read on the next attempt can succeed with
///     no user action, unlike the two cases above.
/// Does NOT change `read_connection_value_in`'s public contract - every
/// other caller (`load_connection_in`, `load_profiles`, `set_active_profile`)
/// keeps using it unchanged; this is a sibling read added alongside for the
/// one call site that needs the finer distinction.
enum MoonConnectionRead {
    Ok(serde_json::Value),
    Absent,
    Invalid(String),
    Io(String),
}

fn read_moon_connection_for_route_resolution(luna_dir: &std::path::Path) -> MoonConnectionRead {
    let path = luna_dir.join("moon-connection.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MoonConnectionRead::Absent,
        Err(e) => return MoonConnectionRead::Io(format!("cannot read moon-connection.json: {e}")),
    };
    match serde_json::from_str::<serde_json::Value>(&contents) {
        Ok(v) => MoonConnectionRead::Ok(v),
        Err(e) => MoonConnectionRead::Invalid(format!("moon-connection.json parse error: {e}")),
    }
}

/// Inner implementation of `resolve_route_token` that operates on an
/// explicit `luna_dir` so the integration tests can drive a tempdir without
/// mutating `$HOME` - the same `_in` pattern `load_connection_in` uses.
///
/// # Error taxonomy, file-reading arms (see `resolve_token_ref` for the rest)
/// - "store-read:" - `client.toml` absent or unparseable, or a GENUINE I/O
///   error (not absence, not a parse failure) reading `moon-connection.json`
///   - see `MoonConnectionRead`'s doc comment for why an absent or garbled
///   moon-connection.json is "not-paired:" instead. Only the genuine-I/O arm
///   is truly retryable-without-user-action. The client.toml-absent arm keeps
///   this classification NOT because a retry fixes it (it does not - the same
///   reasoning that moved the sibling file's absent arm to "not-paired:")
///   but because no caller can reach it in that state: PoolEngine only
///   invokes this command after resolveBootRoute returned a route, which
///   requires a readable client.toml, and Settings requires listRoutes.
///   A mid-session deletion race is the only path here, and for that a
///   retry after the file returns IS the right behavior.
/// - "route-missing:" - `route_key` is not a `[route.*]` table in
///   `client.toml`.
///
/// Resolution is keyed by `route_key` - the route actually being connected -
/// NEVER by moon-connection.json's `activeProfile` (see the parity test
/// below). Reusing `activeProfile` for token lookup is the #528/#529 bug
/// class this command retires: two profiles can carry different tokens, and
/// only the ROUTE's own key names the right one.
pub(crate) fn resolve_route_token_in(
    luna_dir: &std::path::Path,
    route_key: &str,
) -> Result<String, String> {
    let cfg = match load_client_config_in(luna_dir) {
        None => {
            return Err(format!(
                "store-read: client.toml not found under {}",
                luna_dir.display()
            ))
        }
        Some(Err(reason)) => return Err(format!("store-read: {reason}")),
        Some(Ok(cfg)) => cfg,
    };

    let entry = cfg
        .route
        .get(route_key)
        .ok_or_else(|| format!("route-missing: no route named {route_key:?}"))?;

    if entry.token_ref != "legacy" {
        // none/scheme/literal/empty never need moon-connection.json.
        return resolve_token_ref(&entry.token_ref, route_key, &serde_json::Map::new());
    }

    let value = match read_moon_connection_for_route_resolution(luna_dir) {
        MoonConnectionRead::Ok(v) => v,
        MoonConnectionRead::Absent => {
            return Err(format!(
                "not-paired: route {route_key:?} has no credential store yet - pair it to create one"
            ));
        }
        MoonConnectionRead::Invalid(reason) => {
            return Err(format!(
                "not-paired: route {route_key:?}'s credential store is unreadable ({reason}) - pairing will rewrite it"
            ));
        }
        MoonConnectionRead::Io(reason) => return Err(format!("store-read: {reason}")),
    };
    let (_, profiles) = normalize_profiles(&value);
    resolve_token_ref(&entry.token_ref, route_key, &profiles)
}

/// Resolve the bearer token for `route_key` - the Tauri command wrapper
/// around `resolve_route_token_in`. Step 1b
/// (docs/next/routes-and-view-mode-plan.md): route-keyed token resolution
/// now lives in exactly ONE place, retiring the frontend mirrors in
/// wire.ts's PoolEngine and the Settings connection panel (both surfaces).
#[tauri::command]
pub(crate) fn resolve_route_token(route_key: String) -> Result<String, String> {
    let luna_dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".luna"))
        .map_err(|e| format!("store-read: HOME not set: {e}"))?;
    resolve_route_token_in(&luna_dir, &route_key)
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

    /// #532 fold-in: a corrupt (unparseable) moon-connection.json must be
    /// backed up before save_connection_in overwrites it - otherwise pairing
    /// a route through a garbled store silently destroys every other
    /// profile's credentials with no trace they ever existed.
    #[test]
    fn save_connection_in_backs_up_a_corrupt_store_before_overwriting_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna = dir.path().join(".luna");
        std::fs::create_dir_all(&luna).expect("mkdir .luna");

        let garbage = "{ this is not valid json, and it used to hold real creds";
        std::fs::write(luna.join("moon-connection.json"), garbage).expect("seed corrupt file");

        save_connection_in(&luna, "ws://canary:4753/ui", "canary-tok", Some("canary"), false)
            .expect("save must succeed even against a corrupt store");

        // The fresh store parses and carries the new save.
        let fresh = std::fs::read_to_string(luna.join("moon-connection.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&fresh).expect("new store parses");
        assert_eq!(value["profiles"]["canary"]["wsToken"], json!("canary-tok"));

        // Exactly one backup exists, named
        // moon-connection.json.corrupt-<pid>-<nanos>, and its bytes are the
        // ORIGINAL garbage, byte-for-byte.
        let backups: Vec<_> = std::fs::read_dir(&luna)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("moon-connection.json.corrupt-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one corrupt-store backup");
        let backup_contents = std::fs::read_to_string(backups[0].path()).unwrap();
        assert_eq!(backup_contents, garbage, "backup preserves the original bytes exactly");

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(backups[0].path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "backup is mode 0600, same as the store itself");
    }

    /// F4 (opus review): two corrupt saves landing within the same SECOND
    /// must produce TWO distinct backups, not one silently overwriting the
    /// other. A second-precision filename would collide here; nanos does not.
    #[test]
    fn save_connection_in_never_collides_two_corrupt_backups_in_the_same_second() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna = dir.path().join(".luna");
        std::fs::create_dir_all(&luna).expect("mkdir .luna");

        let garbage_one = "{ first corrupt write, garbage-one";
        std::fs::write(luna.join("moon-connection.json"), garbage_one).expect("seed first corrupt file");
        save_connection_in(&luna, "ws://canary:4753/ui", "tok-1", Some("canary"), false).expect("save #1");

        // Corrupt the FRESH store again immediately (well within the same
        // wall-clock second on any real machine) and save again.
        let garbage_two = "{ second corrupt write, garbage-two";
        std::fs::write(luna.join("moon-connection.json"), garbage_two).expect("seed second corrupt file");
        save_connection_in(&luna, "ws://canary:4753/ui", "tok-2", Some("canary"), false).expect("save #2");

        let mut backups: Vec<_> = std::fs::read_dir(&luna)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("moon-connection.json.corrupt-")
            })
            .collect();
        assert_eq!(
            backups.len(),
            2,
            "two distinct backups, not one overwritten by the other"
        );

        backups.sort_by_key(|e| e.file_name());
        let contents: Vec<String> = backups
            .iter()
            .map(|e| std::fs::read_to_string(e.path()).unwrap())
            .collect();
        assert!(
            contents.contains(&garbage_one.to_string()),
            "the FIRST corrupt store's bytes must survive"
        );
        assert!(
            contents.contains(&garbage_two.to_string()),
            "the SECOND corrupt store's bytes must survive"
        );
    }

    /// The common case (file absent, or already valid) must NOT create a
    /// backup - only a genuinely corrupt file triggers one.
    #[test]
    fn save_connection_in_creates_no_backup_when_the_store_is_absent_or_valid() {
        with_tmp_luna_dir(|luna_dir| {
            // Absent case.
            save_connection_in(&luna_dir, "ws://stable:4753/ui", "tok1", None, false)
                .expect("save against an absent store");
            let no_backup = std::fs::read_dir(&luna_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
            assert!(!no_backup, "an absent store must never produce a backup");

            // Valid case: save again against the now-valid store.
            save_connection_in(&luna_dir, "ws://stable:4753/ui", "tok2", None, false)
                .expect("save against a valid store");
            let still_no_backup = std::fs::read_dir(&luna_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
            assert!(!still_no_backup, "a valid store must never produce a backup");
        });
    }

    /// Step 1c Part 3d seeding DECISION, scenario one: a fresh install has
    /// the token ONLY in ~/.luna/.env (load_connection has nothing to
    /// return) - the store must be CREATED with it.
    #[test]
    fn seed_connection_from_env_in_creates_the_store_when_absent() {
        with_tmp_luna_dir(|luna_dir| {
            let seeded = seed_connection_from_env_in(
                &luna_dir,
                "stable",
                "ws://127.0.0.1:4753/ui",
                "env-seed-tok",
            )
            .expect("seeding an absent store must succeed");
            assert!(seeded, "an absent store has no creds - must seed");

            let value = read_connection_value_in(&luna_dir).expect("store now exists");
            let (_, profiles) = normalize_profiles(&value);
            let creds = profile_connection(&profiles, "stable").expect("stable profile written");
            assert_eq!(creds["wsToken"], json!("env-seed-tok"));
            assert_eq!(creds["wsUrl"], json!("ws://127.0.0.1:4753/ui"));
        });
    }

    /// seed_connection_from_env_in goes through save_connection_in, so when
    /// client.toml already exists it ALSO rewrites endpoints[0] (same unified
    /// writer). activate stays false — default / activeProfile are not hijacked.
    #[test]
    fn seed_connection_from_env_in_rewrites_client_toml_endpoints_without_activate() {
        with_tmp_luna_dir(|luna_dir| {
            let toml = r#"kind = "bootstrap"
fileFormatVersion = 3
default = "stable"

[route.stable]
endpoints = ["ws://jax-box:4753/ui"]
label = "stable"
tokenRef = "legacy"
"#;
            std::fs::write(luna_dir.join("client.toml"), toml).expect("seed client.toml");
            // Profile present but uncredentialed → seed is allowed.
            let moon = r#"{"activeProfile":"stable","profiles":{"stable":{"wsUrl":"ws://jax-box:4753/ui","wsToken":""}}}"#;
            std::fs::write(luna_dir.join("moon-connection.json"), moon).expect("seed moon");

            let seeded = seed_connection_from_env_in(
                &luna_dir,
                "stable",
                "ws://127.0.0.1:4753/ui",
                "env-seed-tok",
            )
            .expect("seed ok");
            assert!(seeded);

            let cfg = client_config::parse_client_config(
                &std::fs::read_to_string(luna_dir.join("client.toml")).unwrap(),
            )
            .expect("parse");
            assert_eq!(cfg.default, "stable", "seed must not flip default");
            assert_eq!(
                cfg.route.get("stable").unwrap().endpoints,
                vec!["ws://127.0.0.1:4753/ui".to_string()],
                "seed rewrites endpoints via the unified writer"
            );
            let moon_after: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(luna_dir.join("moon-connection.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(moon_after["activeProfile"], json!("stable"));
            assert_eq!(moon_after["profiles"]["stable"]["wsToken"], json!("env-seed-tok"));
        });
    }

    /// Step 1c Part 3d seeding DECISION, scenario two: the active profile
    /// already has creds - the store must be left UNTOUCHED (never clobber a
    /// genuinely-paired profile with a stale or wrong .env value).
    #[test]
    fn seed_connection_from_env_in_leaves_an_already_credentialed_profile_untouched() {
        with_tmp_luna_dir(|luna_dir| {
            save_connection_in(&luna_dir, "ws://paired.host:4753/ui", "real-paired-tok", Some("stable"), false)
                .expect("seed a real pairing first");

            let seeded = seed_connection_from_env_in(
                &luna_dir,
                "stable",
                "ws://127.0.0.1:4753/ui",
                "env-seed-tok-should-not-land",
            )
            .expect("must not error even though it declines to write");
            assert!(!seeded, "an already-credentialed profile must not be re-seeded");

            let value = read_connection_value_in(&luna_dir).expect("store still exists");
            let (_, profiles) = normalize_profiles(&value);
            let creds = profile_connection(&profiles, "stable").expect("stable profile still present");
            assert_eq!(
                creds["wsToken"],
                json!("real-paired-tok"),
                "the real pairing must survive untouched"
            );
            assert_eq!(creds["wsUrl"], json!("ws://paired.host:4753/ui"));
        });
    }

    /// The seeding decision is keyed by PROFILE, not by "the store has any
    /// content at all" - a store with OTHER profiles paired but NOT this one
    /// must still seed this one.
    #[test]
    fn seed_connection_from_env_in_seeds_a_specific_unpaired_profile_even_when_others_exist() {
        with_tmp_luna_dir(|luna_dir| {
            save_connection_in(&luna_dir, "ws://stable.host:4753/ui", "stable-tok", Some("stable"), false)
                .expect("seed stable first");

            let seeded = seed_connection_from_env_in(
                &luna_dir,
                "canary",
                "ws://canary.host:4753/ui",
                "env-seed-for-canary",
            )
            .expect("seeding a different, unpaired profile must succeed");
            assert!(seeded);

            let value = read_connection_value_in(&luna_dir).unwrap();
            let (_, profiles) = normalize_profiles(&value);
            assert_eq!(
                profile_connection(&profiles, "stable").unwrap()["wsToken"],
                json!("stable-tok"),
                "stable's existing pairing must survive"
            );
            assert_eq!(
                profile_connection(&profiles, "canary").unwrap()["wsToken"],
                json!("env-seed-for-canary"),
                "canary must now be seeded"
            );
        });
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

    // ── resolve_route_token_in - Step 1b route-keyed token resolution ──────
    // (docs/next/routes-and-view-mode-plan.md, closes #529's error taxonomy)

    fn write_route_client_toml(
        luna_dir: &std::path::Path,
        default_key: &str,
        route_key: &str,
        token_ref: &str,
        endpoint: &str,
    ) {
        let toml = format!(
            "kind = \"bootstrap\"\nfileFormatVersion = 3\ndefault = {default_key:?}\n\n[route.{route_key}]\nendpoints = [{endpoint:?}]\nlabel = {route_key:?}\ntokenRef = {token_ref:?}\n"
        );
        std::fs::write(luna_dir.join("client.toml"), toml).expect("write client.toml");
    }

    #[test]
    fn resolve_route_token_none_resolves_to_empty_string() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "none", "ws://host:4753/ui");
            let result = resolve_route_token_in(&luna_dir, "stable");
            assert_eq!(
                result,
                Ok(String::new()),
                "\"none\" is the one intentional empty-string result (token-resolver.ts:43-48)"
            );
        });
    }

    #[test]
    fn resolve_route_token_literal_passes_through() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(
                &luna_dir,
                "stable",
                "stable",
                "already-resolved-literal-tok",
                "ws://host:4753/ui",
            );
            let result = resolve_route_token_in(&luna_dir, "stable");
            assert_eq!(
                result,
                Ok("already-resolved-literal-tok".to_string()),
                "a non-legacy, non-none, non-scheme tokenRef is a backward-compat literal token"
            );
        });
    }

    #[test]
    fn resolve_route_token_scheme_refs_are_unresolvable() {
        for scheme_ref in ["env:LUNA_TOKEN", "file:/abs/path", "op://vault/item/field"] {
            with_tmp_luna_dir(|luna_dir| {
                write_route_client_toml(&luna_dir, "stable", "stable", scheme_ref, "ws://host:4753/ui");
                let result = resolve_route_token_in(&luna_dir, "stable");
                let err = result.expect_err(&format!("{scheme_ref} must be unresolvable"));
                assert!(
                    err.starts_with("unresolvable-scheme:"),
                    "expected an unresolvable-scheme: prefix for {scheme_ref}, got {err:?}"
                );
            });
        }
    }

    #[test]
    fn resolve_route_token_legacy_sentinel_resolves_from_moon_connection() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "legacy", "ws://host:4753/ui");
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": { "stable": { "wsUrl": "ws://host:4753/ui", "wsToken": "real-paired-token" } }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn).expect("write moon-connection.json");

            let result = resolve_route_token_in(&luna_dir, "stable");
            assert_eq!(result, Ok("real-paired-token".to_string()));
        });
    }

    #[test]
    fn resolve_route_token_legacy_sentinel_not_paired_when_profile_missing() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "canary", "legacy", "ws://canary:4753/ui");
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": { "stable": { "wsUrl": "ws://host:4753/ui", "wsToken": "stable-token" } }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn).expect("write moon-connection.json");

            // "canary" has NO profile at all in moon-connection.json.
            let result = resolve_route_token_in(&luna_dir, "canary");
            let err = result.expect_err("an unpaired route must refuse, not fall back to another profile");
            assert!(err.starts_with("not-paired:"), "got {err:?}");
            assert!(err.contains("canary"), "the error must name the route key, got {err:?}");
        });
    }

    #[test]
    fn resolve_route_token_legacy_sentinel_not_paired_when_token_empty() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "canary", "legacy", "ws://canary:4753/ui");
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": { "canary": { "wsUrl": "ws://canary:4753/ui", "wsToken": "" } }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn).expect("write moon-connection.json");

            let result = resolve_route_token_in(&luna_dir, "canary");
            let err = result.expect_err("an empty paired token must refuse, not resolve to \"\"");
            assert!(err.starts_with("not-paired:"), "got {err:?}");
        });
    }

    #[test]
    fn resolve_route_token_route_missing() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "none", "ws://host:4753/ui");
            let result = resolve_route_token_in(&luna_dir, "ghost-route");
            let err = result.expect_err("a route absent from client.toml must refuse");
            assert!(err.starts_with("route-missing:"), "got {err:?}");
        });
    }

    #[test]
    fn resolve_route_token_client_toml_absent_is_store_read() {
        with_tmp_luna_dir(|luna_dir| {
            // No client.toml written at all.
            let result = resolve_route_token_in(&luna_dir, "stable");
            let err = result.expect_err("an absent client.toml must be RETRYABLE, not a permanent refusal");
            assert!(err.starts_with("store-read:"), "got {err:?}");
        });
    }

    #[test]
    fn resolve_route_token_client_toml_unparseable_is_store_read() {
        with_tmp_luna_dir(|luna_dir| {
            std::fs::write(luna_dir.join("client.toml"), "this is not valid toml {{{")
                .expect("write garbage client.toml");
            let result = resolve_route_token_in(&luna_dir, "stable");
            let err = result.expect_err("unparseable client.toml must be RETRYABLE");
            assert!(err.starts_with("store-read:"), "got {err:?}");
        });
    }

    /// F1 (opus review): FLIPS the pre-fix pin. An absent moon-connection.json
    /// is "not-paired:", not "store-read:" - write_atomic_0600 (temp file +
    /// atomic rename) leaves no half-written or transiently-absent window a
    /// retry could cross, so "the file doesn't exist" is a durable fact about
    /// pairing state (no credential store has ever been written for this
    /// route), not a transient I/O condition. See MoonConnectionRead's doc
    /// comment for the full reasoning.
    #[test]
    fn resolve_route_token_moon_connection_absent_for_legacy_is_not_paired() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "legacy", "ws://host:4753/ui");
            // No moon-connection.json at all.
            let result = resolve_route_token_in(&luna_dir, "stable");
            let err = result.expect_err("an absent moon-connection.json means nothing is paired");
            assert!(err.starts_with("not-paired:"), "got {err:?}");
            assert!(err.contains("stable"), "the error must name the route key, got {err:?}");
        });
    }

    /// F1 (opus review): a moon-connection.json that EXISTS but fails to
    /// parse is ALSO "not-paired:" - save_connection starts from an empty
    /// profile set when the existing file is unparseable (see
    /// normalize_profiles's "empty / unrecognized object" arm reached via a
    /// parse failure upstream), so pairing genuinely FIXES this by
    /// rewriting the file, exactly like the absent case. A bare retry with
    /// no user action would not.
    #[test]
    fn resolve_route_token_moon_connection_malformed_for_legacy_is_not_paired() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "legacy", "ws://host:4753/ui");
            std::fs::write(luna_dir.join("moon-connection.json"), "{ this is not valid json")
                .expect("write garbage moon-connection.json");

            let result = resolve_route_token_in(&luna_dir, "stable");
            let err = result.expect_err("a malformed moon-connection.json means nothing is paired");
            assert!(err.starts_with("not-paired:"), "got {err:?}");
            assert!(err.contains("stable"), "the error must name the route key, got {err:?}");
        });
    }

    #[test]
    fn resolve_route_token_empty_token_ref_is_route_config_invalid() {
        // Unit-tested directly against the pure helper (see its doc comment):
        // parse_client_config already rejects an empty tokenRef at parse
        // time, so this arm is unreachable through the file-reading path
        // today and stays as defense in depth.
        let empty_profiles = serde_json::Map::new();
        let result = resolve_token_ref("", "stable", &empty_profiles);
        let err = result.expect_err("an empty tokenRef must be refused, not treated as a literal");
        assert!(err.starts_with("route-config-invalid:"), "got {err:?}");
    }

    #[test]
    fn resolve_route_token_whitespace_only_token_resolves_ok_no_trim_parity() {
        // Documents the deliberate no-trim behavior: neither this function
        // nor profile_connection trims whitespace, matching every other
        // token-touching path in this module.
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "stable", "legacy", "ws://host:4753/ui");
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": { "stable": { "wsUrl": "ws://host:4753/ui", "wsToken": "   " } }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn).expect("write moon-connection.json");

            let result = resolve_route_token_in(&luna_dir, "stable");
            assert_eq!(
                result,
                Ok("   ".to_string()),
                "a whitespace-only paired token resolves Ok verbatim (no trim), matching profile_connection's non-empty-only check"
            );
        });
    }

    /// THE regression test for the #528/#529 bug class: resolution must key
    /// off the ROUTE being connected, never moon-connection.json's
    /// activeProfile. Fixture: activeProfile is "stable", but we resolve
    /// "canary" - a DIFFERENT route with its OWN, different token. If
    /// resolution ever again keys by activeProfile instead of route_key,
    /// this test catches it by asserting the WRONG (stable's) token is
    /// never returned.
    #[test]
    fn resolve_route_token_legacy_sentinel_keys_by_route_key_not_active_profile() {
        with_tmp_luna_dir(|luna_dir| {
            write_route_client_toml(&luna_dir, "stable", "canary", "legacy", "ws://canary:4753/ui");
            let moon_conn = serde_json::json!({
                "activeProfile": "stable",
                "profiles": {
                    "stable": { "wsUrl": "ws://stable:4753/ui", "wsToken": "stable-token-WRONG-for-canary" },
                    "canary": { "wsUrl": "ws://canary:4753/ui", "wsToken": "canary-token-RIGHT" }
                }
            })
            .to_string();
            std::fs::write(luna_dir.join("moon-connection.json"), moon_conn).expect("write moon-connection.json");

            let result = resolve_route_token_in(&luna_dir, "canary")
                .expect("canary is paired and must resolve");
            assert_eq!(
                result, "canary-token-RIGHT",
                "must resolve canary's OWN token, not activeProfile (stable)'s"
            );
            assert_ne!(
                result, "stable-token-WRONG-for-canary",
                "REGRESSION: resolved the active profile's token instead of the route's own"
            );
        });
    }

    /// Unified pair/Save write: after C3, retargeting MUST rewrite
    /// client.toml endpoints[0] + .env + moon-connection together. Without
    /// this, migrate_legacy is idempotent and Moon keeps dialing the old host.
    #[test]
    fn save_connection_in_rewrites_client_toml_env_and_moon_connection() {
        with_tmp_luna_dir(|luna_dir| {
            let toml = r#"kind = "bootstrap"
fileFormatVersion = 3
default = "stable"

[route.stable]
endpoints = ["ws://jax-box:4753/ui"]
label = "stable"
tokenRef = "legacy"

[route.dev]
endpoints = ["ws://jax-box:5753/ui"]
label = "dev"
tokenRef = "legacy"
"#;
            std::fs::write(luna_dir.join("client.toml"), toml).expect("seed client.toml");
            // Pre-existing dual-channel file; active stays stable unless activate.
            let moon = r#"{"activeProfile":"stable","profiles":{"stable":{"wsUrl":"ws://jax-box:4753/ui","wsToken":"old"},"dev":{"wsUrl":"ws://jax-box:5753/ui","wsToken":"devold"}}}"#;
            std::fs::write(luna_dir.join("moon-connection.json"), moon).expect("seed moon");

            save_connection_in(
                &luna_dir,
                "ws://127.0.0.1:4753/ui",
                "newtok",
                Some("stable"),
                false,
            )
            .expect("save without activate");

            let moon_after: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(luna_dir.join("moon-connection.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(moon_after["activeProfile"], json!("stable"));
            assert_eq!(
                moon_after["profiles"]["stable"]["wsUrl"],
                json!("ws://127.0.0.1:4753/ui")
            );
            assert_eq!(moon_after["profiles"]["stable"]["wsToken"], json!("newtok"));
            assert_eq!(
                moon_after["profiles"]["dev"]["wsToken"],
                json!("devold"),
                "other profiles preserved"
            );

            let env = std::fs::read_to_string(luna_dir.join(".env")).expect(".env written");
            assert!(env.contains("LUNA_STABLE_WS_URL=ws://127.0.0.1:4753/ui"));
            assert!(env.contains("LUNA_STABLE_UI_WS_TOKEN=newtok"));

            let cfg = client_config::parse_client_config(
                &std::fs::read_to_string(luna_dir.join("client.toml")).unwrap(),
            )
            .expect("client.toml still valid");
            assert_eq!(cfg.default, "stable", "activate=false leaves default");
            assert_eq!(
                cfg.route.get("stable").unwrap().endpoints,
                vec!["ws://127.0.0.1:4753/ui".to_string()]
            );

            // load_connection must now surface the NEW url (Moon dial path).
            let loaded = load_connection_in(&luna_dir).expect("load");
            assert_eq!(loaded["wsUrl"], json!("ws://127.0.0.1:4753/ui"));
            assert_eq!(loaded["wsToken"], json!("newtok"));

            // activate=true on the other channel flips default + activeProfile.
            save_connection_in(
                &luna_dir,
                "ws://127.0.0.1:5753/ui",
                "devtok",
                Some("dev"),
                true,
            )
            .expect("save with activate");
            let moon2: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(luna_dir.join("moon-connection.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(moon2["activeProfile"], json!("dev"));
            let cfg2 = client_config::parse_client_config(
                &std::fs::read_to_string(luna_dir.join("client.toml")).unwrap(),
            )
            .unwrap();
            assert_eq!(cfg2.default, "dev");
            assert_eq!(
                cfg2.route.get("dev").unwrap().endpoints,
                vec!["ws://127.0.0.1:5753/ui".to_string()]
            );
        });
    }
}
