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

/// Ask the GitHub Releases `latest.json` whether a newer signed build exists.
/// Returns `Ok(None)` when up to date so the UI can stay silent. Network / config
/// errors come back as `Err(String)` rather than panicking the command.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            notes: update.body.clone(),
        })),
        None => Ok(None),
    }
}

/// Download + swap in the latest signed build, then relaunch into it. The
/// minisign signature is verified against `plugins.updater.pubkey` before the
/// swap. `app.restart()` never returns (it re-execs), so the trailing `Ok`
/// is only reached if no update was pending.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    // No-op progress + finish callbacks; the UI relaunches rather than showing a bar.
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
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

/// Spawn position for a panel opened FROM another window (the stacks
/// mechanic): flush at the opener's right edge, or its left edge when the
/// right would overflow the monitor. Pure for tests. Rects are logical px.
fn panel_spawn_pos(
    opener: (i32, i32, i32, i32),
    width: i32,
    monitor_right: i32,
) -> (i32, i32, &'static str) {
    let (ox, oy, ow, _oh) = opener;
    if ox + ow + width <= monitor_right {
        (ox + ow, oy, "r")
    } else {
        (ox - width, oy, "l")
    }
}

/// A caller-supplied window position is honoured only when BOTH coordinates are
/// present — the window builders apply `.position()` solely on `(Some, Some)`.
/// A partial position is therefore treated as "no position": the window snaps
/// to the cluster instead of free-floating at the OS default. Keeps the
/// snap-on-open gate in lockstep with the builder. Pure for tests.
fn has_explicit_position(x: Option<f64>, y: Option<f64>) -> bool {
    x.is_some() && y.is_some()
}

