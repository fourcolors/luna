//! Text-to-speech seam: TtsEngine trait + NoopTts + the platform factory.
//!
//! The macOS engine (AVSpeechSynthesizer on a dedicated thread with a
//! command channel, isSpeaking polled into an atomic) lives in
//! tts_avspeech.rs; [`create_platform_tts`] selects it on macOS and the
//! silent NoopTts everywhere else.

/// One synthesizer voice, as surfaced to the Settings → Voice picker.
/// `quality` ∈ `default | enhanced | premium` (AVSpeech's tiers).
#[derive(serde::Serialize, Clone, Debug)]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub quality: String,
}

/// Sentence-queue TTS engine. `Send` because the engine handle is shared
/// between the command entry points and the pipeline thread (which polls
/// `is_speaking` to drive the `speaking` state + half-duplex mic suppression).
pub trait TtsEngine: Send {
    /// Enqueue one sentence. `interrupt: true` clears the queue first.
    fn speak(&mut self, text: &str, interrupt: bool);
    /// Stop playback and clear the queue.
    fn stop(&mut self);
    /// True while audio is actually playing (drives the `speaking` state).
    fn is_speaking(&self) -> bool;
    /// Lock-free handle to the speaking state, when the engine has one.
    /// The pipeline thread polls THIS instead of `is_speaking` whenever it
    /// is `Some`, so a blocking engine call elsewhere (list_voices holds the
    /// controller's tts Mutex for up to its 3s reply timeout) can never
    /// stall the audio loop. Engines whose `is_speaking` is trivially cheap
    /// and lock-free (NoopTts) may return None.
    fn speaking_flag(&self) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        None
    }
    /// Available voices; empty when the platform has none to offer.
    fn list_voices(&self) -> Vec<Voice>;
    /// Select a voice by id (persisted frontend-side, re-applied per session).
    /// Returns whether the request was applied AS ASKED: an empty id is the
    /// explicit reset to the system default (true); an unknown/stale id that
    /// fell back to the default returns false so the caller can SURFACE the
    /// mismatch (a stderr-only fallback left Settings showing a voice that
    /// wasn't the one speaking, forever).
    fn set_voice(&mut self, id: &str) -> bool;
}

/// Silent engine: every operation is a no-op and nothing ever speaks.
/// VOICE.md: non-macOS builds compile with NoopTts.
pub struct NoopTts;

impl TtsEngine for NoopTts {
    fn speak(&mut self, _text: &str, _interrupt: bool) {}
    fn stop(&mut self) {}
    fn is_speaking(&self) -> bool {
        false
    }
    fn list_voices(&self) -> Vec<Voice> {
        Vec::new()
    }
    fn set_voice(&mut self, _id: &str) -> bool {
        true // nothing to mismatch: the silent engine "applies" everything
    }
}

pub fn create_platform_tts() -> Box<dyn TtsEngine> {
    // macOS: AVSpeechSynthesizer on a dedicated worker thread with a command
    // channel; isSpeaking mirrored into an atomic the pipeline thread polls.
    #[cfg(target_os = "macos")]
    {
        Box::new(super::tts_avspeech::AvSpeechTts::new())
    }
    // Everyone else: the silent engine (VOICE.md: non-macOS builds compile
    // with NoopTts).
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(NoopTts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_tts_never_speaks_and_lists_no_voices() {
        let mut tts = NoopTts;
        tts.speak("hello", false);
        assert!(!tts.is_speaking());
        assert!(tts.list_voices().is_empty());
        tts.stop();
        assert!(!tts.is_speaking());
    }

    #[test]
    fn platform_factory_engine_is_quiet_at_rest() {
        let tts = create_platform_tts();
        assert!(!tts.is_speaking());
        // macOS gets the real AVSpeech engine end-to-end (voice_list_voices
        // returns real data); every other platform stays silent and empty.
        #[cfg(target_os = "macos")]
        assert!(
            !tts.list_voices().is_empty(),
            "macOS factory must surface real AVSpeech voices"
        );
        #[cfg(not(target_os = "macos"))]
        assert!(tts.list_voices().is_empty());
    }
}
