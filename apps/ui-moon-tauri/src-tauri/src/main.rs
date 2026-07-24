// Prevent additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
// `emit_to` lives on the Emitter trait in Tauri 2 (split from Manager). HEAD
// imported only Manager, so the existing luna-config emit below did not compile.
// This one-line import is behavior-preserving and unblocks `cargo check`.
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
// Native OS notifications: `app.notification().builder()...show()` lives on
// the NotificationExt trait. Drives the `notify` command below.
use tauri_plugin_notification::NotificationExt;
// Self-update: `app.updater()` (check) + `update.download_and_install()` come
// from UpdaterExt; `app.restart()` is built into the AppHandle (no process plugin).
use tauri_plugin_updater::UpdaterExt;

/// What the frontend needs to render the "update available" banner. Returned by
/// `check_for_update`; `None` means the app is already current.
#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    /// Release notes (the updater's `body` field), if the release set one.
    notes: Option<String>,
}

// ── Staged update experience ───────────────────────────────────────────────
//
// HEAD had ONE flow: check → download_and_install → restart, with no progress
// and an abrupt relaunch. The staged experience SPLITS that into two halves so
// the bytes can be fetched + signature-verified quietly in the background and
// then HELD until the user is ready:
//
//   * `start_update_download` (and the boot/6h discovery loop) does the slow,
//     networked half: check → download → verify → STAGE the bytes. It emits a
//     live event stream so three surfaces (panel / composer banner / orb pip)
//     can narrate progress. Nothing restarts here.
//   * `apply_update` does the fast, local half: persist the session, install the
//     STAGED bytes, restart. No second network round-trip — the verified archive
//     is already in hand.
//
// WHY split: a download can take many seconds on a 28MB build; restarting the
// instant it finishes would yank the window out from under whatever the user is
// doing. Staging lets the update sit "ready" and lets the USER pick the moment.

/// Snapshot of the updater for replay-on-open. A freshly-opened panel or banner
/// calls `update_state` to sync to wherever the background flow already is,
/// rather than waiting for the next live event (which it may have missed).
///
/// `phase` is the single source of truth the three surfaces switch on:
/// "idle" | "checking" | "available" | "downloading" | "ready" | "error".
#[derive(serde::Serialize, Clone, Default)]
struct UpdateStateDto {
    phase: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    /// The currently-running build version (e.g. "0.0.32"), so the panel can show
    /// "Current version X" instead of a placeholder. Filled by the `update_state`
    /// command, which has the AppHandle; `to_dto` leaves it empty because
    /// `UpdateInner` doesn't know the package version.
    current: String,
}

/// Live updater state behind a std Mutex (see `UpdateManager`). `staged` holds
/// the signature-verified archive bytes plus the `Update` handle that produced
/// them, so `apply_update` can call `update.install(bytes)` WITHOUT re-checking
/// the network. `tauri_plugin_updater::Update` is `Send + Sync` (its callback
/// fields are all `Arc<dyn Fn() + Send + Sync>`), so it lives happily in managed
/// state. The lock is only ever held for short, NON-`.await` critical sections.
#[derive(Default)]
struct UpdateInner {
    phase: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    /// (verified Update handle, verified archive bytes). `Some` once staged.
    staged: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
}

impl UpdateInner {
    /// Pure projection of the live state into the replay DTO. Kept separate (and
    /// unit-tested) so the snapshot shape can't silently drift from the phases
    /// the surfaces switch on.
    fn to_dto(&self) -> UpdateStateDto {
        UpdateStateDto {
            phase: if self.phase.is_empty() {
                "idle".to_string()
            } else {
                self.phase.clone()
            },
            version: self.version.clone(),
            notes: self.notes.clone(),
            downloaded: self.downloaded,
            total: self.total,
            // The running version is stamped by the `update_state` command (which
            // has the AppHandle); UpdateInner can't know it, so default to empty.
            current: String::new(),
        }
    }
}

/// Managed state: one per app, holds the live update phase + staged artifact.
#[derive(Default)]
struct UpdateManager(std::sync::Mutex<UpdateInner>);

/// Shared runner behind every update path (manual check, `start_update_download`,
/// and the background discovery loop). Emits the `update://*` event stream and
/// keeps `UpdateManager` in lock-step so `update_state` can replay it.
///
/// `auto_download = false` stops after the availability decision (manual "Check"
/// just wants to know). `auto_download = true` continues through download → stage
/// → ready. Returns the discovered version (if any) so `check_for_update` can map
/// it back to its `Option<UpdateInfo>` return contract.
///
/// The std Mutex is NEVER held across an `.await`: we lock, mutate, drop the
/// guard, THEN emit / download. Holding it across the network call would serialise
/// the whole app on the updater.
async fn run_update_check(
    app: tauri::AppHandle,
    auto_download: bool,
) -> Result<Option<UpdateInfo>, String> {
    // Single-flight gate: Tauri async commands run concurrently on the runtime,
    // and the background discovery loop runs `run_update_check` on its own. If a
    // check or download is already in flight (`phase` is "checking"/"downloading")
    // a second entrant — a user clicking "Check"/"Download" mid-fetch — would kick
    // off a duplicate ~28MB download and make both flows fight over the shared
    // state + `update://*` stream (phase flapping, a bar that jumps backward). So
    // we bail early under the same lock that sets the phase: the compare ("am I
    // already busy?") and the claim (set phase = checking) happen in one critical
    // section, which is race-free because the std Mutex serialises the two. We
    // re-announce the current version so the late surface still gets a frame.
    {
        let mgr = app.state::<UpdateManager>();
        let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.phase == "checking" || s.phase == "downloading" {
            return Ok(s.version.clone().map(|version| UpdateInfo {
                version,
                notes: s.notes.clone(),
            }));
        }
        // Claim the in-flight slot before we release the lock.
        s.phase = "checking".to_string();
    }
    let _ = app.emit("update://checking", serde_json::json!({}));

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return Err(emit_update_error(&app, e.to_string()));
        }
    };

    match updater.check().await {
        // Up to date — stay quiet (manual checks still get the explicit "none").
        Ok(None) => {
            {
                let mgr = app.state::<UpdateManager>();
                let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
                s.phase = "idle".to_string();
                s.version = None;
                s.notes = None;
            }
            let _ = app.emit("update://none", serde_json::json!({}));
            Ok(None)
        }
        Err(e) => Err(emit_update_error(&app, e.to_string())),
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            {
                let mgr = app.state::<UpdateManager>();
                let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
                s.phase = "available".to_string();
                s.version = Some(version.clone());
                s.notes = notes.clone();
                s.downloaded = 0;
                s.total = None;
            }
            let _ = app.emit(
                "update://available",
                serde_json::json!({ "version": version, "notes": notes }),
            );

            if !auto_download {
                return Ok(Some(UpdateInfo { version, notes }));
            }

            // ── download half ──
            {
                let mgr = app.state::<UpdateManager>();
                let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
                s.phase = "downloading".to_string();
            }

            // Accumulate downloaded bytes in a captured counter; the closure is
            // FnMut. We throttle the emit to ~once per 64KB so a 28MB build does
            // not flood the event bus with thousands of frames (the bar still
            // looks smooth at that granularity). State is updated every chunk so
            // a replay-on-open via `update_state` is always current.
            let app_dl = app.clone();
            let mut downloaded: u64 = 0;
            let mut last_emit: u64 = 0;
            let download_result = update
                .download(
                    move |chunk_len, content_len| {
                        downloaded += chunk_len as u64;
                        {
                            let mgr = app_dl.state::<UpdateManager>();
                            let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
                            s.downloaded = downloaded;
                            s.total = content_len;
                        }
                        if downloaded - last_emit >= 64 * 1024 || Some(downloaded) == content_len {
                            last_emit = downloaded;
                            let _ = app_dl.emit(
                                "update://progress",
                                serde_json::json!({ "downloaded": downloaded, "total": content_len }),
                            );
                        }
                    },
                    || {},
                )
                .await;

            let bytes = match download_result {
                Ok(b) => b,
                Err(e) => return Err(emit_update_error(&app, e.to_string())),
            };

            // Bytes are signature-verified inside `download`; surface the brief
            // verifying beat, then stage + go ready. We STORE the Update handle
            // alongside the bytes so apply skips a redundant network check.
            let _ = app.emit("update://verifying", serde_json::json!({}));
            let total = bytes.len() as u64;
            {
                let mgr = app.state::<UpdateManager>();
                let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
                s.phase = "ready".to_string();
                s.downloaded = total;
                s.total = Some(total);
                s.staged = Some((update, bytes));
            }
            let _ = app.emit(
                "update://ready",
                serde_json::json!({ "version": version, "notes": notes }),
            );
            Ok(Some(UpdateInfo { version, notes }))
        }
    }
}

