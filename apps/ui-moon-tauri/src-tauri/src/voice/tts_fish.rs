//! Fish Audio cloud TTS engine (api.fish.audio — `s2.1-pro-free` tier).
//!
//! One POST per sentence: `POST {base}/v1/tts` with
//! `Authorization: Bearer <key>`, `model: <model>` and a JSON body
//! `{text, format:"wav", sample_rate:<rate>, reference_id?}` returns a WAV
//! stream. A spawned `curl` owns the socket (same posture as model.rs — no
//! HTTP crate in the dep tree); the response is parsed and pushed into an
//! [`AudioSink`] as it ARRIVES, so playback starts with the first generated
//! chunk rather than after the full render (perceived TTFA halves).
//!
//! Architecture mirrors tts_avspeech.rs: a dedicated worker thread owns the
//! !Send cpal output stream (playback.rs) and serializes a pending-sentence
//! queue; the [`FishTts`] handle is an mpsc sender + shared atomics, hence
//! `Send` as `TtsEngine` needs.
//!
//! The API key never crosses the IPC bridge: `voice_fish_set_key` writes
//! `~/.luna/fish-api-key` (0600, atomic) and updates the shared
//! [`FishConfig`]; JS only ever sees `fishKeyConfigured: bool`. Env
//! `FISH_API_KEY` seeds the config at boot; `LUNA_FISH_API_BASE` /
//! `LUNA_FISH_MODEL` override endpoint/model (tests + paid tiers).

use std::io::{Read, Write as _};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use super::capture::{downmix_mono, StreamingResampler};
use super::playback::{AudioSink, CpalSink};
use super::tts::{TtsEngine, Voice};
use super::{lock_unpoisoned, EventSink};

pub const FISH_DEFAULT_BASE: &str = "https://api.fish.audio";
/// Free developer tier — see VOICE.md. Paid tiers pass via LUNA_FISH_MODEL.
pub const FISH_DEFAULT_MODEL: &str = "s2.1-pro-free";

/// Worker idle cadence: pump reaping + pending pickup + speaking publish.
const POLL: Duration = Duration::from_millis(20);
/// Whole-request ceiling; a hung socket must not pin the speaking flag.
const CURL_MAX_TIME_SECS: u32 = 45;
/// Bound on list_voices' HTTP round trips (each GET gets its own timeout).
const LIST_CURL_MAX_TIME_SECS: u32 = 8;
/// Max bytes accumulated while looking for the RIFF/WAVE header: Fish emits
/// a canonical header well inside this; a larger "header" is an error body.
const WAV_HEADER_PROBE_LIMIT: usize = 8192;
/// How much of the API error body to surface in voice-error text.
const ERROR_BODY_TAIL: usize = 300;

// ── shared config / key file ─────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct FishConfig {
    /// Bearer token; None until `fish-api-key` file or FISH_API_KEY supplies it.
    pub api_key: Option<String>,
    /// e.g. https://api.fish.audio (LUNA_FISH_API_BASE overrides — tests too).
    pub api_base: String,
    /// `model:` request header value (LUNA_FISH_MODEL overrides).
    pub model: String,
    /// Voice model id; None = Fish's default voice.
    pub reference_id: Option<String>,
}

pub type SharedFishConfig = Arc<Mutex<FishConfig>>;

pub fn shared_config(cfg: FishConfig) -> SharedFishConfig {
    Arc::new(Mutex::new(cfg))
}

fn luna_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
    Ok(std::path::PathBuf::from(home).join(".luna"))
}

pub fn fish_key_path() -> Result<std::path::PathBuf, String> {
    Ok(luna_dir()?.join("fish-api-key"))
}

/// Boot-time config: key from FISH_API_KEY, else ~/.luna/fish-api-key.
/// Endpoint/model defaults are overridable for tests and paid tiers.
pub fn load_fish_config() -> FishConfig {
    let api_key = std::env::var("FISH_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            fish_key_path()
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    FishConfig {
        api_key,
        api_base: std::env::var("LUNA_FISH_API_BASE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| FISH_DEFAULT_BASE.to_string()),
        model: std::env::var("LUNA_FISH_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| FISH_DEFAULT_MODEL.to_string()),
        reference_id: None,
    }
}

/// Atomic 0600 write — same contract as client_config.rs's writer (that one
/// lives in the bin crate; this dup keeps the lib self-contained).
fn write_atomic_0600(path: &std::path::Path, body: &str) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let dir = path
        .parent()
        .ok_or_else(|| "path has no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(
        ".luna-atomic.{}.{}.tmp",
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
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename failed: {e}")
    })?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod failed: {e}"))?;
    Ok(())
}

/// Persist the key (0600); empty/blank deletes the file.
pub fn persist_fish_key(key: &str) -> Result<(), String> {
    let path = fish_key_path()?;
    let key = key.trim();
    if key.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove fish-api-key failed: {e}")),
        }
    } else {
        write_atomic_0600(&path, &(key.to_string() + "\n"))
    }
}

