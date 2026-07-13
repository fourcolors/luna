/// Phase-2 C3: client route config module.
///
/// Reads `~/.luna/client.toml` (the bootstrap route config) and manages per-panel
/// route state in `~/.luna/moon-session.json`.  Token resolution (`op://` refs) is
/// deliberately deferred to Phase-3 — this module loads and returns the raw
/// `tokenRef` string only.
///
/// # Persistence contract
/// Both files are written atomically at mode 0600 (temp→rename, fsync before
/// rename, chmod re-assert after rename) so a crash can never corrupt either file.
///
/// # Error philosophy
/// Fail-closed.  Unknown `kind`, unknown major `fileFormatVersion`, a route that
/// lacks `endpoints` or `tokenRef`, and a missing route key are all hard errors
/// returned as `Err(String)` (surfaced to the JS caller as a rejected `invoke`).
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::sync::atomic::{AtomicU64, Ordering};

// ── TOML schema ──────────────────────────────────────────────────────────────

/// The top-level `~/.luna/client.toml` structure.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ClientConfig {
    pub kind: String,
    #[serde(rename = "fileFormatVersion")]
    pub file_format_version: u32,
    pub default: String,
    #[serde(default)]
    pub route: HashMap<String, RouteEntry>,
}

/// A single `[route.<label>]` section.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct RouteEntry {
    /// Human-readable label; falls back to the map key when absent.
    pub label: Option<String>,
    /// Ordered dial list — first entry wins on connect.
    pub endpoints: Vec<String>,
    /// Raw token reference string (`env:VAR`, `file:path`, or `op://…`).
    /// Resolution is a Phase-3 concern; we carry it opaquely.
    #[serde(rename = "tokenRef")]
    pub token_ref: String,
    /// Optional hint about the expected server identity (e.g. hostname match).
    pub expect: Option<String>,
}

/// The data returned to JS callers of `load_route`.
#[derive(Debug, Serialize)]
pub struct RouteInfo {
    pub label: String,
    /// Resolved label (map key if `.label` field is absent).
    pub key: String,
    pub endpoints: Vec<String>,
    pub token_ref: String,
    pub expect: Option<String>,
    /// Transport derived from the scheme of `endpoints[0]` (`"ws"` or `"wss"`).
    pub transport: String,
}

/// Returned by `list_routes`.
#[derive(Debug, Serialize)]
pub struct RouteList {
    pub default: String,
    pub routes: Vec<RouteSummary>,
}

#[derive(Debug, Serialize)]
pub struct RouteSummary {
    pub key: String,
    pub label: String,
    pub is_default: bool,
}

// ── moon-session.json schema ──────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, Serialize)]
struct MoonSession {
    #[serde(default)]
    panels: HashMap<String, PanelState>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct PanelState {
    route: Option<String>,
    /// Per-panel last-thread pointer.  Written on every thread-snapshot;
    /// read on cold-start to resume the right thread for this window/server.
    /// Semantically bound to the route this panel runs on (the panel is already
    /// route-bound, so the tuple (panel_id, route) is uniquely identified by
    /// `panel_id` alone — but the field is next to `route` to make the
    /// coupling explicit in the persisted JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_thread: Option<String>,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn luna_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    Ok(std::path::PathBuf::from(home).join(".luna"))
}

fn client_toml_path() -> Result<std::path::PathBuf, String> {
    Ok(luna_dir()?.join("client.toml"))
}

fn moon_session_path() -> Result<std::path::PathBuf, String> {
    Ok(luna_dir()?.join("moon-session.json"))
}

/// Process-lifetime counter — appended to atomic temp names to guarantee
/// uniqueness within the same process even under sub-nanosecond clocks.
static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomic 0600 write — identical contract to `write_atomic_0600` in main.rs.
/// Kept local so client_config.rs is self-contained and testable in isolation.
fn write_atomic_0600(path: &std::path::Path, body: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "path has no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".luna-atomic.{}.{}.{}.tmp",
        std::process::id(),
        nanos,
        seq
    ));

    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("open temp failed: {e}"))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync temp failed: {e}"))?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename failed: {e}"));
    }

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod failed: {e}"))?;

    Ok(())
}

/// Parse and VALIDATE `~/.luna/client.toml`.
///
/// Validation rules (fail-closed):
/// * `kind` must be `"bootstrap"` — `"registry"` and any other value are rejected.
/// * `fileFormatVersion` must be ≤ `SUPPORTED_VERSION` (plain integer, not semver).
///   Version 3 is the canonical value after the `active` → `default` rename.
/// * Each route must have at least one endpoint and a non-empty `tokenRef`.
const SUPPORTED_VERSION: u32 = 3;

pub(crate) fn parse_client_config(toml_str: &str) -> Result<ClientConfig, String> {
    let cfg: ClientConfig =
        toml::from_str(toml_str).map_err(|e| format!("client.toml parse error: {e}"))?;

    // Kind validation — fail-closed on anything other than "bootstrap".
    if cfg.kind != "bootstrap" {
        return Err(format!(
            "client.toml: unsupported kind {:?} (expected \"bootstrap\")",
            cfg.kind
        ));
    }

    // Version guard — reject anything newer than SUPPORTED_VERSION cleanly.
    if cfg.file_format_version > SUPPORTED_VERSION {
        return Err(format!(
            "client.toml: unsupported fileFormatVersion {} (max supported: {})",
            cfg.file_format_version, SUPPORTED_VERSION
        ));
    }

    // Per-route validation.
    for (key, route) in &cfg.route {
        if route.endpoints.is_empty() {
            return Err(format!(
                "client.toml: route {key:?} has no endpoints (at least one required)"
            ));
        }
        if route.token_ref.trim().is_empty() {
            return Err(format!("client.toml: route {key:?} has an empty tokenRef"));
        }
    }

    Ok(cfg)
}

fn load_client_config() -> Result<ClientConfig, String> {
    let path = client_toml_path()?;
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read ~/.luna/client.toml: {e}"))?;
    parse_client_config(&contents)
}

/// Public alias so external callers (e.g. future non-Tauri tooling) can inspect
/// the default route without going through a Tauri command.
/// `main.rs` now uses `load_client_config_in` directly for testability.
#[allow(dead_code)]
pub(crate) fn load_client_config_pub() -> Result<ClientConfig, String> {
    load_client_config()
}