/// Record + broadcast a failed check/download. Returns the same message it
/// emits so callers can `return Err(emit_update_error(..))` in one line.
fn emit_update_error(app: &tauri::AppHandle, message: String) -> String {
    {
        let mgr = app.state::<UpdateManager>();
        let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
        s.phase = "error".to_string();
        // Clear any staged artifact so the state machine stays consistent on
        // error (a failed download/verify leaves no usable stage to apply).
        s.staged = None;
    }
    let _ = app.emit("update://error", serde_json::json!({ "message": message }));
    message
}

/// Ask the GitHub Releases `latest.json` whether a newer signed build exists.
/// Returns `Ok(None)` when up to date so the UI can stay silent. Network / config
/// errors come back as `Err(String)` rather than panicking the command.
///
/// Refactored onto `run_update_check` so the manual "Check" button ALSO drives
/// the event stream + `UpdateManager` (a panel opened mid-check stays in sync),
/// while KEEPING its `Option<UpdateInfo>` return so the existing button contract
/// is untouched. `auto_download = false`: a manual check announces availability
/// but does not start the download (that's the explicit `start_update_download`).
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    run_update_check(app, false).await
}

/// NEW. Drive the full check → download → verify → stage flow, emitting the
/// `update://*` stream. Idempotent: if an artifact is already staged, just
/// re-emit `update://ready` (a re-opened surface re-triggering download must not
/// re-fetch 28MB). On failure it emits `update://error` and returns `Err`.
#[tauri::command]
async fn start_update_download(app: tauri::AppHandle) -> Result<(), String> {
    // Already staged → cheap re-announce, no second download.
    {
        let mgr = app.state::<UpdateManager>();
        let s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.phase == "ready" && s.staged.is_some() {
            let version = s.version.clone();
            let notes = s.notes.clone();
            drop(s);
            let _ = app.emit(
                "update://ready",
                serde_json::json!({ "version": version, "notes": notes }),
            );
            return Ok(());
        }
    }
    run_update_check(app, true).await.map(|_| ())
}

/// NEW. Apply the STAGED build: persist the session, then install the verified
/// bytes already in hand and relaunch into the new build. `app.restart()` never
/// returns, so the trailing `Ok` is unreachable on success.
///
/// Ordering matters: we write `layout.json` and the reopen marker BEFORE
/// installing. The install relaunches the process, so anything not persisted
/// first is lost — saving last would race the re-exec and the user would come
/// back to an empty desktop. If nothing is staged we return `Err` rather than
/// silently kicking off a fresh download (that's `start_update_download`'s job).
#[tauri::command]
async fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
    // 1. Take the staged artifact OUT of the lock (so the std Mutex is not held
    //    across the install) and bail BEFORE any side effects if nothing is
    //    staged. Doing this first matters: a stray call (devtools, a UI race, a
    //    double-invoke after a prior `.take()` emptied the slot) must NOT write
    //    the layout/reopen marker and then error out — a stale `{reopenChat}`
    //    marker that nothing installs would spuriously reopen chat on the NEXT
    //    normal boot. We only commit to side effects once an install is certain.
    //    `install` is synchronous and the signature was verified during download.
    let staged = {
        let mgr = app.state::<UpdateManager>();
        let mut s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
        s.staged.take()
    };
    let (update, bytes) = staged.ok_or_else(|| "no update staged".to_string())?;

    // 2. Persist open panels so the boot-time layout restore can rebuild them.
    write_panel_layout(&app);

    // 3. Leave a one-shot reopen marker so boot can re-open the chat window if
    //    it was open at apply time (Slice C consumes + deletes this via
    //    `take_pending_update`). The chat widget uses the `panel-chat` window
    //    label (see hub_event), so its presence is the signal. Best-effort: a
    //    missing HOME just skips it.
    let reopen_chat = app.get_webview_window("panel-chat").is_some();
    if let Ok(home) = std::env::var("HOME") {
        let dir = std::path::PathBuf::from(&home).join(".luna");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            dir.join("pending-update.json"),
            serde_json::json!({ "reopenChat": reopen_chat }).to_string(),
        );
    }

    // 4. Install the verified bytes already in hand (no second network trip).
    update.install(bytes).map_err(|e| e.to_string())?;

    // 5. Relaunch into the freshly-installed build. Never returns on success.
    app.restart();
}

/// NEW. Replay-on-open snapshot so a freshly-opened panel/banner syncs to the
/// current phase without waiting for the next live event.
#[tauri::command]
fn update_state(app: tauri::AppHandle) -> UpdateStateDto {
    let mut dto = {
        let mgr = app.state::<UpdateManager>();
        let s = mgr.0.lock().unwrap_or_else(|e| e.into_inner());
        s.to_dto()
    };
    // Stamp the running build version here (the lock-guarded UpdateInner can't).
    dto.current = app.package_info().version.to_string();
    dto
}