/// Bounding box (logical px) over a set of rects — the cluster perimeter a
/// freshly-opened panel appends against, so it lands flush with the WHOLE
/// stack and never overlaps a mid-cluster member. Pure for tests; None when
/// the set is empty.
fn cluster_bbox(rects: &[(i32, i32, i32, i32)]) -> Option<(i32, i32, i32, i32)> {
    let mut it = rects.iter();
    let &(fx, fy, fw, fh) = it.next()?;
    let (mut x0, mut y0, mut x1, mut y1) = (fx, fy, fx + fw, fy + fh);
    for &(x, y, w, h) in it {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + w);
        y1 = y1.max(y + h);
    }
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// Pure: the candidate whose centre is nearest `from`'s centre, with a
/// deterministic label tie-break so the snap target is stable regardless of
/// HashMap iteration order (a flickering anchor would dock the new panel to a
/// different neighbour on each open). None when there are no candidates.
fn pick_nearest_label(
    from: (i32, i32, i32, i32),
    cands: &[(String, (i32, i32, i32, i32))],
) -> Option<String> {
    let fc = (from.0 + from.2 / 2, from.1 + from.3 / 2);
    let dist2 = |r: (i32, i32, i32, i32)| -> i64 {
        let c = (r.0 + r.2 / 2, r.1 + r.3 / 2);
        i64::from(c.0 - fc.0).pow(2) + i64::from(c.1 - fc.1).pow(2)
    };
    cands
        .iter()
        .min_by(|a, b| dist2(a.1).cmp(&dist2(b.1)).then_with(|| a.0.cmp(&b.0)))
        .map(|(l, _)| l.clone())
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
    .decorations(false)
    .transparent(true)
    // No native OS shadow: the CSS card-shell halo (.widget-shell box-shadow)
    // is the single, rounded-correct, focus-independent depth cue. The OS
    // shadow follows the SQUARE window bounds and intensifies on focus, which
    // stacked a second, misaligned, focus-reactive edge on the rounded card.
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(visible)
    .inner_size(width.unwrap_or(desc.width), height.unwrap_or(desc.height))
    .min_inner_size(220.0, 120.0);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    // Return the built window so callers reveal it via the handle they already
    // hold — no re-fetch that could miss (and strand a hidden window).
    builder.build().map_err(|e| e.to_string())
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
    // pinned an explicit position, the panel accretes onto the NEAREST open
    // dock cluster — "panels open stuck together", default-on. The moon/hub is
    // never a dock member, so the first panel (opened from the gear with no
    // neighbours) still free-floats. When it WILL snap, build hidden and reveal
    // after positioning so it never flashes at the OS-default spot.
    // "Positioned" = BOTH coords (exactly what the builder honours); a partial
    // position counts as none, so the window snaps rather than free-floating.
    let will_snap = opener.is_some() || !has_explicit_position(x, y);
    let win = spawn_panel_at(&app, desc, &label, &url, x, y, None, None, !will_snap)?;
    let win_label = win.label().to_string();

    if will_snap {
        let app2 = app.clone();
        let label2 = win_label.clone();
        let width = desc.width as i32;
        let scheduled = win.run_on_main_thread(move || {
            let target = match opener {
                Some(anchor) => group_bbox_of(&app2, &anchor).map(|r| (anchor, r)),
                None => nearest_dock_anchor(&app2, &label2),
            };
            if let Some((anchor, anchor_rect)) = target {
                dock_new_panel(&app2, &label2, &anchor, anchor_rect, width);
            }
            // First paint, flush (or at the default spot when there is no cluster).
            if let Some(w) = app2.get_webview_window(&label2) {
                let _ = w.show();
            }
        });
        // Never leave the window stuck hidden if the main-thread hop can't queue.
        if scheduled.is_err() {
            let _ = win.show();
        }
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
    .decorations(false)
    .transparent(true)
    // No native OS shadow — the CSS card-shell halo is the single depth cue
    // (see spawn_panel_at above for the full rationale).
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(width.unwrap_or(360.0), height.unwrap_or(440.0))
    .min_inner_size(220.0, 160.0);
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
    // Snap-on-open: with no explicit position, the artifact / MCP-app window
    // accretes onto the nearest open dock cluster and joins its group, exactly
    // like a system panel. An explicit (x, y) — e.g. a restored pop-out — is
    // honoured as-is.
    if will_snap {
        let app2 = app.clone();
        let label2 = label.clone();
        let w = width.unwrap_or(360.0) as i32;
        let scheduled = win.run_on_main_thread(move || {
            if let Some((anchor, anchor_rect)) = nearest_dock_anchor(&app2, &label2) {
                dock_new_panel(&app2, &label2, &anchor, anchor_rect, w);
            }
            if let Some(w2) = app2.get_webview_window(&label2) {
                let _ = w2.show();
            }
        });
        if scheduled.is_err() {
            let _ = win.show();
        }
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

// ── click-through over the re-tether envelope ───────────────────────────────
//
// A transparent window is still an opaque RECTANGLE to the OS hit-tester: it
// swallows every click inside its bounds even where nothing is painted. That
// is tolerable at the collapsed 140x185, but the re-tether swing envelope
// grows the window to ~460x470 of mostly-empty space — a large invisible
// dead zone over the desktop.
//
// While the string is live the webview publishes the truly-interactive region
// (padded rects for the moon + rope/bead, in LOGICAL window-local px) via
// `set_interactive_region`. The poll loop in setup() watches the global
// cursor and flips set_ignore_cursor_events:
//   cursor inside any rect   -> interactive (immediately, so clicks land)
//   cursor outside all rects -> click-through (after a short hysteresis)
// The webview cannot do this itself: once the window ignores cursor events it
// receives NO mouse input, so it could never observe the cursor returning.
// The poll runs in pure Rust (Window::cursor_position / set_ignore_cursor_
// events), which bypasses the webview ACL — only this rect-push command needs
// a capability. With enabled=false (the default) the loop idles and the
// window behaves exactly as before this feature.

#[derive(Default)]
struct InteractiveRegion(std::sync::Mutex<RegionState>);

#[derive(Default)]
struct RegionState {
    enabled: bool,
    /// (x, y, w, h) in logical window-local px, already padded by the sender.
    rects: Vec<(f64, f64, f64, f64)>,
}

#[tauri::command]
fn set_interactive_region(
    state: tauri::State<'_, InteractiveRegion>,
    enabled: bool,
    rects: Vec<Vec<f64>>,
) -> Result<(), String> {
    // Recover from a poisoned lock instead of erroring: the state is plain data
    // (no invariant a panic could break mid-update), and the JS caller fire-and-
    // forgets this command — a failed DISABLE would silently leave the poll
    // managing click-through forever after the string is gone.
    let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
    s.enabled = enabled;
    s.rects = rects
        .into_iter()
        .filter(|r| r.len() == 4)
        .map(|r| (r[0], r[1], r[2], r[3]))
        .collect();
    Ok(())
}

// ── voice pipeline commands (feature "voice") ───────────────────────────────
//
// Thin wrappers over luna_moon_ui_lib::voice::VoiceController (managed as
// Tauri State, mirroring InteractiveRegion above). Command names, args and
// payloads follow VOICE.md exactly. All are async so a slow operation (mode
// teardown joins through an in-flight whisper inference; ~/.luna model
// download) never runs on the main thread — and async commands taking State
// must return Result (Tauri 2 constraint), hence the uniform signatures.

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
async fn voice_cancel(controller: tauri::State<'_, VoiceController>) -> Result<(), String> {
    controller.cancel();
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

// ── widget dock groups (symmetric group-drag via native child windows) ──────
//
// widget-system.md Phase 0.5 operator feedback, round 3: groups are SYMMETRIC
// and flat — no user-visible hierarchy. A group is a set of windows natively
// parented in a star under one root; dragging ANY member re-roots the star at
// the grabbed window first (`grab_dock`, fired on title-bar pointerdown), so
// the compositor always carries the whole cluster with the drag. The ONLY way
// out of a group is the pin (set_dock docked=false) — there is no drag-detach
// gesture, which is what made round 2 feel "random".
//
// On every membership change each member's page receives a `dock-group` event
// with { grouped, members, outlineSides } — outlineSides are the member's
// FREE (non-touching) sides so the pages can render a faint highlight around
// the GROUP perimeter only, never across interior seams.

#[derive(Default)]
struct DockState(std::sync::Mutex<DockGroups>);

#[derive(Default, Debug)]
struct DockGroups {
    next_id: u64,
    /// group id → flat member set + the current native root.
    groups: std::collections::HashMap<u64, DockGroup>,
    /// window label → group id.
    by_label: std::collections::HashMap<String, u64>,
}

#[derive(Default, Debug, Clone)]
struct DockGroup {
    root: String,
    members: std::collections::HashSet<String>,
}

/// A native parenting mutation: (parent, child, attach?). Applied in order on
/// the main thread. Detaches always precede attaches within one diff.
type DockDiff = Vec<(String, String, bool)>;

impl DockGroups {
    fn group_of(&self, label: &str) -> Option<&DockGroup> {
        self.by_label.get(label).and_then(|id| self.groups.get(id))
    }

    fn members_of(&self, label: &str) -> Vec<String> {
        self.group_of(label)
            .map(|g| g.members.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Link `child` with `anchor` (settle-snap landed flush). Returns the
    /// parenting diff. Handles every membership combination; linking two
    /// windows already in the same group is a no-op.
    fn join(&mut self, child: &str, anchor: &str) -> DockDiff {
        if child == anchor {
            return Vec::new();
        }
        let cg = self.by_label.get(child).copied();
        let ag = self.by_label.get(anchor).copied();
        match (cg, ag) {
            (Some(c), Some(a)) if c == a => Vec::new(),
            (None, None) => {
                let id = self.next_id;
                self.next_id += 1;
                let mut members = std::collections::HashSet::new();
                members.insert(child.to_string());
                members.insert(anchor.to_string());
                self.groups.insert(
                    id,
                    DockGroup { root: anchor.to_string(), members },
                );
                self.by_label.insert(child.to_string(), id);
                self.by_label.insert(anchor.to_string(), id);
                vec![(anchor.to_string(), child.to_string(), true)]
            }
            (None, Some(a)) => {
                let g = self.groups.get_mut(&a).expect("group exists");
                g.members.insert(child.to_string());
                let root = g.root.clone();
                self.by_label.insert(child.to_string(), a);
                vec![(root, child.to_string(), true)]
            }
            (Some(c), None) => {
                let g = self.groups.get_mut(&c).expect("group exists");
                g.members.insert(anchor.to_string());
                let root = g.root.clone();
                self.by_label.insert(anchor.to_string(), c);
                vec![(root, anchor.to_string(), true)]
            }
            (Some(c), Some(a)) => {
                // Merge: child's whole group re-parents under anchor's root.
                let moved = self.groups.remove(&c).expect("group exists");
                let target = self.groups.get_mut(&a).expect("group exists");
                let target_root = target.root.clone();
                let mut diff: DockDiff = Vec::new();
                for m in &moved.members {
                    if *m != moved.root {
                        diff.push((moved.root.clone(), m.clone(), false));
                    }
                }
                for m in &moved.members {
                    target.members.insert(m.clone());
                    self.by_label.insert(m.clone(), a);
                    diff.push((target_root.clone(), m.clone(), true));
                }
                diff
            }
        }
    }

    /// Re-root `label`'s group at `label` (called on grab, before the native
    /// drag carries the cluster). No-op when ungrouped or already root.
    fn reroot(&mut self, label: &str) -> DockDiff {
        let Some(&id) = self.by_label.get(label) else {
            return Vec::new();
        };
        let g = self.groups.get_mut(&id).expect("group exists");
        if g.root == label {
            return Vec::new();
        }
        let old_root = std::mem::replace(&mut g.root, label.to_string());
        let mut diff: DockDiff = Vec::new();
        for m in &g.members {
            if *m != old_root {
                diff.push((old_root.clone(), m.clone(), false));
            }
        }
        for m in &g.members {
            if *m != label {
                diff.push((label.to_string(), m.clone(), true));
            }
        }
        diff
    }

    /// Remove `label` from its group (pin click, or window destroyed).
    /// Returns (diff, departed members) — a 2-member group dissolves
    /// entirely, freeing both. `gone=true` skips native ops involving the
    /// label itself (its window is already destroyed).
    fn leave(&mut self, label: &str, gone: bool) -> (DockDiff, Vec<String>) {
        let Some(&id) = self.by_label.get(label) else {
            return (Vec::new(), Vec::new());
        };
        let g = self.groups.get_mut(&id).expect("group exists");
        g.members.remove(label);
        self.by_label.remove(label);
        let was_root = g.root == label;
        let mut diff: DockDiff = Vec::new();
        let mut departed = vec![label.to_string()];

        if !was_root && !gone {
            diff.push((g.root.clone(), label.to_string(), false));
        }
        if was_root {
            // Detach the orphans from the dead/leaving root...
            for m in g.members.clone() {
                if !gone {
                    diff.push((label.to_string(), m.clone(), false));
                }
            }
            // ...and re-form the star under a surviving member.
            if let Some(new_root) = g.members.iter().min().cloned() {
                g.root = new_root.clone();
                for m in g.members.clone() {
                    if m != new_root {
                        diff.push((new_root.clone(), m, true));
                    }
                }
            }
        }
        // A group of one is no group.
        if g.members.len() <= 1 {
            let last = g.members.iter().next().cloned();
            if let Some(last) = last {
                if !was_root && !gone {
                    // label was a plain member; the survivor may still be
                    // parented if it wasn't the root — it is the root here
                    // (star of 2), so nothing to detach.
                }
                self.by_label.remove(&last);
                departed.push(last);
            }
            self.groups.remove(&id);
        }
        (diff, departed)
    }

    /// Re-partition the group containing `member` by actual geometry: pieces
    /// that no longer touch split into separate groups; singletons dissolve.
    /// Survivor groups keep working natives via fresh detach/attach diffs.
    /// Returns (diff, all labels whose state may have changed).
    fn regroup_by_geometry(
        &mut self,
        member: &str,
        rects: &[(String, (i32, i32, i32, i32))],
    ) -> (DockDiff, Vec<String>) {
        let Some(&id) = self.by_label.get(member) else {
            return (Vec::new(), Vec::new());
        };
        let comps = dock_components(rects);
        if comps.len() <= 1 {
            return (Vec::new(), Vec::new());
        }
        let old = self.groups.remove(&id).expect("group exists");
        let mut diff: DockDiff = Vec::new();
        let mut touched: Vec<String> = Vec::new();
        // Tear the old star down completely…
        for m in &old.members {
            self.by_label.remove(m);
            touched.push(m.clone());
            if *m != old.root {
                diff.push((old.root.clone(), m.clone(), false));
            }
        }
        // …and re-star each connected component (singletons stay free).
        for comp in comps {
            if comp.len() < 2 {
                continue;
            }
            let root = comp.iter().min().cloned().expect("non-empty");
            let gid = self.next_id;
            self.next_id += 1;
            let mut members = std::collections::HashSet::new();
            for m in &comp {
                members.insert(m.clone());
                self.by_label.insert(m.clone(), gid);
                if *m != root {
                    diff.push((root.clone(), m.clone(), true));
                }
            }
            self.groups.insert(gid, DockGroup { root, members });
        }
        (diff, touched)
    }

    /// Form fresh groups from geometry among CURRENTLY-UNGROUPED labels — the
    /// boot-restore re-link. Each connected component of ≥2 touching rects
    /// becomes a star over the SAME MEMBERS it had before the restart, rooted at
    /// the min label (the rooting `regroup_by_geometry` uses). The root is only
    /// the native parent, so a different root than the original runtime group
    /// (which roots at whichever member was snapped to) is behaviourally
    /// identical: same members, same drag-as-a-unit. A component touching any
    /// already-grouped label is skipped, keeping this idempotent and safe over a
    /// partially grouped state. Returns the attach diff + every label whose
    /// membership changed (to notify).
    fn form_groups_by_geometry(
        &mut self,
        rects: &[(String, (i32, i32, i32, i32))],
    ) -> (DockDiff, Vec<String>) {
        let mut diff: DockDiff = Vec::new();
        let mut touched: Vec<String> = Vec::new();
        for comp in dock_components(rects) {
            if comp.len() < 2 {
                continue; // a lone panel stays free — no group of one
            }
            if comp.iter().any(|m| self.by_label.contains_key(m)) {
                continue; // never disturb a label that is already grouped
            }
            let root = comp.iter().min().cloned().expect("non-empty component");
            let gid = self.next_id;
            self.next_id += 1;
            let mut members = std::collections::HashSet::new();
            for m in &comp {
                members.insert(m.clone());
                self.by_label.insert(m.clone(), gid);
                touched.push(m.clone());
                if *m != root {
                    diff.push((root.clone(), m.clone(), true));
                }
            }
            self.groups.insert(gid, DockGroup { root, members });
        }
        (diff, touched)
    }
}

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

/// Is rect `a` within `t` px of a snapable seam against `b` (same candidate
/// geometry as deck-snap.js computeSnap)? Used to validate eject clearance.
fn dock_in_magnet(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32), t: i32) -> bool {
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    let (al, at_, ar, ab) = (ax, ay, ax + aw, ay + ah);
    let (bl, bt, br, bb) = (bx, by, bx + bw, by + bh);
    let v_overlap = at_ < bb && ab > bt;
    let h_overlap = al < br && ar > bl;
    (v_overlap && ((al - br).abs() <= t || (ar - bl).abs() <= t))
        || (h_overlap && ((at_ - bb).abs() <= t || (ab - bt).abs() <= t))
}

/// Do two rects intersect?
fn dock_rects_overlap(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

/// Pick an eject vector (logical px) that lands the leaver clear of every
/// other dock window's MAGNET, not just its body. The ex-member cooldown
/// only shields the group the leaver just left — a bystander's magnet has
/// no cooldown, and the eject's own setPosition fires onMoved, so landing
/// flush with one re-links instantly (live-observed: an unpin stepped a
/// panel straight onto a third window's seam). When the screen is too
/// crowded for a fully-clear spot, settle for overlap-free — the cooldown
/// covers the seams that can survive that. Prefers the axis pointing away
/// from the crowd centroid.
fn dock_eject_vector(
    leaver: (i32, i32, i32, i32),
    others: &[(i32, i32, i32, i32)],
) -> (i32, i32) {
    const STEP: i32 = 36;
    let (lx, ly, lw, lh) = leaver;
    let (lcx, lcy) = (i64::from(lx) + i64::from(lw) / 2, i64::from(ly) + i64::from(lh) / 2);
    let (mut cx, mut cy, mut n) = (0i64, 0i64, 0i64);
    for (ox, oy, ow, oh) in others {
        cx += i64::from(*ox) + i64::from(*ow) / 2;
        cy += i64::from(*oy) + i64::from(*oh) / 2;
        n += 1;
    }
    let (sx, sy) = if n == 0 {
        (1, 0)
    } else {
        (
            if lcx >= cx / n { 1 } else { -1 },
            if lcy >= cy / n { 1 } else { -1 },
        )
    };
    // Same threshold as deck-snap.js computeSnap — keep them in lockstep.
    const MAGNET: i32 = 22;
    let candidates = [
        (STEP * sx, 0),
        (0, STEP * sy),
        (STEP * sx, STEP * sy),
        (-STEP * sx, 0),
        (0, -STEP * sy),
        (2 * STEP * sx, 0),
        (0, 2 * STEP * sy),
        (2 * STEP * sx, 2 * STEP * sy),
        (3 * STEP * sx, 0),
        (0, 3 * STEP * sy),
        (3 * STEP * sx, 3 * STEP * sy),
    ];
    for (dx, dy) in candidates {
        let moved = (lx + dx, ly + dy, lw, lh);
        if others
            .iter()
            .all(|o| !dock_rects_overlap(moved, *o) && !dock_in_magnet(moved, *o, MAGNET))
        {
            return (dx, dy);
        }
    }
    // No magnet-free spot in ladder range: fall back to overlap-free only.
    for (dx, dy) in candidates {
        let moved = (lx + dx, ly + dy, lw, lh);
        if others.iter().all(|o| !dock_rects_overlap(moved, *o)) {
            return (dx, dy);
        }
    }
    (STEP * sx, STEP * sy) // give up gracefully: diagonal shove
}

/// Two rects touch when an edge pair sits flush (≤2 px) with real
/// perpendicular overlap — the shared predicate for the perimeter outline
/// and geometric regrouping.
fn dock_rects_touch(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    const EPS: i32 = 2;
    const MIN_OVERLAP: i32 = 8;
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    let (al, at, ar, ab) = (ax, ay, ax + aw, ay + ah);
    let (bl, bt, br, bb) = (bx, by, bx + bw, by + bh);
    let v_overlap = (ab.min(bb) - at.max(bt)) >= MIN_OVERLAP;
    let h_overlap = (ar.min(br) - al.max(bl)) >= MIN_OVERLAP;
    (v_overlap && ((al - br).abs() <= EPS || (ar - bl).abs() <= EPS))
        || (h_overlap && ((at - bb).abs() <= EPS || (ab - bt).abs() <= EPS))
}

/// Split a member list into geometry-connected components (flood fill over
/// the touch predicate). Pure.
fn dock_components(
    rects: &[(String, (i32, i32, i32, i32))],
) -> Vec<Vec<String>> {
    let n = rects.len();
    let mut seen = vec![false; n];
    let mut out = Vec::new();
    for start in 0..n {
        if seen[start] {
            continue;
        }
        let mut comp = Vec::new();
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(i) = stack.pop() {
            comp.push(rects[i].0.clone());
            for j in 0..n {
                if !seen[j] && dock_rects_touch(rects[i].1, rects[j].1) {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
        out.push(comp);
    }
    out
}

/// Which sides of each member face OUT of the group? A side is interior when
/// it sits flush (≤2 px) against another member with real perpendicular
/// overlap. Pure geometry — drives the perimeter highlight.
fn dock_outline_sides(
    rects: &[(String, (i32, i32, i32, i32))], // (label, (x, y, w, h))
) -> std::collections::HashMap<String, Vec<&'static str>> {
    const EPS: i32 = 2;
    const MIN_OVERLAP: i32 = 8;
    let mut out = std::collections::HashMap::new();
    for (label, (x, y, w, h)) in rects {
        let (l, t, r, b) = (*x, *y, x + w, y + h);
        let mut sides: Vec<&'static str> = Vec::new();
        let mut touched = (false, false, false, false); // l r t b
        for (other, (ox, oy, ow, oh)) in rects {
            if other == label {
                continue;
            }
            let (ol, ot, or_, ob) = (*ox, *oy, ox + ow, oy + oh);
            let v_overlap = (b.min(ob) - t.max(ot)) >= MIN_OVERLAP;
            let h_overlap = (r.min(or_) - l.max(ol)) >= MIN_OVERLAP;
            if v_overlap && (l - or_).abs() <= EPS {
                touched.0 = true;
            }
            if v_overlap && (r - ol).abs() <= EPS {
                touched.1 = true;
            }
            if h_overlap && (t - ob).abs() <= EPS {
                touched.2 = true;
            }
            if h_overlap && (b - ot).abs() <= EPS {
                touched.3 = true;
            }
        }
        if !touched.0 {
            sides.push("l");
        }
        if !touched.1 {
            sides.push("r");
        }
        if !touched.2 {
            sides.push("t");
        }
        if !touched.3 {
            sides.push("b");
        }
        out.insert(label.clone(), sides);
    }
    out
}

/// One interior dock seam, from the OWNING window's point of view: the badge
/// sits on this window's `edge` ("r"|"b"), centered at (`x`, `y`) in the
/// window's LOCAL logical px. Serialized into the `dock-group` payload; the
/// page just renders it (no client-side geometry fan-out).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
struct DockSeam {
    partner: String,
    edge: &'static str,
    x: i32,
    y: i32,
}

/// Per member, the dock seams it OWNS — the interior edges on its RIGHT/BOTTOM
/// where a flush, overlapping neighbor sits. Checking ONLY right/bottom means
/// every seam is reported by exactly one member (the left/top window), so the
/// page draws one chain-link badge per seam with no cross-window dedup. (x, y)
/// is the badge CENTER in the owner's LOCAL logical px, clamped 11px (badge
/// radius) inside so the 22px badge stays on-window. Same EPS / MIN_OVERLAP as
/// dock_rects_touch / dock_outline_sides → the badge appears for exactly the
/// seams Rust counts as touching. The single source of truth for badge
/// placement (the page-side computeSeams port is retired).
fn dock_seams(
    rects: &[(String, (i32, i32, i32, i32))], // (label, (x, y, w, h))
) -> std::collections::HashMap<String, Vec<DockSeam>> {
    const EPS: i32 = 2;
    const MIN_OVERLAP: i32 = 8;
    const BADGE_R: i32 = 11;
    // Safe clamp: i32::clamp panics when min > max (degenerate/minimized rects),
    // so floor the upper bound at BADGE_R.
    let clamp = |v: i32, hi: i32| v.clamp(BADGE_R, hi.max(BADGE_R));
    let mut out = std::collections::HashMap::new();
    for (label, (x, y, w, h)) in rects {
        let (l, t, r, b) = (*x, *y, x + w, y + h);
        let mut seams: Vec<DockSeam> = Vec::new();
        for (other, (ox, oy, ow, oh)) in rects {
            // Never self, and never the hub: the moon is alignment-only and is
            // never truly linked, so it gets no seam badge. Defense-in-depth —
            // the hub is never a group member (is_dock_label gates every join),
            // but keep the guard the page-side render used to carry.
            if other == label || other == "main" {
                continue;
            }
            let (ol, ot, or_, ob) = (*ox, *oy, ox + ow, oy + oh);
            // RIGHT seam: we are the LEFT window (our right edge flush to other's left).
            let v_overlap = b.min(ob) - t.max(ot);
            if (r - ol).abs() <= EPS && v_overlap >= MIN_OVERLAP {
                let mid_y = (t.max(ot) + b.min(ob)) / 2 - t;
                seams.push(DockSeam {
                    partner: other.clone(),
                    edge: "r",
                    x: w - BADGE_R,
                    y: clamp(mid_y, h - BADGE_R),
                });
                continue; // a non-overlapping partner can be flush on only one side
            }
            // BOTTOM seam: we are the TOP window (our bottom edge flush to other's top).
            let h_overlap = r.min(or_) - l.max(ol);
            if (b - ot).abs() <= EPS && h_overlap >= MIN_OVERLAP {
                let mid_x = (l.max(ol) + r.min(or_)) / 2 - l;
                seams.push(DockSeam {
                    partner: other.clone(),
                    edge: "b",
                    x: clamp(mid_x, w - BADGE_R),
                    y: h - BADGE_R,
                });
            }
        }
        out.insert(label.clone(), seams);
    }
    out
}

/// Native half: parent/unparent via AppKit. MUST run on the main thread.
/// NSWindowAbove = 1 — the child orders above its parent, which matches the
/// accepted always-on-top stacking (PRD §23).
#[cfg(target_os = "macos")]
fn ns_set_child(parent: &tauri::WebviewWindow, child: &tauri::WebviewWindow, attach: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let (Ok(p), Ok(c)) = (parent.ns_window(), child.ns_window()) else {
        return;
    };
    let p = p as *mut AnyObject;
    let c = c as *mut AnyObject;
    if p.is_null() || c.is_null() {
        return;
    }
    unsafe {
        if attach {
            let _: () = msg_send![&*p, addChildWindow: &*c, ordered: 1isize];
        } else {
            let _: () = msg_send![&*p, removeChildWindow: &*c];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn ns_set_child(_parent: &tauri::WebviewWindow, _child: &tauri::WebviewWindow, _attach: bool) {}

/// Is the PRIMARY mouse button currently held? The dock settle uses this to
/// make snap-on-release literal: macOS streams `Moved` events DURING a drag
/// (the old drag-end-only claim was wrong for these windows), so a hover-
/// pause over a neighbor used to satisfy the settle debounce and link a
/// group mid-drag — under the user's hand. The webview cannot track this
/// itself: the native drag loop swallows pointermove/pointerup, so JS asks
/// AppKit. Global state, no window access needed; safe from any thread.
#[tauri::command]
fn pointer_button_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::{class, msg_send};
        // +[NSEvent pressedMouseButtons]: bit 0 = primary button.
        let pressed: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
        pressed & 1 != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        false // fail-open: behaves like the pre-gate settle
    }
}

/// Apply a parenting diff + push fresh `dock-group` state to every window
/// whose membership might have changed. Main thread only.
fn dock_apply_and_notify(
    app: &tauri::AppHandle,
    diff: DockDiff,
    notify: Vec<String>,
) {
    for (parent, child, attach) in diff {
        if let (Some(p), Some(c)) = (
            app.get_webview_window(&parent),
            app.get_webview_window(&child),
        ) {
            ns_set_child(&p, &c, attach);
        }
    }
    let state = app.state::<DockState>();
    let s = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for label in notify {
        let members = s.members_of(&label);
        let payload = if members.is_empty() {
            serde_json::json!({ "for": label, "grouped": false, "members": [], "outlineSides": [] })
        } else {
            let rects: Vec<(String, (i32, i32, i32, i32))> = members
                .iter()
                .filter_map(|m| {
                    let w = app.get_webview_window(m)?;
                    Some((m.clone(), dock_logical_rect(&w)?))
                })
                .collect();
            let outline = dock_outline_sides(&rects);
            let seams = dock_seams(&rects);
            serde_json::json!({
                "for": label,
                "grouped": true,
                "members": members,
                "outlineSides": outline.get(&label).cloned().unwrap_or_default(),
                // The owned seam badges, placed by Rust (single source of truth);
                // the page renders them directly, no geometry fan-out.
                "seams": seams.get(&label).cloned().unwrap_or_default(),
            })
        };
        let _ = app.emit_to(tauri::EventTarget::labeled(&label), "dock-group", payload);
    }
}

/// Group bounding box for `label` (logical px): the union of every member's
/// rect, or `label`'s own rect when it is ungrouped. None when no member has a
/// readable rect (e.g. minimized). Main thread (reads window geometry).
fn group_bbox_of(app: &tauri::AppHandle, label: &str) -> Option<(i32, i32, i32, i32)> {
    let members = {
        let state = app.state::<DockState>();
        let s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let m = s.members_of(label);
        if m.is_empty() {
            vec![label.to_string()]
        } else {
            m
        }
    };
    let rects: Vec<(i32, i32, i32, i32)> = members
        .iter()
        .filter_map(|m| app.get_webview_window(m).and_then(|w| dock_logical_rect(&w)))
        .collect();
    cluster_bbox(&rects)
}

/// The open dock cluster nearest `new_label` (excluding the hub and the new
/// window itself), as `(a member label to join, the cluster's bounding box)`.
/// This is the snap-on-open target: a freshly-spawned panel accretes onto the
/// existing stack instead of free-floating. None when nothing dockable is
/// open (the first panel free-floats — there is no stack yet). Main thread.
fn nearest_dock_anchor(
    app: &tauri::AppHandle,
    new_label: &str,
) -> Option<(String, (i32, i32, i32, i32))> {
    let new_rect = app
        .get_webview_window(new_label)
        .and_then(|w| dock_logical_rect(&w))?;
    let cands: Vec<(String, (i32, i32, i32, i32))> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.as_str() != new_label && is_dock_label(label))
        // Never snap to a window the user can't see: a minimized panel keeps
        // stale pre-minimize coordinates, so snapping to it would tile the new
        // panel onto empty space and join it to an invisible group. (A window
        // built hidden mid-snap is likewise skipped until it reveals.)
        .filter(|(_, win)| {
            win.is_minimized().map(|m| !m).unwrap_or(true) && win.is_visible().unwrap_or(true)
        })
        .filter_map(|(label, win)| dock_logical_rect(&win).map(|r| (label, r)))
        .collect();
    let anchor = pick_nearest_label(new_rect, &cands)?;
    let bbox = group_bbox_of(app, &anchor)?;
    Some((anchor, bbox))
}

/// Place a freshly-spawned panel flush against an existing dock cluster and
/// join its group — the open-time twin of a settle-snap. `anchor_rect` is the
/// cluster bounding box; `anchor_label` is any member (join re-parents under
/// the group root). Mirrors the settle path: glide flush, join, flash the
/// seam. Best-effort; main thread.
fn dock_new_panel(
    app: &tauri::AppHandle,
    new_label: &str,
    anchor_label: &str,
    anchor_rect: (i32, i32, i32, i32),
    width: i32,
) {
    let monitor_right = app
        .get_webview_window(anchor_label)
        .and_then(|aw| aw.current_monitor().ok().flatten())
        .map(|m| {
            let sf = m.scale_factor();
            ((f64::from(m.position().x) + m.size().width as f64) / sf) as i32
        })
        .unwrap_or(i32::MAX);
    let (px, py, edge) = panel_spawn_pos(anchor_rect, width, monitor_right);
    if let Some(w) = app.get_webview_window(new_label) {
        let _ = w.set_position(tauri::LogicalPosition::new(f64::from(px), f64::from(py)));
    }
    // Join exactly as a settle-snap would, then notify the cluster.
    let (diff, notify) = {
        let state = app.state::<DockState>();
        let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let diff = s.join(new_label, anchor_label);
        (diff, s.members_of(new_label))
    };
    dock_apply_and_notify(app, diff, notify);
    let _ = app.emit_to(
        tauri::EventTarget::labeled(anchor_label),
        "dock-link",
        serde_json::json!({ "for": anchor_label, "from": new_label, "edge": edge }),
    );
}

/// After a member departs, re-partition its old group by geometry and apply
/// the native changes. Survivors that no longer touch split into separate
/// groups; singletons dissolve. Returns every label whose state changed.
/// MUST run on the main thread.
fn dock_regroup_after_leave(app: &tauri::AppHandle, survivors: &[String]) -> Vec<String> {
    if survivors.len() < 2 {
        return Vec::new();
    }
    let rects: Vec<(String, (i32, i32, i32, i32))> = survivors
        .iter()
        .filter_map(|m| {
            let w = app.get_webview_window(m)?;
            Some((m.clone(), dock_logical_rect(&w)?))
        })
        .collect();
    let (diff, touched) = {
        let state = app.state::<DockState>();
        let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(seed) = survivors.first() else {
            return Vec::new();
        };
        s.regroup_by_geometry(seed, &rects)
    };
    for (parent, child, attach) in diff {
        if let (Some(p), Some(c)) = (
            app.get_webview_window(&parent),
            app.get_webview_window(&child),
        ) {
            ns_set_child(&p, &c, attach);
        }
    }
    touched
}

/// widget.html calls this after a settle-snap lands flush on `anchor`
/// (docked=true) or from the pin (docked=false → leave the group; the window
/// is ejected past the magnet range of every former neighbor). For a GROUPED
/// caller reporting a merge, (dx, dy) is the snap delta in logical px and the
/// caller's whole group is translated so the seam lands flush — individual
/// members never move themselves (that would tear the cluster).
#[tauri::command]
fn set_dock(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DockState>,
    docked: bool,
    anchor: Option<String>,
    edge: Option<String>,
    dx: Option<i32>,
    dy: Option<i32>,
) -> Result<(), String> {
    let label = window.label().to_string();
    if label == "main" {
        return Err("the hub reports no docks of its own".into());
    }
    let app = window.app_handle().clone();

    if docked {
        let anchor = anchor.ok_or_else(|| "anchor required when docking".to_string())?;
        if anchor == "main" {
            // The hub is alignment-only — widget groups never include it, so
            // dragging widgets can never tow the moon around.
            return Err("the hub is not a dockable anchor".into());
        }
        if !is_dock_label(&anchor) {
            // Anchor strings come straight from page JS — keep the dock
            // graph inside the widget-family namespace (widget-* content
            // windows + panel-* system windows; never the hub).
            return Err(format!("anchor outside the widget namespace: {anchor}"));
        }
        if app.get_webview_window(&anchor).is_none() {
            return Err(format!("unknown anchor window: {anchor}"));
        }
        let (diff, notify, group_translate) = {
            let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
            // Same-group re-affirm: nothing to do.
            if s.group_of(&label).is_some()
                && s.by_label.get(&label) == s.by_label.get(&anchor)
            {
                return Ok(());
            }
            // A grouped caller merging into an outsider: translate its whole
            // CURRENT group by the snap delta first (collected before join
            // rewires membership).
            let translate: Vec<String> = if s.group_of(&label).is_some() {
                s.members_of(&label)
            } else {
                Vec::new()
            };
            let diff = s.join(&label, &anchor);
            (diff, s.members_of(&label), translate)
        };
        let (tdx, tdy) = (dx.unwrap_or(0), dy.unwrap_or(0));
        let flash_anchor = anchor.clone();
        let edge = edge.unwrap_or_default();
        window
            .run_on_main_thread(move || {
                if (tdx != 0 || tdy != 0) && !group_translate.is_empty() {
                    for m in &group_translate {
                        if let Some(w) = app.get_webview_window(m) {
                            if let Some((x, y, _, _)) = dock_logical_rect(&w) {
                                let _ = w.set_position(tauri::LogicalPosition::new(
                                    f64::from(x + tdx),
                                    f64::from(y + tdy),
                                ));
                            }
                        }
                    }
                }
                dock_apply_and_notify(&app, diff, notify);
                // Tell the anchor's page to flash its side of the seam.
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(&flash_anchor),
                    "dock-link",
                    serde_json::json!({ "for": flash_anchor, "from": label, "edge": edge }),
                );
            })
            .map_err(|e| e.to_string())
    } else {
        let (diff, departed, remaining) = {
            let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
            let remaining_before = s.members_of(&label);
            let (diff, departed) = s.leave(&label, false);
            let remaining: Vec<String> = remaining_before
                .into_iter()
                .filter(|m| m != &label)
                .collect();
            (diff, departed, remaining)
        };
        if departed.is_empty() {
            // Not in any group (double-click, stale pin) — nothing to do,
            // and definitely no eject of an innocent loose window.
            return Ok(());
        }
        window
            .run_on_main_thread(move || {
                // ORDER MATTERS: detach natives FIRST (an ejected window that
                // still parents survivors would tow them), then eject the
                // now-loose leaver to a spot that clears EVERY dock window's
                // magnet — bystanders included, they have no cooldown — then
                // regroup survivors by geometry and notify everyone with the
                // final state. The hub is deliberately NOT an obstacle:
                // panels float over the moon in normal layouts, so counting
                // it can make every ladder spot "occupied" (live-observed);
                // the worst a hub-adjacent landing causes is an alignment
                // glide, never a link.
                dock_apply_and_notify(&app, diff, Vec::new());
                if let Some(w) = app.get_webview_window(&label) {
                    if let Some(leaver) = dock_logical_rect(&w) {
                        let others: Vec<(i32, i32, i32, i32)> = app
                            .webview_windows()
                            .iter()
                            .filter(|(l, _)| l.as_str() != label && is_dock_label(l))
                            .filter_map(|(_, mw)| dock_logical_rect(mw))
                            .collect();
                        let (ex, ey) = dock_eject_vector(leaver, &others);
                        let _ = w.set_position(tauri::LogicalPosition::new(
                            f64::from(leaver.0 + ex),
                            f64::from(leaver.1 + ey),
                        ));
                    }
                }
                let touched = dock_regroup_after_leave(&app, &remaining);
                // The leaver gets its grouped:false payload with exMembers so
                // its settle ignores the old group briefly (no instant
                // re-link off a surviving flush seam); everyone else gets the
                // generic final state.
                let _ = app.emit_to(
                    tauri::EventTarget::labeled(&label),
                    "dock-group",
                    serde_json::json!({
                        "for": label,
                        "grouped": false,
                        "members": [],
                        "outlineSides": [],
                        "exMembers": remaining,
                    }),
                );
                let mut notify: Vec<String> = departed
                    .into_iter()
                    .filter(|d| d != &label)
                    .collect();
                for m in remaining.into_iter().chain(touched) {
                    if !notify.contains(&m) {
                        notify.push(m);
                    }
                }
                dock_apply_and_notify(&app, Vec::new(), notify);
            })
            .map_err(|e| e.to_string())
    }
}

/// Fired on title-bar pointerdown, BEFORE the native drag session: re-root
/// the grabbed window's group at the grabbed window, so the compositor
/// carries the whole cluster no matter which member the user drags.
#[tauri::command]
fn grab_dock(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DockState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    let diff = {
        let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        s.reroot(&label)
    };
    if diff.is_empty() {
        return Ok(());
    }
    window
        .run_on_main_thread(move || {
            dock_apply_and_notify(&app, diff, Vec::new());
        })
        .map_err(|e| e.to_string())
}

/// Replay-on-subscribe for dock membership. A panel/widget webview calls this
/// once right after wiring its dock listeners, so a window whose `dock-group`
/// event fired BEFORE its webview finished loading (e.g. a boot-restored
/// cluster — the setup() emit races the page load) still learns it is grouped.
/// Returns the membership half of the `dock-group` payload; the perimeter
/// outline is omitted (cosmetic, and it refreshes on the next real event) so
/// this stays a pure DockState read with no off-thread window geometry.
#[tauri::command]
fn dock_group_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DockState>,
) -> serde_json::Value {
    let label = window.label().to_string();
    let members = {
        let s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        s.members_of(&label)
    };
    // The sync reply is geometry-free (membership only) — enough for pin state.
    // Seams + perimeter outline need window rects, so for a grouped window we
    // schedule a full `dock-group` re-emit on the main thread; the page then
    // paints its badges on boot instead of staying badge-less until the first
    // move. Best-effort: a failed schedule just leaves the next real event to
    // refresh us.
    if !members.is_empty() {
        let app = window.app_handle().clone();
        let l = label.clone();
        let _ = window.run_on_main_thread(move || {
            dock_apply_and_notify(&app, Vec::new(), vec![l]);
        });
    }
    serde_json::json!({
        "for": label,
        "grouped": !members.is_empty(),
        "members": members,
        "outlineSides": [],
    })
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
            // A docked window's RESIZE changes the shared overlap span (so the
            // seam-badge midpoints move, and a seam can fall below MIN_OVERLAP),
            // but a Move carries the rigid cluster so relative geometry is
            // unchanged. Re-notify the whole group on Resized so every member
            // repaints its seams with fresh geometry — the ONLY path that
            // catches a NON-owner partner's resize (the owner's own onResized
            // never fires for it). Main-thread handler, so the geometry read +
            // emit inside dock_apply_and_notify are safe.
            if matches!(event, tauri::WindowEvent::Resized(_))
                && is_dock_label(window.label())
                && window.app_handle().get_webview_window("main").is_some()
            {
                let app = window.app_handle();
                let members = {
                    let state = app.state::<DockState>();
                    let s = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    s.members_of(window.label())
                };
                if !members.is_empty() {
                    dock_apply_and_notify(app, Vec::new(), members);
                }
            }
            // Detach dock edges the moment a close is REQUESTED — before the
            // window dies. Closing a native parent takes its attached
            // children down with it (AppKit cascade), so a grouped root's ✕
            // used to close the whole cluster instead of just itself.
            // close() always emits CloseRequested first; the Destroyed arm
            // below stays as the safety net for destroy() paths.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let (diff, survivors) = {
                    let state = app.state::<DockState>();
                    let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    let before = s.members_of(window.label());
                    let (diff, _departed) = s.leave(window.label(), false);
                    let survivors: Vec<String> = before
                        .into_iter()
                        .filter(|m| m != window.label())
                        .collect();
                    (diff, survivors)
                };
                dock_apply_and_notify(&app, diff, Vec::new());
                let touched = dock_regroup_after_leave(&app, &survivors);
                let mut notify = survivors;
                for t in touched {
                    if !notify.contains(&t) {
                        notify.push(t);
                    }
                }
                dock_apply_and_notify(&app, Vec::new(), notify);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle();
                // Dock hygiene: the dead window leaves its group. Survivors
                // are re-shown (AppKit cascades orderOut to children of a
                // dying parent) and get fresh dock-group state. This handler
                // runs on the main thread, so native ops are direct.
                let (diff, survivors) = {
                    let state = app.state::<DockState>();
                    let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    let before = s.members_of(window.label());
                    let (diff, _departed) = s.leave(window.label(), true);
                    let survivors: Vec<String> = before
                        .into_iter()
                        .filter(|m| m != window.label())
                        .collect();
                    (diff, survivors)
                };
                for m in &survivors {
                    if let Some(w) = app.get_webview_window(m) {
                        let _ = w.show();
                    }
                }
                dock_apply_and_notify(&app, diff, Vec::new());
                let touched = dock_regroup_after_leave(&app, &survivors);
                let mut notify = survivors;
                for t in touched {
                    if !notify.contains(&t) {
                        notify.push(t);
                    }
                }
                dock_apply_and_notify(&app, Vec::new(), notify);
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
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // PRD A §09: open the system browser for the connector OAuth hop.
        .plugin(tauri_plugin_opener::init())
        .manage(InteractiveRegion::default())
        // Widget dock graph for group-drag (set_dock + native child windows).
        .manage(DockState::default())
        // PRD A §09: the client-brokered OAuth loopback state.
        .manage(OauthLoopback::default());

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
        set_interactive_region,
        local_shell_exec,
        get_platform,
        check_for_update,
        install_update,
        oauth_loopback_start,
        oauth_loopback_wait,
        oauth_loopback_cancel,
        open_external_url,
        open_artifact_widget,
        open_widget,
        hub_event,
        close_widget,
        list_widget_windows,
        set_dock,
        grab_dock,
        dock_group_state,
        pointer_button_down,
        voice_status,
        voice_set_mode,
        voice_ptt_down,
        voice_ptt_up,
        voice_cancel,
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
        set_interactive_region,
        local_shell_exec,
        get_platform,
        check_for_update,
        install_update,
        oauth_loopback_start,
        oauth_loopback_wait,
        oauth_loopback_cancel,
        open_external_url,
        open_artifact_widget,
        open_widget,
        hub_event,
        close_widget,
        list_widget_windows,
        set_dock,
        grab_dock,
        dock_group_state,
        pointer_button_down
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
                            // Restore each panel, remembering its label + final
                            // (clamped) logical rect so docked neighbours can be
                            // re-linked once every panel is spawned.
                            let mut restored: Vec<(String, (i32, i32, i32, i32))> = Vec::new();
                            for p in doc["panels"].as_array().unwrap_or(&Vec::new()) {
                                let Some(kind) = p["kind"].as_str() else { continue };
                                let Some(desc) = registry_lookup(kind) else { continue };
                                let (x, y) = clamp_to_monitors(
                                    p["x"].as_f64().unwrap_or(180.0),
                                    p["y"].as_f64().unwrap_or(160.0),
                                );
                                let w = p["w"].as_f64().filter(|v| *v >= 220.0);
                                let h = p["h"].as_f64().filter(|v| *v >= 120.0);
                                if spawn_panel(&handle, desc, Some(x), Some(y), w, h).is_ok() {
                                    restored.push((
                                        panel_label(kind),
                                        (
                                            x as i32,
                                            y as i32,
                                            w.unwrap_or(desc.width) as i32,
                                            h.unwrap_or(desc.height) as i32,
                                        ),
                                    ));
                                }
                            }
                            // Re-link docked clusters by geometry: panels saved
                            // flush rejoin a star over the same members, so a
                            // restored layout drags as a unit — not just visually
                            // adjacent. The GROUPING decision uses the SAVED rects
                            // (no live geometry read needed at setup, which the OS
                            // may not have realized yet). The dock-group event
                            // emitted below races the panels' webview load; each
                            // panel re-pulls its membership via dock_group_state
                            // once it wires its dock listeners (replay-on-
                            // subscribe), so a missed boot-time event is recovered.
                            let (diff, notify) = {
                                let state = handle.state::<DockState>();
                                let mut s =
                                    state.0.lock().unwrap_or_else(|e| e.into_inner());
                                s.form_groups_by_geometry(&restored)
                            };
                            dock_apply_and_notify(&handle, diff, notify);
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
            // Click-through cursor poll (~30Hz; see the InteractiveRegion docs).
            // Idles on a bool while no region is enabled, so the everyday widget
            // pays one mutex read per tick and nothing else. Window methods are
            // safe from this thread (they proxy to the main thread internally).
            let poll_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut ignoring = false;
                let mut outside_ticks: u8 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(33));
                    let Some(win) = poll_handle.get_webview_window("main") else {
                        continue;
                    };
                    let (enabled, rects) = {
                        let region = poll_handle.state::<InteractiveRegion>();
                        let guard = region.0.lock().unwrap_or_else(|e| e.into_inner());
                        (guard.enabled, guard.rects.clone())
                    };
                    if !enabled {
                        // Region off (string retracted / app normal): make sure we
                        // are NOT ignoring, then idle.
                        if ignoring && win.set_ignore_cursor_events(false).is_ok() {
                            ignoring = false;
                        }
                        outside_ticks = 0;
                        continue;
                    }
                    let (cursor, origin, sf) = match (
                        win.cursor_position(),
                        win.outer_position(),
                        win.scale_factor(),
                    ) {
                        (Ok(c), Ok(o), Ok(s)) if s > 0.0 => (c, o, s),
                        _ => continue, // transient read failure: keep last state
                    };
                    // Global physical cursor -> logical window-local (the rects'
                    // coordinate space).
                    let lx = (cursor.x - origin.x as f64) / sf;
                    let ly = (cursor.y - origin.y as f64) / sf;
                    let inside = rects
                        .iter()
                        .any(|&(x, y, w, h)| lx >= x && lx <= x + w && ly >= y && ly <= y + h);
                    if inside {
                        outside_ticks = 0;
                        // Flip interactive IMMEDIATELY so an incoming click lands.
                        if ignoring && win.set_ignore_cursor_events(false).is_ok() {
                            ignoring = false;
                        }
                    } else {
                        // Hysteresis (~130ms) before going click-through so edge
                        // skims don't flicker; the rects are pre-padded as well.
                        outside_ticks = outside_ticks.saturating_add(1);
                        if !ignoring
                            && outside_ticks >= 4
                            && win.set_ignore_cursor_events(true).is_ok()
                        {
                            ignoring = true;
                        }
                    }
                }
            });

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
                            // Toggle EVERY app window on the hub's visibility
                            // (widget-system.md Phase 0). Toggling only "main"
                            // used to strand floating widget windows on screen
                            // with the moon hidden. Closed windows no longer
                            // exist, so this never resurrects anything.
                            let windows = app.webview_windows();
                            // No hub window → mid-teardown; never blind-show
                            // orphans (a missing hub would read as "hidden"
                            // and make every press a show-forever).
                            let Some(hub) = windows.get("main") else {
                                return;
                            };
                            let hub_visible = hub.is_visible().unwrap_or(false);
                            for (label, window) in windows {
                                if hub_visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    if label == "main" {
                                        let _ = window.set_focus();
                                    }
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
    fn panel_spawn_prefers_right_edge_and_falls_back_left_on_overflow() {
        // Opener at (100, 50) 360×440, panel 360 wide, monitor right at 1600.
        assert_eq!(panel_spawn_pos((100, 50, 360, 440), 360, 1600), (460, 50, "r"));
        // Right edge would overflow → flush at the opener's LEFT.
        assert_eq!(panel_spawn_pos((1300, 50, 360, 440), 360, 1600), (940, 50, "l"));
        // Exactly fits → still right.
        assert_eq!(panel_spawn_pos((880, 50, 360, 440), 360, 1600), (1240, 50, "r"));
    }

    #[test]
    fn cluster_bbox_unions_member_rects() {
        assert_eq!(cluster_bbox(&[]), None);
        // One member → itself.
        assert_eq!(cluster_bbox(&[(100, 50, 360, 440)]), Some((100, 50, 360, 440)));
        // Two flush-right panels → the perimeter spans BOTH, so a new panel
        // appends past the right of the whole stack (never over member #1).
        assert_eq!(
            cluster_bbox(&[(100, 50, 360, 440), (460, 50, 360, 440)]),
            Some((100, 50, 720, 440))
        );
        // Vertically offset members widen + heighten the box.
        assert_eq!(
            cluster_bbox(&[(100, 50, 200, 200), (250, 300, 200, 200)]),
            Some((100, 50, 350, 450))
        );
    }

    #[test]
    fn pick_nearest_label_is_closest_with_stable_tie_break() {
        let from = (1000, 100, 360, 440); // centre (1180, 320)
        let cands = vec![
            ("panel-far".to_string(), (0, 0, 100, 100)),
            ("panel-near".to_string(), (980, 90, 360, 440)),
        ];
        assert_eq!(
            pick_nearest_label(from, &cands).as_deref(),
            Some("panel-near")
        );
        // No candidates → no anchor (the first panel free-floats).
        assert_eq!(pick_nearest_label(from, &[]), None);
        // Equidistant centres resolve by label, deterministically, so the snap
        // target never flickers with HashMap iteration order.
        let a = (100, 100, 100, 100); // centre (150, 150)
        let tie = vec![
            ("widget-b".to_string(), (0, 100, 100, 100)), // centre (50, 150)
            ("widget-a".to_string(), (200, 100, 100, 100)), // centre (250, 150)
        ];
        assert_eq!(pick_nearest_label(a, &tie).as_deref(), Some("widget-a"));
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

#[cfg(test)]
mod dock_tests {
    use super::{dock_outline_sides, dock_seams, DockGroups, DockSeam};

    fn attaches(diff: &[(String, String, bool)]) -> Vec<(String, String)> {
        diff.iter()
            .filter(|(_, _, a)| *a)
            .map(|(p, c, _)| (p.clone(), c.clone()))
            .collect()
    }

    #[test]
    fn joining_two_loose_windows_forms_a_star_rooted_at_the_anchor() {
        let mut g = DockGroups::default();
        let diff = g.join("widget-a", "main");
        assert_eq!(attaches(&diff), vec![("main".into(), "widget-a".into())]);
        let mut members = g.members_of("widget-a");
        members.sort();
        assert_eq!(members, vec!["main".to_string(), "widget-a".to_string()]);
        // Same-group re-join is a no-op.
        assert!(g.join("widget-a", "main").is_empty());
    }

    #[test]
    fn newcomers_attach_to_the_group_root_not_the_touched_member() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        // b touches widget-a, but the star parents it to the root (main).
        let diff = g.join("widget-b", "widget-a");
        assert_eq!(attaches(&diff), vec![("main".into(), "widget-b".into())]);
        assert_eq!(g.members_of("widget-b").len(), 3);
    }

    #[test]
    fn merging_two_groups_reparents_the_absorbed_star() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        let _ = g.join("widget-c", "widget-b"); // second group, root widget-b
        let diff = g.join("widget-b", "widget-a"); // merge into main's group
        // widget-c detaches from widget-b, then both attach under main.
        assert!(diff.contains(&("widget-b".into(), "widget-c".into(), false)));
        assert!(diff.contains(&("main".into(), "widget-b".into(), true)));
        assert!(diff.contains(&("main".into(), "widget-c".into(), true)));
        assert_eq!(g.members_of("main").len(), 4);
    }

    #[test]
    fn reroot_moves_every_member_under_the_grabbed_window() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        let _ = g.join("widget-b", "widget-a");
        let diff = g.reroot("widget-b");
        // Old root detaches its children, new root adopts everyone else.
        assert!(diff.contains(&("main".into(), "widget-a".into(), false)));
        assert!(diff.contains(&("widget-b".into(), "main".into(), true)));
        assert!(diff.contains(&("widget-b".into(), "widget-a".into(), true)));
        // Grabbing the root again is a no-op.
        assert!(g.reroot("widget-b").is_empty());
        // Ungrouped windows are no-ops too.
        assert!(g.reroot("widget-zzz").is_empty());
    }

    #[test]
    fn leaving_a_three_group_keeps_the_other_two_linked() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        let _ = g.join("widget-b", "widget-a");
        let (diff, departed) = g.leave("widget-a", false);
        assert_eq!(departed, vec!["widget-a".to_string()]);
        assert!(diff.contains(&("main".into(), "widget-a".into(), false)));
        let mut rest = g.members_of("main");
        rest.sort();
        assert_eq!(rest, vec!["main".to_string(), "widget-b".to_string()]);
    }

    #[test]
    fn a_two_group_dissolves_when_either_member_leaves() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        let (_, departed) = g.leave("widget-a", false);
        let mut d = departed;
        d.sort();
        assert_eq!(d, vec!["main".to_string(), "widget-a".to_string()]);
        assert!(g.members_of("main").is_empty());
        assert!(g.groups.is_empty());
    }

    #[test]
    fn root_departure_reforms_the_star_under_a_survivor() {
        let mut g = DockGroups::default();
        let _ = g.join("widget-a", "main");
        let _ = g.join("widget-b", "widget-a");
        // The root (main) is destroyed — gone=true skips ops on the corpse.
        let (diff, _) = g.leave("main", true);
        for (p, c, _) in &diff {
            assert!(p != "main" && c != "main", "no native ops on a dead window");
        }
        let survivors = g.members_of("widget-a");
        assert_eq!(survivors.len(), 2);
        // One survivor adopted the other.
        assert_eq!(attaches(&diff).len(), 1);
    }

    #[test]
    fn outline_marks_only_perimeter_sides() {
        // Two 100x100 windows side by side: a | b
        let rects = vec![
            ("a".to_string(), (0, 0, 100, 100)),
            ("b".to_string(), (100, 0, 100, 100)),
        ];
        let out = dock_outline_sides(&rects);
        assert_eq!(out["a"], vec!["l", "t", "b"]); // right side is interior
        assert_eq!(out["b"], vec!["r", "t", "b"]); // left side is interior
    }

    #[test]
    fn outline_ignores_near_misses_and_corner_touches() {
        let rects = vec![
            ("a".to_string(), (0, 0, 100, 100)),
            ("far".to_string(), (110, 0, 100, 100)),   // 10px gap — not flush
            ("corner".to_string(), (100, 95, 100, 100)), // only 5px overlap
        ];
        let out = dock_outline_sides(&rects);
        assert_eq!(out["a"], vec!["l", "r", "t", "b"]);
    }

    // dock_seams is the Rust source of truth for badge placement; these mirror
    // the deck-snap.test.ts computeSeams cases so the two stay in lockstep.
    fn seam(partner: &str, edge: &'static str, x: i32, y: i32) -> DockSeam {
        DockSeam { partner: partner.to_string(), edge, x, y }
    }

    #[test]
    fn seam_owned_by_the_left_window_on_its_right_edge() {
        // a (left, 200x300) | b (250x220, flush right, vertically overlapping)
        let rects = vec![
            ("a".to_string(), (0, 0, 200, 300)),
            ("b".to_string(), (200, 40, 250, 220)),
        ];
        let out = dock_seams(&rects);
        // Overlap run [40,260] → mid 150 (a-local). Badge centered on a's right
        // edge, inset 11px (badge radius) so it stays on-window.
        assert_eq!(out["a"], vec![seam("b", "r", 189, 150)]);
        // b's matching edge is its LEFT, which dock_seams never inspects → silent.
        assert_eq!(out["b"], Vec::<DockSeam>::new());
    }

    #[test]
    fn seam_owned_by_the_top_window_on_its_bottom_edge() {
        let rects = vec![
            ("a".to_string(), (0, 0, 200, 300)),
            ("below".to_string(), (30, 300, 140, 180)),
        ];
        let out = dock_seams(&rects);
        // Overlap run [30,170] → mid 100 (a-local x); y pinned to h - 11.
        assert_eq!(out["a"], vec![seam("below", "b", 100, 289)]);
    }

    #[test]
    fn seam_ignores_near_misses_and_thin_overlap() {
        let rects = vec![
            ("a".to_string(), (0, 0, 200, 300)),
            ("gap".to_string(), (205, 40, 250, 220)),   // 5px gap (> EPS 2)
            ("thin".to_string(), (200, 295, 250, 220)), // flush but 5px overlap (< 8)
        ];
        let out = dock_seams(&rects);
        assert_eq!(out["a"], Vec::<DockSeam>::new());
    }

    #[test]
    fn seam_clamps_toward_the_overlapping_end() {
        // A tall partner overlaps only a's very top → midpoint ~10px up-edge;
        // the clamp floor keeps the badge fully inside (y ≥ 11).
        let rects = vec![
            ("a".to_string(), (0, 0, 200, 300)),
            ("tall".to_string(), (200, -260, 200, 280)),
        ];
        let out = dock_seams(&rects);
        assert_eq!(out["a"][0].edge, "r");
        assert_eq!(out["a"][0].y, 11);
    }

    #[test]
    fn seam_one_per_partner_in_a_multi_window_group() {
        let rects = vec![
            ("a".to_string(), (0, 0, 200, 300)),
            ("right".to_string(), (200, 0, 250, 300)),
            ("below".to_string(), (0, 300, 200, 180)),
            ("afar".to_string(), (600, 600, 100, 100)),
        ];
        let out = dock_seams(&rects);
        let mut partners: Vec<&str> = out["a"].iter().map(|s| s.partner.as_str()).collect();
        partners.sort_unstable();
        assert_eq!(partners, vec!["below", "right"]);
    }

    #[test]
    fn seam_never_against_the_hub() {
        // Defense-in-depth: even if the alignment-only hub were ever flush in a
        // group's rect list, it draws no seam badge.
        let rects = vec![
            ("widget-a".to_string(), (0, 0, 200, 300)),
            ("main".to_string(), (200, 0, 200, 300)), // hub flush on the right
        ];
        let out = dock_seams(&rects);
        assert_eq!(out["widget-a"], Vec::<DockSeam>::new());
    }
}

