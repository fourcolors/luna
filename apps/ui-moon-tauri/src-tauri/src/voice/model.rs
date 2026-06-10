//! Whisper model presence check + download.
//!
//! Download is delegated to a spawned `curl` (tokio::process — already a dep;
//! no new HTTP stack in the binary): fetch to a `.part` file, then an atomic
//! rename into place so a half-written model is never mistaken for a real
//! one. Progress is file-size polling at ~2Hz (curl owns the socket; the
//! `.part` size IS the downloaded byte count), emitted through the caller's
//! closure as `voice-model-progress` payloads.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::json;

pub const MODEL_FILE: &str = "ggml-base.en.bin";
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

/// Anything smaller cannot be a real ggml whisper model (the tiniest is
/// ~75MB; base.en is ~148MB) but easily IS a captive-portal/proxy HTML page
/// that came back with a 200 — `curl --fail` cannot tell those apart.
/// Guards both `model_present()` and the post-download rename.
pub const MIN_MODEL_BYTES: u64 = 10 * 1024 * 1024;

const PROGRESS_POLL: Duration = Duration::from_millis(500); // ~2Hz

/// Pure path layout (unit-testable without touching $HOME).
pub fn model_path_for_home(home: &str) -> PathBuf {
    PathBuf::from(home)
        .join(".luna")
        .join("models")
        .join(MODEL_FILE)
}

pub fn model_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    Ok(model_path_for_home(&home))
}

/// Present = exists AND is plausibly a model. A bare `exists()` made a
/// corrupt-but-present file (intercepted download, truncated copy) look
/// ready forever: the Download button stayed hidden while whisper kept
/// rejecting the file, with manual deletion the only way out.
pub fn model_present() -> bool {
    model_path().map(|p| model_present_at(&p)).unwrap_or(false)
}

fn model_present_at(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| is_plausible_model_size(m.len()))
}

/// Pure size sanity floor shared by presence checks and download validation.
pub fn is_plausible_model_size(len: u64) -> bool {
    len >= MIN_MODEL_BYTES
}

/// Validate a finished download BEFORE the rename into place. The HEAD total
/// is authoritative when known (a short body means an interrupted/foreign
/// payload); otherwise fall back to the plausibility floor.
pub fn validate_model_size(downloaded: u64, head_total: u64) -> Result<(), String> {
    if head_total > 0 && downloaded != head_total {
        return Err(format!(
            "model download incomplete: got {downloaded} of {head_total} bytes"
        ));
    }
    if !is_plausible_model_size(downloaded) {
        return Err(format!(
            "downloaded file is too small to be a whisper model ({downloaded} bytes) — \
             a proxy or captive portal may have intercepted the download"
        ));
    }
    Ok(())
}

/// Download staging path: a `.part` sibling made unique PER PROCESS (pid
/// suffix), so a second running Moon instance can never clobber the first's
/// in-flight download. The old shared `.part` name was unconditionally
/// deleted at entry — resetting a concurrent instance's progress poll to 0
/// and racing its final rename.
pub fn part_path_for(path: &Path, pid: u32) -> PathBuf {
    path.with_extension(format!("bin.part.{pid}"))
}

/// Parse the payload size out of `curl -sIL` output. Redirect chains print
/// one header block per hop — the LAST Content-Length is the real file's.
pub fn parse_content_length(headers: &str) -> Option<u64> {
    headers
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<u64>().ok()
            } else {
                None
            }
        })
        .last()
}