fn derive_transport(endpoints: &[String]) -> String {
    let first = endpoints.first().map(String::as_str).unwrap_or("");
    if first.starts_with("wss://") {
        "wss".to_string()
    } else {
        "ws".to_string()
    }
}

fn route_info(key: &str, entry: &RouteEntry) -> RouteInfo {
    let label = entry.label.clone().unwrap_or_else(|| key.to_string());
    let transport = derive_transport(&entry.endpoints);
    RouteInfo {
        label,
        key: key.to_string(),
        endpoints: entry.endpoints.clone(),
        token_ref: entry.token_ref.clone(),
        expect: entry.expect.clone(),
        transport,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Load the configuration for a single named route.
///
/// Returns `{key, label, endpoints, tokenRef, expect, transport}`.
/// Hard-errors on: file missing, parse failure, unknown route key.
#[tauri::command]
pub fn load_route(route_key: String) -> Result<RouteInfo, String> {
    let cfg = load_client_config()?;
    let entry = cfg
        .route
        .get(&route_key)
        .ok_or_else(|| format!("client.toml: no route named {route_key:?}"))?;
    Ok(route_info(&route_key, entry))
}

/// List all available routes plus the current default, for the route switcher UI.
#[tauri::command]
pub fn list_routes() -> Result<RouteList, String> {
    let cfg = load_client_config()?;
    let mut routes: Vec<RouteSummary> = cfg
        .route
        .iter()
        .map(|(key, entry)| RouteSummary {
            label: entry.label.clone().unwrap_or_else(|| key.clone()),
            is_default: key == &cfg.default,
            key: key.clone(),
        })
        .collect();
    // Stable sort: default first, then alphabetical.
    routes.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.key.cmp(&b.key))
    });
    Ok(RouteList {
        default: cfg.default,
        routes,
    })
}

/// Atomically update the `default` field in `~/.luna/client.toml` while
/// preserving comments, unknown fields, and route ordering.
/// Uses `toml_edit` for surgical in-place editing instead of a full round-trip.
///
/// Hard-errors if the route key doesn't exist in the file (prevents pointing
/// `default` at a phantom route).
#[tauri::command]
pub fn set_default_route(route_key: String) -> Result<(), String> {
    // Guard: route must exist before we touch the file.
    let cfg = load_client_config()?;
    if !cfg.route.contains_key(&route_key) {
        return Err(format!(
            "client.toml: cannot set default — no route named {route_key:?}"
        ));
    }

    // Read the raw file and parse with toml_edit to preserve formatting.
    let path = client_toml_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read ~/.luna/client.toml: {e}"))?;
    let mut doc: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| format!("client.toml toml_edit parse error: {e}"))?;

    // Surgically update only the `default` key.
    doc["default"] = toml_edit::value(route_key);

    write_atomic_0600(&path, &doc.to_string())
}

// ── moon-session.json (panel → route state) ───────────────────────────────────

fn load_session() -> MoonSession {
    let path = match moon_session_path() {
        Ok(p) => p,
        Err(_) => return MoonSession::default(),
    };
    let contents = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return MoonSession::default(),
    };
    match serde_json::from_str(&contents) {
        Ok(session) => session,
        Err(err) => {
            eprintln!(
                "warn: [luna] moon-session.json is corrupt or unreadable: {err}; starting with empty bindings"
            );
            MoonSession::default()
        }
    }
}

fn save_session(session: &MoonSession) -> Result<(), String> {
    let path = moon_session_path()?;
    let body = serde_json::to_string_pretty(session)
        .map_err(|e| format!("moon-session.json serialize error: {e}"))?;
    write_atomic_0600(&path, &body)
}

/// Retrieve the route key assigned to a panel (returns `null` / `None` when
/// the panel hasn't been assigned one yet; the caller then uses the default).
#[tauri::command]
pub fn get_panel_route(panel_id: String) -> Option<String> {
    let session = load_session();
    session.panels.get(&panel_id).and_then(|p| p.route.clone())
}

/// Persist `route_key` as the route for `panel_id` in `moon-session.json`.
#[tauri::command]
pub fn set_panel_route(panel_id: String, route_key: String) -> Result<(), String> {
    let mut session = load_session();
    session.panels.entry(panel_id).or_default().route = Some(route_key);
    save_session(&session)
}

// ── Phase-2 last-thread (per-panel) ──────────────────────────────────────────

/// The file name for the legacy global last-thread pointer.
const LEGACY_LAST_THREAD_FILE: &str = ".last-thread-default";

