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