/// NEW. One-shot consumer of the reopen marker `apply_update` leaves behind.
/// Reads `~/.luna/pending-update.json`, DELETES it (so it fires exactly once),
/// and returns its contents (`{ reopenChat: bool }`) or `null` when absent.
///
/// Slice C's hub boot calls this and re-opens the chat window via
/// `open_widget('chat')` when `reopenChat` is true. We delete-after-read here —
/// not in the frontend — so a stale marker from a prior update can never
/// spuriously reopen chat on an unrelated boot, even if the frontend never runs.
#[tauri::command]
fn take_pending_update() -> Option<serde_json::Value> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::PathBuf::from(home)
        .join(".luna")
        .join("pending-update.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    // Delete BEFORE parsing so a malformed marker is still cleared once.
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn get_last_thread_id() -> Option<String> {
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
fn set_last_thread_id(thread_id: String) -> Result<(), String> {
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
const DEFAULT_PROFILE: &str = "stable";

/// Read + parse moon-connection.json into a serde Value, or None if the file is
/// missing / empty / unparseable. NEVER throws — a garbage file behaves exactly
/// like "no connection" (matches the legacy load_connection contract).
fn read_connection_value() -> Option<serde_json::Value> {
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
fn save_connection(url: String, token: String, profile: Option<String>) -> Result<(), String> {
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
fn load_connection() -> Option<serde_json::Value> {
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

// ── local shell executor ───────────────────────────────────────────────────
//
// Runs a shell command on THIS machine (the client) and returns the captured
// result. It is a deliberately UNGUARDED executor: it does NOT restrict which
// directory or files a command may touch. That is intentional and honest — soft
// scope cannot jail an arbitrary shell (a command run in /foo can still read
// /etc), so a cwd gate here would only imply a confinement we do not provide.
// Scope is decided in the frontend, which calls this only for an in-scope /
// auto-approved request and denies the rest — the same trust model as the CLI,
// which already spawns whatever the server asks once approval passes. The Tauri
// `allow-local-shell-exec` capability is the one real gate. A future true
// client-side sandbox is the isolation seam and would plug in right here.

const LOCAL_SHELL_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const LOCAL_SHELL_FORCE_KILL_GRACE_MS: u64 = 250;
const LOCAL_SHELL_DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalShellExecResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
}

/// Mirror the CLI's SECRET_ENV_KEY filter so token-ish env vars never leak into a
/// spawned command. Case-insensitive substring match, same needles as
/// apps/agent-cli/src/chat/local-shell.ts.
fn is_secret_env_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    const NEEDLES: [&str; 7] = [
        "TOKEN",
        "SECRET",
        "PASS",
        "CREDENTIAL",
        "AUTH",
        "COOKIE",
        "SESSION",
    ];
    if NEEDLES.iter().any(|n| k.contains(n)) {
        return true;
    }
    k.contains("APIKEY")
        || k.contains("API_KEY")
        || k.contains("API-KEY")
        || k.contains("PRIVATEKEY")
        || k.contains("PRIVATE_KEY")
        || k.contains("PRIVATE-KEY")
}

/// Drain a child pipe fully, retaining at most `cap` bytes and counting the rest
/// as omitted — bounds memory without ever deadlocking on a full pipe.
async fn read_capped<R>(mut reader: R, cap: usize) -> (Vec<u8>, usize)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut retained: Vec<u8> = Vec::new();
    let mut omitted = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if retained.len() < cap {
                    let room = cap - retained.len();
                    if n <= room {
                        retained.extend_from_slice(&chunk[..n]);
                    } else {
                        retained.extend_from_slice(&chunk[..room]);
                        omitted += n - room;
                    }
                } else {
                    omitted += n;
                }
            }
        }
    }
    (retained, omitted)
}

fn format_captured(bytes: Vec<u8>, omitted: usize) -> String {
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if omitted == 0 {
        text
    } else {
        format!("{}\n[truncated {} bytes]", text, omitted)
    }
}

/// Pure executor core — Tauri-free so it is unit-testable (`#[tokio::test]` below).
async fn exec_local(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> LocalShellExecResult {
    use std::process::Stdio;
    use tokio::process::Command;
    use tokio::time::{timeout, Duration};

    let started = std::time::Instant::now();
    let elapsed_ms = move || started.elapsed().as_millis() as u64;
    let timeout_dur = Duration::from_millis(timeout_ms.unwrap_or(LOCAL_SHELL_DEFAULT_TIMEOUT_MS));

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(&command);
    if let Some(dir) = cwd.as_deref() {
        cmd.current_dir(dir);
    }
    // Sanitized env: inherit everything except token-ish keys.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if !is_secret_env_key(&k) {
            cmd.env(k, v);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // New process group so a timeout can kill the whole tree, not just `sh`.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Mirror the CLI's child.on("error"): a spawn failure is a RESULT, not
            // an exception, so the caller always has a frame to send back.
            return LocalShellExecResult {
                exit_code: None,
                stdout: String::new(),
                stderr: e.to_string(),
                duration_ms: elapsed_ms(),
                timed_out: false,
            };
        }
    };

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(r) => read_capped(r, LOCAL_SHELL_MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), 0),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(r) => read_capped(r, LOCAL_SHELL_MAX_OUTPUT_BYTES).await,
            None => (Vec::new(), 0),
        }
    });

    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;
    match timeout(timeout_dur, child.wait()).await {
        Ok(Ok(status)) => exit_code = status.code(),
        Ok(Err(_)) => {} // wait() failed → leave exit_code None
        Err(_) => {
            // Timed out: SIGTERM the process group, brief grace, then SIGKILL.
            timed_out = true;
            #[cfg(unix)]
            if let Some(pid) = pid {
                let gid = pid as libc::pid_t;
                unsafe { libc::kill(-gid, libc::SIGTERM) };
                tokio::time::sleep(Duration::from_millis(LOCAL_SHELL_FORCE_KILL_GRACE_MS)).await;
                unsafe { libc::kill(-gid, libc::SIGKILL) };
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
        }
    }

    let (out_bytes, out_omitted) = stdout_task.await.unwrap_or((Vec::new(), 0));
    let (err_bytes, err_omitted) = stderr_task.await.unwrap_or((Vec::new(), 0));

    LocalShellExecResult {
        exit_code,
        stdout: format_captured(out_bytes, out_omitted),
        stderr: format_captured(err_bytes, err_omitted),
        duration_ms: elapsed_ms(),
        timed_out,
    }
}

/// Run a shell command on the client machine. See exec_local for the trust model.
#[tauri::command]
async fn local_shell_exec(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> LocalShellExecResult {
    exec_local(command, cwd, timeout_ms).await
}

/// The client OS ("macos" | "linux" | "windows" | ...), advertised in the
/// local-shell capability frame so the server knows the platform.
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// Raise a native OS notification (macOS Notification Center / Linux
/// libnotify / Windows toast). Called from the chat webview when a
/// background/scheduled job result is delivered while the user isn't watching
/// (frontend `Notifier`, chat.html). Thin wrapper over the notification
/// plugin's Rust API — same shape as `speak_text` wrapping the voice engine,
/// so the webview only needs the `allow-notify` capability, not the plugin's
/// own `notification:default` IPC surface.
///
/// `body` is truncated defensively to a notification-sized preview so a long
/// job result can't produce a wall-of-text banner. Returns the plugin error
/// as a string rather than panicking, so a failed `show()` (e.g. the user has
/// notifications disabled in System Settings) degrades to a no-op the caller
/// can log.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(truncate_notification_body(body))
        .show()
        .map_err(|e| e.to_string())
}

/// Cap a notification body at ~140 chars on a char boundary (not a byte
/// slice — job text can be multi-byte). Takes MAX chars and peeks one
/// further to detect truncation, so a huge job output is never scanned
/// end-to-end. Appends an ellipsis when truncated.
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

// ── connector OAuth: client-brokered loopback (PRD A §09, RFC 8252) ─────────
//
// The Moon is the BROWSER side of the flow: it binds an ephemeral
// 127.0.0.1 port, tells the server that port (the server builds
// redirect_uri = http://127.0.0.1:<port>/callback), opens the consent URL
// in the operator's real browser, and captures the provider's redirect.
// Only the authorization CODE passes through here — it is worthless
// without the PKCE verifier, which never leaves the server.
//
// One flow at a time (a human is clicking through consent); starting a new
// listener cancels the previous one. The accept loop polls a nonblocking
// listener so cancel/timeout are responsive without OS-specific tricks.

