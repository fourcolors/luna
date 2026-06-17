//! AVSpeechSynthesizer TTS engine (macOS only).
//!
//! Compiled under `cfg(all(feature = "voice", target_os = "macos"))` — see
//! the module declaration in voice/mod.rs. Every behavioral claim below was
//! verified by the compiled probe in .scratch/avspeech-probe (FINDINGS.md);
//! trust that over Apple-doc folklore.
//!
//! Architecture (VOICE.md):
//!
//! * `AVSpeechSynthesizer` is **!Send** (compile-verified by the probe), so
//!   it is created on, owned by, and only ever touched from ONE dedicated
//!   std::thread (the "TTS worker"). The [`AvSpeechTts`] handle holds just
//!   an mpsc `Sender<Cmd>` + a shared `AtomicBool` — trivially `Send`.
//! * Queueing is native: back-to-back `speakUtterance` calls play serially
//!   (probe phase D), and `stopSpeakingAtBoundary(Immediate)` stops the
//!   current utterance AND clears the queue — so `interrupt` and `stop`
//!   need no queue bookkeeping of our own.
//! * NO run-loop pumping anywhere: inside the Tauri app the MAIN thread's
//!   NSRunLoop (NSApplication) services AVSpeech's queue advancement (probe
//!   phases F/G — pumping a worker's own loop does nothing). Headless
//!   processes (plain `cargo test`) only render the FIRST utterance, which
//!   is exactly what the `#[ignore]` smoke test below restricts itself to.
//! * Speaking state: the worker polls `isSpeaking` every tick and mirrors
//!   it into the shared `AtomicBool` the pipeline thread polls (trait
//!   `is_speaking`). Probe trap: there is a brief false window (~35ms)
//!   between `speakUtterance` returning and `isSpeaking` going true, so the
//!   worker reports "speaking" from the moment a Speak command lands until
//!   real start — keeping the half-duplex mic gate closed during speech
//!   onset — watchdogged at [`START_TIMEOUT`] so a wedged synthesizer can't
//!   pin the flag true forever.
//! * Voice selection: resolved ONCE at `set_voice` time via
//!   `voiceWithIdentifier` (returns `None` for a stale/unknown id → fall
//!   back to the system default voice, not the previously pinned one).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2_avf_audio::{
    AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesisVoiceQuality,
    AVSpeechSynthesizer, AVSpeechUtterance,
};
use objc2_foundation::NSString;

use super::tts::{TtsEngine, Voice};

/// Default playback volume: slight headroom under full scale (1.0 booms on
/// some output devices; utterance default is 1.0).
const DEFAULT_VOLUME: f32 = 0.9;
/// Worker idle-poll cadence for `isSpeaking`. Command pickup is NOT bounded
/// by this — `recv_timeout` wakes immediately when a command arrives.
const POLL: Duration = Duration::from_millis(50);
/// A speak whose `isSpeaking` never goes true within this window is wedged
/// (probe: normal start latency ≈ 35ms). Logged + flag released.
const START_TIMEOUT: Duration = Duration::from_millis(1500);
/// Bound on the `list_voices` round trip; the first `speechVoices()` call
/// loads the voice registry and can take a few hundred ms.
const LIST_TIMEOUT: Duration = Duration::from_secs(3);

enum Cmd {
    Speak { text: String, interrupt: bool },
    Stop,
    /// Pin a voice; the reply reports whether the id applied AS ASKED
    /// (false = unknown/stale id fell back to the system default).
    SetVoice(String, mpsc::Sender<bool>),
    ListVoices(mpsc::Sender<Vec<Voice>>),
    Shutdown,
}