/// Read the legacy `~/.luna/.last-thread-default` file and return its content,
/// or `None` if absent / empty.
fn read_legacy_last_thread_in(luna_dir: &std::path::Path) -> Option<String> {
    let path = luna_dir.join(LEGACY_LAST_THREAD_FILE);
    let content = std::fs::read_to_string(path).ok()?;
    let id = content.trim().to_string();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Inner implementation of `get_panel_last_thread` that accepts an explicit
/// `luna_dir` so tests can pass a tempdir without mutating `HOME`.
///
/// Resolution order (Phase-2 migration):
///   1. `panels[panel_id].last_thread` in moon-session.json — if set, return it.
///   2. Legacy `~/.luna/.last-thread-default` — adopt it (write into the panel
///      slot so the next read is fast, idempotent on 2nd call) but do NOT delete
///      the legacy file (one-release grace period for rollback).
///   3. Returns `None` when neither source is set.
///
/// PINNED windows must never call this — they are bound to ONE thread via URL
/// param and must not interact with the restart-resume pointer.
fn get_panel_last_thread_in(luna_dir: &std::path::Path, panel_id: &str) -> Option<String> {
    let session_path = luna_dir.join("moon-session.json");

    // Load the session from the explicit luna_dir (not the HOME-derived path).
    let mut session: MoonSession = std::fs::read_to_string(&session_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // 1. Per-panel slot already set → fast path (idempotent on 2nd call).
    if let Some(existing) = session
        .panels
        .get(panel_id)
        .and_then(|p| p.last_thread.clone())
    {
        return Some(existing);
    }

    // 2. Adopt from the legacy file (one-release migration).
    let legacy_id = read_legacy_last_thread_in(luna_dir)?;

    // Persist the adopted id into the panel slot so future reads skip this path.
    session
        .panels
        .entry(panel_id.to_string())
        .or_default()
        .last_thread = Some(legacy_id.clone());
    // Best-effort write — failure is non-fatal (we still return the adopted id).
    if let Ok(body) = serde_json::to_string_pretty(&session) {
        let _ = write_atomic_0600(&session_path, &body);
    }

    Some(legacy_id)
}

/// Inner implementation of `set_panel_last_thread` that accepts an explicit
/// `luna_dir` so tests can pass a tempdir without mutating `HOME`.
///
/// Trims `thread_id` once at entry so both the session slot and the legacy
/// file store the same value, regardless of any whitespace in the caller's input.
fn set_panel_last_thread_in(
    luna_dir: &std::path::Path,
    panel_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    // Trim once — both stores must agree on the id (no whitespace divergence).
    let thread_id = thread_id.trim().to_string();

    let session_path = luna_dir.join("moon-session.json");

    // Load the session from the explicit luna_dir.
    let mut session: MoonSession = std::fs::read_to_string(&session_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Per-panel write (authoritative store).
    session
        .panels
        .entry(panel_id.to_string())
        .or_default()
        .last_thread = Some(thread_id.clone());
    let body = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("moon-session.json serialize error: {e}"))?;
    write_atomic_0600(&session_path, &body)?;

    // Dual-write: also update the legacy global file for rollback safety.
    let legacy_path = luna_dir.join(LEGACY_LAST_THREAD_FILE);
    std::fs::create_dir_all(luna_dir).map_err(|e| format!("create ~/.luna failed: {e}"))?;
    // Plain write (not 0600 atomic) — mirrors the existing set_last_thread_id in
    // main.rs which uses std::fs::write.  The dual-write is fire-and-forget
    // redundancy; the authoritative store is moon-session.json.
    std::fs::write(&legacy_path, &thread_id)
        .map_err(|e| format!("failed to write .last-thread-default: {e}"))?;

    Ok(())
}

/// Retrieve the per-panel last-thread pointer from `moon-session.json`.
///
/// Delegates to `get_panel_last_thread_in` with the real `~/.luna` directory.
/// PINNED windows must never call this — they are bound to ONE thread via URL
/// param and must not interact with the restart-resume pointer.
#[tauri::command]
pub fn get_panel_last_thread(panel_id: String) -> Option<String> {
    let luna_dir = luna_dir().ok()?;
    get_panel_last_thread_in(&luna_dir, &panel_id)
}

/// Persist `thread_id` as the last-thread pointer for `panel_id` in
/// `moon-session.json`.  Additionally writes the legacy global file so that
/// older app versions still resume correctly (one-release dual-write period).
///
/// Delegates to `set_panel_last_thread_in` with the real `~/.luna` directory.
/// Atomic 0600 write (mirrors the existing `set_panel_route` pattern).
#[tauri::command]
pub fn set_panel_last_thread(panel_id: String, thread_id: String) -> Result<(), String> {
    let luna_dir = luna_dir()?;
    set_panel_last_thread_in(&luna_dir, &panel_id, &thread_id)
}

// ── Phase-2 C10: legacy migration ────────────────────────────────────────────

/// Default profile name (mirrors DEFAULT_PROFILE in main.rs).
const DEFAULT_PROFILE: &str = "stable";

/// Read `~/.luna/moon-connection.json` and extract the profiles map for
/// migration. Returns `Some((activeProfile, HashMap<profileName → wsUrl>))`
/// or `None` if the file is absent / unreadable / unrecognised.
///
/// Mirrors the `normalize_profiles()` logic in main.rs but is read-only and
/// self-contained so the migration can run without touching main.rs state.
fn read_legacy_profiles_for_migration_in(
    luna_dir: &std::path::Path,
) -> Option<(String, std::collections::HashMap<String, String>)> {
    let path = luna_dir.join("moon-connection.json");
    let contents = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let obj = value.as_object()?;

    // New multi-profile format: both `activeProfile` + `profiles` present.
    if let (Some(active), Some(profiles_obj)) = (
        obj.get("activeProfile").and_then(|v| v.as_str()),
        obj.get("profiles").and_then(|v| v.as_object()),
    ) {
        let mut map = std::collections::HashMap::new();
        for (name, profile_val) in profiles_obj {
            let ws_url = profile_val
                .get("wsUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            map.insert(name.clone(), ws_url);
        }
        return Some((active.to_string(), map));
    }

    // Legacy flat format: top-level `wsUrl` / `wsToken` → treat as `profiles["stable"]`.
    if obj.contains_key("wsUrl") || obj.contains_key("wsToken") {
        let ws_url = obj
            .get("wsUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut map = std::collections::HashMap::new();
        map.insert(DEFAULT_PROFILE.to_string(), ws_url);
        return Some((DEFAULT_PROFILE.to_string(), map));
    }

    None
}

/// Inner implementation of the migration that operates on an explicit luna_dir.
/// Separated from the public wrapper so tests can pass a tempdir without
/// mutating the `HOME` environment variable (which is a shared process global).
/// `pub(crate)` so the integration tests in `main.rs` can call it directly to
/// reproduce the real boot sequence (migrate → load_connection).
pub(crate) fn migrate_legacy_to_client_toml_in(luna_dir: &std::path::Path) -> Result<(), String> {
    let client_toml = luna_dir.join("client.toml");

    // Idempotent: if client.toml already exists, do nothing.
    if client_toml.exists() {
        return Ok(());
    }

    // Read legacy profiles; bail out silently when nothing to migrate.
    let (active_profile, profiles) = match read_legacy_profiles_for_migration_in(luna_dir) {
        Some(pair) => pair,
        None => return Ok(()),
    };

    // Build the document with toml_edit so every key + value is ESCAPED
    // correctly. A raw format!() interpolation lets a `"`, backslash, or
    // newline in a ws_url or profile name corrupt or inject TOML; and since the
    // write-verify below deletes an unparseable file, that corruption would
    // re-trigger identically on every boot (never producing a usable config).
    let mut doc = toml_edit::DocumentMut::new();
    doc["kind"] = toml_edit::value("bootstrap");
    doc["fileFormatVersion"] = toml_edit::value(3_i64);
    doc["default"] = toml_edit::value(active_profile.as_str());

    let mut wrote_any = false;
    // Stable sort for deterministic output (active profile first, then alpha).
    let mut profile_names: Vec<&String> = profiles.keys().collect();
    profile_names.sort_by(|a, b| {
        let a_is_active = *a == &active_profile;
        let b_is_active = *b == &active_profile;
        b_is_active.cmp(&a_is_active).then_with(|| a.cmp(b))
    });

    // `[route.<name>]` tables live under an implicit `route` parent so the
    // output carries no bare `[route]` header (matching the prior format).
    let mut routes = toml_edit::Table::new();
    routes.set_implicit(true);
    for name in profile_names {
        let ws_url = &profiles[name];
        if ws_url.is_empty() {
            continue;
        }
        let mut endpoints = toml_edit::Array::new();
        endpoints.push(ws_url.as_str());
        let mut route = toml_edit::Table::new();
        route["endpoints"] = toml_edit::value(endpoints);
        route["label"] = toml_edit::value(name.as_str());
        route["tokenRef"] = toml_edit::value("legacy");
        routes.insert(name.as_str(), toml_edit::Item::Table(route));
        wrote_any = true;
    }
    doc["route"] = toml_edit::Item::Table(routes);

    if !wrote_any {
        // All profiles had empty wsUrl — nothing useful to migrate.
        return Ok(());
    }

    let body = doc.to_string();

    // Atomic write (F10 write-verify pattern).
    write_atomic_0600(&client_toml, &body)?;

    // Re-read and parse to verify the written file is valid.
    let written = std::fs::read_to_string(&client_toml)
        .map_err(|e| format!("migration verify read failed: {e}"))?;
    if let Err(e) = parse_client_config(&written) {
        // Verification failed — remove the bad file so next boot retries cleanly.
        let _ = std::fs::remove_file(&client_toml);
        return Err(format!("migration verify parse failed: {e}"));
    }

    Ok(())
}

/// Migrate `~/.luna/moon-connection.json` → `~/.luna/client.toml` (idempotent).
///
/// Safety contract (F10):
/// * If client.toml ALREADY exists → no-op immediately (idempotent).
/// * If moon-connection.json is absent or unparseable → no-op (nothing to migrate).
/// * Write-verify: write to temp → rename (atomic, via write_atomic_0600) →
///   RE-READ AND PARSE the written file to verify it's valid BEFORE returning Ok.
///   If verification fails → remove the bad file so next boot retries cleanly;
///   return Err.
/// * moon-connection.json is NEVER touched (stays intact as token source + rollback).
///
/// The token handling: each [route.<profileName>] gets `tokenRef = "legacy"`.
/// The actual token continues to come from load_connection / moon-connection.json.
/// Phase-3 wires real op:// / env: / file: refs; "legacy" is the placeholder
/// that tells the token resolver "fall back to moon-connection.json".
pub fn migrate_legacy_to_client_toml() -> Result<(), String> {
    migrate_legacy_to_client_toml_in(&luna_dir()?)
}

/// Tauri command: migrate `~/.luna/moon-connection.json` → `~/.luna/client.toml`.
/// Called on boot from the frontend. Idempotent. Never touches moon-connection.json.
#[tauri::command]
pub fn migrate_legacy_connection() -> Result<(), String> {
    migrate_legacy_to_client_toml()
}

// ── unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_TOML: &str = r#"
kind = "bootstrap"
fileFormatVersion = 3
default = "jax-stable"

[route.jax-stable]
endpoints = ["wss://jax.example.com/ws"]
tokenRef  = "env:LUNA_TOKEN_STABLE"
expect    = "jax-stable-host"

[route.jax-dev]
label     = "Dev (jax)"
endpoints = ["ws://localhost:4753/ws", "wss://jax.example.com/ws-dev"]
tokenRef  = "file:~/.luna/.dev-token"
"#;

    // ── parse + validation ────────────────────────────────────────────────────

    #[test]
    fn parse_valid_config_returns_two_routes() {
        let cfg = parse_client_config(VALID_TOML).expect("should parse");
        assert_eq!(cfg.kind, "bootstrap");
        assert_eq!(cfg.file_format_version, 3);
        assert_eq!(cfg.default, "jax-stable");
        assert_eq!(cfg.route.len(), 2);

        let stable = cfg.route.get("jax-stable").expect("jax-stable");
        assert_eq!(stable.endpoints, vec!["wss://jax.example.com/ws"]);
        assert_eq!(stable.token_ref, "env:LUNA_TOKEN_STABLE");
        assert_eq!(stable.expect.as_deref(), Some("jax-stable-host"));

        let dev = cfg.route.get("jax-dev").expect("jax-dev");
        assert_eq!(dev.label.as_deref(), Some("Dev (jax)"));
        assert_eq!(dev.endpoints.len(), 2);
    }

    #[test]
    fn registry_kind_is_rejected() {
        let toml = r#"
kind = "registry"
fileFormatVersion = 3
default = "x"
"#;
        let err = parse_client_config(toml).unwrap_err();
        assert!(
            err.contains("unsupported kind"),
            "expected 'unsupported kind' in: {err}"
        );
    }

    #[test]
    fn unknown_major_version_is_rejected() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 99
default = "x"
"#;
        let err = parse_client_config(toml).unwrap_err();
        assert!(
            err.contains("unsupported fileFormatVersion"),
            "expected version error in: {err}"
        );
    }

    #[test]
    fn route_with_empty_endpoints_is_rejected() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 3
default = "bad"

[route.bad]
endpoints = []
tokenRef  = "env:FOO"
"#;
        let err = parse_client_config(toml).unwrap_err();
        assert!(
            err.contains("no endpoints"),
            "expected endpoints error in: {err}"
        );
    }

    #[test]
    fn route_with_empty_token_ref_is_rejected() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 3
default = "bad"

[route.bad]
endpoints = ["wss://example.com/ws"]
tokenRef  = "   "
"#;
        let err = parse_client_config(toml).unwrap_err();
        assert!(
            err.contains("empty tokenRef"),
            "expected tokenRef error in: {err}"
        );
    }

    // ── transport derivation ─────────────────────────────────────────────────

    #[test]
    fn wss_endpoint_gives_wss_transport() {
        assert_eq!(
            derive_transport(&["wss://example.com/ws".to_string()]),
            "wss"
        );
    }

    #[test]
    fn ws_endpoint_gives_ws_transport() {
        assert_eq!(
            derive_transport(&["ws://localhost:4753/ws".to_string()]),
            "ws"
        );
    }

    // ── set_default_route (round-trip via temp dir) ──────────────────────────

    #[test]
    fn set_default_route_round_trips_atomically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.toml");

        // Seed file.
        std::fs::write(&path, VALID_TOML).expect("write");
        let contents = std::fs::read_to_string(&path).expect("read back");

        // Parse + change default in memory, serialize, write atomically.
        let mut cfg = parse_client_config(&contents).expect("parse");
        assert_eq!(cfg.default, "jax-stable");
        cfg.default = "jax-dev".to_string();
        let body = toml::to_string_pretty(&cfg).expect("serialize");
        write_atomic_0600(&path, &body).expect("atomic write");

        // Re-read and verify.
        let updated = std::fs::read_to_string(&path).expect("re-read");
        let cfg2 = parse_client_config(&updated).expect("re-parse");
        assert_eq!(cfg2.default, "jax-dev");
        assert_eq!(cfg2.route.len(), 2, "routes preserved");

        // Permissions.
        let meta = std::fs::metadata(&path).expect("metadata");
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "file must be mode 0600"
        );
    }

    // ── moon-session.json round-trip ─────────────────────────────────────────

    #[test]
    fn session_get_set_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let session_path = dir.path().join("moon-session.json");

        // Build a session in memory and save.
        let mut session = MoonSession::default();
        session.panels.insert(
            "panel-chat".to_string(),
            PanelState {
                route: Some("jax-dev".to_string()),
                last_thread: None,
            },
        );
        let body = serde_json::to_string_pretty(&session).expect("serialize");
        write_atomic_0600(&session_path, &body).expect("write session");

        // Re-read and verify.
        let contents = std::fs::read_to_string(&session_path).expect("read session");
        let s2: MoonSession = serde_json::from_str(&contents).expect("parse session");
        assert_eq!(
            s2.panels.get("panel-chat").and_then(|p| p.route.as_deref()),
            Some("jax-dev")
        );

        // Permissions.
        let meta = std::fs::metadata(&session_path).expect("metadata");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn missing_session_file_returns_default() {
        // Temporarily redirect HOME to an empty dir so load_session finds nothing.
        // We test the helper directly instead of monkeypatching HOME.
        let session = MoonSession::default();
        assert!(session.panels.is_empty(), "default session has no panels");
    }

    // ── ClientConfig Serialize (needed for set_default_route) ────────────────

    #[test]
    fn client_config_serializes_for_roundtrip() {
        let cfg = parse_client_config(VALID_TOML).expect("parse");
        let body = toml::to_string_pretty(&cfg).expect("serialize");
        let cfg2 = parse_client_config(&body).expect("re-parse");
        assert_eq!(cfg2.default, cfg.default);
        assert_eq!(cfg2.route.len(), cfg.route.len());
    }

    // ── FIX 1: fileFormatVersion acceptance boundary ─────────────────────────

    #[test]
    fn file_format_version_1_is_accepted() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 1