#[derive(Default)]
struct OauthLoopback {
    inner: std::sync::Mutex<Option<OauthLoopbackActive>>,
}

struct OauthLoopbackActive {
    port: u16,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>>,
}

#[derive(Clone, Debug, serde::Serialize)]
struct OauthRedirectResult {
    code: String,
    state: String,
}

/// What one raw HTTP request hitting the loopback listener turned out to be.
enum CallbackOutcome {
    /// The provider redirect with `code` + `state` — the flow succeeded.
    Captured(OauthRedirectResult),
    /// The provider redirect with `error=…` — consent was denied/blocked
    /// (e.g. Google `access_denied` for a non-test-user on a Testing-mode
    /// app). Must surface immediately, NOT time out after 5 minutes.
    Declined(String),
    /// Favicon probe or other noise — keep listening.
    NotRedirect,
}

fn parse_loopback_request(req: &str) -> CallbackOutcome {
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let query = path.split_once('?').map(|x| x.1).unwrap_or("");
    if let (Some(code), Some(state)) = (query_param(query, "code"), query_param(query, "state")) {
        return CallbackOutcome::Captured(OauthRedirectResult { code, state });
    }
    if let Some(err) = query_param(query, "error") {
        let detail = query_param(query, "error_description")
            .map(|d| format!(" — {d}"))
            .unwrap_or_default();
        return CallbackOutcome::Declined(format!(
            "consent was declined by the provider: {err}{detail}"
        ));
    }
    CallbackOutcome::NotRedirect
}

/// Tiny query-string field extractor — enough for `?code=…&state=…` from a
/// well-formed provider redirect; both values are percent-decoded.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            let raw = it.next().unwrap_or("");
            return Some(percent_decode(raw));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the operator sees in the browser tab after consenting — night-sky
/// wash, "return to Luna". Inlined: the listener serves exactly one page
/// and dies.
const OAUTH_DONE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Luna</title></head>\
<body style=\"margin:0;display:flex;align-items:center;justify-content:center;height:100vh;\
background:radial-gradient(900px 600px at 70% 10%,#16203c 0%,#0a0e1c 60%,#05070f 100%);\
font-family:-apple-system,sans-serif;color:#e7edf8\">\
<div style=\"text-align:center\"><div style=\"font-size:42px\">\u{1F319}</div>\
<h2 style=\"font-weight:600;margin:12px 0 6px\">Consent received</h2>\
<p style=\"color:#8ea2c8;font-size:14px\">You can close this tab and return to Luna — finishing up there.</p></div></body></html>";

/// Shown when the provider redirected with `error=…` — the old behavior
/// served the success page here, telling the operator "Connected" while
/// Luna hung waiting for a code that would never come.
const OAUTH_FAIL_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Luna</title></head>\
<body style=\"margin:0;display:flex;align-items:center;justify-content:center;height:100vh;\
background:radial-gradient(900px 600px at 70% 10%,#16203c 0%,#0a0e1c 60%,#05070f 100%);\
font-family:-apple-system,sans-serif;color:#e7edf8\">\
<div style=\"text-align:center\"><div style=\"font-size:42px\">\u{1F311}</div>\
<h2 style=\"font-weight:600;margin:12px 0 6px\">Not connected</h2>\
<p style=\"color:#8ea2c8;font-size:14px\">The provider declined the request. You can close this tab — details are in Luna.</p></div></body></html>";

/// The single-shot accept loop: parse each request, answer with the right
/// page, capture the outcome. Shared verbatim by the production command and
/// the loopback tests (they spawn THIS, not a mirror of it).
fn run_loopback_accept_loop(
    listener: std::net::TcpListener,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>>,
) {
    use std::io::{Read, Write};
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                // First line: GET /callback?code=…&state=… HTTP/1.1
                let outcome = parse_loopback_request(&req);
                let page = match outcome {
                    CallbackOutcome::Declined(_) => OAUTH_FAIL_HTML,
                    _ => OAUTH_DONE_HTML,
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        page.len(),
                        page
                    )
                    .as_bytes(),
                );
                let _ = stream.flush();
                match outcome {
                    CallbackOutcome::Captured(r) => {
                        *result.lock().unwrap() = Some(Ok(r));
                        return; // single-shot: captured, listener dies
                    }
                    CallbackOutcome::Declined(msg) => {
                        *result.lock().unwrap() = Some(Err(msg));
                        return; // single-shot: the flow is dead either way
                    }
                    // Not the redirect (favicon probe etc.) — keep listening.
                    CallbackOutcome::NotRedirect => {}
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// Bind 127.0.0.1:0 and start the single-shot accept loop. Returns the port
/// for the client to put in `connector-oauth-begin`.
#[tauri::command]
fn oauth_loopback_start(state: tauri::State<'_, OauthLoopback>) -> Result<u16, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not bind a loopback port: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("loopback setup failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("loopback setup failed: {e}"))?
        .port();

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));

    // Replace (and cancel) any previous flow.
    {
        let mut guard = state.inner.lock().unwrap();
        if let Some(prev) = guard.take() {
            prev.cancel.store(true, Ordering::Relaxed);
        }
        *guard = Some(OauthLoopbackActive {
            port,
            cancel: cancel.clone(),
            result: result.clone(),
        });
    }

    std::thread::spawn(move || run_loopback_accept_loop(listener, cancel, result));

    Ok(port)
}

