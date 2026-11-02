//! Local shell executor + platform probe.
//!
//! Split out of main.rs (moon-next split): moved verbatim, only visibility
//! (`pub(crate)`) changed so `main.rs` can wire these into
//! `tauri::generate_handler!`.

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
/// How long the pipe drains may run after the child exits before they are
/// cut short. Pipes normally hit EOF within milliseconds of child death;
/// anything longer means a surviving background child holds them open, and
/// waiting for it would hang the command indefinitely (see exec_local).
const LOCAL_SHELL_DRAIN_GRACE_MS: u64 = 1_000;
const LOCAL_SHELL_DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalShellExecResult {
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

/// Byte-capped capture shared between a drain task and the executor, so the
/// executor can snapshot what arrived even when a drain task is cut short
/// (a background child holding the pipes open). Same cap accounting as the
/// old read_capped: retain the first `cap` bytes, count the rest as omitted.
struct CappedSink {
    retained: Vec<u8>,
    omitted: usize,
    cap: usize,
}

impl CappedSink {
    fn new(cap: usize) -> Self {
        Self {
            retained: Vec::new(),
            omitted: 0,
            cap,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        if self.retained.len() < self.cap {
            let room = self.cap - self.retained.len();
            if chunk.len() <= room {
                self.retained.extend_from_slice(chunk);
            } else {
                self.retained.extend_from_slice(&chunk[..room]);
                self.omitted += chunk.len() - room;
            }
        } else {
            self.omitted += chunk.len();
        }
    }
}

/// Drain one child pipe into a shared sink until EOF or read error. The
/// sink (not the task's return value) owns the bytes, so the executor can
/// snapshot partial output if it has to cut this task short.
async fn drain_capped<R>(reader: Option<R>, sink: std::sync::Arc<std::sync::Mutex<CappedSink>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let Some(mut reader) = reader else { return };
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                sink.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(&chunk[..n]);
            }
        }
    }
}

fn snapshot_sink(sink: &std::sync::Mutex<CappedSink>) -> (Vec<u8>, usize) {
    let guard = sink.lock().unwrap_or_else(|e| e.into_inner());
    (guard.retained.clone(), guard.omitted)
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
    let stdout_sink = std::sync::Arc::new(std::sync::Mutex::new(CappedSink::new(
        LOCAL_SHELL_MAX_OUTPUT_BYTES,
    )));
    let stderr_sink = std::sync::Arc::new(std::sync::Mutex::new(CappedSink::new(
        LOCAL_SHELL_MAX_OUTPUT_BYTES,
    )));
    let mut stdout_task = tokio::spawn(drain_capped(
        child.stdout.take(),
        std::sync::Arc::clone(&stdout_sink),
    ));
    let mut stderr_task = tokio::spawn(drain_capped(
        child.stderr.take(),
        std::sync::Arc::clone(&stderr_sink),
    ));

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

    // Bound the pipe drains. After the child exits, a surviving background
    // child — daemonized on the normal path, or setsid'd out of the process
    // group the timeout path just killed — can hold the pipes open
    // indefinitely, and awaiting the drains unbounded would hang this command
    // forever (past the timeout path too, which already killed and waited).
    // Give the drains a short grace for in-flight bytes to land, then cut
    // them short and report what was captured.
    let drained = timeout(Duration::from_millis(LOCAL_SHELL_DRAIN_GRACE_MS), async {
        let _ = (&mut stdout_task).await;
        let _ = (&mut stderr_task).await;
    })
    .await;
    let stdout_cut = drained.is_err() && !stdout_task.is_finished();
    let stderr_cut = drained.is_err() && !stderr_task.is_finished();
    if drained.is_err() {
        stdout_task.abort();
        stderr_task.abort();
    }

    let (out_bytes, out_omitted) = snapshot_sink(&stdout_sink);
    let (err_bytes, err_omitted) = snapshot_sink(&stderr_sink);
    let mut stdout = format_captured(out_bytes, out_omitted);
    let mut stderr = format_captured(err_bytes, err_omitted);
    if stdout_cut {
        stdout.push_str("\n[output cut short: a background process still holds the stream open]");
    }
    if stderr_cut {
        stderr.push_str("\n[output cut short: a background process still holds the stream open]");
    }

    LocalShellExecResult {
        exit_code,
        stdout,
        stderr,
        duration_ms: elapsed_ms(),
        timed_out,
    }
}

/// Run a shell command on the client machine. See exec_local for the trust model.
#[tauri::command]
pub(crate) async fn local_shell_exec(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> LocalShellExecResult {
    exec_local(command, cwd, timeout_ms).await
}

/// The client OS ("macos" | "linux" | "windows" | ...), advertised in the
/// local-shell capability frame so the server knows the platform.
#[tauri::command]
pub(crate) fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// Short host label used to ADDRESS this machine, e.g. "mr-macbook-pro".
///
/// Several machines can be attached to one thread at once, and the agent picks
/// between them by label, so the label has to distinguish two of the operator's
/// own machines. The platform string cannot: two Macs would both be "macos".
/// Falls back to the platform when the host name is unavailable.
#[tauri::command]
pub(crate) fn get_host_label() -> String {
    let raw = std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // Strip the domain and any trailing ".local" so the label stays short.
    let short = raw.split('.').next().unwrap_or("").trim().to_lowercase();
    if short.is_empty() {
        std::env::consts::OS.to_string()
    } else {
        short
    }
}

/// The user's home directory, advertised in the local-shell capability frame
/// as the default cwd when no root is attached — so a cwd-less command runs
/// somewhere sane instead of the app process cwd ('/' for a packaged .app).
#[tauri::command]
pub(crate) fn get_home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn returns_promptly_when_a_background_child_holds_the_pipes() {
        // A daemonizing command exits at once, but its background child
        // keeps the stdio pipes open. The old code awaited the pipe drains
        // with no bound, so the result never arrived until the background
        // child exited; the drain grace must cut it short instead.
        let started = std::time::Instant::now();
        let r = exec_local("(sleep 30 &)".into(), None, Some(10_000)).await;
        assert_eq!(r.exit_code, Some(0));
        assert!(!r.timed_out);
        assert!(
            started.elapsed().as_millis() < 5_000,
            "must return within the drain grace, not when the background child exits"
        );
        assert!(
            r.stdout.contains("still holds the stream open"),
            "cut-short output must say so, got: {:?}",
            r.stdout
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
}
