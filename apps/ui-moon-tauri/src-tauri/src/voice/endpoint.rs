//! VAD-driven endpointer: feed 512-sample 16kHz frames, get bounded
//! utterances out. Ported from the Phase-0 spike (examples/voice_spike.rs),
//! with two deliberate changes:
//!
//!   1. Generic over the speech-probability function — the constructor takes
//!      a closure instead of owning a Silero VAD, so unit tests inject
//!      synthetic probability sequences (no ONNX model needed). Production
//!      wires [`silero_probe`].
//!   2. The min-utterance check now subtracts the TRAILING silence before
//!      comparing against [`MIN_UTTERANCE_MS`]. The spike zeroed `silence_ms`
//!      before using it, so the 600ms hang alone always satisfied the 300ms
//!      minimum and no blip was ever discarded. Covered by a unit test.

pub const TARGET_RATE: u32 = 16_000;
/// Silero V5 expects 512-sample chunks at 16kHz (32ms per frame).
pub const VAD_CHUNK: usize = 512;
pub const FRAME_MS: u32 = (VAD_CHUNK as u32 * 1000) / TARGET_RATE; // 32ms

// ── Endpointing tunables ────────────────────────────────────────────────
// These define how "speaking" becomes "an utterance" and are the main UX
// dials (too eager = Luna interrupts you mid-thought, too lazy = dead air
// after you stop talking).
pub const SPEECH_THRESHOLD: f32 = 0.5; // Silero probability above which a frame counts as speech
pub const MIN_UTTERANCE_MS: u32 = 300; // discard blips shorter than this
pub const PRE_ROLL_MS: u32 = 250; // audio kept from before VAD triggered (avoids clipped first syllable)

/// `silence_hang_ms` (silence needed to close an utterance) is the one
/// user-tunable knob (`voice_set_config`); it is clamped to this range.
pub const DEFAULT_SILENCE_HANG_MS: u32 = 600;
pub const MIN_SILENCE_HANG_MS: u32 = 200;
pub const MAX_SILENCE_HANG_MS: u32 = 2000;

pub fn clamp_silence_hang_ms(ms: u32) -> u32 {
    ms.clamp(MIN_SILENCE_HANG_MS, MAX_SILENCE_HANG_MS)
}

/// Speech-probability function: one 512-sample frame in, P(speech) 0–1 out.
pub type SpeechProbe = Box<dyn FnMut(&[f32]) -> f32>;

/// Production probe: the Silero VAD from the spike, wrapped as a closure.
/// Built ON the pipeline thread (the ONNX session never crosses threads).
pub fn silero_probe() -> Result<impl FnMut(&[f32]) -> f32, String> {
    let mut vad = voice_activity_detector::VoiceActivityDetector::builder()
        .sample_rate(TARGET_RATE as i64)
        .chunk_size(VAD_CHUNK)
        .build()
        .map_err(|e| format!("failed to build Silero VAD: {e}"))?;
    Ok(move |frame: &[f32]| vad.predict(frame.iter().copied()))
}

pub struct Utterance {
    pub samples: Vec<f32>,
    /// Offset of the utterance start within the source audio, in ms.
    pub start_ms: u32,
}

pub struct Endpointer {
    probe: SpeechProbe,
    silence_hang_ms: u32,
    pre_roll: Vec<f32>, // rolling buffer of recent non-speech audio
    current: Vec<f32>,  // accumulating utterance, empty = not in speech
    silence_ms: u32,    // consecutive silence while in speech
    frames_seen: u32,
    utterance_start_frame: u32,
    /// While true (ptt key held), the silence hang NEVER closes the
    /// utterance — VOICE.md scopes a ptt capture to the down→up window, so a
    /// mid-hold thinking pause must not endpoint early. `flush` (PttUp)
    /// still closes normally.
    hold_open: bool,
}

impl Endpointer {
    pub fn new(probe: SpeechProbe, silence_hang_ms: u32) -> Self {
        Self {
            probe,
            silence_hang_ms: clamp_silence_hang_ms(silence_hang_ms),
            pre_roll: Vec::new(),
            current: Vec::new(),
            silence_ms: 0,
            frames_seen: 0,
            utterance_start_frame: 0,
            hold_open: false,
        }
    }

    pub fn set_silence_hang_ms(&mut self, ms: u32) {
        self.silence_hang_ms = clamp_silence_hang_ms(ms);
    }

    /// Suppress hang-closes while a ptt hold is active (see `hold_open`).
    pub fn set_hold_open(&mut self, hold: bool) {
        self.hold_open = hold;
    }