default = "x"

[route.x]
endpoints = ["wss://example.com/ws"]
tokenRef  = "env:TOK"
"#;
        assert!(
            parse_client_config(toml).is_ok(),
            "version 1 must still be accepted"
        );
    }

    #[test]
    fn file_format_version_3_is_accepted() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 3
default = "x"

[route.x]
endpoints = ["wss://example.com/ws"]
tokenRef  = "env:TOK"
"#;
        assert!(
            parse_client_config(toml).is_ok(),
            "version 3 must be accepted"
        );
    }

    #[test]
    fn file_format_version_4_is_rejected() {
        let toml = r#"
kind = "bootstrap"
fileFormatVersion = 4
default = "x"

[route.x]
endpoints = ["wss://example.com/ws"]
tokenRef  = "env:TOK"
"#;
        let err = parse_client_config(toml).unwrap_err();
        assert!(
            err.contains("unsupported fileFormatVersion"),
            "expected version error in: {err}"
        );
    }

    // ── FIX 2: set_default_route preserves comments, unknown fields, and order

    // ── Phase-2 C10: migration tests ─────────────────────────────────────────

    #[test]
    fn migration_no_op_when_client_toml_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna_dir = dir.path().join(".luna");
        std::fs::create_dir_all(&luna_dir).expect("mkdir .luna");

        // Write a minimal valid client.toml.
        let existing_toml = r#"kind = "bootstrap"