/// macOS TTS engine handle. All ObjC state lives on the worker thread; this
/// struct is plain channels + an atomic, hence `Send` as `TtsEngine` needs.
pub struct AvSpeechTts {
    tx: mpsc::Sender<Cmd>,
    speaking: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AvSpeechTts {
    pub fn new() -> Self {
        Self::with_volume(DEFAULT_VOLUME)
    }

    /// Engine with a custom utterance volume (0.0–1.0). Used by the audible
    /// smoke test to whisper at 0.1.
    fn with_volume(volume: f32) -> Self {
        let (tx, rx) = mpsc::channel();
        let speaking = Arc::new(AtomicBool::new(false));
        let flag = speaking.clone();
        let worker = std::thread::Builder::new()
            .name("luna-voice-tts".to_string())
            .spawn(move || worker_main(rx, flag, volume));
        let worker = match worker {
            Ok(h) => Some(h),
            Err(e) => {
                // Inert engine: sends fail silently, lists come back empty,
                // is_speaking stays false. Same posture as NoopTts.
                eprintln!("voice/tts: failed to spawn TTS worker thread: {e}");
                None
            }
        };
        Self {
            tx,
            speaking,
            worker,
        }
    }

}

impl TtsEngine for AvSpeechTts {
    fn speak(&mut self, text: &str, interrupt: bool) {
        let text = text.trim();
        if text.is_empty() {
            // Nothing speakable; an interrupting empty speak still honors
            // its queue-clearing half. Also keeps the start-watchdog from
            // pinning the speaking flag true for a phantom utterance.
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
        // The pipeline thread polls this atomic directly so a blocked
        // list_voices round trip (worker busy, registry loading) can never
        // stall the audio loop behind the controller's tts Mutex.
        Some(self.speaking.clone())
    }

    fn list_voices(&self) -> Vec<Voice> {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(Cmd::ListVoices(reply_tx)).is_err() {
            return Vec::new();
        }
        reply_rx.recv_timeout(LIST_TIMEOUT).unwrap_or_default()
    }

    fn set_voice(&mut self, id: &str) -> bool {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(Cmd::SetVoice(id.to_string(), reply_tx)).is_err() {
            return true; // inert engine: nothing speaks, nothing to mismatch
        }
        // Worker replies after voiceWithIdentifier resolves; the first call
        // may load the voice registry, hence the list-sized timeout. On a
        // timeout we don't KNOW a fallback happened — report success rather
        // than raise a false alarm.
        reply_rx.recv_timeout(LIST_TIMEOUT).unwrap_or(true)
    }
}

impl Drop for AvSpeechTts {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Shutdown);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

// ── worker thread ────────────────────────────────────────────────────────

fn worker_main(rx: mpsc::Receiver<Cmd>, speaking: Arc<AtomicBool>, volume: f32) {
    // !Send object: born, used, and dropped on THIS thread only.
    let synth = unsafe { AVSpeechSynthesizer::new() };
    // Pinned voice; None = system default. AVSpeechSynthesisVoice itself is
    // Send+Sync, but keeping it worker-local keeps all ObjC on one thread.
    let mut voice: Option<Retained<AVSpeechSynthesisVoice>> = None;
    // Set when a speak was issued while isSpeaking was (still) false —
    // bridges the ~35ms post-speakUtterance false window (probe trap).
    let mut await_start: Option<Instant> = None;

    loop {
        let msg = rx.recv_timeout(POLL);
        // Every iteration runs inside its own autorelease pool: this thread
        // lives for the whole process and AVFoundation autoreleases
        // temporaries internally (speechVoices(), voiceWithIdentifier(),
        // isSpeaking(), utterance plumbing). Without a per-tick drain those
        // land in the thread's implicit runtime pool — which is only emptied
        // at thread exit, i.e. never — and memory grows with every utterance
        // spoken. Retained values created inside (the pinned voice) own a
        // +1 retain and legally outlive the pool.
        let shutdown = objc2::rc::autoreleasepool(|_| {
            match msg {
                Ok(Cmd::Speak { text, interrupt }) => {
                    if interrupt {
                        // Stops the current utterance AND clears the native queue.
                        let _ =
                            unsafe { synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
                    }
                    // Fresh utterance per speak — re-speaking the same instance
                    // raises an ObjC exception (probe).
                    let utt = make_utterance(&text, voice.as_deref(), volume);
                    unsafe { synth.speakUtterance(&utt) };
                    if !unsafe { synth.isSpeaking() } {
                        await_start = Some(Instant::now());
                    }
                }
                Ok(Cmd::Stop) => {
                    let _ = unsafe { synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
                    await_start = None;
                }
                Ok(Cmd::SetVoice(id, reply)) => {
                    voice = resolve_voice(&id);
                    // Applied-as-asked: blank = explicit reset (success);
                    // otherwise the id must have actually resolved.
                    let applied = id.trim().is_empty() || voice.is_some();
                    let _ = reply.send(applied);
                }
                Ok(Cmd::ListVoices(reply)) => {
                    let _ = reply.send(collect_voices());
                }
                Ok(Cmd::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => return true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            // Poll + publish the speaking state (the pipeline thread reads this
            // at its own ~20Hz tick to drive `speaking` + the half-duplex gate).
            let now_speaking = unsafe { synth.isSpeaking() };
            if now_speaking {
                await_start = None;
            } else if let Some(t0) = await_start {
                if t0.elapsed() > START_TIMEOUT {
                    // Never started: wedged synthesizer (or an unspeakable
                    // utterance). Release the flag so the mic re-arms; the
                    // TtsEngine trait has no error channel, so log it.
                    eprintln!(
                        "voice/tts: utterance never started speaking within {START_TIMEOUT:?}"
                    );
                    await_start = None;
                }
            }
            speaking.store(now_speaking || await_start.is_some(), Ordering::SeqCst);
            false
        });
        if shutdown {
            break;
        }
    }

    // Shutdown: best-effort silence before the synthesizer drops.
    objc2::rc::autoreleasepool(|_| {
        let _ = unsafe { synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
    });
    speaking.store(false, Ordering::SeqCst);
}

/// Build one utterance: default system rate, configured volume, pinned voice
/// (or `None` → system default voice).
fn make_utterance(
    text: &str,
    voice: Option<&AVSpeechSynthesisVoice>,
    volume: f32,
) -> Retained<AVSpeechUtterance> {
    let ns_text = NSString::from_str(text);
    let utt = unsafe { AVSpeechUtterance::speechUtteranceWithString(&ns_text) };
    unsafe {
        // VOICE task spec: default rate, slight volume headroom.
        utt.setRate(objc2_avf_audio::AVSpeechUtteranceDefaultSpeechRate);
        utt.setVolume(volume.clamp(0.0, 1.0));
        // setVoice(None) selects the system default explicitly.
        utt.setVoice(voice);
    }
    utt
}

/// Resolve a voice id. Empty/blank id = explicit reset to system default;
/// unknown/stale id = fall back to system default (logged).
fn resolve_voice(id: &str) -> Option<Retained<AVSpeechSynthesisVoice>> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let ns_id = NSString::from_str(id);
    let resolved = unsafe { AVSpeechSynthesisVoice::voiceWithIdentifier(&ns_id) };
    if resolved.is_none() {
        eprintln!("voice/tts: unknown voice id {id:?}; falling back to system default");
    }
    resolved
}

fn collect_voices() -> Vec<Voice> {
    let voices = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    voices
        .iter()
        .map(|v| Voice {
            id: unsafe { v.identifier() }.to_string(),
            name: unsafe { v.name() }.to_string(),
            lang: unsafe { v.language() }.to_string(),
            quality: quality_str(unsafe { v.quality() }).to_string(),
        })
        .collect()
}

/// Map AVSpeech's quality tiers onto the VOICE.md contract strings
/// (`default | enhanced | premium`). Unknown future tiers degrade to
/// "default" rather than leaking a new string to the frontend.
fn quality_str(q: AVSpeechSynthesisVoiceQuality) -> &'static str {
    match q {
        AVSpeechSynthesisVoiceQuality::Enhanced => "enhanced",
        AVSpeechSynthesisVoiceQuality::Premium => "premium",
        _ => "default",
    }
}

// ── tests ────────────────────────────────────────────────────────────────
//
// Everything except the #[ignore] smoke is SILENT: listing voices and
// resolving identifiers never touches the audio output.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_real_voices_with_contract_fields() {
        let tts = AvSpeechTts::new();
        let voices = tts.list_voices();
        assert!(!voices.is_empty(), "macOS always ships AVSpeech voices");
        for v in &voices {
            assert!(!v.id.is_empty(), "voice id must be non-empty");
            assert!(!v.name.is_empty(), "voice name must be non-empty");
            assert!(!v.lang.is_empty(), "voice lang must be non-empty");
            assert!(
                matches!(v.quality.as_str(), "default" | "enhanced" | "premium"),
                "quality {:?} outside the VOICE.md contract",
                v.quality
            );
        }
    }

    #[test]
    fn set_voice_pins_known_id_and_falls_back_to_default_on_stale() {
        let mut tts = AvSpeechTts::new();
        let first = tts
            .list_voices()
            .into_iter()
            .next()
            .expect("at least one voice");
        assert!(tts.set_voice(&first.id), "known id applies as asked");
        // Stale/unknown id → system default, NOT sticky-previous — and the
        // fallback is REPORTED (false) so the app can emit a voice-error
        // instead of Settings silently showing a voice that isn't speaking.
        assert!(
            !tts.set_voice("com.apple.voice.does.not.exist.luna-test"),
            "stale id must report the fallback"
        );
        // Empty id = explicit reset to system default (a success, not a fallback).
        assert!(tts.set_voice(&first.id), "re-pinning known id applies as asked");
        assert!(tts.set_voice(""), "explicit reset is applied-as-asked");
    }

    #[test]
    fn silent_at_rest_and_stop_without_speech_is_safe() {
        let mut tts = AvSpeechTts::new();
        assert!(!tts.is_speaking());
        tts.stop();
        assert!(!tts.is_speaking());
    }

    #[test]
    fn blank_text_is_not_enqueued() {
        let mut tts = AvSpeechTts::new();
        tts.speak("   ", false);
        tts.speak("", true);
        // Give the worker a few polls; the flag must never flip true for a
        // phantom utterance (the speak() guard drops blanks pre-channel).
        std::thread::sleep(Duration::from_millis(150));
        assert!(!tts.is_speaking(), "blank text must not flip the speaking flag");
    }

    /// REAL AUDIO smoke — speaks out loud (quietly, volume 0.1). Run once
    /// manually:
    ///
    ///   cargo test --lib -- --ignored tts_avspeech
    ///
    /// Single utterance ONLY: the first utterance renders without any run
    /// loop (probe finding #1); multi-utterance flows additionally need the
    /// app's live main run loop, which a headless test process lacks. The
    /// >2s duration floor distinguishes real audio from the 1.5s wedge
    /// watchdog releasing the flag.
    #[test]
    #[ignore = "audible: speaks through the default output device"]
    fn smoke_first_utterance_speaks_and_is_speaking_roundtrips() {
        let mut tts = AvSpeechTts::with_volume(0.1);
        tts.speak("Luna voice check complete, all systems are go.", false);

        let t0 = Instant::now();
        while !tts.is_speaking() && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(tts.is_speaking(), "is_speaking never went true");
        let started_after = t0.elapsed();

        while tts.is_speaking() && t0.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!tts.is_speaking(), "is_speaking never returned to false");
        let total = t0.elapsed();
        println!(
            "smoke: speaking flag true {started_after:?} after speak(), false again at {total:?}"
        );
        assert!(
            total > Duration::from_secs(2),
            "speech ended after only {total:?} — audio likely did not render \
             (wedge watchdog releases at {START_TIMEOUT:?})"
        );
    }
}
