//! Phase-0 voice pipeline spike: capture → VAD endpointing → whisper STT.
//!
//! Now the LIVE E2E HARNESS for the shared voice library: it drives the same
//! endpoint/stt modules (luna_moon_ui_lib::voice) the app's pipeline thread
//! uses, with the same CLI and output format as the original spike. Two modes:
//!
//!   voice_spike --file <wav>     offline: 16kHz mono wav through the full
//!                                VAD→STT pipeline (automatable via `say`)
//!   voice_spike --mic [secs]     live mic capture (default 8s), same pipeline
//!
//! Model resolves from --model, else ~/.luna/models/ggml-base.en.bin.
//!
//! Build: cargo run --bin voice_spike --features voice-spike --release -- --file t.wav

use std::time::Instant;

use luna_moon_ui_lib::voice::capture::resample_linear;
use luna_moon_ui_lib::voice::endpoint::{
    self, Endpointer, Utterance, DEFAULT_SILENCE_HANG_MS, TARGET_RATE, VAD_CHUNK,
};
use luna_moon_ui_lib::voice::stt::{SttEngine, WhisperEngine};

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
                // processing thread. (The app uses capture::CpalSource.)
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

    // The lib engine creates its ONE long-lived state at load time, so the
    // Metal init cost shows up here (once) instead of on the first utterance.
    let load_start = Instant::now();
    let mut stt = WhisperEngine::load(&model_path).unwrap_or_else(|e| panic!("{e}"));
    eprintln!("[stt] model loaded in {:.2?}", load_start.elapsed());

    let probe = endpoint::silero_probe().unwrap_or_else(|e| panic!("{e}"));
    let mut ep = Endpointer::new(Box::new(probe), DEFAULT_SILENCE_HANG_MS);

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
        let t = Instant::now();
        let text = stt
            .transcribe(&u.samples)
            .unwrap_or_else(|e| panic!("{e}"));
        let secs = t.elapsed().as_secs_f64();
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
