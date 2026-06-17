//! VoiceController: the Rust-owned voice state machine per VOICE.md.
//!
//! States: `off → starting → idle ⇄ listening → transcribing → idle` plus
//! `speaking` (TTS active) and `error` (terminal until the next mode change).
//! Modes: `off | ptt | auto`.
//!
//! The entire audio loop runs on ONE dedicated std::thread (the "pipeline
//! thread") which owns the cpal stream (cpal Streams are !Send), the VAD
//! endpointer, and the whisper engine. The controller feeds it control
//! messages over std::sync::mpsc and shares a lean snapshot through
//! `Arc<Mutex<Shared>>`. Events reach the webview through an [`EventSink`]
//! which the app implements with `emit_to(EventTarget::labeled("main"), …)`,
//! exactly like the luna-config seed emit in main.rs.
//!
//! Half-duplex rule (auto mode, no AEC in v1): while TTS is speaking, mic
//! chunks are READ but DISCARDED; listening re-arms ~300ms after speech ends.

pub mod capture;
pub mod endpoint;
pub mod model;
pub mod stt;
pub mod tts;
// `feature = "voice"` is implied (lib.rs gates the whole voice module on it)
// but spelled out so the compilation condition is readable here.
#[cfg(all(feature = "voice", target_os = "macos"))]
pub mod tts_avspeech;

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::json;

use capture::AudioSource;
use endpoint::{clamp_silence_hang_ms, Endpointer, DEFAULT_SILENCE_HANG_MS, VAD_CHUNK};
use stt::SttEngine;
use tts::{TtsEngine, Voice};

/// Listening re-arms this long after TTS playback ends (lets the room's
/// echo of Luna's last word die before the mic re-opens).
const REARM_MS: u64 = 300;
/// Level (RMS) events while listening are throttled to ~10Hz.
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
/// How long one pipeline tick blocks waiting for mic data; also the worst-
/// case latency for reacting to a control message.
const SOURCE_TIMEOUT: Duration = Duration::from_millis(50);

/// Recover a poisoned lock instead of erroring: all shared voice state is
/// plain data with no invariant a panic could break mid-update.
pub(crate) fn lock_unpoisoned<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ── modes / states ───────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoiceMode {
    Off,
    Ptt,
    Auto,
}

impl VoiceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceMode::Off => "off",
            VoiceMode::Ptt => "ptt",
            VoiceMode::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(VoiceMode::Off),
            "ptt" => Some(VoiceMode::Ptt),
            "auto" => Some(VoiceMode::Auto),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoiceState {
    Off,
    Starting,
    Idle,
    Listening,
    Transcribing,
    Speaking,
    Error,
}

impl VoiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceState::Off => "off",
            VoiceState::Starting => "starting",
            VoiceState::Idle => "idle",
            VoiceState::Listening => "listening",
            VoiceState::Transcribing => "transcribing",
            VoiceState::Speaking => "speaking",
            VoiceState::Error => "error",
        }
    }
}

/// Snapshot returned by `voice_status` / `voice_set_mode`.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub state: String,
    pub mode: String,
    pub model_present: bool,
    pub silence_hang_ms: u32,
}

// ── event sink ───────────────────────────────────────────────────────────

/// Where voice events go. The app implements this on AppHandle; tests
/// collect into a Vec.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Production sink: BROADCAST to every window (Phase 3). Voice events are
/// global telemetry (state/transcript/progress/errors) with no per-window
/// state, so any window may render them — the hub paints the moon's
/// data-voice-state, the settings.voice panel paints model progress. The
/// window-targeted discipline (`for:` payloads) stays reserved for events
/// that carry per-window state, like dock-group.
impl<R: tauri::Runtime> EventSink for tauri::AppHandle<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = tauri::Emitter::emit(self, event, payload);
    }
}

// ── injectable dependencies ──────────────────────────────────────────────

/// Factories invoked ON the pipeline thread (cpal streams and the ONNX VAD
/// session never cross threads; whisper load takes hundreds of ms and
/// belongs off the command path). Injectable so controller tests run with
/// mocks and no audio device.
pub struct VoiceDeps {
    pub stt_factory: Box<dyn Fn() -> Result<Box<dyn SttEngine>, String> + Send + Sync>,
    pub source_factory: Box<dyn Fn() -> Result<Box<dyn AudioSource>, String> + Send + Sync>,
    pub probe_factory:
        Box<dyn Fn() -> Result<Box<dyn FnMut(&[f32]) -> f32>, String> + Send + Sync>,
    pub model_present: Box<dyn Fn() -> bool + Send + Sync>,
}

// ── controller ───────────────────────────────────────────────────────────

enum Ctrl {
    PttDown,
    PttUp,
    Cancel,
    SetHang(u32),
    Stop,
}

struct Shared {
    state: VoiceState,
    mode: VoiceMode,
    silence_hang_ms: u32,
}

struct PipelineHandle {
    tx: mpsc::Sender<Ctrl>,
    join: std::thread::JoinHandle<()>,
}

pub struct VoiceController {
    shared: Arc<Mutex<Shared>>,
    sink: Arc<dyn EventSink>,
    deps: Arc<VoiceDeps>,
    tts: Arc<Mutex<Box<dyn TtsEngine>>>,
    pipeline: Mutex<Option<PipelineHandle>>,
    /// Control-channel sender kept OUTSIDE the pipeline-handle Mutex:
    /// `set_mode` holds `pipeline` across a join that can ride through a
    /// whole whisper inference, and the global PTT shortcut handler runs on
    /// the macOS main thread — `send()` must never block behind that join
    /// (a blocked main thread freezes the whole app). This lock is only ever
    /// held for a non-blocking mpsc send or a pointer swap.
    ctrl_tx: Mutex<Option<mpsc::Sender<Ctrl>>>,
}

