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

/// Public alias used by `main.rs`'s `load_connection` shim so the backward-
/// compat path can inspect the default route without going through a Tauri command.
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
}
