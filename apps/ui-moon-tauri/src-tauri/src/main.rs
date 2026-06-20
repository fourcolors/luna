// Prevent additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
// `emit_to` lives on the Emitter trait in Tauri 2 (split from Manager). HEAD
// imported only Manager, so the existing luna-config emit below did not compile.
// This one-line import is behavior-preserving and unblocks `cargo check`.
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
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
    let _ = app.emit(
        "update://error",
        serde_json::json!({ "message": message }),
    );
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
        "TOKEN", "SECRET", "PASS", "CREDENTIAL", "AUTH", "COOKIE", "SESSION",
    ];
    if NEEDLES.iter().any(|n| k.contains(n)) {
        return true;
    }
    k.contains("APIKEY") || k.contains("API_KEY") || k.contains("API-KEY")
        || k.contains("PRIVATEKEY") || k.contains("PRIVATE_KEY") || k.contains("PRIVATE-KEY")
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
    let query = path.splitn(2, '?').nth(1).unwrap_or("");
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
        active.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
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
    let is_https = url.get(..8).map_or(false, |p| p.eq_ignore_ascii_case("https://"));
    let is_mailto = url.get(..7).map_or(false, |p| p.eq_ignore_ascii_case("mailto:"));
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
    #[allow(dead_code)] // all v1 panels are singletons; instance suffixes come with non-singleton kinds
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