impl VoiceController {
    pub fn new(sink: Arc<dyn EventSink>, deps: VoiceDeps, tts: Box<dyn TtsEngine>) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                state: VoiceState::Off,
                mode: VoiceMode::Off,
                silence_hang_ms: DEFAULT_SILENCE_HANG_MS,
            })),
            sink,
            deps: Arc::new(deps),
            tts: Arc::new(Mutex::new(tts)),
            pipeline: Mutex::new(None),
            ctrl_tx: Mutex::new(None),
        }
    }

    /// Real wiring: cpal mic, Silero VAD, whisper from ~/.luna/models, and
    /// the platform TTS factory.
    pub fn production(sink: Arc<dyn EventSink>) -> Self {
        let deps = VoiceDeps {
            stt_factory: Box::new(|| {
                let path = model::model_path()?;
                let engine = stt::WhisperEngine::load(&path.to_string_lossy())?;
                Ok(Box::new(engine) as Box<dyn SttEngine>)
            }),
            source_factory: Box::new(|| {
                Ok(Box::new(capture::CpalSource::start()?) as Box<dyn AudioSource>)
            }),
            probe_factory: Box::new(|| {
                Ok(Box::new(endpoint::silero_probe()?) as Box<dyn FnMut(&[f32]) -> f32>)
            }),
            model_present: Box::new(model::model_present),
        };
        Self::new(sink, deps, tts::create_platform_tts())
    }

    pub fn status(&self) -> VoiceStatus {
        let s = lock_unpoisoned(&self.shared);
        VoiceStatus {
            state: s.state.as_str().to_string(),
            mode: s.mode.as_str().to_string(),
            model_present: (self.deps.model_present)(),
            silence_hang_ms: s.silence_hang_ms,
        }
    }

    /// [`set_mode_with_sync`]: Start/stop the pipeline thread. With a missing
    /// model this emits voice-error("model missing") and stays off — the
    /// frontend drives voice_ensure_model first, then retries
    /// (startModelDownload re-applies the chosen mode after a successful
    /// download). Pass `|_| {}` as the sync callback when no shortcut
    /// registration sync is needed.
    ///
    /// `sync` is invoked with the EFFECTIVE mode
    /// while the pipeline lock is still held. The app hangs the global PTT
    /// shortcut register/unregister on this: syncing AFTER set_mode returned
    /// was a TOCTOU — two interleaved mode changes could complete in one
    /// order but run their shortcut syncs in the other, leaving
    /// Cmd+Shift+Space registered system-wide while voice was off. Under the
    /// lock, the last completed mode change is always the last sync, and the
    /// register/unregister decision itself is serialized.
    pub fn set_mode_with_sync(
        &self,
        mode_str: &str,
        sync: impl FnOnce(VoiceMode),
    ) -> Result<VoiceStatus, String> {
        let mode = VoiceMode::parse(mode_str)
            .ok_or_else(|| format!("unknown voice mode: {mode_str}"))?;

        let mut pipe = lock_unpoisoned(&self.pipeline);
        let (cur_mode, cur_state) = {
            let s = lock_unpoisoned(&self.shared);
            (s.mode, s.state)
        };
        let alive = pipe.as_ref().map(|p| !p.join.is_finished()).unwrap_or(false);

        // Idempotent re-set of the SAME healthy mode is a no-op. Re-setting
        // a mode whose pipeline died (state=error) restarts it — "error is
        // terminal until the next mode change".
        if mode == cur_mode
            && (mode == VoiceMode::Off || (alive && cur_state != VoiceState::Error))
        {
            sync(cur_mode); // harmless re-sync; heals registration drift
            return Ok(self.status());
        }

        // Tear down any existing pipeline (joins through an in-flight
        // transcription; bounded by one whisper inference). The ctrl_tx slot
        // is cleared FIRST so concurrent send()s become no-ops instead of
        // queueing onto a dying thread.
        if let Some(p) = pipe.take() {
            *lock_unpoisoned(&self.ctrl_tx) = None;
            let _ = p.tx.send(Ctrl::Stop);
            let _ = p.join.join();
        }

        if mode == VoiceMode::Off {
            lock_unpoisoned(&self.shared).mode = VoiceMode::Off;
            set_state_emit(&self.shared, &self.sink, VoiceState::Off);
            sync(VoiceMode::Off);
            return Ok(self.status());
        }

        if !(self.deps.model_present)() {
            lock_unpoisoned(&self.shared).mode = VoiceMode::Off;
            set_state_emit(&self.shared, &self.sink, VoiceState::Off);
            self.sink
                .emit("voice-error", json!({ "message": "model missing" }));
            // The EFFECTIVE mode is off: a requested ptt must NOT leave the
            // global chord registered.
            sync(VoiceMode::Off);
            return Ok(self.status());
        }

        lock_unpoisoned(&self.shared).mode = mode;
        set_state_emit(&self.shared, &self.sink, VoiceState::Starting);

        let (tx, rx) = mpsc::channel();
        let shared = self.shared.clone();
        let sink = self.sink.clone();
        let deps = self.deps.clone();
        let tts = self.tts.clone();
        let spawned = std::thread::Builder::new()
            .name("luna-voice-pipeline".to_string())
            .spawn({
                let shared = shared.clone();
                let sink = sink.clone();
                move || {
                    // Panic guard: native code (ort/Silero predict, whisper)
                    // can panic rather than return Err. Without this the UI
                    // would be stranded in `listening`/`transcribing` forever
                    // with no voice-error and dead controls.
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
                        let shared = shared.clone();
                        let sink = sink.clone();
                        move || pipeline_main(mode, shared, sink, deps, tts, rx)
                    }));
                    if let Err(p) = result {
                        let msg = p
                            .downcast_ref::<&str>()
                            .map(|s| s.to_string())
                            .or_else(|| p.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "unknown panic".to_string());
                        fail(&shared, &sink, format!("voice pipeline crashed: {msg}"));
                    }
                }
            });
        let join = match spawned {
            Ok(j) => j,
            Err(e) => {
                let msg = self.fail_spawn(format!("failed to spawn voice pipeline thread: {e}"));
                sync(VoiceMode::Off); // rolled back to off — unregister too
                return Err(msg);
            }
        };
        *lock_unpoisoned(&self.ctrl_tx) = Some(tx.clone());
        *pipe = Some(PipelineHandle { tx, join });

        sync(mode);
        Ok(self.status())
    }

    /// Spawn failure: roll the just-committed mode + `starting` state back to
    /// off and surface a voice-error — otherwise the moon shows `starting`
    /// forever and the frontend (which logs-and-swallows command rejections)
    /// never tells the user anything went wrong.
    fn fail_spawn(&self, msg: String) -> String {
        lock_unpoisoned(&self.shared).mode = VoiceMode::Off;
        set_state_emit(&self.shared, &self.sink, VoiceState::Off);
        self.sink
            .emit("voice-error", json!({ "message": msg.clone() }));
        msg
    }

    fn send(&self, msg: Ctrl) {
        // Deliberately NOT the pipeline-handle Mutex (held across teardown
        // joins): see the ctrl_tx field docs. Dead pipeline: harmless no-op.
        if let Some(tx) = lock_unpoisoned(&self.ctrl_tx).as_ref() {
            let _ = tx.send(msg);
        }
    }

    /// `ptt` mode only (the pipeline ignores it otherwise); begins capture.
    pub fn ptt_down(&self) {
        self.send(Ctrl::PttDown);
    }

    /// Ends the capture window → endpoint → transcribe.
    pub fn ptt_up(&self) {
        self.send(Ctrl::PttUp);
    }

    /// Discard in-flight capture/transcription.
    pub fn cancel(&self) {
        self.send(Ctrl::Cancel);
    }

    /// Endpointing tunables; clamped here (200–2000ms) per VOICE.md.
    pub fn set_config(&self, silence_hang_ms: Option<u32>) {
        if let Some(ms) = silence_hang_ms {
            let ms = clamp_silence_hang_ms(ms);
            lock_unpoisoned(&self.shared).silence_hang_ms = ms;
            self.send(Ctrl::SetHang(ms));
        }
    }

    /// Enqueue one sentence. No-op (returns Ok) when mode is off.
    pub fn speak_text(&self, text: &str, interrupt: bool) -> Result<(), String> {
        if lock_unpoisoned(&self.shared).mode == VoiceMode::Off {
            return Ok(());
        }
        lock_unpoisoned(&self.tts).speak(text, interrupt);
        Ok(())
    }

    pub fn stop_speaking(&self) {
        lock_unpoisoned(&self.tts).stop();
    }

    pub fn list_voices(&self) -> Vec<Voice> {
        lock_unpoisoned(&self.tts).list_voices()
    }

    /// Select a voice by id. Returns false when the engine fell back to the
    /// system default (unknown/stale id) — the app surfaces that as a
    /// voice-error so Settings can't keep showing a voice that isn't the
    /// one actually speaking.
    pub fn set_voice(&self, id: &str) -> bool {
        lock_unpoisoned(&self.tts).set_voice(id)
    }
}