// ── WAV stream parsing ───────────────────────────────────────────────────

/// Parsed WAV/PCM16 stream header plus the byte offset where frames begin.
#[derive(Debug, Clone, Copy, PartialEq)]
struct WavInfo {
    rate: u32,
    channels: u16,
    data_offset: usize,
}

fn le_u16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// Incremental RIFF/WAVE header parse. `Ok(None)` = need more bytes;
/// `Err` = definitively not a WAV stream (an API error body). Handles
/// non-canonical chunks (`LIST`, `fact`, JUNK) by skipping id+size pairs;
/// requires PCM (format 1 or 0xFFFE) 16-bit — what we request.
fn try_parse_wav_header(b: &[u8]) -> Result<Option<WavInfo>, String> {
    if b.len() < 12 {
        return Ok(None);
    }
    if &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("response is not a WAV stream".to_string());
    }
    let mut off = 12usize;
    let mut fmt: Option<(u16, u32)> = None; // (channels, rate)
    loop {
        if b.len() < off + 8 {
            return Ok(None);
        }
        let id = &b[off..off + 4];
        let size = le_u32(&b[off + 4..off + 8]) as usize;
        match id {
            b"fmt " => {
                if b.len() < off + 8 + 16 {
                    return Ok(None);
                }
                let f = &b[off + 8..];
                let format = le_u16(&f[0..2]);
                let channels = le_u16(&f[2..4]);
                let rate = le_u32(&f[4..8]);
                let bits = le_u16(&f[14..16]);
                if !matches!(format, 1 | 0xfffe) || bits != 16 || channels == 0 {
                    return Err(format!(
                        "unsupported WAV layout (format {format}, {bits}-bit, {channels} ch) — expected PCM16"
                    ));
                }
                fmt = Some((channels, rate));
                // Chunk bodies are 2-byte aligned.
                off += 8 + size + (size & 1);
            }
            b"data" => {
                let (channels, rate) = fmt.ok_or_else(|| {
                    "WAV data chunk before fmt".to_string()
                })?;
                return Ok(Some(WavInfo {
                    rate,
                    channels,
                    data_offset: off + 8,
                }));
            }
            _ => {
                off += 8 + size + (size & 1);
            }
        }
    }
}

/// s16le bytes → mono f32; `carry` holds a split byte across chunk edges.
fn pcm_bytes_to_f32(carry: &mut Option<u8>, bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut i = 0usize;
    if let Some(lo) = carry.take() {
        if let Some(&hi) = bytes.first() {
            out.push(i16::from_le_bytes([lo, hi]) as f32 / 32768.0);
            i = 1;
        } else {
            *carry = Some(lo);
        }
    }
    while i + 1 < bytes.len() {
        out.push(i16::from_le_bytes([bytes[i], bytes[i + 1]]) as f32 / 32768.0);
        i += 2;
    }
    if i < bytes.len() {
        *carry = Some(bytes[i]);
    }
    out
}

// ── engine ───────────────────────────────────────────────────────────────

enum Cmd {
    Speak { text: String, interrupt: bool },
    Stop,
    Shutdown,
}

type SharedSink = Arc<Mutex<Box<dyn AudioSink>>>;

/// Outcome of one synthesis pump; the worker turns Err into voice-error.
type PumpReport = Result<(), String>;

/// Shared kill slot: the worker takes the Child to kill+wait on stop;
/// the pump reclaims it to `wait()` on natural EOF (std::process::Child is
/// not reaped by Drop — without this slot every sentence leaves a zombie
/// or an unkillable process).
type ChildSlot = Arc<Mutex<Option<Child>>>;

/// Fish Audio TTS engine handle. Audio + HTTP live on the worker thread
/// and its per-sentence pump; this struct is channels + shared state.
pub struct FishTts {
    tx: mpsc::Sender<Cmd>,
    speaking: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    config: SharedFishConfig,
}