/// A caller-supplied window position is honoured only when BOTH coordinates are
/// present — the window builders apply `.position()` solely on `(Some, Some)`.
/// A partial position is therefore treated as "no position": the window snaps
/// to the cluster instead of free-floating at the OS default. Keeps the
/// snap-on-open gate in lockstep with the builder. Pure for tests.
fn has_explicit_position(x: Option<f64>, y: Option<f64>) -> bool {
    x.is_some() && y.is_some()
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
        if let Some((x, y, w, h)) = dock_logical_rect(&win) {
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
    spawn_panel_at(app, desc, &panel_label(&desc.kind), &desc.page, x, y, width, height, true)
        .map(|w| w.label().to_string())
}

/// spawn_panel with an explicit label + url (non-singleton instances).
/// `visible: false` defers the first paint until a snap-on-open caller has
/// positioned the window (so it never flashes from the OS-default spot to the
/// cluster seam); that caller MUST then show() it.
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
    visible: bool,
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
    .visible(visible)
    .inner_size(width.unwrap_or(desc.width), height.unwrap_or(desc.height))
    .min_inner_size(220.0, 120.0);
    // macOS overlay title bar: hidden_title drops the window title text;
    // exact traffic-light placement is synced from #title-bar via
    // sync_traffic_light_position (wry's static inset cannot move the cluster
    // down into the card — only horizontal nudge).
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    // Return the built window so callers reveal it via the handle they already
    // hold — no re-fetch that could miss (and strand a hidden window).
    let win = builder.build().map_err(|e| e.to_string())?;
    // Antinote-style: native lights stay hidden until the title bar is hovered.
    let _ = apply_native_controls_visible(&win, false);
    Ok(win)
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
/// namespace, optional opener-edge placement + dock-group join (a panel
/// opened from another widget/panel spawns docked to it — stacks). Unknown
/// kinds are rejected; the registry is the trust boundary.
#[tauri::command]
async fn open_widget(
    app: tauri::AppHandle,
    kind: String,
    params: Option<serde_json::Value>,
    opener: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
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
    // Singleton (or same-params instance): already open → show + focus.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(label);
    }
    // An explicit opener must be a dock-namespace window that actually exists;
    // the hub ("main") deliberately does NOT qualify (the moon is never a group
    // member). A gear-opened panel passes no opener and instead snaps to the
    // nearest existing cluster below — so it still never docks TO the moon.
    let opener = opener.filter(|o| is_dock_label(o) && app.get_webview_window(o).is_some());

    // Snap-on-open: an explicit opener wins (the "stacks" mechanic — a panel
    // launched from another panel docks to it); otherwise, unless the caller
    // pinned an explicit position, the panel accretes onto the chat anchor's /
    // nearest open cluster — "panels open stuck together", default-on. The
    // moon/hub is never a dock member, so the first panel (opened from the gear
    // with no neighbours) still free-floats. When it WILL snap, build HIDDEN;
    // the panel's moon-dock.js then computes the flush dock position in JS and
    // calls `dock_self` to position + reveal it, so it never flashes at the
    // OS-default spot. The opener (if any) rides the URL so JS knows its anchor.
    // "Positioned" = BOTH coords (exactly what the builder honours); a partial
    // position counts as none, so the window snaps rather than free-floating.
    let will_snap = opener.is_some() || !has_explicit_position(x, y);
    let url = match &opener {
        Some(o) => {
            let sep = if url.contains('?') { '&' } else { '?' };
            format!("{url}{sep}__dockOpener={o}")
        }
        None => url,
    };
    let win = spawn_panel_at(&app, desc, &label, &url, x, y, None, None, !will_snap)?;
    let win_label = win.label().to_string();

    if will_snap {
        // SAFETY NET: JS (dock_self) reveals the hidden window almost immediately;
        // if it never does (page load failure), reveal it anyway so a snap-on-open
        // panel can't strand itself hidden.
        let app2 = app.clone();
        let label2 = win_label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let app3 = app2.clone();
            let label3 = label2.clone();
            let _ = app2.run_on_main_thread(move || {
                if let Some(w) = app3.get_webview_window(&label3) {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
        });
    }
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
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
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
    .inner_size(width.unwrap_or(360.0), height.unwrap_or(440.0))
    .min_inner_size(220.0, 160.0);
    // macOS overlay title bar — position synced from the page (spawn_panel_at).
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // When it will snap (no explicit position), build hidden and reveal flush
    // after positioning so the window never flashes at the OS-default spot. A
    // partial position counts as none (the builder honours only both coords).
    let will_snap = !has_explicit_position(x, y);
    builder = builder.visible(!will_snap);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    // Keep the built window handle so reveal can never miss it (a re-fetch
    // could return None and strand a hidden window).
    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = apply_native_controls_visible(&win, false);
    // Snap-on-open: with no explicit position, the artifact / MCP-app window
    // accretes onto the chat / nearest open dock cluster, exactly like a system
    // panel. widget.html loads moon-dock.js, so the page computes its flush dock
    // position in JS and calls `dock_self` to position + reveal itself. An
    // explicit (x, y) — e.g. a restored pop-out — was honoured at build time.
    if will_snap {
        // SAFETY NET: reveal the hidden window if JS never calls dock_self.
        let app2 = app.clone();
        let label2 = label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let app3 = app2.clone();
            let label3 = label2.clone();
            let _ = app2.run_on_main_thread(move || {
                if let Some(w2) = app3.get_webview_window(&label3) {
                    if !w2.is_visible().unwrap_or(true) {
                        let _ = w2.show();
                    }
                }
            });
        });
    }
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

/// Labels of every currently-open widget-family window (widget-* content
/// windows AND panel-* system windows) — snap candidates for the dock wiring
/// and the cascade counter for pop-outs.
#[tauri::command]
fn list_widget_windows(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|l| is_dock_label(l))
        .cloned()
        .collect()
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

/// Show or hide the macOS native traffic-light buttons (close / miniaturize /
/// zoom) on a card window. Used at spawn (hidden until title-bar hover) and by
/// the `set_native_controls_visible` command from the frontend skin/hover layer.
#[cfg(target_os = "macos")]
fn apply_native_controls_visible(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::{NSWindow, NSWindowButton};

        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            for btn_kind in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(btn) = ns_win.standardWindowButton(btn_kind) {
                    btn.setHidden(!visible);
                }
            }
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_native_controls_visible(_window: &tauri::WebviewWindow, _visible: bool) -> Result<(), String> {
    Ok(())
}