fileFormatVersion = 3
default = "stable"

[route.stable]
endpoints = ["ws://existing:4753/ui"]
label = "stable"
tokenRef = "legacy"
"#;
        std::fs::write(luna_dir.join("client.toml"), existing_toml).expect("write client.toml");

        // No moon-connection.json needed — the no-op path should fire first.
        let result = migrate_legacy_to_client_toml_in(&luna_dir);
        assert!(result.is_ok(), "must return Ok: {:?}", result);

        // File must be UNCHANGED.
        let after = std::fs::read_to_string(luna_dir.join("client.toml")).expect("read back");
        assert_eq!(after, existing_toml, "client.toml must not be modified");
    }

    #[test]
    fn migration_no_op_when_no_moon_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna_dir = dir.path().join(".luna");
        std::fs::create_dir_all(&luna_dir).expect("mkdir .luna");
        // No moon-connection.json and no client.toml.

        let result = migrate_legacy_to_client_toml_in(&luna_dir);
        assert!(result.is_ok(), "must return Ok: {:?}", result);
        assert!(
            !luna_dir.join("client.toml").exists(),
            "client.toml must NOT be created when there is nothing to migrate"
        );
    }

    #[test]
    fn migration_creates_client_toml_from_new_format_moon_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna_dir = dir.path().join(".luna");
        std::fs::create_dir_all(&luna_dir).expect("mkdir .luna");

        let moon_conn = r#"{"activeProfile":"stable","profiles":{"stable":{"wsUrl":"ws://jax:4753/ui","wsToken":"tok123"},"dev":{"wsUrl":"ws://jax:5753/ui","wsToken":"devtok"}}}"#;
        std::fs::write(luna_dir.join("moon-connection.json"), moon_conn)
            .expect("write moon-connection.json");

        let result = migrate_legacy_to_client_toml_in(&luna_dir);
        assert!(result.is_ok(), "migration must succeed: {:?}", result);

        let client_toml_path = luna_dir.join("client.toml");
        assert!(client_toml_path.exists(), "client.toml must be created");

        let contents = std::fs::read_to_string(&client_toml_path).expect("read client.toml");
        let cfg = parse_client_config(&contents).expect("must be valid client.toml");

        assert_eq!(cfg.default, "stable", "default must be stable");

        let stable = cfg.route.get("stable").expect("stable route must exist");
        assert_eq!(
            stable.endpoints,
            vec!["ws://jax:4753/ui"],
            "stable endpoint"
        );
        assert_eq!(stable.token_ref, "legacy", "tokenRef must be 'legacy'");

        let dev = cfg.route.get("dev").expect("dev route must exist");
        assert_eq!(dev.endpoints, vec!["ws://jax:5753/ui"], "dev endpoint");
        assert_eq!(dev.token_ref, "legacy", "dev tokenRef must be 'legacy'");

        // moon-connection.json must be UNCHANGED.
        let after_moon = std::fs::read_to_string(luna_dir.join("moon-connection.json"))
            .expect("moon-connection.json must still exist");
        assert_eq!(
            after_moon, moon_conn,
            "moon-connection.json must not be touched"
        );
    }

    #[test]
    fn migration_creates_client_toml_from_legacy_flat_moon_connection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna_dir = dir.path().join(".luna");
        std::fs::create_dir_all(&luna_dir).expect("mkdir .luna");

        let moon_conn = r#"{"wsUrl":"ws://oldserver:4753/ui","wsToken":"mytoken"}"#;
        std::fs::write(luna_dir.join("moon-connection.json"), moon_conn)
            .expect("write moon-connection.json");

        let result = migrate_legacy_to_client_toml_in(&luna_dir);
        assert!(result.is_ok(), "migration must succeed: {:?}", result);

        let client_toml_path = luna_dir.join("client.toml");
        assert!(client_toml_path.exists(), "client.toml must be created");

        let contents = std::fs::read_to_string(&client_toml_path).expect("read client.toml");
        let cfg = parse_client_config(&contents).expect("must be valid client.toml");

        assert_eq!(
            cfg.default, "stable",
            "default must be stable (DEFAULT_PROFILE)"
        );

        let stable = cfg.route.get("stable").expect("stable route must exist");
        assert_eq!(
            stable.endpoints,
            vec!["ws://oldserver:4753/ui"],
            "stable endpoint from legacy flat"
        );
        assert_eq!(stable.token_ref, "legacy", "tokenRef must be 'legacy'");
    }

    #[test]
    fn migration_is_idempotent_second_call_is_noop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna_dir = dir.path().join(".luna");
        std::fs::create_dir_all(&luna_dir).expect("mkdir .luna");

        let moon_conn = r#"{"wsUrl":"ws://jax:4753/ui","wsToken":"tok"}"#;
        std::fs::write(luna_dir.join("moon-connection.json"), moon_conn)
            .expect("write moon-connection.json");

        // First call — creates client.toml.
        migrate_legacy_to_client_toml_in(&luna_dir).expect("first call must succeed");

        let after_first = std::fs::read_to_string(luna_dir.join("client.toml"))
            .expect("client.toml after first call");

        // Second call — client.toml already exists, must be a no-op.
        migrate_legacy_to_client_toml_in(&luna_dir).expect("second call must succeed");

        let after_second = std::fs::read_to_string(luna_dir.join("client.toml"))
            .expect("client.toml after second call");

        assert_eq!(
            after_first, after_second,
            "second migration call must leave client.toml unchanged"
        );
    }

    #[test]
    fn test_set_default_preserves_comments_and_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.toml");

        // A file with a top-of-file comment, an unknown/future field, and two
        // routes in deliberate order (beta before alpha).
        let original = r#"# Luna client config — do not edit manually