type SinkFactory = Box<dyn Fn() -> Result<Box<dyn AudioSink>, String> + Send>;

impl FishTts {
    /// Production engine: cpal output via CpalSink, errors → voice-error.
    pub fn new(config: SharedFishConfig, events: Option<Arc<dyn EventSink>>) -> Self {
        Self::with_sink_factory(
            config,
            events,
            Box::new(|| CpalSink::open().map(|s| Box::new(s) as Box<dyn AudioSink>)),
        )
    }

    /// Engine with an injectable sink factory (tests pass QueueSink).
    pub fn with_sink_factory(
        config: SharedFishConfig,
        events: Option<Arc<dyn EventSink>>,
        factory: SinkFactory,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        let speaking = Arc::new(AtomicBool::new(false));
        let flag = speaking.clone();
        let cfg = config.clone();
        let worker = std::thread::Builder::new()
            .name("luna-voice-fish".to_string())
            .spawn(move || worker_main(rx, flag, cfg, events, factory));
        let worker = match worker {
            Ok(h) => Some(h),
            Err(e) => {
                eprintln!("voice/tts-fish: failed to spawn TTS worker thread: {e}");
                None
            }
        };
        Self {
            tx,
            speaking,
            worker,
            config,
        }
    }
}

impl TtsEngine for FishTts {
    fn speak(&mut self, text: &str, interrupt: bool) {
        let text = text.trim();
        if text.is_empty() {
            if interrupt {
                let _ = self.tx.send(Cmd::Stop);
            }
            return;
        }
        let _ = self.tx.send(Cmd::Speak {
            text: text.to_string(),
            interrupt,
        });
    }

    fn stop(&mut self) {
        let _ = self.tx.send(Cmd::Stop);
    }

    fn is_speaking(&self) -> bool {
        self.speaking.load(Ordering::SeqCst)
    }

    fn speaking_flag(&self) -> Option<Arc<AtomicBool>> {
        Some(self.speaking.clone())
    }

    /// Voice catalog: the user's own models first, then top public voices —
    /// via curl GET /model (no worker round trip needed; plain blocking HTTP
    /// with its own timeout, bounded by the caller's LIST_TIMEOUT semantics).
    fn list_voices(&self) -> Vec<Voice> {
        let cfg = lock_unpoisoned(&self.config).clone();
        let key = match cfg.api_key.as_deref() {
            Some(k) if !k.is_empty() => k,
            _ => return Vec::new(), // unauthenticated catalog is useless to us
        };
        let mut out = fetch_models(&cfg, key, true);
        for v in fetch_models(&cfg, key, false) {
            if !out.iter().any(|e| e.id == v.id) {
                out.push(v);
            }
        }
        out
    }

    /// Voice = Fish `reference_id`. Blank resets to the default voice.
    /// Always reports applied-as-asked: ids are validated server-side at
    /// speak time (a 400 surfaces as voice-error), never by a sync lookup.
    fn set_voice(&mut self, id: &str) -> bool {
        let id = id.trim();
        lock_unpoisoned(&self.config).reference_id = if id.is_empty() {
            None
        } else {
            Some(id.to_string())
        };
        true
    }
}

impl Drop for FishTts {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Shutdown);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

// ── worker thread ────────────────────────────────────────────────────────

/// One in-flight synthesis: the pump thread streams curl's stdout into the
/// sink; `report_rx` delivers the single terminal result.
struct Pump {
    join: std::thread::JoinHandle<()>,
    report_rx: mpsc::Receiver<PumpReport>,
    child_slot: ChildSlot,
}