/// Align the native traffic-light cluster with the CSS `#title-bar`.
///
/// `x` / `y_top` are logical px from the webview top-left (same space as
/// `getBoundingClientRect`): `x` is the close-button left edge, `y_top` is the
/// close-button top edge. The webview is full-bleed (TitleBarStyle::Overlay), so
/// these are equivalently the inset from the window's own top-left.
///
/// We mirror wry's own `inset_traffic_lights`: GROW the NSTitlebarContainerView
/// (the standard buttons' grandparent) so its bounds enclose the lowered buttons
/// BEFORE offsetting them. This is load-bearing for CLICKABILITY, not just looks.
/// AppKit clips a view's `hitTest:` to its superview's bounds, so buttons shoved
/// below the default (~28pt) container's bounds still PAINT but stop receiving
/// mouse events — the pointer falls through to the full-bleed WKWebView beneath,
/// so no native hover glyph is drawn and clicks do nothing. That was the "lights
/// visible but dead" bug: the previous code moved the bare buttons via
/// `setFrameOrigin` but never resized their container. The resize MUST re-run on
/// every sync (AppKit re-pins + shrinks the container on reveal/resize/zoom/
/// focus), which the JS hover/resize/weld syncs already guarantee.
#[cfg(target_os = "macos")]
fn apply_traffic_light_layout(
    window: &tauri::WebviewWindow,
    x: f64,
    y_top: f64,
) -> Result<(), String> {
    if !x.is_finite() || !y_top.is_finite() {
        return Ok(());
    }
    with_appkit_main_thread(window.clone(), move |win| {
        use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

        let ns_win_ptr = win.ns_window().map_err(|e| e.to_string())?;

        unsafe {
            let ns_win: &NSWindow = &*ns_win_ptr.cast();
            let Some(close) = ns_win.standardWindowButton(NSWindowButton::CloseButton) else {
                return Ok(());
            };
            let Some(mini) = ns_win.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
                return Ok(());
            };
            let zoom = ns_win.standardWindowButton(NSWindowButton::ZoomButton);

            // The standard buttons live inside the (short) NSTitlebarContainerView,
            // reached two levels up from the close button — exactly as wry does.
            let Some(group) = close.superview() else {
                return Ok(());
            };
            let Some(container) = group.superview() else {
                return Ok(());
            };

            let close_rect = NSView::frame(&close);
            let space = NSView::frame(&mini).origin.x - close_rect.origin.x;

            // Grow the container so its bounds enclose the lowered buttons (else
            // they paint but stop hit-testing — see the doc comment). Pin its top
            // to the window top: height = close height + y_top, origin.y flipped
            // into AppKit's bottom-left space.
            let title_bar_h = close_rect.size.height + y_top;
            let mut container_rect = NSView::frame(&container);
            container_rect.size.height = title_bar_h;
            container_rect.origin.y = ns_win.frame().size.height - title_bar_h;
            container.setFrame(container_rect);

            let mut buttons = vec![close, mini];
            if let Some(zoom) = zoom {
                buttons.push(zoom);
            }
            for (i, button) in buttons.into_iter().enumerate() {
                let mut rect = NSView::frame(&button);
                rect.origin.x = x + (i as f64) * space;
                button.setFrameOrigin(rect.origin);
            }
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn apply_traffic_light_layout(
    _window: &tauri::WebviewWindow,
    _x: f64,
    _y_top: f64,
) -> Result<(), String> {
    Ok(())
}

/// Sync native traffic-light layout to the CSS title bar (see
/// `apply_traffic_light_layout`). Called from moon-native-titlebar.js on hover,
/// resize, and after dock weld geometry changes.
#[tauri::command]
fn sync_traffic_light_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    apply_traffic_light_layout(&window, x, y)
}

/// Show or hide the macOS native traffic-light buttons (close / miniaturize /
/// zoom) on the CALLING card window. Invoked by moon-native-titlebar.js for
/// Antinote-style hover reveal (studio/aqua) and by moon-appearance.js when
/// switching skins. Each card window calls this on itself.
///
/// Non-macOS: compiles to a no-op that returns `Ok(())` immediately.
#[tauri::command]
fn set_native_controls_visible(window: tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    apply_native_controls_visible(&window, visible)
}

/// Snap-on-open placement, owned by the frontend. A freshly-opened panel is
/// built HIDDEN; its moon-dock.js computes the flush dock position (in card-face
/// space, via LunaDeckSnap.dockOnOpenPosition) and calls this to position +
/// reveal itself — so it never flashes at the OS-default spot. `x`/`y` are the
/// logical-px frame top-left (both present = position; absent = reveal in place,
/// e.g. the first panel with no cluster). `anchor`/`edge` (when present) flash
/// the anchor's side of the new seam. Replaces the old Rust dock graph
/// (group_bbox_of / dock_components / dock_rects_touch / dock_new_panel).
#[tauri::command]
fn dock_self(
    window: tauri::WebviewWindow,
    x: Option<f64>,
    y: Option<f64>,
    anchor: Option<String>,
    edge: Option<String>,
) -> Result<(), String> {
    if let (Some(px), Some(py)) = (x, y) {
        let _ = window.set_position(tauri::LogicalPosition::new(px, py));
    }
    let _ = window.show();
    let app = window.app_handle();
    if let (Some(a), Some(e)) = (anchor, edge) {
        let _ = app.emit_to(
            tauri::EventTarget::labeled(&a),
            "dock-link",
            serde_json::json!({ "for": a, "from": window.label(), "edge": e }),
        );
    }
    broadcast_dock_geometry_settled(app, window.label());
    Ok(())
}

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
    let registered = gs.is_registered(shortcut.clone());
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
            let _ = tauri::Emitter::emit(app,
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
async fn voice_stop_speaking(
    controller: tauri::State<'_, VoiceController>,
) -> Result<(), String> {
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
        let _ = tauri::Emitter::emit(&app,
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
        let _ = tauri::Emitter::emit(&app,
            "voice-model-progress",
            payload,
        );
    })
    .await
}

// ── widget dock geometry (open-time clustering) ─────────────────────────────
//
// Welding is emergent JS now (moon-dock.js + deck-snap.js): each window squares
// its own seams from live geometry on every move/resize, and there is no Rust
// membership graph. Rust keeps only the pure-geometry helpers below, used at
// OPEN time to place a freshly-spawned panel flush against the cluster nearest
// its spawn point — the connected component (flush-touching rects) is unioned
// into a bounding box the new panel appends against.

/// A window's outer rect in LOGICAL px (its own monitor's scale) — all dock
/// geometry runs in logical units so mixed-DPI setups compare coherently.
fn dock_logical_rect(w: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let p = w.outer_position().ok()?;
    let s = w.outer_size().ok()?;
    let sf = w.scale_factor().unwrap_or(1.0);
    Some((
        (f64::from(p.x) / sf) as i32,
        (f64::from(p.y) / sf) as i32,
        (f64::from(s.width) / sf) as i32,
        (f64::from(s.height) / sf) as i32,
    ))
}

/// Broadcast a settled geometry tick so every dock window recomputes weld +
/// per-side inset collapse. Emitted after snap-on-open positioning so panels
/// that booted hidden at the OS-default spot repaint flush at the seam.
fn broadcast_dock_geometry_settled(app: &tauri::AppHandle, from: &str) {
    let _ = app.emit(
        "dock-geometry-changed",
        serde_json::json!({ "from": from, "settled": true }),
    );
}

fn main() {
    let builder = tauri::Builder::default()
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
                write_panel_layout(&window.app_handle());
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
                    write_panel_layout(&app);
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
                            let _ = app.emit_to(
                                tauri::EventTarget::labeled("main"),
                                "moon-absorb",
                                (),
                            );
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
        // PRD A §09: the client-brokered OAuth loopback state.
        .manage(OauthLoopback::default())
        // Staged-update flow: live phase + the verified, held archive bytes so
        // apply_update installs without a second network round-trip.
        .manage(UpdateManager::default());

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
        local_shell_exec,
        get_platform,
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
        list_widget_windows,
        collapse_to_moon,
        expand_from_moon,
        set_native_controls_visible,
        sync_traffic_light_position,
        dock_self,
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
        local_shell_exec,
        get_platform,
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
        list_widget_windows,
        collapse_to_moon,
        expand_from_moon,
        set_native_controls_visible,
        sync_traffic_light_position,
        dock_self
    ]);

    builder
        .setup(|app| {
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
                            (f64::from(m.position().x) / sf, f64::from(m.position().y) / sf),
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
                            // Restore each panel at its saved (clamped) rect. The
                            // welding is emergent now: each restored panel's
                            // moon-dock.js re-welds against its neighbours on its
                            // first boot geometry event, so there is no Rust-side
                            // re-link to perform here.
                            for p in doc["panels"].as_array().unwrap_or(&Vec::new()) {
                                let Some(kind) = p["kind"].as_str() else { continue };
                                let Some(desc) = registry_lookup(kind) else { continue };
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
                "CmdOrCtrl+Alt+Shift+L"
            ];
            
            let mut registered = false;
            for shortcut_str in shortcuts {
                if let Ok(shortcut) = shortcut_str.parse::<Shortcut>() {
                    let shortcut_clone = shortcut.clone();
                    let _ = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
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
        assert!(!reg.is_empty(), "bundled registry must parse (a broken JSON would silently disable every panel)");
        let upd = registry_lookup("settings.updates").expect("settings.updates registered");
        assert_eq!(upd.trust, "system");
        assert!(upd.page.starts_with("panel.html?type="), "system kinds resolve only to shipped pages");
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
            assert!(label.starts_with("panel-"), "must match the panel-* capability glob");
            assert_eq!(panel_kind_from_label(&label).as_deref(), Some(d.kind.as_str()));
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

    #[test]
    fn explicit_position_requires_both_coordinates() {
        assert!(has_explicit_position(Some(10.0), Some(20.0)));
        // A partial position is NOT honoured by the builder → counts as none,
        // so the window snaps instead of free-floating at the OS default.
        assert!(!has_explicit_position(Some(10.0), None));
        assert!(!has_explicit_position(None, Some(20.0)));
        assert!(!has_explicit_position(None, None));
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
        assert_eq!(a, b, "same id → same label (focus-if-open + restore rely on it)");
        assert!(a.starts_with("widget-"), "must match the widget-* capability glob");
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
        assert_eq!(creds["wsToken"], json!("dtok"), "returns the now-active dev creds");

        // The file on disk must now read activeProfile=dev with BOTH profiles intact.
        let after = read_connection_value().expect("file present after toggle");
        let (active, profiles) = normalize_profiles(&after);
        assert_eq!(active, "dev", "activeProfile PERSISTED to disk after toggle");
        assert!(profile_connection(&profiles, "stable").is_some(), "stable creds preserved");
        assert!(profile_connection(&profiles, "dev").is_some(), "dev creds preserved");

        // Toggle back dev -> stable; must flip on disk again with no creds lost.
        set_active_profile("stable".to_string()).expect("switch back ok");
        let back = read_connection_value().unwrap();
        let (active2, profiles2) = normalize_profiles(&back);
        assert_eq!(active2, "stable", "activeProfile flips back to stable on disk");
        assert!(profile_connection(&profiles2, "dev").is_some(), "dev creds still preserved");

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
        assert!(r.stdout.starts_with(&"a".repeat(LOCAL_SHELL_MAX_OUTPUT_BYTES)));
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
        assert!(matches!(parse_loopback_request(""), CallbackOutcome::NotRedirect));
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