impl Drop for VoiceController {
    fn drop(&mut self) {
        if let Some(p) = lock_unpoisoned(&self.pipeline).take() {
            *lock_unpoisoned(&self.ctrl_tx) = None;
            let _ = p.tx.send(Ctrl::Stop);
            let _ = p.join.join();
        }
    }
}

// ── pipeline thread ──────────────────────────────────────────────────────

fn set_state_emit(shared: &Arc<Mutex<Shared>>, sink: &Arc<dyn EventSink>, state: VoiceState) {
    let mode = {
        let mut s = lock_unpoisoned(shared);
        s.state = state;
        s.mode
    }; // guard dropped before emitting
    sink.emit(
        "voice-state",
        json!({ "state": state.as_str(), "mode": mode.as_str() }),
    );
}

/// Startup/stream failures: emit voice-error and park in the terminal error
/// state (the thread exits; the mode sticks until the next voice_set_mode).
fn fail(shared: &Arc<Mutex<Shared>>, sink: &Arc<dyn EventSink>, message: String) {
    sink.emit("voice-error", json!({ "message": message }));
    set_state_emit(shared, sink, VoiceState::Error);
}

/// Transcribe a closed utterance and emit the transcript. Pending control
/// messages that arrived DURING inference are drained into `pending`; a
/// Cancel among them discards this transcript (that is what "discard
/// in-flight transcription" means for a batch engine that cannot be
/// interrupted mid-inference). Empty/blank transcripts are never emitted.
/// A transcription error is reported but is NOT terminal — the pipeline
/// stays healthy for the next utterance.
fn finish_utterance(
    utt: endpoint::Utterance,
    stt: &mut Box<dyn SttEngine>,
    rx: &mpsc::Receiver<Ctrl>,
    pending: &mut VecDeque<Ctrl>,
    shared: &Arc<Mutex<Shared>>,
    sink: &Arc<dyn EventSink>,
) {
    set_state_emit(shared, sink, VoiceState::Transcribing);
    let result = stt.transcribe(&utt.samples);

    let mut cancelled = false;
    while let Ok(msg) = rx.try_recv() {
        match msg {
            // Cancel discards this transcript. Stop means the user turned
            // voice off MID-INFERENCE (mic-pause click, mode change) — the
            // transcript must be suppressed too, or the frontend auto-sends
            // speech the user explicitly stopped. Stop is still re-queued so
            // the main loop tears down as requested.
            Ctrl::Cancel => cancelled = true,
            Ctrl::Stop => {
                cancelled = true;
                pending.push_back(Ctrl::Stop);
            }
            other => pending.push_back(other),
        }
    }

    match result {
        Ok(text) => {
            let text = text.trim();
            if !cancelled && !text.is_empty() {
                sink.emit("voice-transcript", json!({ "text": text, "final": true }));
            }
        }
        Err(e) => {
            sink.emit(
                "voice-error",
                json!({ "message": format!("transcription failed: {e}") }),
            );
        }
    }
}