#[cfg(test)]
mod dock_geometry_tests {
    use super::{dock_components, dock_rects_touch, DockGroups};

    #[test]
    fn touch_predicate_matches_flush_edges_only() {
        let a = (0, 0, 100, 100);
        assert!(dock_rects_touch(a, (100, 0, 100, 100))); // flush right
        assert!(dock_rects_touch(a, (0, 100, 100, 100))); // flush below
        assert!(!dock_rects_touch(a, (110, 0, 100, 100))); // 10px gap
        assert!(!dock_rects_touch(a, (100, 95, 100, 100))); // 5px overlap only
    }

    #[test]
    fn chain_minus_middle_splits_into_two_singletons_that_dissolve() {
        let mut g = DockGroups::default();
        let _ = g.join("b", "a");
        let _ = g.join("c", "b");
        // The middle (b) leaves; survivors a and c are 280px apart.
        let _ = g.leave("b", false);
        let rects = vec![
            ("a".to_string(), (0, 0, 280, 220)),
            ("c".to_string(), (560, 0, 280, 220)),
        ];
        let (diff, touched) = g.regroup_by_geometry("a", &rects);
        // Both singletons dissolve: no attaches, both freed.
        assert!(diff.iter().all(|(_, _, attach)| !attach));
        let mut t = touched;
        t.sort();
        assert_eq!(t, vec!["a".to_string(), "c".to_string()]);
        assert!(g.members_of("a").is_empty());
        assert!(g.members_of("c").is_empty());
    }

