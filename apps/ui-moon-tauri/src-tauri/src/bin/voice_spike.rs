//! Phase-0 voice pipeline spike: capture → VAD endpointing → whisper STT.
//!
//! Proves the all-Rust voice loop (Silero VAD + whisper.cpp/Metal) works on
//! this machine and measures real-time factor before we commit to wiring it
//! into the Tauri app. Two modes:
//!
//!   voice_spike --file <wav>     offline: 16kHz mono wav through the full
//!                                VAD→STT pipeline (automatable via `say`)
//!   voice_spike --mic [secs]     live mic capture (default 8s), same pipeline
//!
//! Model resolves from --model, else ~/.luna/models/ggml-base.en.bin.
//!
//! Build: cargo run --bin voice_spike --features voice-spike --release -- --file t.wav

use std::time::Instant;

use voice_activity_detector::VoiceActivityDetector;

const TARGET_RATE: u32 = 16_000;
/// Silero V5 expects 512-sample chunks at 16kHz (32ms per frame).
const VAD_CHUNK: usize = 512;

// ── Endpointing tunables ────────────────────────────────────────────────
// These four constants define how "speaking" becomes "an utterance" and are
// the main UX dials for Phase 1 (too eager = Luna interrupts you mid-thought,
// too lazy = dead air after you stop talking).
const SPEECH_THRESHOLD: f32 = 0.5; // Silero probability above which a frame counts as speech
const SILENCE_HANG_MS: u32 = 600; // silence needed to close an utterance
const MIN_UTTERANCE_MS: u32 = 300; // discard blips shorter than this
const PRE_ROLL_MS: u32 = 250; // audio kept from before VAD triggered (avoids clipped first syllable)

const FRAME_MS: u32 = (VAD_CHUNK as u32 * 1000) / TARGET_RATE; // 32ms

struct Utterance {
    samples: Vec<f32>,
    /// Offset of the utterance start within the source audio, in ms.
    start_ms: u32,
}

/// VAD-driven endpointer: feed 512-sample frames, get bounded utterances out.
struct Endpointer {
    vad: VoiceActivityDetector,
    pre_roll: Vec<f32>,    // rolling buffer of recent non-speech audio
    current: Vec<f32>,     // accumulating utterance, empty = not in speech
    silence_ms: u32,       // consecutive silence while in speech
    frames_seen: u32,
    utterance_start_frame: u32,
}

impl Endpointer {
    fn new() -> Self {
        let vad = VoiceActivityDetector::builder()
            .sample_rate(TARGET_RATE as i64)
            .chunk_size(VAD_CHUNK)
            .build()
            .expect("failed to build Silero VAD");
        Self {
            vad,
            pre_roll: Vec::new(),
            current: Vec::new(),
            silence_ms: 0,
            frames_seen: 0,
            utterance_start_frame: 0,
        }
    }

    /// Push one 32ms frame; returns a finished utterance when one closes.
    fn push_frame(&mut self, frame: &[f32]) -> Option<Utterance> {
        let prob = self.vad.predict(frame.iter().copied());
        let is_speech = prob > SPEECH_THRESHOLD;
        self.frames_seen += 1;
        let mut finished = None;

        if self.current.is_empty() {
            if is_speech {
                // Speech onset: seed with pre-roll so the first syllable survives.
                let pre_frames = (PRE_ROLL_MS / FRAME_MS) as usize;
                self.utterance_start_frame =
                    self.frames_seen.saturating_sub(1 + pre_frames as u32);
                self.current = std::mem::take(&mut self.pre_roll);
                self.current.extend_from_slice(frame);
                self.silence_ms = 0;
            } else {
                self.pre_roll.extend_from_slice(frame);
                let max = (PRE_ROLL_MS / FRAME_MS) as usize * VAD_CHUNK;
                if self.pre_roll.len() > max {
                    let excess = self.pre_roll.len() - max;
                    self.pre_roll.drain(..excess);
                }
            }
        } else {
            self.current.extend_from_slice(frame);
            if is_speech {
                self.silence_ms = 0;
            } else {
                self.silence_ms += FRAME_MS;
                if self.silence_ms >= SILENCE_HANG_MS {
                    finished = self.close_utterance();
                }
            }
        }
        finished
    }

    /// Flush whatever is in progress (end of stream).
    fn flush(&mut self) -> Option<Utterance> {
        if self.current.is_empty() {
            None
        } else {
            self.close_utterance()
        }
    }

    fn close_utterance(&mut self) -> Option<Utterance> {
        let samples = std::mem::take(&mut self.current);
        self.silence_ms = 0;
        self.pre_roll.clear();
        let speech_ms =
            (samples.len() as u32 * 1000 / TARGET_RATE).saturating_sub(self.silence_ms);
        if speech_ms < MIN_UTTERANCE_MS {
            return None; // a cough, not a sentence
        }
        Some(Utterance {
            samples,
            start_ms: self.utterance_start_frame * FRAME_MS,
        })
    }
}

// ── Whisper ─────────────────────────────────────────────────────────────

struct Stt {
    ctx: whisper_rs::WhisperContext,
}