fn worker_main(
    rx: mpsc::Receiver<Cmd>,
    speaking: Arc<AtomicBool>,
    config: SharedFishConfig,
    events: Option<Arc<dyn EventSink>>,
    factory: SinkFactory,
) {
    let emit_err = |msg: &str| {
        eprintln!("voice/tts-fish: {msg}");
        if let Some(sink) = &events {
            sink.emit("voice-error", serde_json::json!({ "message": msg }));
        }
    };

    // Lazily opened on the first speak — a voice-off session (and every
    // system-engine user) never holds the output device.
    let mut sink: Option<SharedSink> = None;
    let mut pending: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut pump: Option<Pump> = None;
    let mut sink_error_reported = false;

    loop {
        match rx.recv_timeout(POLL) {
            Ok(Cmd::Speak { text, interrupt }) => {
                if interrupt {
                    pending.clear();
                    stop_pump(&mut pump, &mut sink);
                }
                pending.push_back(text);
            }
            Ok(Cmd::Stop) => {
                pending.clear();
                stop_pump(&mut pump, &mut sink);
            }
            Ok(Cmd::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        // Reap a finished pump; surface its terminal error once.
        if let Some(p) = &pump {
            match p.report_rx.try_recv() {
                Ok(Ok(())) => pump = None,
                Ok(Err(msg)) => {
                    emit_err(&msg);
                    pump = None;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    // Pump died without reporting (panic); join to be sure.
                    pump = None;
                }
            }
        }

        // Start the next sentence. Sink opens on first use (and re-opens if
        // a previous open failed — a re-plugged device gets a fresh shot).
        if pump.is_none() {
            if let Some(text) = pending.pop_front() {
                if sink.is_none() {
                    match factory() {
                        Ok(s) => sink = Some(Arc::new(Mutex::new(s))),
                        Err(e) => {
                            if !sink_error_reported {
                                emit_err(&format!("voice output unavailable: {e}"));
                                sink_error_reported = true;
                            }
                            continue;
                        }
                    }
                }
                let s = sink.as_ref().expect("sink just opened").clone();
                match spawn_pump(&config, s, text) {
                    Ok(p) => pump = Some(p),
                    Err(e) => emit_err(&e),
                }
            }
        }

        speaking.store(
            !pending.is_empty()
                || pump.is_some()
                || sink.as_ref().map(|s| lock_unpoisoned(s).has_pending()).unwrap_or(false),
            Ordering::SeqCst,
        );
    }

    stop_pump(&mut pump, &mut sink);
    speaking.store(false, Ordering::SeqCst);
}

fn stop_pump(pump: &mut Option<Pump>, sink: &mut Option<SharedSink>) {
    if let Some(p) = pump.take() {
        if let Some(mut child) = lock_unpoisoned(&p.child_slot).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = p.join.join();
    }
    if let Some(s) = sink {
        lock_unpoisoned(s).flush();
    }
}

/// Build the curl invocation + spawn it for one sentence.
fn spawn_pump(
    config: &SharedFishConfig,
    sink: SharedSink,
    text: String,
) -> Result<Pump, String> {
    let cfg = lock_unpoisoned(config).clone();
    let key = cfg.api_key.clone().ok_or_else(|| {
        "Fish voice needs an API key — add it under Settings → Voice".to_string()
    })?;

    // Mono PCM16 at the sink rate when the API supports it directly
    // (8/16/24/32/44.1k), else nearest supported rate + local resample.
    let sink_rate = lock_unpoisoned(&sink).rate();
    let request_rate = match sink_rate {
        r @ (8000 | 16000 | 24000 | 32000 | 44100) => r,
        _ => 44100,
    };

    let mut body = serde_json::json!({
        "text": text,
        "format": "wav",
        "sample_rate": request_rate,
        "latency": "normal",
        "normalize": true,
    });
    if let Some(id) = cfg.reference_id.as_deref() {
        body["reference_id"] = serde_json::Value::String(id.to_string());
    }

    let mut child = Command::new("curl")
        .args([
            "-sS",
            "-X",
            "POST",
            &format!("{}/v1/tts", cfg.api_base),
            "-H",
            &format!("Authorization: Bearer {key}"),
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("model: {}", cfg.model),
            "--data",
            &body.to_string(),
            "--max-time",
            &CURL_MAX_TIME_SECS.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn curl for Fish TTS: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "curl stdout not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "curl stderr not piped".to_string())?;

    let child_slot: ChildSlot = Arc::new(Mutex::new(Some(child)));
    let (report_tx, report_rx) = mpsc::channel();
    let slot = child_slot.clone();
    let join = std::thread::Builder::new()
        .name("luna-voice-fish-pump".to_string())
        .spawn(move || {
            let result = pump_main(stdout, stderr, sink, sink_rate);
            // Reap the child so no zombie outlives the sentence. The slot is
            // empty when the worker already kill+waited it (stop/interrupt).
            if let Some(mut c) = lock_unpoisoned(&slot).take() {
                let _ = c.wait();
            }
            let _ = report_tx.send(result);
        })
        .map_err(|e| {
            let _ = lock_unpoisoned(&child_slot).take().map(|mut c| {
                let _ = c.kill();
                let _ = c.wait();
            });
            format!("failed to spawn Fish TTS pump thread: {e}")
        })?;

    Ok(Pump {
        join,
        report_rx,
        child_slot,
    })
}

/// Read curl stdout: WAV header first (errors → the JSON body as text),
/// then PCM frames → f32 → resample → sink, chunk by chunk as they arrive.
fn pump_main(
    mut stdout: impl Read,
    mut stderr: impl Read,
    sink: SharedSink,
    sink_rate: u32,
) -> PumpReport {
    let mut header_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut wav: Option<WavInfo> = None;
    let mut resampler: Option<StreamingResampler> = None;
    let mut byte_carry: Option<u8> = None;
    let mut stderr_tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];

    loop {
        let n = match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            // Interrupted/killed child: read fails or EOFs — treat as done;
            // the exit-status check below decides error vs. clean stop.
            Err(_) => break,
        };
        let bytes = &chunk[..n];

        if wav.is_none() {
            header_buf.extend_from_slice(bytes);
            match try_parse_wav_header(&header_buf) {
                Ok(Some(info)) => {
                    wav = Some(info);
                    if info.rate != sink_rate {
                        resampler = Some(StreamingResampler::new(
                            info.rate as f64,
                            sink_rate as f64,
                        ));
                    }
                    let pcm = pcm_bytes_to_f32(&mut byte_carry, &header_buf[info.data_offset..]);
                    write_pcm(&sink, info.channels, resampler.as_mut(), pcm);
                }
                Ok(None) => {
                    if header_buf.len() > WAV_HEADER_PROBE_LIMIT {
                        let body = String::from_utf8_lossy(&header_buf);
                        return Err(format!(
                            "Fish TTS failed: {}",
                            error_body_summary(&body)
                        ));
                    }
                }
                Err(_) => {
                    // Not a WAV stream: the API returned an error body
                    // (JSON {"status":…,"message":…}). Read it to the end.
                    let mut rest = Vec::new();
                    let _ = stdout.read_to_end(&mut rest);
                    header_buf.extend_from_slice(&rest);
                    let body = String::from_utf8_lossy(&header_buf);
                    return Err(format!("Fish TTS failed: {}", error_body_summary(&body)));
                }
            }
            continue;
        }

        let pcm = pcm_bytes_to_f32(&mut byte_carry, bytes);
        let info = wav.expect("wav set");
        write_pcm(&sink, info.channels, resampler.as_mut(), pcm);
    }

    // Drain whatever curl said on stderr (small: -sS writes only errors).
    let mut se = Vec::new();
    let _ = stderr.read_to_end(&mut se);
    stderr_tail.extend_from_slice(&se);
    let stderr_text = String::from_utf8_lossy(&stderr_tail);
    let stderr_text = stderr_text.trim();
    if !stderr_text.is_empty() && wav.is_none() {
        return Err(format!("Fish TTS failed: {stderr_text}"));
    }
    Ok(())
}

fn write_pcm(
    sink: &SharedSink,
    channels: u16,
    resampler: Option<&mut StreamingResampler>,
    pcm: Vec<f32>,
) {
    if pcm.is_empty() {
        return;
    }
    let mono = if channels > 1 {
        downmix_mono(&pcm, channels as usize)
    } else {
        pcm
    };
    let out = match resampler {
        Some(r) => r.process(&mono),
        None => mono,
    };
    if !out.is_empty() {
        lock_unpoisoned(sink).write(&out);
    }
}

/// Compact the API error body for a voice-error line: prefer the JSON
/// `message` field; otherwise a bounded tail of raw text.
fn error_body_summary(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    let t = body.trim();
    if t.len() > ERROR_BODY_TAIL {
        format!("{}…", &t[..ERROR_BODY_TAIL])
    } else if t.is_empty() {
        "empty response body".to_string()
    } else {
        t.to_string()
    }
}

/// `GET {base}/model` → Voice list. `self=true` for the account's own
/// models, `false`+task_count for the public catalog. Empty on any failure.
fn fetch_models(cfg: &FishConfig, key: &str, own: bool) -> Vec<Voice> {
    let url = if own {
        format!("{}/model?self=true&page_size=100", cfg.api_base)
    } else {
        format!("{}/model?sort_by=task_count&page_size=40", cfg.api_base)
    };
    let out = Command::new("curl")
        .args([
            "-sS",
            "-X",
            "GET",
            &url,
            "-H",
            &format!("Authorization: Bearer {key}"),
            "--max-time",
            &LIST_CURL_MAX_TIME_SECS.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            eprintln!(
                "voice/tts-fish: model list failed (status {}): {}",
                o.status,
                String::from_utf8_lossy(&o.stdout).chars().take(200).collect::<String>()
            );
            return Vec::new();
        }
        Err(e) => {
            eprintln!("voice/tts-fish: model list spawn failed: {e}");
            return Vec::new();
        }
    };
    parse_model_list(&out)
}

/// `{items:[{_id,title,languages[]}]}` → engine Voice entries.
fn parse_model_list(body: &[u8]) -> Vec<Voice> {
    let v: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(items) = v.get("items").and_then(|i| i.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|m| {
            let id = m.get("_id").and_then(|s| s.as_str())?;
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let lang = m
                .get("languages")
                .and_then(|l| l.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            Some(Voice {
                id: id.to_string(),
                name,
                lang,
                quality: "default".to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::playback::QueueSink;

    // -- wav header parse --------------------------------------------------

    fn wav_bytes(rate: u32, channels: u16, pcm: &[i16]) -> Vec<u8> {
        // Canonical 44-byte header + PCM16 data.
        let mut b = Vec::new();
        let data_len = (pcm.len() * 2) as u32;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes()); // byte rate
        b.extend_from_slice(&(channels * 2).to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes()); // bits
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        for s in pcm {
            b.extend_from_slice(&s.to_le_bytes());
        }
        b
    }

    #[test]
    fn parses_canonical_header() {
        let b = wav_bytes(44100, 1, &[0, 1000, -1000]);
        let info = match try_parse_wav_header(&b) {
            Ok(Some(i)) => i,
            other => panic!("expected parsed header, got {other:?}"),
        };
        assert_eq!(info.rate, 44100);
        assert_eq!(info.channels, 1);
        assert_eq!(info.data_offset, 44);
    }

    #[test]
    fn header_needs_more_bytes_until_data_chunk() {
        let b = wav_bytes(44100, 1, &[7]);
        for cut in [4, 12, 30, 43] {
            match try_parse_wav_header(&b[..cut]) {
                Ok(None) => {}
                other => panic!("cut {cut}: expected need-more, got {other:?}"),
            }
        }
    }

    #[test]
    fn skips_unknown_chunks_before_data() {
        // RIFF + JUNK + fmt + data.
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"JUNK");
        b.extend_from_slice(&3u32.to_le_bytes()); // odd size → pad byte
        b.extend_from_slice(&[1, 2, 3, 0]);
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&22050u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&4u32.to_le_bytes());
        b.extend_from_slice(&[1, 0, 2, 0]);
        let info = try_parse_wav_header(&b).unwrap().unwrap();
        assert_eq!(info.rate, 22050);
        assert_eq!(info.channels, 1);
        // JUNK(8+4=12) + fmt(8+16=24) after RIFF(12) → data payload at 12+12+24+8 = 56
        assert_eq!(info.data_offset, 56);
    }

    #[test]
    fn non_riff_body_is_an_error_not_pending() {
        let body = br#"{"status":401,"message":"bad key"}"#;
        match try_parse_wav_header(body) {
            Err(e) => assert!(e.contains("not a WAV")),
            other => panic!("expected Err, got {other:?}"),
        }
    }

    #[test]
    fn pcm_bytes_decodes_and_carries_split_sample() {
        let mut carry = None;
        let out = pcm_bytes_to_f32(&mut carry, &[0x00, 0x40, 0xFF]); // 0x4000 + split 0xFF
        assert_eq!(out.len(), 1);
        assert!((out[0] - (0x4000 as f32 / 32768.0)).abs() < 1e-7);
        assert_eq!(carry, Some(0xFF));
        let out2 = pcm_bytes_to_f32(&mut carry, &[0xC0]); // -0x3F01+... → 0xC0FF
        assert_eq!(out2.len(), 1);
        assert!((out2[0] - (i16::from_le_bytes([0xFF, 0xC0]) as f32 / 32768.0)).abs() < 1e-7);
        assert_eq!(carry, None);
    }

    #[test]
    fn error_body_summary_prefers_json_message() {
        let j = r#"{"status":401,"message":"invalid api key"}"#;
        assert_eq!(error_body_summary(j), "invalid api key");
        assert_eq!(error_body_summary("  boom "), "boom");
        assert_eq!(error_body_summary(""), "empty response body");
    }

    // -- model list parse ---------------------------------------------------

    #[test]
    fn parse_model_list_maps_items() {
        let body = br#"{"total":2,"items":[
            {"_id":"abc","title":"Aria","languages":["en","zh"]},
            {"_id":"def","title":"Bob"},
            {"noId":"skip"}]}"#;
        let v = parse_model_list(body);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].id, "abc");
        assert_eq!(v[0].name, "Aria");
        assert_eq!(v[0].lang, "en,zh");
        assert_eq!(v[1].lang, "");
    }

    #[test]
    fn parse_model_list_garbage_is_empty() {
        assert!(parse_model_list(b"not json").is_empty());
        assert!(parse_model_list(b"{}").is_empty());
    }

    // -- engine e2e over a stub HTTP server ---------------------------------

    /// Serve `n` HTTP requests on 127.0.0.1, each returning `response`;
    /// returns the bound port. Bodies are bytes — a WAV or a JSON error.
    fn stub_http(responses: Vec<Vec<u8>>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::Read as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for response in responses {
                let Ok((mut conn, _)) = listener.accept() else {
                    return;
                };
                let mut req = [0u8; 8192];
                // Read the request headers (body may follow; curl writes it
                // in the same segment for our small JSON payloads).
                let _ = conn.read(&mut req);
                let _ = conn.write_all(&response);
            }
        });
        (port, handle)
    }

    fn http_ok_wav(wav: &[u8]) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
            wav.len()
        )
        .into_bytes()
        .into_iter()
        .chain(wav.iter().copied())
        .collect()
    }

    fn test_config(base: String, key: Option<&str>) -> SharedFishConfig {
        shared_config(FishConfig {
            api_key: key.map(|k| k.to_string()),
            api_base: base,
            model: "test-model".to_string(),
            reference_id: None,
        })
    }

    #[test]
    fn speaks_wav_from_http_into_sink() {
        // 0.25s of 16k samples through a real curl→stub→parse→sink path.
        let pcm: Vec<i16> = (0..4000).map(|i| ((i % 100) as i16 - 50) * 300).collect();
        let wav = wav_bytes(16000, 1, &pcm);
        let (port, server) = stub_http(vec![http_ok_wav(&wav)]);
        let cfg = test_config(format!("http://127.0.0.1:{port}"), Some("k"));

        let collected: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let c = collected.clone();
        let mut tts = FishTts::with_sink_factory(
            cfg,
            None,
            Box::new(move || {
                struct CollectSink(Arc<Mutex<Vec<f32>>>);
                impl AudioSink for CollectSink {
                    fn write(&mut self, s: &[f32]) {
                        self.0.lock().unwrap().extend_from_slice(s);
                    }
                    fn rate(&self) -> u32 {
                        16000 // request-rate hit: no resample
                    }
                    fn has_pending(&self) -> bool {
                        false
                    }
                    fn flush(&mut self) {}
                }
                Ok(Box::new(CollectSink(c.clone())))
            }),
        );
        let _ = &collected;
        tts.speak("hello there", false);
        let t0 = std::time::Instant::now();
        while collected.lock().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Give the pump a beat to finish the tail.
        std::thread::sleep(Duration::from_millis(150));
        let got = collected.lock().unwrap().clone();
        assert_eq!(got.len(), 4000, "all wav samples must reach the sink");
        let expect0 = pcm[0] as f32 / 32768.0;
        assert!((got[0] - expect0).abs() < 1e-6);
        drop(tts);
        let _ = server.join();
    }

    #[test]
    fn missing_key_reports_voice_error() {
        let events: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        struct TestSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
        impl EventSink for TestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.0.lock().unwrap().push((event.to_string(), payload));
            }
        }
        let es = events.clone();
        let mut tts = FishTts::with_sink_factory(
            test_config("http://127.0.0.1:1".to_string(), None),
            Some(Arc::new(TestSink(es))),
            Box::new(|| Ok(Box::new(QueueSink::new(44100)))),
        );
        tts.speak("needs a key", false);
        let t0 = std::time::Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _)| e == "voice-error")
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ev = events.lock().unwrap();
        let msg = ev
            .iter()
            .find(|(e, _)| e == "voice-error")
            .map(|(_, p)| p["message"].as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        assert!(msg.contains("API key"), "expected key error, got: {msg}");
    }

    #[test]
    fn http_error_body_surfaces_as_voice_error() {
        let body = br#"{"status":401,"message":"invalid api key"}"#.to_vec();
        let resp = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body)
        .collect();
        let (port, server) = stub_http(vec![resp]);
        let events: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        struct TestSink(Arc<Mutex<Vec<(String, serde_json::Value)>>>);
        impl EventSink for TestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.0.lock().unwrap().push((event.to_string(), payload));
            }
        }
        let es = events.clone();
        let mut tts = FishTts::with_sink_factory(
            test_config(format!("http://127.0.0.1:{port}"), Some("bad")),
            Some(Arc::new(TestSink(es))),
            Box::new(|| Ok(Box::new(QueueSink::new(44100)))),
        );
        tts.speak("will fail", false);
        let t0 = std::time::Instant::now();
        while t0.elapsed() < Duration::from_secs(10) {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _)| e == "voice-error")
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ev = events.lock().unwrap();
        let msg = ev
            .iter()
            .find(|(e, _)| e == "voice-error")
            .map(|(_, p)| p["message"].as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        assert!(msg.contains("invalid api key"), "expected api error text, got: {msg}");
        drop(tts);
        let _ = server.join();
    }

    #[test]
    fn stop_kills_in_flight_request() {
        // A server that accepts then hangs: Stop must release the engine
        // promptly (curl --max-time is the backstop at 45s).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((conn, _)) = listener.accept() {
                std::thread::sleep(Duration::from_secs(30));
                drop(conn);
            }
        });
        let mut tts = FishTts::with_sink_factory(
            test_config(format!("http://127.0.0.1:{port}"), Some("k")),
            None,
            Box::new(|| Ok(Box::new(QueueSink::new(44100)))),
        );
        tts.speak("stuck request", false);
        std::thread::sleep(Duration::from_millis(200));
        let t0 = std::time::Instant::now();
        tts.stop();
        // Engine must be quiet immediately after stop.
        std::thread::sleep(Duration::from_millis(150));
        assert!(!tts.is_speaking(), "stop must clear the speaking flag");
        assert!(t0.elapsed() < Duration::from_secs(3));
        drop(tts);
        drop(server);
    }

    // -- live API smoke (opt-in) --------------------------------------------

    /// Real api.fish.audio round trip: skipped unless FISH_API_KEY is set.
    /// Collects PCM through the actual curl→WAV-parse→sink path (no playback
    /// device needed — the factory injects a capturing sink).
    #[test]
    fn live_fish_api_speaks_pcm() {
        let key = match std::env::var("FISH_API_KEY") {
            Ok(k) if !k.trim().is_empty() => k,
            _ => {
                eprintln!("live_fish_api_speaks_pcm: FISH_API_KEY unset — skipping");
                return;
            }
        };
        let cfg = shared_config(FishConfig {
            api_key: Some(key),
            api_base: FISH_DEFAULT_BASE.to_string(),
            model: FISH_DEFAULT_MODEL.to_string(),
            reference_id: None,
        });
        let collected: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let c = collected.clone();
        let mut tts = FishTts::with_sink_factory(
            cfg,
            None,
            Box::new(move || {
                struct CollectSink(Arc<Mutex<Vec<f32>>>);
                impl AudioSink for CollectSink {
                    fn write(&mut self, s: &[f32]) {
                        self.0.lock().unwrap().extend_from_slice(s);
                    }
                    fn rate(&self) -> u32 {
                        44100
                    }
                    fn has_pending(&self) -> bool {
                        false
                    }
                    fn flush(&mut self) {}
                }
                Ok(Box::new(CollectSink(c.clone())))
            }),
        );
        tts.speak("Luna voice pipeline end to end.", false);
        let t0 = std::time::Instant::now();
        while collected.lock().unwrap().is_empty() && t0.elapsed() < Duration::from_secs(45) {
            std::thread::sleep(Duration::from_millis(25));
        }
        // Let the tail finish streaming in.
        while tts.is_speaking() && t0.elapsed() < Duration::from_secs(45) {
            std::thread::sleep(Duration::from_millis(25));
        }
        let got = collected.lock().unwrap().clone();
        // Any real utterance is well over half a second of 44.1kHz PCM.
        assert!(
            got.len() > 20_000,
            "expected real PCM from api.fish.audio, got {} samples",
            got.len()
        );
        assert!(got.iter().any(|s| s.abs() > 0.001), "PCM was all silence");
        drop(tts);
    }
}