    #[test]
    fn four_chain_minus_one_keeps_the_touching_pair_linked() {
        let mut g = DockGroups::default();
        let _ = g.join("b", "a");
        let _ = g.join("c", "b");
        let _ = g.join("d", "c");
        let _ = g.leave("c", false);
        // a|b still flush; d is far away.
        let rects = vec![
            ("a".to_string(), (0, 0, 280, 220)),
            ("b".to_string(), (280, 0, 280, 220)),
            ("d".to_string(), (840, 0, 280, 220)),
        ];
        let (_, touched) = g.regroup_by_geometry("a", &rects);
        assert_eq!(touched.len(), 3);
        let mut ab = g.members_of("a");
        ab.sort();
        assert_eq!(ab, vec!["a".to_string(), "b".to_string()]);
        assert!(g.members_of("d").is_empty());
    }

    #[test]
    fn connected_survivors_are_left_alone() {
        let mut g = DockGroups::default();
        let _ = g.join("b", "a");
        let rects = vec![
            ("a".to_string(), (0, 0, 280, 220)),
            ("b".to_string(), (280, 0, 280, 220)),
        ];
        let (diff, touched) = g.regroup_by_geometry("a", &rects);
        assert!(diff.is_empty());
        assert!(touched.is_empty());
        assert_eq!(g.members_of("a").len(), 2);
    }