impl Stt {
    fn load(model_path: &str) -> Self {
        let load_start = Instant::now();
        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path,
            whisper_rs::WhisperContextParameters::default(),
        )
        .unwrap_or_else(|e| panic!("failed to load whisper model {model_path}: {e}"));
        eprintln!("[stt] model loaded in {:.2?}", load_start.elapsed());
        Self { ctx }
    }

    /// Transcribe one utterance; returns (text, inference_time_secs).
    fn transcribe(&self, samples: &[f32]) -> (String, f64) {
        let mut state = self.ctx.create_state().expect("whisper state");
        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy {
            best_of: 1,
        });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        // Whisper requires >= 1s of audio; pad short utterances with silence.
        let mut audio = samples.to_vec();
        let min_len = TARGET_RATE as usize + TARGET_RATE as usize / 10;
        if audio.len() < min_len {
            audio.resize(min_len, 0.0);
        }

        let t = Instant::now();
        state.full(params, &audio).expect("whisper inference failed");
        let elapsed = t.elapsed().as_secs_f64();

        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(s) = seg.to_str() {
                    text.push_str(s.trim());
                    text.push(' ');
                }
            }
        }
        (text.trim().to_string(), elapsed)
    }
}

// ── Audio sources ───────────────────────────────────────────────────────

fn read_wav_16k_mono(path: &str) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path)
        .unwrap_or_else(|e| panic!("cannot open {path}: {e}"));
    let spec = reader.spec();
    assert_eq!(
        spec.sample_rate, TARGET_RATE,
        "spike expects a 16kHz wav (convert with: afconvert -f WAVE -d LEI16@16000 -c 1 in out.wav)"
    );
    assert_eq!(spec.channels, 1, "spike expects mono");
    match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.unwrap() as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
    }
}

/// Naive linear resampler — good enough for speech into VAD/whisper in a
/// spike. Production uses a proper windowed-sinc resampler.
fn resample_linear(input: &[f32], from_rate: f64, to_rate: f64) -> Vec<f32> {
    if (from_rate - to_rate).abs() < f64::EPSILON {
        return input.to_vec();
    }
    let ratio = from_rate / to_rate;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

fn capture_mic(seconds: u64) -> Vec<f32> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .expect("no default input device — check mic permission for this terminal");
    let config = device.default_input_config().expect("no input config");
    let in_rate = config.sample_rate();
    let channels = config.channels() as usize;
    eprintln!(
        "[mic] device='{}' rate={}Hz channels={} — recording {}s, speak now…",
        device.name().unwrap_or_default(),
        in_rate,
        channels,
        seconds
    );

    let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                // Downmix interleaved channels to mono and ship to the
                // processing thread. (Production: lock-free ring buffer.)
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|f| f.iter().sum::<f32>() / channels as f32)
                    .collect();
                let _ = tx.send(mono);
            },
            |e| eprintln!("[mic] stream error: {e}"),
            None,
        )
        .expect("failed to build input stream");
    stream.play().expect("failed to start stream");

    let deadline = Instant::now() + std::time::Duration::from_secs(seconds);
    let mut raw = Vec::new();
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
            raw.extend(chunk);
        }
    }
    drop(stream);
    resample_linear(&raw, in_rate as f64, TARGET_RATE as f64)
}

// ── Main ────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get_flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };

    let model_path = get_flag("--model").unwrap_or_else(|| {
        let home = std::env::var("HOME").expect("HOME not set");
        format!("{home}/.luna/models/ggml-base.en.bin")
    });
    if !std::path::Path::new(&model_path).exists() {
        eprintln!("model not found at {model_path}");
        eprintln!("download: curl -L -o {model_path} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin");
        std::process::exit(1);
    }

    let audio: Vec<f32> = if let Some(file) = get_flag("--file") {
        read_wav_16k_mono(&file)
    } else if args.iter().any(|a| a == "--mic") {
        let secs = get_flag("--mic").and_then(|s| s.parse().ok()).unwrap_or(8);
        capture_mic(secs)
    } else {
        eprintln!("usage: voice_spike (--file <16k-mono.wav> | --mic [secs]) [--model <ggml.bin>]");
        std::process::exit(2);
    };

    let audio_secs = audio.len() as f64 / TARGET_RATE as f64;
    eprintln!("[in] {:.1}s of 16kHz audio", audio_secs);

    let stt = Stt::load(&model_path);
    let mut ep = Endpointer::new();

    let wall = Instant::now();
    let mut utterances: Vec<Utterance> = Vec::new();
    for frame in audio.chunks(VAD_CHUNK) {
        if frame.len() < VAD_CHUNK {
            break; // trailing partial frame
        }
        if let Some(u) = ep.push_frame(frame) {
            utterances.push(u);
        }
    }
    if let Some(u) = ep.flush() {
        utterances.push(u);
    }
    let vad_elapsed = wall.elapsed();
    eprintln!(
        "[vad] {} utterance(s) segmented in {:.2?} ({:.0}x realtime)",
        utterances.len(),
        vad_elapsed,
        audio_secs / vad_elapsed.as_secs_f64().max(1e-9)
    );

    let mut total_inference = 0.0;
    let mut total_speech = 0.0;
    for (i, u) in utterances.iter().enumerate() {
        let dur = u.samples.len() as f64 / TARGET_RATE as f64;
        let (text, secs) = stt.transcribe(&u.samples);
        total_inference += secs;
        total_speech += dur;
        println!(
            "[{}] @{:.1}s ({:.1}s, stt {:.0}ms, rtf {:.2}): {}",
            i,
            u.start_ms as f64 / 1000.0,
            dur,
            secs * 1000.0,
            secs / dur,
            text
        );
    }
    if total_speech > 0.0 {
        eprintln!(
            "[stt] overall RTF {:.2} ({:.1}s speech in {:.1}s inference)",
            total_inference / total_speech,
            total_speech,
            total_inference
        );
    }
}