/// Serializes concurrent ensure_model calls WITHIN THIS PROCESS: the second
/// caller waits on this lock, then finds the file already present. A second
/// app instance is outside its reach — that case is handled by the
/// pid-unique `.part` staging name (see [`part_path_for`]): worst case two
/// instances download in parallel and the later rename wins atomically.
static DOWNLOAD_GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Ensure the whisper model exists at `~/.luna/models/ggml-base.en.bin`,
/// downloading it if missing. Resolves when present. Idempotent.
///
/// `progress` receives `voice-model-progress` payloads:
/// `{ downloadedBytes, totalBytes, done, error? }` — `error` is set (with
/// `done: false`) when the download fails; `done: true` only when the model
/// is actually in place.
pub async fn ensure_model(progress: impl Fn(serde_json::Value) + Send) -> Result<(), String> {
    let _guard = DOWNLOAD_GUARD
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    let path = model_path()?;
    if path.exists() {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if is_plausible_model_size(size) {
            // Already present (or a concurrent caller just finished): report
            // an instantly-complete download so the UI can settle.
            progress(json!({
                "downloadedBytes": size,
                "totalBytes": size,
                "done": true,
            }));
            return Ok(());
        }
        // Present but implausible (a junk file renamed into place by an
        // older build, or a truncated copy): short-circuiting here would
        // make every retry an instant no-op while whisper keeps rejecting
        // the file. Remove it and re-download for real.
        std::fs::remove_file(&path)
            .map_err(|e| format!("failed to remove corrupt model file: {e}"))?;
    }

    let dir = path
        .parent()
        .ok_or_else(|| "model path has no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create {dir:?}: {e}"))?;

    // Total size up front (curl -sIL follows redirects; last header block
    // wins). 0 = unknown → the frontend shows an indeterminate bar.
    let total = head_total_bytes().await.unwrap_or(0);

    // Download to a pid-unique .part sibling, never the final name (see
    // part_path_for). A stale .part from a crashed run of THIS pid is
    // removed first so the size poll starts honest; other pids' parts are
    // left alone — they may belong to a live concurrent instance.
    let part = part_path_for(&path, std::process::id());
    let _ = std::fs::remove_file(&part);

    let emit = |downloaded: u64, done: bool, error: Option<String>| {
        let mut payload = json!({
            "downloadedBytes": downloaded,
            "totalBytes": total,
            "done": done,
        });
        if let Some(msg) = error {
            payload["error"] = json!(msg);
        }
        progress(payload);
    };
    emit(0, false, None);

    let mut child = tokio::process::Command::new("curl")
        .arg("-sSL")
        .arg("--fail")
        .arg("-o")
        .arg(&part)
        .arg(MODEL_URL)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn curl: {e}"))?;

    // Drain stderr concurrently (curl -sS only writes on error; small).
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf).await;
        }
        buf
    });

    // Poll the .part size at ~2Hz until curl exits. Child::wait is
    // cancel-safe, so re-arming it inside select! each iteration is sound.
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            _ = tokio::time::sleep(PROGRESS_POLL) => {
                let downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                emit(downloaded, false, None);
            }
        }
    };

    let fail = |downloaded: u64, msg: String| {
        let _ = std::fs::remove_file(&part);
        emit(downloaded, false, Some(msg.clone()));
        Err(msg)
    };

    match status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            let detail = stderr_task.await.unwrap_or_default();
            let downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            return fail(
                downloaded,
                format!("model download failed ({s}): {}", detail.trim()),
            );
        }
        Err(e) => {
            let downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            return fail(downloaded, format!("model download failed: {e}"));
        }
    }

    // Size gate BEFORE the rename: a captive-portal/proxy 200-with-HTML body
    // passes `curl --fail` — without this check it became "the model" and
    // the only symptom was whisper rejecting it on every later load.
    let downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if let Err(msg) = validate_model_size(downloaded, total) {
        return fail(downloaded, msg);
    }
    std::fs::rename(&part, &path)
        .map_err(|e| format!("failed to move model into place: {e}"))?;

    progress(json!({
        "downloadedBytes": downloaded,
        "totalBytes": if total > 0 { total } else { downloaded },
        "done": true,
    }));
    Ok(())
}

async fn head_total_bytes() -> Option<u64> {
    let out = tokio::process::Command::new("curl")
        .arg("-sIL")
        .arg(MODEL_URL)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_content_length(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_path_layout_matches_the_spike() {
        let p = model_path_for_home("/tmp/fakehome");
        assert_eq!(
            p,
            PathBuf::from("/tmp/fakehome/.luna/models/ggml-base.en.bin")
        );
    }

    #[test]
    fn part_path_is_a_pid_unique_dot_part_sibling() {
        // Regression (finding: shared .part): two app instances must stage
        // into DIFFERENT files so neither can delete/race the other's
        // in-flight download.
        let model = model_path_for_home("/h");
        assert_eq!(
            part_path_for(&model, 4242),
            PathBuf::from("/h/.luna/models/ggml-base.en.bin.part.4242")
        );
        assert_ne!(part_path_for(&model, 1), part_path_for(&model, 2));
    }

    #[test]
    fn download_size_validation_rejects_short_bodies_and_junk() {
        // HEAD total known: the body must match it exactly.
        assert!(validate_model_size(147_951_465, 147_951_465).is_ok());
        let e = validate_model_size(12_345, 147_951_465).unwrap_err();
        assert!(e.contains("incomplete"), "{e}");
        // HEAD total unknown (0): fall back to the plausibility floor — a
        // captive-portal HTML page is KBs, never tens of MB.
        assert!(validate_model_size(MIN_MODEL_BYTES, 0).is_ok());
        let e = validate_model_size(4_096, 0).unwrap_err();
        assert!(e.contains("too small"), "{e}");
        // A "consistent" tiny body (HEAD also hijacked) still fails the floor.
        assert!(validate_model_size(4_096, 4_096).is_err());
    }

    #[test]
    fn model_presence_requires_a_plausible_size_not_bare_existence() {
        assert!(!is_plausible_model_size(0));
        assert!(!is_plausible_model_size(MIN_MODEL_BYTES - 1));
        assert!(is_plausible_model_size(MIN_MODEL_BYTES));

        // A present-but-junk file must NOT count as the model (it kept the
        // Download button hidden with no recovery path).
        let dir = std::env::temp_dir().join(format!("luna-model-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let junk = dir.join(MODEL_FILE);
        std::fs::write(&junk, b"<html>captive portal</html>").unwrap();
        assert!(!model_present_at(&junk));
        assert!(!model_present_at(&dir.join("missing.bin")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_length_takes_the_last_header_block_after_redirects() {
        let headers = "HTTP/1.1 302 Found\r\n\
                       location: https://cdn.example/real\r\n\
                       Content-Length: 1234\r\n\
                       \r\n\
                       HTTP/1.1 200 OK\r\n\
                       content-length: 147951465\r\n\
                       \r\n";
        assert_eq!(parse_content_length(headers), Some(147_951_465));
    }

    #[test]
    fn content_length_absent_or_garbage_is_none() {
        assert_eq!(parse_content_length("HTTP/1.1 200 OK\r\n\r\n"), None);
        assert_eq!(
            parse_content_length("Content-Length: not-a-number\r\n"),
            None
        );
        assert_eq!(parse_content_length(""), None);
    }
}