    #[test]
    fn components_flood_fill_handles_l_shapes() {
        let rects = vec![
            ("a".to_string(), (0, 0, 100, 100)),
            ("b".to_string(), (100, 0, 100, 100)),
            ("c".to_string(), (100, 100, 100, 100)), // touches b's bottom
            ("lone".to_string(), (500, 500, 100, 100)),
        ];
        let comps = dock_components(&rects);
        assert_eq!(comps.len(), 2);
        let big = comps.iter().find(|c| c.len() == 3).expect("L-component");
        assert!(big.contains(&"a".to_string()) && big.contains(&"c".to_string()));
    }

    #[test]
    fn form_groups_relinks_flush_clusters_and_leaves_singletons_free() {
        let mut g = DockGroups::default();
        // A saved layout after a restart: two flush panels + one detached.
        let rects = vec![
            ("panel-now".to_string(), (100, 100, 280, 220)),
            ("panel-flow".to_string(), (380, 100, 280, 220)), // flush right of now
            ("panel-settings".to_string(), (900, 100, 280, 220)), // alone
        ];
        let (diff, touched) = g.form_groups_by_geometry(&rects);
        // now|flow rejoin one star rooted at the MIN label ("panel-flow"); the
        // lone panel stays free (no group of one).
        let mut members = g.members_of("panel-now");
        members.sort();
        assert_eq!(
            members,
            vec!["panel-flow".to_string(), "panel-now".to_string()]
        );
        assert!(g.members_of("panel-settings").is_empty());
        // Exactly one attach (the non-root member parents under the root); both
        // grouped labels are reported as touched.
        assert_eq!(diff.iter().filter(|(_, _, attach)| *attach).count(), 1);
        let mut t = touched;
        t.sort();
        assert_eq!(t, vec!["panel-flow".to_string(), "panel-now".to_string()]);

        // Idempotent: a second pass over the SAME layout disturbs nothing — the
        // labels are already grouped, so boot re-link never double-attaches.
        let (diff2, touched2) = g.form_groups_by_geometry(&rects);
        assert!(diff2.is_empty());
        assert!(touched2.is_empty());
    }