/// Await the captured redirect (poll the shared slot; the JS side calls this
/// right after opening the consent URL). Times out cleanly so an abandoned
/// consent doesn't wedge the settings UI.
#[tauri::command]
async fn oauth_loopback_wait(
    state: tauri::State<'_, OauthLoopback>,
    timeout_ms: Option<u64>,
) -> Result<OauthRedirectResult, String> {
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));
    let (cancel, result) = {
        let guard = state.inner.lock().unwrap();
        match guard.as_ref() {
            Some(active) => (active.cancel.clone(), active.result.clone()),
            None => return Err("no OAuth flow in progress".into()),
        }
    };
    loop {
        // A captured redirect resolves; a provider `error=…` redirect
        // rejects IMMEDIATELY with the provider's reason (it used to fall
        // through to the 5-minute timeout below).
        if let Some(r) = result.lock().unwrap().take() {
            return r;
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("OAuth flow cancelled".into());
        }
        if std::time::Instant::now() >= deadline {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err("timed out waiting for the browser consent".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Abort the in-flight flow (user closed the consent sheet).
#[tauri::command]
fn oauth_loopback_cancel(state: tauri::State<'_, OauthLoopback>) {
    if let Some(active) = state.inner.lock().unwrap().take() {
        active
            .cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Poke the port so a blocked accept wakes promptly (best-effort).
        let _ = std::net::TcpStream::connect(("127.0.0.1", active.port));
    }
}

/// Open a URL in the user's default handler. Allows only https:// (web links,
/// OAuth consent) and mailto: (compose in the mail client). Everything else —
/// http://, file://, javascript:, custom schemes — is refused so that
/// agent-authored prose can never open an arbitrary handler. This must not
/// become a general shell-open primitive.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Scheme allowlist, checked case-insensitively (a URL scheme is
    // case-insensitive per RFC 3986). `get(..n)` is char-boundary-safe — it
    // returns None rather than panicking if a multi-byte char straddles the
    // boundary. We match on the prefix but open the ORIGINAL `url`, since
    // lowercasing the whole string would corrupt the path/query/address.
    let is_https = url
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
    let is_mailto = url
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("mailto:"));
    if !(is_https || is_mailto) {
        return Err("only https:// or mailto: URLs can be opened".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("could not open the link: {e}"))
}

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
struct WidgetDescriptor {
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

fn registry_lookup(kind: &str) -> Option<&'static WidgetDescriptor> {
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

/// May this label participate in the dock graph and be closed by page JS?
/// widget-* (content tier) and panel-* (system tier); never the hub.
fn is_dock_label(label: &str) -> bool {
    label.starts_with("widget-") || label.starts_with("panel-")
}

/// ~/.luna/layout.json — positions of OPEN system panels (and nothing else:
/// pin state for content widgets stays server-side; design doc Persistence).
fn layout_path() -> Option<std::path::PathBuf> {
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
fn write_panel_layout(app: &tauri::AppHandle) {
    let Some(path) = layout_path() else { return };
    let mut entries = Vec::new();
    for (label, win) in app.webview_windows() {
        if !label.starts_with("panel-") {
            continue;
        }
        let Some(kind) = panel_kind_from_label(&label) else {
            continue;
        };
        if let Some((x, y, w, h)) = window_logical_rect(&win) {
            entries.push(serde_json::json!({
                "kind": kind, "x": x, "y": y, "w": w, "h": h
            }));
        }
    }
    let doc = serde_json::json!({ "version": 1, "panels": entries });
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
fn spawn_panel(
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
    "open-wizard",
];

/// Forward an allowlisted action to the window that owns it (`hub-event`
/// with a `for:` payload — the same targeted-event discipline as dock-group).
/// Most actions are hub-owned; `fresh-thread` belongs to the CHAT widget
/// (Phase 4: the chat window owns the thread). When the chat window is
/// closed, fresh-thread falls back to the hub, whose handler opens it (a
/// fresh boot lands on the thread bootstrap).
#[tauri::command]
fn hub_event(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !HUB_EVENT_NAMES.contains(&name.as_str()) {
        return Err(format!("unknown hub event: {name}"));
    }
    let chat_open = app.get_webview_window("panel-chat").is_some();
    let targets: &[&str] = match name.as_str() {
        // The chat window owns the thread; the hub is the fallback opener.
        "fresh-thread" if chat_open => &["panel-chat"],
        // Both sockets react to a credential/channel swap: the hub rebuilds
        // its hello-only connection, the chat window its thread connection.
        "profile-changed" | "connection-changed" if chat_open => &["main", "panel-chat"],
        _ => &["main"],
    };
    for target in targets {
        app.emit_to(
            tauri::EventTarget::labeled(*target),
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
async fn open_widget(
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
async fn open_artifact_widget(
    app: tauri::AppHandle,
    artifact_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let label = widget_label(&artifact_id);
    // Already open → focus, don't spawn a duplicate.
    if let Some(win) = app.get_webview_window(&label) {
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
async fn close_widget(app: tauri::AppHandle, label: String) -> Result<(), String> {
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

/// Redock a pinned chat floater into its owner window (issue #380).
///
/// Used by the explicit Redock button and by live drag-release when the floater
/// center is over the owner's left dock strip. Focuses the owner, emits
/// `redock-thread` with thread id + optional draft + insert hint, then closes
/// the caller. Returns false (no error) when the call is invalid so the page
/// can fall back to just closing.
#[tauri::command]
async fn redock_thread(
    window: tauri::WebviewWindow,
    thread_id: String,
    owner_label: String,
    draft: Option<String>,
    y_ratio: Option<f64>,
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
        serde_json::json!({
            "threadId": thread_id,
            "draft": draft,
            "from": caller_label,
            "yRatio": y_ratio,
        }),
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

// ── Collapse ⟷ expand: the moon is the minimized form of the workspace ───────
//
// The moon orb (window "main") and the widget windows (panel-* / widget-*) are
// MUTUALLY EXCLUSIVE surfaces: either the orb is showing (collapsed) or the
// widgets are (expanded). "Minimize" on any widget tucks the WHOLE set into the
// moon; clicking the moon pours the whole set back out. The windows are HIDDEN,
// not closed, so positions / dock groups / page state all survive the round
// trip — the only way a widget leaves the set is the user closing it (×).

/// Hide every widget window and reveal + focus the moon orb. Widgets are hidden
/// (not destroyed) so a later expand restores them exactly. Emits `moon-absorb`
/// to the orb so index.html can play the "pulled into the moon" pulse.
fn collapse_into_moon(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    for (label, win) in &windows {
        if is_dock_label(label) {
            // Deminiaturize before hiding so a card OS-minimized via the native
            // yellow traffic-light doesn't linger as a Dock tile while the
            // workspace is collapsed. No-op on non-minimized windows.
            let _ = win.unminimize();
            let _ = win.hide();
        }
    }
    if let Some(moon) = windows.get("main") {
        let _ = moon.show();
        let _ = moon.set_focus();
        let _ = app.emit_to(tauri::EventTarget::labeled("main"), "moon-absorb", ());
    }
}

/// Reveal every widget window and hide the moon orb. Show the widgets BEFORE
/// hiding the orb so the desktop is never momentarily empty. When nothing is
/// open yet (a fresh moon), open the chat as the default widget so a click still
/// lands somewhere.
fn expand_out_of_moon(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    let mut shown = 0usize;
    for (label, win) in &windows {
        if is_dock_label(label) {
            // A card the user OS-minimized via the native yellow traffic-light
            // is miniaturized in the Dock; show() alone does NOT deminiaturize
            // on macOS, so unminimize first — otherwise the card is stranded in
            // the Dock with no in-app way back. No-op on non-minimized windows.
            let _ = win.unminimize();
            let _ = win.show();
            shown += 1;
        }
    }
    if let Some(moon) = windows.get("main") {
        let _ = moon.hide();
    }
    if shown == 0 {
        // No widgets to restore → open the chat. open_widget is async and shows
        // the window itself; spawn it so this stays callable from sync contexts
        // (the global-shortcut closure and the sync command wrapper).
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = open_widget(app2, "chat".to_string(), None, None, None, None).await;
        });
    }
}

/// Collapse the whole workspace into the moon (a widget's minimize button / the
/// keyboard toggle when expanded).
#[tauri::command]
fn collapse_to_moon(app: tauri::AppHandle) -> Result<(), String> {
    collapse_into_moon(&app);
    Ok(())
}

/// Expand the workspace back out of the moon (the moon's own click / the
/// keyboard toggle when collapsed).
#[tauri::command]
fn expand_from_moon(app: tauri::AppHandle) -> Result<(), String> {
    expand_out_of_moon(&app);
    Ok(())
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
struct CaptureResult {
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
async fn capture_window_screenshot(window: tauri::WebviewWindow) -> Result<CaptureResult, String> {
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
async fn capture_window_screenshot(_window: tauri::WebviewWindow) -> Result<CaptureResult, String> {
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
fn begin_native_resize(window: tauri::WebviewWindow, direction: String) -> Result<(), String> {
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
fn begin_native_resize(_window: tauri::WebviewWindow, _direction: String) -> Result<(), String> {
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
fn begin_redock_drag(
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
fn begin_redock_drag(
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
fn begin_native_pullout_drag(
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
fn begin_native_pullout_drag(
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

// ── Phase-2 C3: client route config + session state ──────────────────────────
//
// Reads ~/.luna/client.toml (bootstrap route config) and manages per-panel
// route state in ~/.luna/moon-session.json.  Token resolution is deferred to
// Phase-3.  The existing `load_connection` command is shimmed to delegate to
// `load_route(default)` so the current single-connection boot keeps working.
mod client_config;

// ── voice pipeline commands (feature "voice") ───────────────────────────────
//
// Thin wrappers over luna_moon_ui_lib::voice::VoiceController (managed as
// Tauri State). Command names, args and payloads follow VOICE.md exactly.
// All are async so a slow operation (mode teardown joins through an in-flight
// whisper inference; ~/.luna model download) never runs on the main thread —
// and async commands taking State must return Result (Tauri 2 constraint),
// hence the uniform signatures.

#[cfg(feature = "voice")]
use luna_moon_ui_lib::voice::{self, VoiceController};

/// Global push-to-talk shortcut, registered ONLY while mode=ptt (VOICE.md:
/// default Cmd+Shift+Space; CmdOrCtrl maps to Cmd on macOS).
#[cfg(feature = "voice")]
const PTT_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";

/// Keep the global PTT shortcut registration in sync with the active mode:
/// registered while ptt, unregistered otherwise. Pressed/Released route to
/// the same internal ptt down/up paths as the mic button. A registration
/// failure (e.g. another app owns the chord) must not fail the mode change —
/// the in-app mic button still drives PTT — so it surfaces as a voice-error
/// banner instead.
///
/// ALWAYS called from inside `set_mode_with_sync`'s mode lock, which makes
/// the is_registered → on_shortcut/unregister decision atomic with the mode
/// write (and with concurrent voice_set_mode calls).
#[cfg(feature = "voice")]
fn sync_ptt_shortcut(app: &tauri::AppHandle, want_registered: bool) {
    let shortcut = match PTT_SHORTCUT.parse::<Shortcut>() {
        Ok(s) => s,
        Err(_) => return, // a constant that fails to parse is a build-time bug
    };
    let gs = app.global_shortcut();
    let registered = gs.is_registered(shortcut);
    if want_registered && !registered {
        let result = gs.on_shortcut(shortcut, |app, _shortcut, event| {
            let controller = app.state::<VoiceController>();
            if event.state == ShortcutState::Pressed {
                controller.ptt_down();
            } else if event.state == ShortcutState::Released {
                controller.ptt_up();
            }
        });
        if let Err(e) = result {
            let _ = tauri::Emitter::emit(
                app,
                "voice-error",
                serde_json::json!({
                    "message": format!("global PTT shortcut unavailable: {e}")
                }),
            );
        }
    } else if !want_registered && registered {
        let _ = gs.unregister(shortcut);
    }
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_status(
    controller: tauri::State<'_, VoiceController>,
) -> Result<voice::VoiceStatus, String> {
    Ok(controller.status())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_set_mode(
    app: tauri::AppHandle,
    controller: tauri::State<'_, VoiceController>,
    mode: String,
) -> Result<voice::VoiceStatus, String> {
    // The shortcut sync runs INSIDE the controller's mode lock, with the
    // EFFECTIVE mode (a missing model keeps the mode off). Syncing after
    // set_mode returned was a TOCTOU: interleaved mode changes could finish
    // ptt→off but sync off→ptt, leaving the chord registered system-wide
    // while voice was off (see set_mode_with_sync docs).
    controller.set_mode_with_sync(&mode, |effective| {
        sync_ptt_shortcut(&app, effective == voice::VoiceMode::Ptt);
    })
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_ptt_down(controller: tauri::State<'_, VoiceController>) -> Result<(), String> {
    controller.ptt_down();
    Ok(())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_ptt_up(controller: tauri::State<'_, VoiceController>) -> Result<(), String> {
    controller.ptt_up();
    Ok(())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn speak_text(
    controller: tauri::State<'_, VoiceController>,
    text: String,
    interrupt: bool,
) -> Result<(), String> {
    controller.speak_text(&text, interrupt)
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_stop_speaking(controller: tauri::State<'_, VoiceController>) -> Result<(), String> {
    controller.stop_speaking();
    Ok(())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_list_voices(
    controller: tauri::State<'_, VoiceController>,
) -> Result<Vec<voice::tts::Voice>, String> {
    Ok(controller.list_voices())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_set_voice(
    app: tauri::AppHandle,
    controller: tauri::State<'_, VoiceController>,
    id: String,
) -> Result<(), String> {
    if !controller.set_voice(&id) {
        // Stale persisted id (e.g. a premium voice deleted in System
        // Settings): the engine fell back to the system default. Surface it
        // — stderr-only logging left Settings showing the stale pick as the
        // active voice indefinitely while a different voice spoke.
        let _ = tauri::Emitter::emit(
            &app,
            "voice-error",
            serde_json::json!({
                "message": format!(
                    "saved voice {id:?} is unavailable — speaking with the system default voice"
                )
            }),
        );
    }
    Ok(())
}

#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_set_config(
    controller: tauri::State<'_, VoiceController>,
    silence_hang_ms: Option<u32>,
) -> Result<(), String> {
    controller.set_config(silence_hang_ms);
    Ok(())
}

/// Download the whisper model if missing (idempotent; resolves when
/// present). Progress streams as `voice-model-progress` events.
#[cfg(feature = "voice")]
#[tauri::command]
async fn voice_ensure_model(app: tauri::AppHandle) -> Result<(), String> {
    voice::model::ensure_model(move |payload| {
        let _ = tauri::Emitter::emit(&app, "voice-model-progress", payload);
    })
    .await
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

/// Clear ONLY the WKWebView disk + memory cache, preserving localStorage /
/// IndexedDB. WKWebView caches the `tauri://` asset responses (the embedded
/// frontend) and keeps serving them ACROSS app updates — so a user on a fresh
/// binary kept seeing a months-old frontend (none of the shipped frontend fixes
/// ran). Purging the cache forces the webview to re-fetch the new embedded
/// assets. Must run on the main thread.
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
    // only — NOT LocalStorage / IndexedDB / Cookies, so user settings survive.
    let disk = NSString::from_str("WKWebsiteDataTypeDiskCache");
    let mem = NSString::from_str("WKWebsiteDataTypeMemoryCache");
    let types = NSSet::from_retained_slice(&[disk, mem]);
    let epoch = NSDate::dateWithTimeIntervalSince1970(0.0); // clear all ages
    let done = RcBlock::new(|| eprintln!("[moon] WKWebView cache purge completed"));
    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &epoch, &done) };
    eprintln!("[moon] clearing WKWebView disk/memory cache (frontend refresh)");
}

/// On the FIRST launch after an app update, purge the webview cache so the new
/// embedded frontend loads instead of the version the webview cached under the
/// old build. Tracks the last-seen version in `~/.luna/.moon-webview-version`.
/// Best-effort: any error simply skips the purge (no worse than before). Runs at
/// the very start of `setup`, before any panel webview opens on demand, so the
/// panels load fresh.
fn clear_webview_cache_if_updated() {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let dir = std::path::PathBuf::from(home).join(".luna");
        let stamp = dir.join(".moon-webview-version");
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
    // `mut` only needed when the optional wdio-e2e plugin is registered below.
    #[cfg_attr(not(feature = "wdio-e2e"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        // Hub-owns-exit lifecycle (widget-system.md Phase 0): the moon hub is
        // the owning window — when it is destroyed, every other window
        // (widget-*/panel-*) closes with it, and Tauri's natural
        // last-window-closed exit fires. The reverse never holds: closing a
        // widget leaves the hub (and the app) alive.
        .on_window_event(|window, event| {
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
                write_panel_layout(window.app_handle());
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
                    write_panel_layout(app);
                }
                // Don't strand the user with nothing on screen: while the
                // workspace is EXPANDED the moon is hidden, so closing (×) the
                // LAST widget would leave an empty desktop. When a widget is
                // destroyed and none remain while the orb is hidden, bring the
                // moon back (the workspace has collapsed by attrition). Skipped
                // during hub-owned shutdown — main is already gone, so the
                // get_webview_window("main") guard fails closed.
                if is_dock_label(window.label()) {
                    if let Some(moon) = app.get_webview_window("main") {
                        let any_widget_left = app
                            .webview_windows()
                            .keys()
                            .any(|l| l != window.label() && is_dock_label(l));
                        if !any_widget_left && !moon.is_visible().unwrap_or(true) {
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
        .manage(OauthLoopback::default())
        // Staged-update flow: live phase + the verified, held archive bytes so
        // apply_update installs without a second network round-trip.
        .manage(UpdateManager::default());

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
        get_last_thread_id,
        set_last_thread_id,
        save_connection,
        load_connection,
        load_profiles,
        set_active_profile,
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
        local_shell_exec,
        get_platform,
        notify,
        check_for_update,
        start_update_download,
        apply_update,
        update_state,
        take_pending_update,
        oauth_loopback_start,
        oauth_loopback_wait,
        oauth_loopback_cancel,
        open_external_url,
        open_artifact_widget,
        open_widget,
        hub_event,
        close_widget,
        redock_thread,
        begin_redock_drag,
        begin_native_pullout_drag,
        collapse_to_moon,
        expand_from_moon,
        begin_native_resize,
        capture_window_screenshot,
        voice_status,
        voice_set_mode,
        voice_ptt_down,
        voice_ptt_up,
        speak_text,
        voice_stop_speaking,
        voice_list_voices,
        voice_set_voice,
        voice_set_config,
        voice_ensure_model
    ]);
    #[cfg(not(feature = "voice"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_last_thread_id,
        set_last_thread_id,
        save_connection,
        load_connection,
        load_profiles,
        set_active_profile,
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
        local_shell_exec,
        get_platform,
        notify,
        check_for_update,
        start_update_download,
        apply_update,
        update_state,
        take_pending_update,
        oauth_loopback_start,
        oauth_loopback_wait,
        oauth_loopback_cancel,
        open_external_url,
        open_artifact_widget,
        open_widget,
        hub_event,
        close_widget,
        redock_thread,
        begin_redock_drag,
        begin_native_pullout_drag,
        collapse_to_moon,
        expand_from_moon,
        begin_native_resize,
        capture_window_screenshot
    ]);

    builder
        .setup(|app| {
            // FIRST: if this is the first launch after an app update, purge the
            // WKWebView cache so the new embedded frontend loads (WKWebView
            // otherwise serves the tauri:// assets it cached under the old build).
            // Runs before any panel webview opens on demand, so panels load fresh.
            clear_webview_cache_if_updated();

            // Restore open system panels from ~/.luna/layout.json (design doc
            // Persistence): positions clamped to the primary monitor so a
            // display change can't strand a panel off-screen. Unknown kinds
            // (stale file, removed registry entry) are skipped silently.
            {
                let handle = app.handle().clone();
                // Logical bounds of every connected monitor; a saved position
                // clamps to the monitor that CONTAINS it (multi-display
                // setups), falling back to the first monitor when the saved
                // display is gone.
                let monitors: Vec<((f64, f64), (f64, f64))> = app
                    .available_monitors()
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
                    .collect();
                let clamp_to_monitors = move |x: f64, y: f64| -> (f64, f64) {
                    if monitors.is_empty() {
                        return (x, y);
                    }
                    let containing = monitors.iter().find(|((mx, my), (mw, mh))| {
                        x >= *mx && x < mx + mw && y >= *my && y < my + mh
                    });
                    let ((mx, my), (mw, mh)) = containing.unwrap_or(&monitors[0]);
                    (
                        x.clamp(*mx, (mx + mw - 80.0).max(*mx)),
                        y.clamp(*my, (my + mh - 80.0).max(*my)),
                    )
                };
                if let Some(path) = layout_path() {
                    if let Ok(raw) = std::fs::read_to_string(&path) {
                        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
                            // Restore each panel independently at its saved,
                            // clamped rect. No dock graph is reconstructed.
                            for p in doc["panels"].as_array().unwrap_or(&Vec::new()) {
                                let Some(kind) = p["kind"].as_str() else {
                                    continue;
                                };
                                let Some(desc) = registry_lookup(kind) else {
                                    continue;
                                };
                                let (x, y) = clamp_to_monitors(
                                    p["x"].as_f64().unwrap_or(180.0),
                                    p["y"].as_f64().unwrap_or(160.0),
                                );
                                let w = p["w"].as_f64().filter(|v| *v >= 220.0);
                                let h = p["h"].as_f64().filter(|v| *v >= 120.0);
                                let _ = spawn_panel(&handle, desc, Some(x), Some(y), w, h);
                            }
                        }
                    }
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
                                    expand_out_of_moon(app);
                                } else {
                                    collapse_into_moon(app);
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
                        if let Err(e) = run_update_check(handle.clone(), true).await {
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

#[cfg(test)]
mod panel_registry_tests {
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

    #[test]
    fn dock_namespace_admits_widget_and_panel_but_never_the_hub() {
        assert!(is_dock_label("widget-abc123"));
        assert!(is_dock_label("panel-settings-updates"));
        assert!(!is_dock_label("main"));
        assert!(!is_dock_label("settings"));
        assert!(is_closable_widget_label("panel-settings-updates"));
        assert!(!is_closable_widget_label("main"));
    }

    // ── staged-update DTO projection (no network) ────────────────────────────

    #[test]
    fn update_inner_default_projects_idle_dto() {
        // A fresh UpdateManager (never checked) reads as "idle", not "" — the
        // surfaces switch on this phase string, so an empty default would render
        // a blank pill.
        let dto = UpdateInner::default().to_dto();
        assert_eq!(dto.phase, "idle");
        assert!(dto.version.is_none());
        assert!(dto.notes.is_none());
        assert_eq!(dto.downloaded, 0);
        assert!(dto.total.is_none());
    }

    #[test]
    fn update_inner_ready_dto_carries_progress_and_version() {
        // The "ready" snapshot is what a freshly-opened panel replays to skip
        // straight to the "Restart to update" state.
        let inner = UpdateInner {
            phase: "ready".to_string(),
            version: Some("0.0.99".to_string()),
            notes: Some("fixes".to_string()),
            downloaded: 1_000,
            total: Some(1_000),
            staged: None,
        };
        let dto = inner.to_dto();
        assert_eq!(dto.phase, "ready");
        assert_eq!(dto.version.as_deref(), Some("0.0.99"));
        assert_eq!(dto.notes.as_deref(), Some("fixes"));
        assert_eq!(dto.downloaded, 1_000);
        assert_eq!(dto.total, Some(1_000));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn close_widget_refuses_to_close_non_widget_windows() {
        // The per-window boundary the widgets capability documents: a widget may
        // only close widget-* windows, NEVER the main chat window (review G3).
        assert!(is_closable_widget_label("widget-deadbeef"));
        assert!(is_closable_widget_label(&widget_label("anything")));
        assert!(!is_closable_widget_label("main"));
        assert!(!is_closable_widget_label("setup"));
        assert!(!is_closable_widget_label(""));
    }

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

    // ── local shell executor ────────────────────────────────────────────────

    #[test]
    fn secret_env_key_matches_token_like_names_only() {
        for k in [
            "GH_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "API_KEY",
            "APIKEY",
            "MY_PASSWORD",
            "DB_PASS",
            "X_AUTH_HEADER",
            "SESSION_ID",
            "PRIVATE_KEY",
            "LUNA_UI_WS_TOKEN",
        ] {
            assert!(is_secret_env_key(k), "{k} should be treated as secret");
        }
        for k in ["PATH", "HOME", "LANG", "TERM", "USER", "PWD", "SHELL"] {
            assert!(!is_secret_env_key(k), "{k} should NOT be treated as secret");
        }
    }

    #[test]
    fn format_captured_appends_marker_only_when_truncated() {
        assert_eq!(format_captured(b"abcd".to_vec(), 0), "abcd");
        assert_eq!(
            format_captured(b"abcd".to_vec(), 2),
            "abcd\n[truncated 2 bytes]"
        );
    }

    #[tokio::test]
    async fn captures_stdout_and_zero_exit() {
        let r = exec_local("printf hello".into(), None, Some(2_000)).await;
        assert_eq!(r.stdout, "hello");
        assert_eq!(r.exit_code, Some(0));
        assert!(!r.timed_out);
    }

    #[tokio::test]
    async fn preserves_nonzero_exit_and_stderr() {
        let r = exec_local("printf oops >&2; exit 7".into(), None, Some(2_000)).await;
        assert_eq!(r.exit_code, Some(7));
        assert_eq!(r.stderr, "oops");
        assert_eq!(r.stdout, "");
    }

    #[tokio::test]
    async fn honors_per_request_cwd() {
        let r = exec_local("pwd".into(), Some("/".into()), Some(2_000)).await;
        assert_eq!(r.stdout.trim(), "/");
    }

    #[tokio::test]
    async fn times_out_and_kills_long_command() {
        let started = std::time::Instant::now();
        let r = exec_local("sleep 5".into(), None, Some(50)).await;
        assert!(r.timed_out, "should report timed_out");
        assert!(r.exit_code.is_none());
        assert!(
            started.elapsed().as_millis() < 1_500,
            "must not wait the full 5s"
        );
    }

    #[tokio::test]
    async fn truncates_output_beyond_the_cap() {
        let r = exec_local(
            "head -c 100000 /dev/zero | tr '\\0' a".into(),
            None,
            Some(4_000),
        )
        .await;
        assert!(r
            .stdout
            .starts_with(&"a".repeat(LOCAL_SHELL_MAX_OUTPUT_BYTES)));
        assert!(r.stdout.contains("[truncated "));
    }

    #[tokio::test]
    async fn spawn_failure_is_a_result_not_an_error() {
        // An unreadable cwd makes the spawn fail; we still get a result frame
        // (exit_code None, stderr set) rather than a Tauri error.
        let r = exec_local(
            "echo nope".into(),
            Some("/no/such/dir/really".into()),
            Some(2_000),
        )
        .await;
        assert!(r.exit_code.is_none());
        assert!(!r.stderr.is_empty());
        assert!(!r.timed_out);
    }

    // ── connector OAuth loopback parsing (PRD A §09) ────────────────────────

    #[test]
    fn query_param_extracts_code_and_state_with_percent_decoding() {
        let q = "code=4%2F0Adeu5BW&state=abc-_123&scope=email+profile";
        assert_eq!(query_param(q, "code").as_deref(), Some("4/0Adeu5BW"));
        assert_eq!(query_param(q, "state").as_deref(), Some("abc-_123"));
        assert_eq!(query_param(q, "scope").as_deref(), Some("email profile"));
        assert_eq!(query_param(q, "missing"), None);
    }

    #[test]
    fn query_param_survives_junk() {
        assert_eq!(query_param("", "code"), None);
        assert_eq!(query_param("code", "code").as_deref(), Some(""));
        assert_eq!(query_param("a=%ZZ", "a").as_deref(), Some("%ZZ")); // bad hex passes through
        assert_eq!(query_param("a=1&a=2", "a").as_deref(), Some("1")); // first wins
    }

    #[test]
    fn parse_loopback_request_classifies_redirects() {
        // Success redirect.
        match parse_loopback_request(
            "GET /callback?code=4%2Fabc&state=st-1 HTTP/1.1\r\nhost: x\r\n\r\n",
        ) {
            CallbackOutcome::Captured(r) => {
                assert_eq!(r.code, "4/abc");
                assert_eq!(r.state, "st-1");
            }
            _ => panic!("expected Captured"),
        }
        // Provider error redirect (the Testing-mode / denied-consent path).
        match parse_loopback_request(
            "GET /callback?error=access_denied&error_description=App+not+verified&state=st-1 HTTP/1.1\r\n\r\n",
        ) {
            CallbackOutcome::Declined(msg) => {
                assert!(msg.contains("access_denied"));
                assert!(msg.contains("App not verified"));
            }
            _ => panic!("expected Declined"),
        }
        // Error without a description still reports the code.
        match parse_loopback_request("GET /callback?error=access_denied&state=s HTTP/1.1\r\n\r\n") {
            CallbackOutcome::Declined(msg) => assert!(msg.ends_with("access_denied")),
            _ => panic!("expected Declined"),
        }
        // Favicon probe / junk keeps the listener alive.
        assert!(matches!(
            parse_loopback_request("GET /favicon.ico HTTP/1.1\r\n\r\n"),
            CallbackOutcome::NotRedirect
        ));
        assert!(matches!(
            parse_loopback_request(""),
            CallbackOutcome::NotRedirect
        ));
    }

    /// Spawn the REAL accept loop (not a mirror), play the provider with a
    /// browser-style redirect, assert the captured outcome + response page.
    fn run_loopback_against(
        request: &[u8],
    ) -> (String, Option<Result<OauthRedirectResult, String>>) {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicBool;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let result: std::sync::Arc<std::sync::Mutex<Option<Result<OauthRedirectResult, String>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        let c2 = cancel.clone();
        let r2 = result.clone();
        let handle = std::thread::spawn(move || run_loopback_accept_loop(listener, c2, r2));

        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        handle.join().unwrap();

        let outcome = result.lock().unwrap().take();
        (response, outcome)
    }

    #[test]
    fn loopback_captures_a_provider_redirect() {
        let (response, outcome) = run_loopback_against(
            b"GET /callback?code=the-code&state=the-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
        );
        assert!(response.contains("200 OK"));
        assert!(response.contains("return to Luna"));
        let captured = outcome.unwrap().unwrap();
        assert_eq!(captured.code, "the-code");
        assert_eq!(captured.state, "the-state");
    }

    #[test]
    fn loopback_surfaces_a_provider_error_redirect() {
        let (response, outcome) = run_loopback_against(
            b"GET /callback?error=access_denied&state=the-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n",
        );
        // The browser tab must NOT claim success…
        assert!(response.contains("Not connected"));
        assert!(!response.contains("Consent received"));
        // …and the waiting client gets the provider's reason immediately.
        let err = outcome.unwrap().unwrap_err();
        assert!(err.contains("access_denied"));
    }
}