    /// Discard any in-progress capture (voice_cancel, or mic suppression
    /// starting while TTS speaks — stale pre-roll must not leak into the
    /// next utterance).
    pub fn cancel_current(&mut self) {
        self.current.clear();
        self.pre_roll.clear();
        self.silence_ms = 0;
    }

    /// Push one 32ms frame; returns a finished utterance when one closes.
    pub fn push_frame(&mut self, frame: &[f32]) -> Option<Utterance> {
        let prob = (self.probe)(frame);
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
                self.silence_ms = 0; // hang resets on speech resume
            } else {
                self.silence_ms += FRAME_MS;
                if self.silence_ms >= self.silence_hang_ms && !self.hold_open {
                    finished = self.close_utterance();
                }
            }
        }
        finished
    }

    /// Flush whatever is in progress (ptt_up / end of stream).
    pub fn flush(&mut self) -> Option<Utterance> {
        if self.current.is_empty() {
            None
        } else {
            self.close_utterance()
        }
    }

    fn close_utterance(&mut self) -> Option<Utterance> {
        // Capture the trailing silence BEFORE resetting it — speech length is
        // total minus the hang (see module docs, change #2 vs the spike).
        let trailing_silence_ms = self.silence_ms;
        let samples = std::mem::take(&mut self.current);
        self.silence_ms = 0;
        self.pre_roll.clear();
        let total_ms = samples.len() as u32 * 1000 / TARGET_RATE;
        let speech_ms = total_ms.saturating_sub(trailing_silence_ms);
        if speech_ms < MIN_UTTERANCE_MS {
            return None; // a cough, not a sentence
        }
        Some(Utterance {
            samples,
            start_ms: self.utterance_start_frame * FRAME_MS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic probe: a frame whose first sample is > 0.5 is "speech".
    fn amplitude_probe() -> SpeechProbe {
        Box::new(|frame: &[f32]| {
            if frame.first().copied().unwrap_or(0.0) > 0.5 {
                0.95
            } else {
                0.05
            }
        })
    }

    fn speech_frame() -> Vec<f32> {
        vec![0.9; VAD_CHUNK]
    }

    fn silence_frame() -> Vec<f32> {
        vec![0.0; VAD_CHUNK]
    }

    /// Frames needed for `ms` of cumulative silence (32ms per frame, >=).
    fn hang_frames(ms: u32) -> usize {
        ms.div_ceil(FRAME_MS) as usize
    }

    #[test]
    fn clamp_silence_hang_bounds() {
        assert_eq!(clamp_silence_hang_ms(50), MIN_SILENCE_HANG_MS);
        assert_eq!(clamp_silence_hang_ms(200), 200);
        assert_eq!(clamp_silence_hang_ms(600), 600);
        assert_eq!(clamp_silence_hang_ms(2000), 2000);
        assert_eq!(clamp_silence_hang_ms(9999), MAX_SILENCE_HANG_MS);
    }

    #[test]
    fn onset_includes_pre_roll() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        // 10 marked silence frames (distinct sub-threshold values), then speech.
        for i in 0..10u32 {
            let marker = 0.001 * (i + 1) as f32;
            assert!(ep.push_frame(&vec![marker; VAD_CHUNK]).is_none());
        }
        for _ in 0..10 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let mut utt = None;
        for _ in 0..hang_frames(DEFAULT_SILENCE_HANG_MS) {
            if let Some(u) = ep.push_frame(&silence_frame()) {
                utt = Some(u);
            }
        }
        let utt = utt.expect("utterance should close after the hang");
        // Pre-roll keeps the LAST 250ms/32ms = 7 frames: silence frames 3..=9.
        let pre_frames = (PRE_ROLL_MS / FRAME_MS) as usize;
        assert_eq!(pre_frames, 7);
        let expected_len = (pre_frames + 10 + hang_frames(DEFAULT_SILENCE_HANG_MS)) * VAD_CHUNK;
        assert_eq!(utt.samples.len(), expected_len);
        // First retained sample is the marker of silence frame index 3 (0.004):
        // the first syllable's lead-in survives.
        assert!((utt.samples[0] - 0.004).abs() < 1e-6, "pre-roll head wrong");
        // Onset at frames_seen=11 → start = 11 - 1 - 7 = frame 3 → 96ms.
        assert_eq!(utt.start_ms, 3 * FRAME_MS);
    }

    #[test]
    fn silence_hang_closes_the_utterance_exactly_at_the_hang() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        for _ in 0..12 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let frames = hang_frames(DEFAULT_SILENCE_HANG_MS); // 19 × 32ms = 608ms ≥ 600
        for i in 1..frames {
            assert!(
                ep.push_frame(&silence_frame()).is_none(),
                "must not close at {}ms of silence",
                i as u32 * FRAME_MS
            );
        }
        let utt = ep.push_frame(&silence_frame());
        assert!(utt.is_some(), "must close once cumulative silence ≥ hang");
        assert_eq!(utt.map(|u| u.samples.len()), Some((12 + frames) * VAD_CHUNK));
    }

    #[test]
    fn configured_hang_is_clamped_and_honored() {
        // Asking for 50ms clamps to 200ms → closes after ceil(200/32) = 7 frames.
        let mut ep = Endpointer::new(amplitude_probe(), 50);
        for _ in 0..12 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let frames = hang_frames(MIN_SILENCE_HANG_MS);
        for _ in 1..frames {
            assert!(ep.push_frame(&silence_frame()).is_none());
        }
        assert!(ep.push_frame(&silence_frame()).is_some());
    }

    #[test]
    fn min_utterance_blip_is_discarded() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        // 2 speech frames = 64ms of speech, well under MIN_UTTERANCE_MS.
        for _ in 0..2 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        for _ in 0..hang_frames(DEFAULT_SILENCE_HANG_MS) + 5 {
            assert!(
                ep.push_frame(&silence_frame()).is_none(),
                "a 64ms blip must be discarded, not emitted"
            );
        }
        // Nothing left in progress either.
        assert!(ep.flush().is_none());
    }

    #[test]
    fn hang_resets_when_speech_resumes() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        for _ in 0..10 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        // 10 silence frames = 320ms < 600ms hang: must NOT close…
        for _ in 0..10 {
            assert!(ep.push_frame(&silence_frame()).is_none());
        }
        // …and resuming speech resets the hang counter.
        for _ in 0..10 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let frames = hang_frames(DEFAULT_SILENCE_HANG_MS);
        let mut utt = None;
        for _ in 0..frames {
            if let Some(u) = ep.push_frame(&silence_frame()) {
                utt = Some(u);
            }
        }
        let utt = utt.expect("one utterance after the full hang");
        // ONE utterance spanning everything (no close at the mid-pause).
        assert_eq!(utt.samples.len(), (10 + 10 + 10 + frames) * VAD_CHUNK);
        assert!(ep.flush().is_none());
    }

    #[test]
    fn flush_emits_in_progress_capture() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        for _ in 0..15 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let utt = ep.flush().expect("flush closes the in-progress utterance");
        assert_eq!(utt.samples.len(), 15 * VAD_CHUNK);
    }

    #[test]
    fn cancel_discards_in_progress_capture() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        for _ in 0..15 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        ep.cancel_current();
        assert!(ep.flush().is_none(), "cancelled capture must not flush");
    }

    /// Regression (review finding: ptt silence-hang fired mid-hold): while
    /// hold_open is set, NO amount of silence may close the utterance — a
    /// mid-hold thinking pause stays in ONE capture; flush (PttUp) closes it.
    #[test]
    fn hold_open_suppresses_hang_close_until_flush() {
        let mut ep = Endpointer::new(amplitude_probe(), DEFAULT_SILENCE_HANG_MS);
        ep.set_hold_open(true);
        for _ in 0..12 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let pause = hang_frames(DEFAULT_SILENCE_HANG_MS) * 3; // 3× the hang
        for i in 0..pause {
            assert!(
                ep.push_frame(&silence_frame()).is_none(),
                "hang-close fired at pause frame {i} despite hold_open"
            );
        }
        // Speech resumes after the pause: still the SAME utterance.
        for _ in 0..12 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let utt = ep.flush().expect("PttUp flush closes the utterance");
        assert_eq!(
            utt.samples.len(),
            (12 + pause + 12) * VAD_CHUNK,
            "one continuous utterance spanning the mid-hold pause"
        );
        // And releasing the hold restores normal hang behavior.
        ep.set_hold_open(false);
        for _ in 0..12 {
            assert!(ep.push_frame(&speech_frame()).is_none());
        }
        let mut closed = None;
        for _ in 0..hang_frames(DEFAULT_SILENCE_HANG_MS) {
            if let Some(u) = ep.push_frame(&silence_frame()) {
                closed = Some(u);
            }
        }
        assert!(closed.is_some(), "hang closes again once the hold is released");
    }
}
