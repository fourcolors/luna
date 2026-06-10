//! Speech-to-text: SttEngine trait + the whisper.cpp implementation.
//!
//! WhisperEngine holds ONE WhisperContext AND ONE reused WhisperState for the
//! engine's lifetime. The Phase-0 spike measured ~+300ms PER UTTERANCE when
//! the state is re-created each time (state init re-inits the Metal backend),
//! so the state is created once at load and `full()` is re-run on it.

use std::sync::Once;

use super::endpoint::TARGET_RATE;

/// Batch transcription of one utterance (16kHz mono). Implementations live
/// on the pipeline thread; tests inject mocks.
pub trait SttEngine {
    fn transcribe(&mut self, samples_16k_mono: &[f32]) -> Result<String, String>;
}

/// Route whisper.cpp/ggml log spam away from stderr. whisper-rs 0.16 exposes
/// `install_logging_hooks()`; with neither the `log_backend` nor
/// `tracing_backend` feature enabled this effectively silences the ~50 lines
/// of ggml/Metal init chatter per model load. Safe to call multiple times,
/// but guarded with Once anyway (the hook install is permanent).
fn quiet_whisper_logs() {
    static ONCE: Once = Once::new();
    ONCE.call_once(whisper_rs::install_logging_hooks);
}

pub struct WhisperEngine {
    // Kept alive for the state's lifetime; inference runs through `state`.
    _ctx: whisper_rs::WhisperContext,
    state: whisper_rs::WhisperState,
}

impl WhisperEngine {
    pub fn load(model_path: &str) -> Result<Self, String> {
        quiet_whisper_logs();
        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|e| format!("failed to load whisper model {model_path}: {e}"))?;
        let state = ctx
            .create_state()
            .map_err(|e| format!("failed to init whisper state: {e}"))?;
        Ok(Self { _ctx: ctx, state })
    }
}

impl SttEngine for WhisperEngine {
    fn transcribe(&mut self, samples_16k_mono: &[f32]) -> Result<String, String> {
        let mut params =
            whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        // Whisper requires >= 1s of audio; pad short utterances with silence.
        let mut audio = samples_16k_mono.to_vec();
        let min_len = TARGET_RATE as usize + TARGET_RATE as usize / 10;
        if audio.len() < min_len {
            audio.resize(min_len, 0.0);
        }

        self.state
            .full(params, &audio)
            .map_err(|e| format!("whisper inference failed: {e}"))?;

        // whisper-rs 0.16: full_n_segments() returns i32 (not Result);
        // segments come back via get_segment(i) -> Option.
        let n = self.state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = self.state.get_segment(i) {
                if let Ok(s) = seg.to_str() {
                    text.push_str(s.trim());
                    text.push(' ');
                }
            }
        }
        Ok(text.trim().to_string())
    }
}