    #[test]
    fn form_groups_skips_a_component_touching_an_already_grouped_label() {
        let mut g = DockGroups::default();
        // Pre-existing runtime group: x|y already linked.
        let _ = g.join("panel-y", "panel-x");
        // A flush chain where a THIRD panel touches the existing pair.
        let rects = vec![
            ("panel-x".to_string(), (100, 100, 280, 220)),
            ("panel-y".to_string(), (380, 100, 280, 220)),
            ("panel-z".to_string(), (660, 100, 280, 220)), // flush right of y
        ];
        let (diff, touched) = g.form_groups_by_geometry(&rects);
        // The whole component touches an already-grouped label → skipped
        // wholesale (the guard): z is NOT yanked in, the existing group is
        // untouched, no native ops emitted.
        assert!(diff.is_empty());
        assert!(touched.is_empty());
        assert!(g.members_of("panel-z").is_empty());
        let mut xy = g.members_of("panel-x");
        xy.sort();
        assert_eq!(xy, vec!["panel-x".to_string(), "panel-y".to_string()]);
    }
}

#[cfg(test)]
mod dock_eject_tests {
    use super::{dock_eject_vector, dock_in_magnet, dock_rects_overlap};

    #[test]
    fn magnet_check_matches_snap_candidates() {
        let a = (336, 0, 300, 300);
        assert!(dock_in_magnet(a, (300, 300, 300, 300), 28)); // flush below seam
        assert!(!dock_in_magnet(a, (800, 0, 300, 300), 28)); // far away
    }

