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
    result: std::sync::Arc<std::sync::Mutex<Option<OauthRedirectResult>>>,
}

#[derive(Clone, serde::Serialize)]
struct OauthRedirectResult {
    code: String,
    state: String,
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
<h2 style=\"font-weight:600;margin:12px 0 6px\">Connected</h2>\
<p style=\"color:#8ea2c8;font-size:14px\">You can close this tab and return to Luna.</p></div></body></html>";

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
    let result: std::sync::Arc<std::sync::Mutex<Option<OauthRedirectResult>>> =
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

    std::thread::spawn(move || {
        use std::io::{Read, Write};
        loop {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    // First line: GET /callback?code=…&state=… HTTP/1.1
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let query = path.splitn(2, '?').nth(1).unwrap_or("");
                    let code = query_param(query, "code");
                    let st = query_param(query, "state");
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            OAUTH_DONE_HTML.len(),
                            OAUTH_DONE_HTML
                        )
                        .as_bytes(),
                    );
                    let _ = stream.flush();
                    if let (Some(code), Some(st)) = (code, st) {
                        *result.lock().unwrap() = Some(OauthRedirectResult { code, state: st });
                        return; // single-shot: captured, listener dies
                    }
                    // Not the redirect (favicon probe etc.) — keep listening.
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    });

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
        if let Some(r) = result.lock().unwrap().take() {
            return Ok(r);
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

/// Open a URL in the system browser. https-only by design: this exists for
/// OAuth consent pages; it must not become a general shell-open primitive.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https:// URLs can be opened".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("could not open the browser: {e}"))
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
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(width.unwrap_or(360.0), height.unwrap_or(440.0))
    .min_inner_size(220.0, 160.0);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    builder.build().map_err(|e| e.to_string())?;
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
fn is_closable_widget_label(label: &str) -> bool {
    label.starts_with("widget-")
}

/// Labels of every currently-open widget window (those with the `widget-`
/// prefix) — lets the deck reconcile its persisted layout against reality.
#[tauri::command]
fn list_widget_windows(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|l| l.starts_with("widget-"))
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
            let _ = app.emit_to(
                tauri::EventTarget::labeled("main"),
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
        let _ = app.emit_to(
            tauri::EventTarget::labeled("main"),
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
        let _ = app.emit_to(
            tauri::EventTarget::labeled("main"),
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

/// Pick an eject vector (logical px) that doesn't land the leaver INSIDE a
/// former neighbor. Instant re-linking is prevented separately by the
/// ex-member cooldown (the leaver ignores its old group briefly), so a
/// surviving flush seam here is fine. Prefers the axis pointing away from
/// the group centroid.
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
    let candidates = [
        (STEP * sx, 0),
        (0, STEP * sy),
        (STEP * sx, STEP * sy),
        (-STEP * sx, 0),
        (0, -STEP * sy),
        (2 * STEP * sx, 0),
        (0, 2 * STEP * sy),
        (2 * STEP * sx, 2 * STEP * sy),
    ];
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
            serde_json::json!({
                "for": label,
                "grouped": true,
                "members": members,
                "outlineSides": outline.get(&label).cloned().unwrap_or_default(),
            })
        };
        let _ = app.emit_to(tauri::EventTarget::labeled(&label), "dock-group", payload);
    }
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
        if !anchor.starts_with("widget-") {
            // Anchor strings come straight from page JS — keep the dock
            // graph inside the widget namespace (extend deliberately when
            // panel-* windows arrive).
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
                // now-loose leaver to a spot that clears EVERY former
                // neighbor's magnet, then regroup survivors by geometry and
                // notify everyone with the final state.
                dock_apply_and_notify(&app, diff, Vec::new());
                if let Some(w) = app.get_webview_window(&label) {
                    if let Some(leaver) = dock_logical_rect(&w) {
                        let others: Vec<(i32, i32, i32, i32)> = remaining
                            .iter()
                            .filter_map(|m| {
                                let mw = app.get_webview_window(m)?;
                                dock_logical_rect(&mw)
                            })
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

fn main() {
    let builder = tauri::Builder::default()
        // Hub-owns-exit lifecycle (widget-system.md Phase 0): the moon hub is
        // the owning window — when it is destroyed, every other window
        // (widget-*/panel-*) closes with it, and Tauri's natural
        // last-window-closed exit fires. The reverse never holds: closing a
        // widget leaves the hub (and the app) alive.
        .on_window_event(|window, event| {
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
        close_widget,
        list_widget_windows,
        set_dock,
        grab_dock,
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
        close_widget,
        list_widget_windows,
        set_dock,
        grab_dock
    ]);

    builder
        .setup(|app| {
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

    /// End-to-end over a REAL socket: bind, hit /callback like a provider
    /// redirect, assert the captured code/state and the response page.
    #[test]
    fn loopback_captures_a_provider_redirect() {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicBool;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let result: std::sync::Arc<std::sync::Mutex<Option<OauthRedirectResult>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        // Mirror the accept-loop body from oauth_loopback_start.
        let c2 = cancel.clone();
        let r2 = result.clone();
        let handle = std::thread::spawn(move || loop {
            if c2.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");
                    let query = path.splitn(2, '?').nth(1).unwrap_or("");
                    let code = query_param(query, "code");
                    let st = query_param(query, "state");
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            OAUTH_DONE_HTML.len(),
                            OAUTH_DONE_HTML
                        )
                        .as_bytes(),
                    );
                    if let (Some(code), Some(st)) = (code, st) {
                        *r2.lock().unwrap() = Some(OauthRedirectResult { code, state: st });
                        return;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(_) => return,
            }
        });

        // Play the provider: GET the callback like a browser redirect would.
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(b"GET /callback?code=the-code&state=the-state HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        handle.join().unwrap();

        assert!(response.contains("200 OK"));
        assert!(response.contains("return to Luna"));
        let captured = result.lock().unwrap().take().unwrap();
        assert_eq!(captured.code, "the-code");
        assert_eq!(captured.state, "the-state");
    }
}

#[cfg(test)]
mod dock_tests {
    use super::{dock_outline_sides, DockGroups};

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
}
