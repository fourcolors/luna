//! Staged self-update flow: check → download → verify → stage → apply.
//!
//! Split out of main.rs (moon-next split): commands + state moved verbatim,
//! only visibility (`pub(crate)`) and the one cross-module call
//! (`crate::windows::write_panel_layout`) changed so `main.rs` can still wire
//! these into `tauri::generate_handler!` and the background discovery loop.

use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// What the frontend needs to render the "update available" banner. Returned by
/// `check_for_update`; `None` means the app is already current.
#[derive(serde::Serialize)]
pub(crate) struct UpdateInfo {
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
pub(crate) struct UpdateStateDto {
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
pub(crate) struct UpdateManager(std::sync::Mutex<UpdateInner>);

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
pub(crate) async fn run_update_check(
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
pub(crate) async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    run_update_check(app, false).await
}

/// NEW. Drive the full check → download → verify → stage flow, emitting the
/// `update://*` stream. Idempotent: if an artifact is already staged, just
/// re-emit `update://ready` (a re-opened surface re-triggering download must not
/// re-fetch 28MB). On failure it emits `update://error` and returns `Err`.
#[tauri::command]
pub(crate) async fn start_update_download(app: tauri::AppHandle) -> Result<(), String> {
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
pub(crate) async fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
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
    crate::windows::write_panel_layout(&app);

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
pub(crate) fn update_state(app: tauri::AppHandle) -> UpdateStateDto {
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
pub(crate) fn take_pending_update() -> Option<serde_json::Value> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::PathBuf::from(home)
        .join(".luna")
        .join("pending-update.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    // Delete BEFORE parsing so a malformed marker is still cleared once.
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