    #[test]
    fn straight_eject_when_clear() {
        // Pair: leaver right of the survivor — +x eject is clear.
        let leaver = (300, 0, 300, 300);
        let others = vec![(0, 0, 300, 300)];
        assert_eq!(dock_eject_vector(leaver, &others), (36, 0));
    }

    #[test]
    fn middle_of_row_never_lands_inside_a_neighbor() {
        // L(0,0) M(300,0) R(600,0): +x would bury M in R — the ladder must
        // pick a non-overlapping vector (vertical slide).
        let leaver = (300, 0, 300, 300);
        let others = vec![(0, 0, 300, 300), (600, 0, 300, 300)];
        let (dx, dy) = dock_eject_vector(leaver, &others);
        let moved = (300 + dx, dy, 300, 300);
        assert!(
            others.iter().all(|o| !dock_rects_overlap(moved, *o)),
            "eject ({dx},{dy}) buried the leaver in a neighbor"
        );
    }

    #[test]
    fn lone_leaver_gets_the_default_shove() {
        assert_eq!(dock_eject_vector((0, 0, 100, 100), &[]), (36, 0));
    }

    #[test]
    fn eject_clears_a_bystanders_magnet() {
        // The live incident, verbatim: voice unpins from chat (its survivor,
        // below) while the Now panel sits a hair right of the +x step. The
        // old overlap-only ladder took (+36, 0) and landed flush on Now's
        // left seam — a window with NO cooldown — and the settle linked
        // them instantly. The vector must clear every magnet, not just
        // every body.
        let leaver = (1080, 208, 400, 420); // voice
        let others = vec![
            (959, 628, 560, 520),  // chat (ex-member survivor)
            (1519, 195, 320, 440), // Now (bystander)
        ];
        let (dx, dy) = dock_eject_vector(leaver, &others);
        let moved = (1080 + dx, 208 + dy, 400, 420);
        assert!(
            others
                .iter()
                .all(|o| !dock_rects_overlap(moved, *o) && !dock_in_magnet(moved, *o, 22)),
            "eject ({dx},{dy}) landed inside someone's magnet"
        );
    }

    #[test]
    fn crowded_screen_falls_back_to_overlap_free() {
        // Sandwiched mid-row: every ladder spot keeps a flush seam with an
        // ex-member, so tier 1 finds nothing — the fallback must still
        // return an overlap-free vector (the cooldown covers those seams).
        let leaver = (300, 0, 300, 300);
        let others = vec![(0, 0, 300, 300), (600, 0, 300, 300)];
        let (dx, dy) = dock_eject_vector(leaver, &others);
        let moved = (300 + dx, dy, 300, 300);
        assert!(
            others.iter().all(|o| !dock_rects_overlap(moved, *o)),
            "fallback eject ({dx},{dy}) buried the leaver"
        );
    }
}