fn pipeline_main(
    mode: VoiceMode,
    shared: Arc<Mutex<Shared>>,
    sink: Arc<dyn EventSink>,
    deps: Arc<VoiceDeps>,
    tts: Arc<Mutex<Box<dyn TtsEngine>>>,
    rx: mpsc::Receiver<Ctrl>,
) {
    // `starting` was set by set_mode before the spawn. Heavy init first:
    let mut stt = match (deps.stt_factory)() {
        Ok(s) => s,
        Err(e) => return fail(&shared, &sink, format!("voice model load failed: {e}")),
    };
    let mut source = match (deps.source_factory)() {
        Ok(s) => s,
        Err(e) => return fail(&shared, &sink, e),
    };
    let probe = match (deps.probe_factory)() {
        Ok(p) => p,
        Err(e) => return fail(&shared, &sink, e),
    };
    let hang = lock_unpoisoned(&shared).silence_hang_ms;
    let mut ep = Endpointer::new(probe, hang);

    // Lock-free speaking flag when the engine offers one: the tts Mutex can
    // be held for seconds by a blocking list_voices round trip (first
    // speechVoices() call loads the whole registry) and must never stall the
    // pipeline tick — control handling, levels, and the half-duplex gate all
    // ride on it.
    let speaking_flag = lock_unpoisoned(&tts).speaking_flag();

    let auto = mode == VoiceMode::Auto;
    set_state_emit(&shared, &sink, VoiceState::Idle);
    if auto {
        // Hands-free: VAD arms continuously from the start.
        set_state_emit(&shared, &sink, VoiceState::Listening);
    }

    let mut held = false; // ptt: capture only between down/up
    let mut buf: Vec<f32> = Vec::new(); // 16k mono awaiting full VAD frames
    let mut pending: VecDeque<Ctrl> = VecDeque::new();
    let mut tts_speaking = false;
    let mut rearm_until: Option<Instant> = None;
    let mut last_level = Instant::now() - LEVEL_INTERVAL;

    'outer: loop {
        // 1. Control messages (re-queued ones first, then the channel).
        loop {
            let msg = match pending.pop_front() {
                Some(m) => m,
                None => match rx.try_recv() {
                    Ok(m) => m,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break 'outer,
                },
            };
            match msg {
                Ctrl::Stop => break 'outer,
                Ctrl::Cancel => {
                    ep.cancel_current();
                    buf.clear();
                }
                Ctrl::SetHang(ms) => ep.set_silence_hang_ms(ms),
                Ctrl::PttDown if !auto => {
                    held = true;
                    ep.cancel_current();
                    // VOICE.md: ptt captures the WHOLE down→up window — a
                    // mid-hold thinking pause must not hang-close and
                    // auto-send a fragment; the utterance closes at PttUp.
                    ep.set_hold_open(true);
                    buf.clear();
                    set_state_emit(&shared, &sink, VoiceState::Listening);
                }
                Ctrl::PttUp if !auto => {
                    held = false;
                    ep.set_hold_open(false);
                    buf.clear(); // drop the sub-frame tail (≤32ms)
                    if let Some(utt) = ep.flush() {
                        finish_utterance(utt, &mut stt, &rx, &mut pending, &shared, &sink);
                    }
                    set_state_emit(&shared, &sink, VoiceState::Idle);
                }
                Ctrl::PttDown | Ctrl::PttUp => {} // ptt messages in auto mode: ignore
            }
        }

        // 2. Half-duplex bookkeeping. The loop ticks at least every
        //    SOURCE_TIMEOUT, so this doubles as the ~10Hz+ isSpeaking poll
        //    that drives the `speaking` state. Poll the shared atomic when
        //    available — NEVER the tts Mutex (see speaking_flag above).
        let speaking_now = match speaking_flag.as_ref() {
            Some(flag) => flag.load(std::sync::atomic::Ordering::SeqCst),
            None => lock_unpoisoned(&tts).is_speaking(),
        };
        if speaking_now != tts_speaking {
            tts_speaking = speaking_now;
            if speaking_now {
                rearm_until = None;
                if !held {
                    // An explicit PTT hold wins over the speaking display.
                    ep.cancel_current(); // stale pre-roll must not leak
                    buf.clear();
                    set_state_emit(&shared, &sink, VoiceState::Speaking);
                }
            } else {
                rearm_until = Some(Instant::now() + Duration::from_millis(REARM_MS));
                if !held {
                    set_state_emit(&shared, &sink, VoiceState::Idle);
                }
            }
        }
        if let Some(t) = rearm_until {
            if Instant::now() >= t {
                rearm_until = None;
                if auto && !tts_speaking {
                    set_state_emit(&shared, &sink, VoiceState::Listening);
                }
            }
        }

        // 3. Audio. A read error (device unplugged, permission revoked
        //    mid-stream) is terminal for this pipeline run.
        let chunk = match source.next_chunk(SOURCE_TIMEOUT) {
            Ok(c) => c,
            Err(e) => return fail(&shared, &sink, e),
        };
        let Some(chunk) = chunk else { continue };

        // Half-duplex: while TTS is speaking (or within the re-arm window)
        // mic frames are READ but DISCARDED. In ptt mode the gate is the
        // held key instead (an explicit hold may talk over TTS).
        let suppressed = tts_speaking || rearm_until.is_some();
        let capture_active = if auto { !suppressed } else { held };
        if !capture_active {
            buf.clear();
            continue;
        }

        buf.extend_from_slice(&chunk);

        // Level pulse ~10Hz, only while listening.
        if lock_unpoisoned(&shared).state == VoiceState::Listening
            && last_level.elapsed() >= LEVEL_INTERVAL
        {
            last_level = Instant::now();
            let level = capture::rms(&chunk).clamp(0.0, 1.0);
            sink.emit(
                "voice-state",
                json!({ "state": VoiceState::Listening.as_str(), "mode": mode.as_str(), "level": level }),
            );
        }

        // 4. Feed whole VAD frames; an utterance may close on a hang.
        let mut closed: Option<endpoint::Utterance> = None;
        while buf.len() >= VAD_CHUNK {
            let frame: Vec<f32> = buf.drain(..VAD_CHUNK).collect();
            if let Some(u) = ep.push_frame(&frame) {
                closed = Some(u);
            }
        }

        if let Some(utt) = closed {
            finish_utterance(utt, &mut stt, &rx, &mut pending, &shared, &sink);
            // Auto re-arms immediately; ptt returns to the hold state.
            let next = if auto || held {
                VoiceState::Listening
            } else {
                VoiceState::Idle
            };
            set_state_emit(&shared, &sink, next);
        }
    }
    // Stop requested: set_mode owns the transition to `off` after joining.
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    // -- mocks ------------------------------------------------------------

    struct TestSink(Mutex<Vec<(String, serde_json::Value)>>);

    impl TestSink {
        fn new() -> Arc<Self> {
            Arc::new(TestSink(Mutex::new(Vec::new())))
        }
        fn events(&self) -> Vec<(String, serde_json::Value)> {
            self.0.lock().unwrap().clone()
        }
        /// Poll until an event matching `pred` shows up (or panic).
        fn wait_for(&self, what: &str, pred: impl Fn(&(String, serde_json::Value)) -> bool) {
            self.wait_for_after(0, what, pred);
        }
        /// Poll until an event matching `pred` shows up AT OR AFTER index
        /// `from` — for asserting a transition happened after a marker point
        /// (e.g. listening re-arms after speaking, not the initial arm).
        fn wait_for_after(
            &self,
            from: usize,
            what: &str,
            pred: impl Fn(&(String, serde_json::Value)) -> bool,
        ) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if self.events()[from.min(self.events().len())..].iter().any(&pred) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("timed out waiting for {what}; events: {:?}", self.events());
        }
        fn has_event(&self, pred: impl Fn(&(String, serde_json::Value)) -> bool) -> bool {
            self.events().iter().any(&pred)
        }
    }

    impl EventSink for TestSink {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    fn state_is(ev: &(String, serde_json::Value), state: &str) -> bool {
        ev.0 == "voice-state" && ev.1["state"] == state
    }

    /// Audio source backed by a queue the test pushes into; `None` (timeout)
    /// when empty, so the pipeline keeps ticking.
    struct QueueSource(Arc<Mutex<VecDeque<Vec<f32>>>>);

    impl AudioSource for QueueSource {
        fn next_chunk(&mut self, timeout: Duration) -> Result<Option<Vec<f32>>, String> {
            let popped = self.0.lock().unwrap().pop_front();
            match popped {
                Some(c) => Ok(Some(c)),
                None => {
                    std::thread::sleep(timeout.min(Duration::from_millis(5)));
                    Ok(None)
                }
            }
        }
    }

    struct FixedStt(String);

    impl SttEngine for FixedStt {
        fn transcribe(&mut self, _samples: &[f32]) -> Result<String, String> {
            Ok(self.0.clone())
        }
    }

    struct FlagTts {
        speaking: Arc<AtomicBool>,
        spoken: Arc<Mutex<Vec<String>>>,
    }

    impl TtsEngine for FlagTts {
        fn speak(&mut self, text: &str, _interrupt: bool) {
            self.spoken.lock().unwrap().push(text.to_string());
        }
        fn stop(&mut self) {
            self.speaking.store(false, Ordering::SeqCst);
        }
        fn is_speaking(&self) -> bool {
            self.speaking.load(Ordering::SeqCst)
        }
        fn list_voices(&self) -> Vec<Voice> {
            Vec::new()
        }
        fn set_voice(&mut self, _id: &str) -> bool {
            true
        }
    }

    /// SttEngine that takes `delay` per transcription — long enough for a
    /// test to act WHILE inference is in flight (stop/teardown races).
    struct SlowStt {
        delay: Duration,
        text: String,
    }

    impl SttEngine for SlowStt {
        fn transcribe(&mut self, _samples: &[f32]) -> Result<String, String> {
            std::thread::sleep(self.delay);
            Ok(self.text.clone())
        }
    }

    /// TtsEngine whose `list_voices` blocks until the test releases it, with
    /// a lock-free speaking flag — models AvSpeechTts during the first
    /// (slow, registry-loading) voice list round trip.
    struct BlockingListTts {
        speaking: Arc<AtomicBool>,
        release: Arc<(Mutex<bool>, std::sync::Condvar)>,
    }

    impl TtsEngine for BlockingListTts {
        fn speak(&mut self, _text: &str, _interrupt: bool) {}
        fn stop(&mut self) {}
        fn is_speaking(&self) -> bool {
            self.speaking.load(Ordering::SeqCst)
        }
        fn speaking_flag(&self) -> Option<Arc<AtomicBool>> {
            Some(self.speaking.clone())
        }
        fn list_voices(&self) -> Vec<Voice> {
            let (m, cv) = &*self.release;
            let guard = m.lock().unwrap();
            let _ = cv
                .wait_timeout_while(guard, Duration::from_secs(5), |done| !*done)
                .unwrap();
            Vec::new()
        }
        fn set_voice(&mut self, _id: &str) -> bool {
            true
        }
    }

    /// Mirrors AvSpeechTts's set_voice contract: empty id (reset to system
    /// default) applies; any other id here is "stale" and reports fallback.
    struct PickyVoiceTts;

    impl TtsEngine for PickyVoiceTts {
        fn speak(&mut self, _text: &str, _interrupt: bool) {}
        fn stop(&mut self) {}
        fn is_speaking(&self) -> bool {
            false
        }
        fn list_voices(&self) -> Vec<Voice> {
            Vec::new()
        }
        fn set_voice(&mut self, id: &str) -> bool {
            id.is_empty()
        }
    }

    fn amplitude_probe() -> Box<dyn FnMut(&[f32]) -> f32> {
        Box::new(|f: &[f32]| {
            if f.first().copied().unwrap_or(0.0) > 0.5 {
                0.95
            } else {
                0.05
            }
        })
    }

    fn speech_frames(n: usize) -> Vec<Vec<f32>> {
        (0..n).map(|_| vec![0.9; VAD_CHUNK]).collect()
    }

    fn silence_frames(n: usize) -> Vec<Vec<f32>> {
        (0..n).map(|_| vec![0.0; VAD_CHUNK]).collect()
    }

    struct Rig {
        sink: Arc<TestSink>,
        queue: Arc<Mutex<VecDeque<Vec<f32>>>>,
        speaking: Arc<AtomicBool>,
        spoken: Arc<Mutex<Vec<String>>>,
        controller: VoiceController,
    }

    /// Core builder: queue-backed audio source + amplitude probe, with the
    /// stt factory and tts engine injectable per test.
    fn rig_parts(
        model_present: bool,
        stt_factory: Box<dyn Fn() -> Result<Box<dyn SttEngine>, String> + Send + Sync>,
        tts: Box<dyn TtsEngine>,
    ) -> (Arc<TestSink>, Arc<Mutex<VecDeque<Vec<f32>>>>, VoiceController) {
        let sink = TestSink::new();
        let queue: Arc<Mutex<VecDeque<Vec<f32>>>> = Arc::new(Mutex::new(VecDeque::new()));
        let q = queue.clone();
        let deps = VoiceDeps {
            stt_factory,
            source_factory: Box::new(move || {
                Ok(Box::new(QueueSource(q.clone())) as Box<dyn AudioSource>)
            }),
            probe_factory: Box::new(|| Ok(amplitude_probe())),
            model_present: Box::new(move || model_present),
        };
        let controller = VoiceController::new(sink.clone(), deps, tts);
        (sink, queue, controller)
    }

    fn rig(model_present: bool, stt_text: &str) -> Rig {
        let speaking = Arc::new(AtomicBool::new(false));
        let spoken = Arc::new(Mutex::new(Vec::new()));
        let text = stt_text.to_string();
        let tts = FlagTts {
            speaking: speaking.clone(),
            spoken: spoken.clone(),
        };
        let (sink, queue, controller) = rig_parts(
            model_present,
            Box::new(move || Ok(Box::new(FixedStt(text.clone())) as Box<dyn SttEngine>)),
            Box::new(tts),
        );
        Rig {
            sink,
            queue,
            speaking,
            spoken,
            controller,
        }
    }

    fn slow_stt_factory(
        delay: Duration,
        text: &str,
    ) -> Box<dyn Fn() -> Result<Box<dyn SttEngine>, String> + Send + Sync> {
        let text = text.to_string();
        Box::new(move || {
            Ok(Box::new(SlowStt {
                delay,
                text: text.clone(),
            }) as Box<dyn SttEngine>)
        })
    }

    fn push_frames(queue: &Arc<Mutex<VecDeque<Vec<f32>>>>, frames: Vec<Vec<f32>>) {
        queue.lock().unwrap().extend(frames);
    }

    fn wait_drained(queue: &Arc<Mutex<VecDeque<Vec<f32>>>>) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if queue.lock().unwrap().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("queue never drained");
    }

    // -- tests ------------------------------------------------------------

    #[test]
    fn initial_status_is_off_with_default_hang() {
        let r = rig(true, "hi");
        let st = r.controller.status();
        assert_eq!(st.state, "off");
        assert_eq!(st.mode, "off");
        assert_eq!(st.silence_hang_ms, DEFAULT_SILENCE_HANG_MS);
    }

    #[test]
    fn set_mode_with_missing_model_emits_error_and_stays_off() {
        let r = rig(false, "hi");
        let st = r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        assert_eq!(st.mode, "off", "mode must stay off without a model");
        assert_eq!(st.state, "off");
        assert!(!st.model_present);
        r.sink.wait_for("model-missing error", |e| {
            e.0 == "voice-error" && e.1["message"] == "model missing"
        });
    }

    #[test]
    fn unknown_mode_is_an_error() {
        let r = rig(true, "hi");
        assert!(r.controller.set_mode_with_sync("loud", |_| {}).is_err());
    }

    #[test]
    fn auto_mode_speech_produces_transcript_and_relistens() {
        let r = rig(true, "hello world");
        // Pre-load enough speech + closing silence for one utterance.
        push_frames(&r.queue, speech_frames(15));
        push_frames(&r.queue, silence_frames(25));
        let st = r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        assert_eq!(st.mode, "auto");

        r.sink.wait_for("starting", |e| state_is(e, "starting"));
        r.sink.wait_for("listening", |e| state_is(e, "listening"));
        r.sink.wait_for("transcribing", |e| state_is(e, "transcribing"));
        r.sink.wait_for("transcript", |e| {
            e.0 == "voice-transcript"
                && e.1["text"] == "hello world"
                && e.1["final"] == true
        });
        // Re-arms after transcription.
        let before = r
            .sink
            .events()
            .iter()
            .position(|e| e.0 == "voice-transcript")
            .unwrap();
        r.sink.wait_for_after(before, "re-listen after transcript", |e| {
            state_is(e, "listening")
        });
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
        let st = r.controller.status();
        assert_eq!(st.state, "off");
    }

    #[test]
    fn empty_transcript_is_not_emitted() {
        let r = rig(true, "   "); // whisper returned only blanks
        push_frames(&r.queue, speech_frames(15));
        push_frames(&r.queue, silence_frames(25));
        r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        r.sink.wait_for("transcribing", |e| state_is(e, "transcribing"));
        r.sink.wait_for("back to listening", |e| state_is(e, "listening"));
        wait_drained(&r.queue);
        assert!(
            !r.sink.has_event(|e| e.0 == "voice-transcript"),
            "blank transcripts must never be emitted"
        );
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    #[test]
    fn ptt_flow_captures_only_between_down_and_up() {
        let r = rig(true, "ptt works");
        // Frames present BEFORE the hold must be discarded.
        push_frames(&r.queue, speech_frames(5));
        r.controller.set_mode_with_sync("ptt", |_| {}).unwrap();
        r.sink.wait_for("idle", |e| state_is(e, "idle"));
        wait_drained(&r.queue);
        assert!(
            !r.sink.has_event(|e| state_is(e, "transcribing")),
            "no capture without the key held"
        );

        r.controller.ptt_down();
        r.sink.wait_for("listening on ptt_down", |e| state_is(e, "listening"));
        push_frames(&r.queue, speech_frames(15));
        wait_drained(&r.queue);
        r.controller.ptt_up();
        r.sink.wait_for("transcript on ptt_up", |e| {
            e.0 == "voice-transcript" && e.1["text"] == "ptt works"
        });
        r.sink.wait_for("idle after ptt_up", |e| state_is(e, "idle"));
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    #[test]
    fn cancel_discards_in_flight_capture() {
        let r = rig(true, "should never appear");
        r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        r.sink.wait_for("listening", |e| state_is(e, "listening"));
        // Speech with NO closing silence → capture is in-flight…
        push_frames(&r.queue, speech_frames(15));
        wait_drained(&r.queue);
        r.controller.cancel();
        // …then silence that would have closed it.
        push_frames(&r.queue, silence_frames(25));
        wait_drained(&r.queue);
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !r.sink.has_event(|e| e.0 == "voice-transcript"),
            "cancelled capture must not produce a transcript"
        );
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    #[test]
    fn speak_text_is_a_noop_when_mode_off() {
        let r = rig(true, "hi");
        assert!(r.controller.speak_text("hello", false).is_ok());
        assert!(
            r.spoken.lock().unwrap().is_empty(),
            "TTS must not be touched while mode=off"
        );
    }

    #[test]
    fn speak_text_reaches_tts_when_voice_is_on() {
        let r = rig(true, "hi");
        r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        r.sink.wait_for("listening", |e| state_is(e, "listening"));
        r.controller.speak_text("good evening", true).unwrap();
        assert_eq!(r.spoken.lock().unwrap().as_slice(), ["good evening"]);
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    #[test]
    fn half_duplex_discards_mic_while_speaking_then_rearms() {
        let r = rig(true, "leaked through tts");
        r.controller.set_mode_with_sync("auto", |_| {}).unwrap();
        r.sink.wait_for("listening", |e| state_is(e, "listening"));

        // TTS starts speaking → state speaking, mic discarded.
        r.speaking.store(true, Ordering::SeqCst);
        r.sink.wait_for("speaking", |e| state_is(e, "speaking"));
        push_frames(&r.queue, speech_frames(15));
        push_frames(&r.queue, silence_frames(25));
        wait_drained(&r.queue);
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !r.sink.has_event(|e| e.0 == "voice-transcript"),
            "mic input during TTS must be discarded (half-duplex)"
        );

        // Speaking ends → idle, then listening re-arms after ~300ms.
        let n_before = r.sink.events().len();
        r.speaking.store(false, Ordering::SeqCst);
        r.sink
            .wait_for_after(n_before, "idle after speaking", |e| state_is(e, "idle"));
        r.sink
            .wait_for_after(n_before, "re-arm listening", |e| state_is(e, "listening"));
        // Frames pushed AFTER re-arm transcribe normally again.
        push_frames(&r.queue, speech_frames(15));
        push_frames(&r.queue, silence_frames(25));
        r.sink.wait_for("transcript after re-arm", |e| {
            e.0 == "voice-transcript"
        });
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    #[test]
    fn set_config_clamps_silence_hang() {
        let r = rig(true, "hi");
        r.controller.set_config(Some(50));
        assert_eq!(r.controller.status().silence_hang_ms, 200);
        r.controller.set_config(Some(9999));
        assert_eq!(r.controller.status().silence_hang_ms, 2000);
        r.controller.set_config(Some(750));
        assert_eq!(r.controller.status().silence_hang_ms, 750);
        r.controller.set_config(None); // absent key: unchanged
        assert_eq!(r.controller.status().silence_hang_ms, 750);
    }

    #[test]
    fn stt_factory_failure_lands_in_terminal_error_state() {
        let sink = TestSink::new();
        let deps = VoiceDeps {
            stt_factory: Box::new(|| Err("model file corrupt".to_string())),
            source_factory: Box::new(|| {
                Ok(Box::new(QueueSource(Arc::new(Mutex::new(VecDeque::new()))))
                    as Box<dyn AudioSource>)
            }),
            probe_factory: Box::new(|| Ok(amplitude_probe())),
            model_present: Box::new(|| true),
        };
        let controller = VoiceController::new(sink.clone(), deps, Box::new(tts::NoopTts));
        controller.set_mode_with_sync("auto", |_| {}).unwrap();
        sink.wait_for("load error", |e| {
            e.0 == "voice-error"
                && e.1["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("model load failed"))
        });
        sink.wait_for("error state", |e| state_is(e, "error"));
        // Error is terminal until the next mode change: a re-set of the SAME
        // mode restarts the (still failing) pipeline rather than no-opping.
        let st = controller.status();
        assert_eq!(st.state, "error");
        // Switching off clears it.
        controller.set_mode_with_sync("off", |_| {}).unwrap();
        assert_eq!(controller.status().state, "off");
    }

    // -- regression tests for the voice review findings ---------------------

    /// Finding 1: turning voice off MID-TRANSCRIPTION (mic-pause click /
    /// settings toggle send Stop) must suppress the transcript, exactly like
    /// Cancel — the frontend auto-sends transcripts, so an emitted one would
    /// SEND speech the user explicitly stopped.
    #[test]
    fn stop_during_transcription_suppresses_the_transcript() {
        let (sink, queue, controller) = rig_parts(
            true,
            slow_stt_factory(Duration::from_millis(400), "should never be sent"),
            Box::new(tts::NoopTts),
        );
        push_frames(&queue, speech_frames(15));
        push_frames(&queue, silence_frames(25));
        controller.set_mode_with_sync("auto", |_| {}).unwrap();
        sink.wait_for("transcribing", |e| state_is(e, "transcribing"));
        // Stop lands while transcribe() sleeps; set_mode joins through it.
        controller.set_mode_with_sync("off", |_| {}).unwrap();
        assert!(
            !sink.has_event(|e| e.0 == "voice-transcript"),
            "a transcript whose inference a Stop rode through must be \
             suppressed; events: {:?}",
            sink.events()
        );
        assert_eq!(controller.status().state, "off");
    }

    /// Finding 2: the global PTT shortcut handler runs on the macOS main
    /// thread and calls ptt_down/ptt_up → send(). While voice_set_mode joins
    /// through an in-flight whisper inference (holding the pipeline-handle
    /// Mutex), send() must stay non-blocking or the WHOLE app UI freezes.
    #[test]
    fn controls_do_not_block_behind_a_teardown_join() {
        let (sink, queue, controller) = rig_parts(
            true,
            slow_stt_factory(Duration::from_millis(500), "x"),
            Box::new(tts::NoopTts),
        );
        let controller = Arc::new(controller);
        push_frames(&queue, speech_frames(15));
        push_frames(&queue, silence_frames(25));
        controller.set_mode_with_sync("auto", |_| {}).unwrap();
        sink.wait_for("transcribing", |e| state_is(e, "transcribing"));

        let c2 = controller.clone();
        let teardown = std::thread::spawn(move || {
            c2.set_mode_with_sync("off", |_| {}).unwrap(); // blocks in join through the 500ms inference
        });
        std::thread::sleep(Duration::from_millis(50)); // let set_mode reach the join
        let t0 = Instant::now();
        controller.ptt_down();
        controller.ptt_up();
        controller.cancel();
        let elapsed = t0.elapsed();
        teardown.join().unwrap();
        assert!(
            elapsed < Duration::from_millis(200),
            "control sends blocked {elapsed:?} behind the teardown join \
             (main-thread freeze in the app)"
        );
    }

    /// Finding 3: a blocking voice_list_voices round trip holds the
    /// controller's tts Mutex (boot fires one right as the pipeline starts).
    /// The pipeline polls the engine's lock-free speaking flag, so the
    /// half-duplex transition must still happen while the Mutex is held.
    #[test]
    fn pipeline_keeps_ticking_while_list_voices_blocks_the_tts_mutex() {
        let speaking = Arc::new(AtomicBool::new(false));
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let tts = BlockingListTts {
            speaking: speaking.clone(),
            release: release.clone(),
        };
        let (sink, _queue, controller) = rig_parts(
            true,
            Box::new(|| Ok(Box::new(FixedStt("hi".into())) as Box<dyn SttEngine>)),
            Box::new(tts),
        );
        let controller = Arc::new(controller);
        controller.set_mode_with_sync("auto", |_| {}).unwrap();
        sink.wait_for("listening", |e| state_is(e, "listening"));

        // Boot-shaped stall: list_voices blocks, holding the tts Mutex…
        let c2 = controller.clone();
        let lister = std::thread::spawn(move || c2.list_voices());
        std::thread::sleep(Duration::from_millis(50));

        // …and the pipeline must still see the speaking flag flip (it reads
        // the shared atomic, never the tts Mutex). wait_for panics at 3s —
        // well before the 5s blocked-list release below.
        let n = sink.events().len();
        speaking.store(true, Ordering::SeqCst);
        sink.wait_for_after(n, "speaking while list_voices is blocked", |e| {
            state_is(e, "speaking")
        });

        let (m, cv) = &*release;
        *m.lock().unwrap() = true;
        cv.notify_all();
        lister.join().unwrap();
        controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    /// Finding 4 (TOCTOU): the PTT-shortcut sync callback runs INSIDE the
    /// mode lock, so however many mode changes interleave, the registration
    /// state always matches the FINAL mode (post-return syncing could leave
    /// the chord registered while voice ended up off).
    #[test]
    fn shortcut_sync_runs_under_the_mode_lock_and_matches_the_final_mode() {
        let r = rig(true, "hi");
        let controller = Arc::new(r.controller);
        let registered = Arc::new(AtomicBool::new(false));

        let mut handles = Vec::new();
        for i in 0..4 {
            let c = controller.clone();
            let reg = registered.clone();
            handles.push(std::thread::spawn(move || {
                for j in 0..6 {
                    let mode = if (i + j) % 2 == 0 { "ptt" } else { "off" };
                    let _ = c.set_mode_with_sync(mode, |m| {
                        reg.store(m == VoiceMode::Ptt, Ordering::SeqCst);
                    });
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            registered.load(Ordering::SeqCst),
            controller.status().mode == VoiceMode::Ptt.as_str(),
            "registration must match the final mode after arbitrary interleaving"
        );
        controller
            .set_mode_with_sync("off", |m| {
                registered.store(m == VoiceMode::Ptt, Ordering::SeqCst);
            })
            .unwrap();
        assert!(!registered.load(Ordering::SeqCst), "off must unregister");
    }

    /// Finding 4 (model-missing arm): the sync callback receives the
    /// EFFECTIVE mode — a refused ptt request must unregister, not register.
    #[test]
    fn shortcut_sync_receives_the_effective_mode_not_the_requested_one() {
        let r = rig(false, "hi"); // model missing → mode forced off
        let mut seen = None;
        r.controller
            .set_mode_with_sync("ptt", |m| seen = Some(m))
            .unwrap();
        assert_eq!(
            seen,
            Some(VoiceMode::Off),
            "missing model keeps voice off; the chord must not be registered"
        );
    }

    /// Finding 12: a panic inside the pipeline (ort/whisper native code) must
    /// surface as voice-error + the terminal error state, not strand the UI
    /// in `listening` forever with dead controls.
    #[test]
    fn pipeline_panic_is_caught_and_surfaces_as_voice_error() {
        let sink = TestSink::new();
        let queue: Arc<Mutex<VecDeque<Vec<f32>>>> = Arc::new(Mutex::new(VecDeque::new()));
        let q = queue.clone();
        let deps = VoiceDeps {
            stt_factory: Box::new(|| Ok(Box::new(FixedStt("hi".into())) as Box<dyn SttEngine>)),
            source_factory: Box::new(move || {
                Ok(Box::new(QueueSource(q.clone())) as Box<dyn AudioSource>)
            }),
            probe_factory: Box::new(|| {
                Ok(Box::new(|_f: &[f32]| -> f32 { panic!("ort runtime error") })
                    as Box<dyn FnMut(&[f32]) -> f32>)
            }),
            model_present: Box::new(|| true),
        };
        let controller = VoiceController::new(sink.clone(), deps, Box::new(tts::NoopTts));
        controller.set_mode_with_sync("auto", |_| {}).unwrap();
        push_frames(&queue, speech_frames(1)); // first full VAD frame → probe panics
        sink.wait_for("crash voice-error", |e| {
            e.0 == "voice-error"
                && e.1["message"].as_str().is_some_and(|m| {
                    m.contains("voice pipeline crashed") && m.contains("ort runtime error")
                })
        });
        sink.wait_for("error state", |e| state_is(e, "error"));
        assert_eq!(controller.status().state, "error");
        // Controls on the dead pipeline are harmless no-ops; off recovers.
        controller.ptt_down();
        controller.cancel();
        controller.set_mode_with_sync("off", |_| {}).unwrap();
        assert_eq!(controller.status().state, "off");
    }

    /// Finding 13: a thread-spawn failure must roll the just-committed mode
    /// + `starting` state back to off AND emit a voice-error (the frontend
    /// logs-and-swallows command rejections, so the moon would otherwise
    /// show `starting` forever).
    #[test]
    fn spawn_failure_rolls_back_to_off_and_emits_voice_error() {
        let r = rig(true, "hi");
        // Reproduce the exact pre-spawn commit set_mode performs…
        lock_unpoisoned(&r.controller.shared).mode = VoiceMode::Auto;
        set_state_emit(&r.controller.shared, &r.controller.sink, VoiceState::Starting);
        // …then drive the spawn-failure path.
        let msg = r
            .controller
            .fail_spawn("failed to spawn voice pipeline thread: boom".to_string());
        assert!(msg.contains("boom"));
        let st = r.controller.status();
        assert_eq!(st.mode, "off", "mode must roll back to off");
        assert_eq!(st.state, "off", "state must not stick at `starting`");
        r.sink.wait_for("spawn voice-error", |e| {
            e.0 == "voice-error"
                && e.1["message"].as_str().is_some_and(|m| m.contains("boom"))
        });
    }

    /// Finding 17: in ptt mode a mid-hold thinking pause (silence ≥ hang)
    /// must NOT endpoint and auto-send a fragment — the capture window is
    /// down→up, closing exactly once at release.
    #[test]
    fn ptt_hold_survives_a_silence_hang_pause_one_transcript_on_release() {
        let r = rig(true, "one full thought");
        r.controller.set_mode_with_sync("ptt", |_| {}).unwrap();
        r.sink.wait_for("idle", |e| state_is(e, "idle"));
        r.controller.ptt_down();
        r.sink.wait_for("listening", |e| state_is(e, "listening"));
        push_frames(&r.queue, speech_frames(15));
        push_frames(&r.queue, silence_frames(40)); // 1280ms ≫ 600ms hang
        push_frames(&r.queue, speech_frames(15));
        wait_drained(&r.queue);
        std::thread::sleep(Duration::from_millis(30));
        assert!(
            !r.sink.has_event(|e| e.0 == "voice-transcript"),
            "a mid-hold pause must not close + auto-send (VOICE.md ptt window)"
        );
        r.controller.ptt_up();
        r.sink
            .wait_for("transcript on release", |e| e.0 == "voice-transcript");
        let transcripts = r
            .sink
            .events()
            .iter()
            .filter(|e| e.0 == "voice-transcript")
            .count();
        assert_eq!(transcripts, 1, "exactly ONE transcript for the whole hold");
        r.controller.set_mode_with_sync("off", |_| {}).unwrap();
    }

    /// Finding 14: a stale voice id's fallback-to-default must be REPORTED
    /// to the caller (the app turns false into a voice-error event).
    #[test]
    fn set_voice_reports_a_stale_id_fallback_to_the_caller() {
        let (_sink, _queue, controller) = rig_parts(
            true,
            Box::new(|| Ok(Box::new(FixedStt("hi".into())) as Box<dyn SttEngine>)),
            Box::new(PickyVoiceTts),
        );
        assert!(
            !controller.set_voice("com.apple.voice.premium.deleted"),
            "stale id must report the fallback"
        );
        assert!(
            controller.set_voice(""),
            "explicit reset to system default is a success"
        );
    }
}