kind = "bootstrap"
fileFormatVersion = 3
default = "beta"
futureField = "kept"

[route.beta]
endpoints = ["wss://beta.example.com/ws"]
tokenRef  = "env:BETA_TOKEN"

[route.alpha]
endpoints = ["wss://alpha.example.com/ws"]
tokenRef  = "env:ALPHA_TOKEN"
"#;
        std::fs::write(&path, original).expect("write");

        // Temporarily redirect HOME so the command resolves client.toml correctly.
        std::env::set_var("HOME", dir.path());

        write_atomic_0600(&path, original).expect("seed write");

        // Use toml_edit directly (same logic as set_default_route command body).
        let raw = std::fs::read_to_string(&path).expect("read");
        let mut doc: toml_edit::DocumentMut = raw.parse().expect("parse toml_edit");
        doc["default"] = toml_edit::value("alpha");
        write_atomic_0600(&path, &doc.to_string()).expect("atomic write");

        let updated = std::fs::read_to_string(&path).expect("re-read");

        // Comment survives.
        assert!(
            updated.contains("# Luna client config"),
            "top-of-file comment must survive"
        );
        // Unknown future field survives.
        assert!(
            updated.contains("futureField"),
            "unknown future field must survive"
        );
        // Route order is preserved (beta section appears before alpha section).
        let beta_pos = updated.find("[route.beta]").expect("beta section");
        let alpha_pos = updated.find("[route.alpha]").expect("alpha section");
        assert!(
            beta_pos < alpha_pos,
            "route order must be preserved (beta before alpha)"
        );
        // Default is updated.
        let cfg = parse_client_config(&updated).expect("re-parse");
        assert_eq!(cfg.default, "alpha", "default must be updated to alpha");
    }

    // ── Phase-2 last-thread: PanelState.last_thread ──────────────────────────

    /// Helper: build a minimal MoonSession JSON with one panel.
    fn session_json_with_last_thread(panel_id: &str, thread_id: Option<&str>) -> String {
        let thread_val = match thread_id {
            Some(id) => format!(r#", "last_thread": "{}""#, id),
            None => String::new(),
        };
        format!(r#"{{"panels": {{"{panel_id}": {{"route": "stable"{thread_val}}}}}}}"#)
    }

    #[test]
    fn panel_state_serializes_last_thread_when_set() {
        let state = PanelState {
            route: Some("stable".to_string()),
            last_thread: Some("thread-abc123".to_string()),
        };
        let json = serde_json::to_string(&state).expect("serialize");
        let v: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(v["last_thread"].as_str(), Some("thread-abc123"));
        assert_eq!(v["route"].as_str(), Some("stable"));
    }

    #[test]
    fn panel_state_omits_last_thread_when_none() {
        let state = PanelState {
            route: Some("stable".to_string()),
            last_thread: None,
        };
        let json = serde_json::to_string(&state).expect("serialize");
        // skip_serializing_if = "Option::is_none" means key must be absent.
        assert!(
            !json.contains("last_thread"),
            "last_thread key must be absent when None; got: {json}"
        );
    }

    #[test]
    fn panel_state_deserializes_last_thread() {
        let json = r#"{"route": "stable", "last_thread": "thread-xyz"}"#;
        let state: PanelState = serde_json::from_str(json).expect("deserialize");
        assert_eq!(state.last_thread.as_deref(), Some("thread-xyz"));
        assert_eq!(state.route.as_deref(), Some("stable"));
    }

    #[test]
    fn panel_state_deserializes_without_last_thread() {
        let json = r#"{"route": "stable"}"#;
        let state: PanelState = serde_json::from_str(json).expect("deserialize");
        assert!(
            state.last_thread.is_none(),
            "last_thread must default to None"
        );
    }

    // ── Phase-2 last-thread: get_panel_last_thread migration ─────────────────

    /// Shared tempdir helper — creates a fresh `~/.luna`-equivalent dir and
    /// passes it to the closure.  Avoids mutating the `HOME` env var (a process-
    /// global that cannot be safely shared across parallel tests).
    fn with_tmp_luna<F: FnOnce(std::path::PathBuf)>(f: F) {
        let dir = tempfile::tempdir().expect("tempdir");
        let luna = dir.path().join(".luna");
        std::fs::create_dir_all(&luna).expect("mkdir .luna");
        f(luna);
        // `dir` drops here — cleaned up automatically.
    }

    #[test]
    fn get_panel_last_thread_reads_from_session_json() {
        with_tmp_luna(|luna_dir| {
            // Write a moon-session.json with a last_thread for panel-chat.
            let json = session_json_with_last_thread("panel-chat", Some("thread-from-session"));
            let session_path = luna_dir.join("moon-session.json");
            write_atomic_0600(&session_path, &json).expect("write session");

            // Call the real inner fn against the tempdir.
            let result = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                result.as_deref(),
                Some("thread-from-session"),
                "must return the stored thread id"
            );
        });
    }

    // ── End-to-end tests for the inner command functions ─────────────────────

    /// (a) Empty slot + legacy present → returns legacy id AND the panel slot is
    ///     now persisted (idempotent fast-path on 2nd call).
    #[test]
    fn get_panel_last_thread_in_adopts_legacy_and_persists_slot() {
        with_tmp_luna(|luna_dir| {
            // Write legacy file but NO moon-session.json.
            let legacy = luna_dir.join(LEGACY_LAST_THREAD_FILE);
            std::fs::write(&legacy, "legacy-thread-id\n").expect("write legacy");

            // First call: empty slot → reads legacy → returns "legacy-thread-id".
            let first = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                first.as_deref(),
                Some("legacy-thread-id"),
                "first call must adopt the legacy id"
            );

            // The panel slot must now be persisted in moon-session.json.
            let session_path = luna_dir.join("moon-session.json");
            assert!(
                session_path.exists(),
                "moon-session.json must be created after adopt"
            );
            let contents = std::fs::read_to_string(&session_path).expect("read");
            let session: MoonSession = serde_json::from_str(&contents).expect("parse");
            assert_eq!(
                session
                    .panels
                    .get("panel-chat")
                    .and_then(|p| p.last_thread.as_deref()),
                Some("legacy-thread-id"),
                "slot must be persisted after adopt"
            );

            // Second call (idempotent fast-path): returns the slot id without
            // reading the legacy file again.
            let second = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                second.as_deref(),
                Some("legacy-thread-id"),
                "second call must hit the fast-path slot"
            );

            // Legacy file must NOT be deleted (one-release grace period).
            assert!(
                legacy.exists(),
                "legacy .last-thread-default must NOT be deleted during migration"
            );
        });
    }

    /// (b) Slot already set → legacy is ignored and never read.
    #[test]
    fn get_panel_last_thread_in_prefers_slot_over_legacy() {
        with_tmp_luna(|luna_dir| {
            // Pre-populate the panel slot.
            let json = session_json_with_last_thread("panel-chat", Some("slot-thread"));
            write_atomic_0600(&luna_dir.join("moon-session.json"), &json).expect("write");

            // Also write a legacy file with a DIFFERENT id.
            std::fs::write(
                luna_dir.join(LEGACY_LAST_THREAD_FILE),
                "legacy-should-be-ignored",
            )
            .expect("write legacy");

            let result = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                result.as_deref(),
                Some("slot-thread"),
                "slot must win over legacy when already set"
            );
        });
    }

    /// (c) set_panel_last_thread_in writes session slot atomically + dual-writes
    ///     legacy (slot first, then legacy file).  Both stores must agree.
    #[test]
    fn set_panel_last_thread_in_writes_slot_and_legacy() {
        with_tmp_luna(|luna_dir| {
            set_panel_last_thread_in(&luna_dir, "panel-chat", "thread-set-123")
                .expect("set must succeed");

            // Panel slot in moon-session.json.
            let contents =
                std::fs::read_to_string(luna_dir.join("moon-session.json")).expect("read session");
            let session: MoonSession = serde_json::from_str(&contents).expect("parse");
            assert_eq!(
                session
                    .panels
                    .get("panel-chat")
                    .and_then(|p| p.last_thread.as_deref()),
                Some("thread-set-123"),
                "session slot must contain the thread id"
            );

            // Legacy file must also be written.
            let legacy = std::fs::read_to_string(luna_dir.join(LEGACY_LAST_THREAD_FILE))
                .expect("read legacy");
            assert_eq!(
                legacy.trim(),
                "thread-set-123",
                "legacy file must contain the same trimmed id"
            );
        });
    }

    /// (d) set_panel_last_thread_in trims whitespace: both stores agree on the
    ///     trimmed form even when the caller passes a padded id.
    #[test]
    fn set_panel_last_thread_in_trims_whitespace() {
        with_tmp_luna(|luna_dir| {
            set_panel_last_thread_in(&luna_dir, "panel-chat", "  thread-padded  ")
                .expect("set must succeed");

            let contents =
                std::fs::read_to_string(luna_dir.join("moon-session.json")).expect("read session");
            let session: MoonSession = serde_json::from_str(&contents).expect("parse");
            assert_eq!(
                session
                    .panels
                    .get("panel-chat")
                    .and_then(|p| p.last_thread.as_deref()),
                Some("thread-padded"),
                "slot must store the trimmed id"
            );

            let legacy = std::fs::read_to_string(luna_dir.join(LEGACY_LAST_THREAD_FILE))
                .expect("read legacy");
            assert_eq!(
                legacy, "thread-padded",
                "legacy file must store the trimmed id"
            );
        });
    }

    /// (e) set_panel_last_thread_in followed by get_panel_last_thread_in is a
    ///     clean round-trip without touching the legacy file on the read side.
    #[test]
    fn set_then_get_panel_last_thread_in_round_trips() {
        with_tmp_luna(|luna_dir| {
            set_panel_last_thread_in(&luna_dir, "panel-chat", "thread-rt")
                .expect("set must succeed");
            let result = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                result.as_deref(),
                Some("thread-rt"),
                "get must return what was just set"
            );
        });
    }

    #[test]
    fn last_thread_migration_adopts_legacy_file_when_panel_slot_absent() {
        with_tmp_luna(|luna_dir| {
            // Write legacy file but NO moon-session.json.
            let legacy = luna_dir.join(LEGACY_LAST_THREAD_FILE);
            std::fs::write(&legacy, "legacy-thread-id").expect("write legacy");

            // Use the real inner fn: both the return value AND the persisted slot
            // are asserted (not a manual simulation any more).
            let result = get_panel_last_thread_in(&luna_dir, "panel-chat");
            assert_eq!(
                result.as_deref(),
                Some("legacy-thread-id"),
                "get_panel_last_thread_in must adopt the legacy id"
            );

            // Re-read: panel slot now has the adopted id.
            let contents =
                std::fs::read_to_string(luna_dir.join("moon-session.json")).expect("read");
            let s2: MoonSession = serde_json::from_str(&contents).expect("parse");
            assert_eq!(
                s2.panels
                    .get("panel-chat")
                    .and_then(|p| p.last_thread.as_deref()),
                Some("legacy-thread-id"),
                "adopted id must be persisted in panel slot"
            );

            // Legacy file must NOT be deleted (one-release grace period).
            assert!(
                legacy.exists(),
                "legacy .last-thread-default must NOT be deleted during migration"
            );
        });
    }

    #[test]
    fn last_thread_legacy_absent_returns_none() {
        with_tmp_luna(|luna_dir| {
            // No legacy file, no moon-session.json.
            let result = read_legacy_last_thread_in(&luna_dir);
            assert!(
                result.is_none(),
                "must return None when legacy file is absent"
            );
        });
    }

    #[test]
    fn last_thread_legacy_empty_returns_none() {
        with_tmp_luna(|luna_dir| {
            let legacy = luna_dir.join(LEGACY_LAST_THREAD_FILE);
            std::fs::write(&legacy, "  \n  ").expect("write empty legacy");
            let result = read_legacy_last_thread_in(&luna_dir);
            assert!(
                result.is_none(),
                "must return None when legacy file contains only whitespace"
            );
        });
    }

    // ── Phase-2 last-thread: per-route isolation ──────────────────────────────

    /// Panel A's last-thread must not bleed into Panel B's slot.
    #[test]
    fn per_panel_last_thread_isolation() {
        with_tmp_luna(|luna_dir| {
            // Write a session with two different panels.
            let json = r#"{
                "panels": {
                    "panel-chat": {"route": "stable", "last_thread": "thread-for-chat"},
                    "panel-secondary": {"route": "dev", "last_thread": "thread-for-secondary"}
                }
            }"#;
            let session_path = luna_dir.join("moon-session.json");
            write_atomic_0600(&session_path, json).expect("write session");

            let chat_thread = get_panel_last_thread_in(&luna_dir, "panel-chat");
            let secondary_thread = get_panel_last_thread_in(&luna_dir, "panel-secondary");

            assert_eq!(
                chat_thread.as_deref(),
                Some("thread-for-chat"),
                "panel-chat slot"
            );
            assert_eq!(
                secondary_thread.as_deref(),
                Some("thread-for-secondary"),
                "panel-secondary slot"
            );
            assert_ne!(
                chat_thread, secondary_thread,
                "panel A last-thread must differ from panel B's"
            );
        });
    }

    /// Writing panel A's last-thread must not affect panel B's slot.
    #[test]
    fn set_last_thread_for_one_panel_does_not_affect_other() {
        with_tmp_luna(|luna_dir| {
            // Start with two panels in the session via the real inner fn.
            set_panel_last_thread_in(&luna_dir, "panel-chat", "old-chat-thread")
                .expect("set panel-chat");
            set_panel_last_thread_in(&luna_dir, "panel-secondary", "secondary-thread")
                .expect("set panel-secondary");

            // Update only panel-chat's last_thread.
            set_panel_last_thread_in(&luna_dir, "panel-chat", "new-chat-thread")
                .expect("update panel-chat");

            // Verify panel-secondary is untouched.
            let chat = get_panel_last_thread_in(&luna_dir, "panel-chat");
            let secondary = get_panel_last_thread_in(&luna_dir, "panel-secondary");
            assert_eq!(
                chat.as_deref(),
                Some("new-chat-thread"),
                "panel-chat must have the new thread"
            );
            assert_eq!(
                secondary.as_deref(),
                Some("secondary-thread"),
                "panel-secondary must be untouched"
            );
        });
    }
}
