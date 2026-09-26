//! TTS engine router: selects among speech engines at runtime.
//!
//! `system` — the platform factory (AVSpeech on macOS, NoopTts elsewhere)
//! `fish`   — Fish Audio cloud TTS (tts_fish.rs; works on every platform)
//!
//! The router itself IS a `TtsEngine` (the VoiceController needs no
//! surgery): speak/list/set_voice forward to the active engine; stop halts
//! EVERY engine (a queued utterance must not leak across a switch).
//!
//! The `speaking` signal the pipeline polls is the OR of all engines' flags,
//! mirrored into one router-owned atomic by a ~50Hz thread. OR-of-all —
//! not active-engine-only — because a stale flag can stay true briefly
//! after the user switches engines mid-utterance, and the half-duplex mic
//! gate must keep suppressing either way. Engines without a lock-free flag
//! are polled through their entry Mutex with try_lock (a busy engine —
//! list_voices round trips — just reports its last value rather than
//! stalling the mirror).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::tts::{self, TtsEngine, Voice};
use super::tts_fish;
use super::{lock_unpoisoned, EventSink};

/// Mirror cadence: the pipeline's own speaking poll is ~20Hz via its tick;
/// 20ms here keeps the reported flag fresher than its consumer.
const MIRROR_POLL: Duration = Duration::from_millis(20);

/// Payload for `voice_tts_info`: engine inventory + Fish key presence
/// (never the key itself — it must not cross the IPC bridge).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TtsInfo {
    pub engine: String,
    pub engines: Vec<String>,
    pub fish_key_configured: bool,
}

struct EngineEntry {
    name: &'static str,
    engine: Mutex<Box<dyn TtsEngine>>,
    /// Lock-free speaking flag when the engine exposes one (None → mirror
    /// try_locks the engine for `is_speaking`, reporting false while busy).
    flag: Option<Arc<AtomicBool>>,
}

struct TtsRouterInner {
    engines: Vec<EngineEntry>,
    active: Mutex<String>,
    reported: Arc<AtomicBool>,
    mirror_stop: Arc<AtomicBool>,
    fish_config: tts_fish::SharedFishConfig,
}

/// Command-facing handle — app-managed alongside the VoiceController.
/// Routing state lives behind Arcs so the handle stays a cheap clone.
pub struct TtsRouterHandle {
    inner: Arc<TtsRouterInner>,
}

/// The router as an engine + its command handle. Engine switching is live:
/// `speak` consults `active` per call — no pipeline restart needed.
pub struct TtsRouter {
    inner: Arc<TtsRouterInner>,
    mirror: Option<std::thread::JoinHandle<()>>,
}

/// Build the routed engine stack for production: platform engine + Fish.
/// `events` feeds Fish's voice-error emission (missing key, API failures).
pub fn create_routed(
    events: Option<Arc<dyn EventSink>>,
) -> (Box<dyn TtsEngine>, TtsRouterHandle) {
    let fish_config = tts_fish::shared_config(tts_fish::load_fish_config());
    create_routed_with(
        vec![
            ("system", tts::create_platform_tts()),
            (
                "fish",
                Box::new(tts_fish::FishTts::new(fish_config.clone(), events))
                    as Box<dyn TtsEngine>,
            ),
        ],
        "system",
        fish_config,
    )
}

/// Test seam: caller supplies the engine set + shared Fish config.
pub fn create_routed_with(
    engines: Vec<(&'static str, Box<dyn TtsEngine>)>,
    active: &str,
    fish_config: tts_fish::SharedFishConfig,
) -> (Box<dyn TtsEngine>, TtsRouterHandle) {
    let entries: Vec<EngineEntry> = engines
        .into_iter()
        .map(|(name, engine)| {
            let flag = engine.speaking_flag();
            EngineEntry {
                name,
                engine: Mutex::new(engine),
                flag,
            }
        })
        .collect();
    assert!(
        entries.iter().any(|e| e.name == active),
        "unknown initial TTS engine {active:?}"
    );
    let inner = Arc::new(TtsRouterInner {
        engines: entries,
        active: Mutex::new(active.to_string()),
        reported: Arc::new(AtomicBool::new(false)),
        mirror_stop: Arc::new(AtomicBool::new(false)),
        fish_config,
    });
    let mirror_inner = inner.clone();
    let mirror = std::thread::Builder::new()
        .name("luna-voice-tts-mirror".to_string())
        .spawn(move || mirror_main(mirror_inner))
        .ok();
    let router = TtsRouter {
        inner,
        mirror,
    };
    let handle = TtsRouterHandle {
        inner: router.inner.clone(),
    };
    (Box::new(router), handle)
}

/// OR of every engine's speaking state into `reported`.
fn mirror_main(inner: Arc<TtsRouterInner>) {
    while !inner.mirror_stop.load(Ordering::SeqCst) {
        let any = inner.engines.iter().any(|e| match &e.flag {
            Some(f) => f.load(Ordering::SeqCst),
            None => e
                .engine
                .try_lock()
                .map(|en| en.is_speaking())
                .unwrap_or(false),
        });
        inner.reported.store(any, Ordering::SeqCst);
        std::thread::sleep(MIRROR_POLL);
    }
}

fn entry<'a>(
    inner: &'a TtsRouterInner,
    name: &str,
) -> Option<&'a EngineEntry> {
    inner.engines.iter().find(|e| e.name == name)
}

fn active_entry<'a>(inner: &'a TtsRouterInner) -> Option<&'a EngineEntry> {
    let active = lock_unpoisoned(&inner.active).clone();
    entry(inner, &active)
}

impl TtsEngine for TtsRouter {
    fn speak(&mut self, text: &str, interrupt: bool) {
        if let Some(e) = active_entry(&self.inner) {
            lock_unpoisoned(&e.engine).speak(text, interrupt);
        }
    }

    /// Stop halts EVERY engine: a sentence queued on the outgoing engine
    /// must not start playing after the user switches.
    fn stop(&mut self) {
        for e in &self.inner.engines {
            lock_unpoisoned(&e.engine).stop();
        }
    }

    fn is_speaking(&self) -> bool {
        self.inner.reported.load(Ordering::SeqCst)
    }

    /// The OR-mirrored flag — stays correct across mid-utterance engine
    /// switches, which a cached per-engine flag could not.
    fn speaking_flag(&self) -> Option<Arc<AtomicBool>> {
        Some(self.inner.reported.clone())
    }

    fn list_voices(&self) -> Vec<Voice> {
        active_entry(&self.inner)
            .map(|e| lock_unpoisoned(&e.engine).list_voices())
            .unwrap_or_default()
    }

    fn set_voice(&mut self, id: &str) -> bool {
        active_entry(&self.inner)
            .map(|e| lock_unpoisoned(&e.engine).set_voice(id))
            .unwrap_or(true)
    }
}

impl Drop for TtsRouter {
    fn drop(&mut self) {
        self.inner.mirror_stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.mirror.take() {
            let _ = h.join();
        }
    }
}

impl TtsRouterHandle {
    /// Switch the active engine; unknown names are rejected with the valid
    /// set. Stops all engines first so nothing speaks across the boundary.
    pub fn set_engine(&self, name: &str) -> Result<String, String> {
        if entry(&self.inner, name).is_none() {
            let valid: Vec<&str> = self.inner.engines.iter().map(|e| e.name).collect();
            return Err(format!(
                "unknown TTS engine {name:?} (valid: {})",
                valid.join(", ")
            ));
        }
        for e in &self.inner.engines {
            lock_unpoisoned(&e.engine).stop();
        }
        *lock_unpoisoned(&self.inner.active) = name.to_string();
        Ok(name.to_string())
    }

    pub fn engine(&self) -> String {
        lock_unpoisoned(&self.inner.active).clone()
    }

    pub fn info(&self) -> TtsInfo {
        TtsInfo {
            engine: self.engine(),
            engines: self.inner.engines.iter().map(|e| e.name.to_string()).collect(),
            fish_key_configured: lock_unpoisoned(&self.inner.fish_config)
                .api_key
                .is_some(),
        }
    }

    /// Write/clear the Fish API key: persists ~/.luna/fish-api-key (0600)
    /// and updates the running config. Empty key deletes the file.
    pub fn set_fish_key(&self, key: &str) -> Result<(), String> {
        tts_fish::persist_fish_key(key)?;
        lock_unpoisoned(&self.inner.fish_config).api_key = {
            let k = key.trim();
            if k.is_empty() {
                None
            } else {
                Some(k.to_string())
            }
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct MockTts {
        spoken: Arc<StdMutex<Vec<String>>>,
        flag: Arc<AtomicBool>,
        stop_count: Arc<StdMutex<u32>>,
        voice: Arc<StdMutex<String>>,
    }

    impl MockTts {
        fn new() -> Self {
            Self {
                spoken: Arc::new(StdMutex::new(Vec::new())),
                flag: Arc::new(AtomicBool::new(false)),
                stop_count: Arc::new(StdMutex::new(0)),
                voice: Arc::new(StdMutex::new(String::new())),
            }
        }
    }

    impl TtsEngine for MockTts {
        fn speak(&mut self, text: &str, _interrupt: bool) {
            self.spoken.lock().unwrap().push(text.to_string());
        }
        fn stop(&mut self) {
            *self.stop_count.lock().unwrap() += 1;
        }
        fn is_speaking(&self) -> bool {
            self.flag.load(Ordering::SeqCst)
        }
        fn speaking_flag(&self) -> Option<Arc<AtomicBool>> {
            Some(self.flag.clone())
        }
        fn list_voices(&self) -> Vec<Voice> {
            vec![Voice {
                id: "v".to_string(),
                name: "v".to_string(),
                lang: "en".to_string(),
                quality: "default".to_string(),
            }]
        }
        fn set_voice(&mut self, id: &str) -> bool {
            *self.voice.lock().unwrap() = id.to_string();
            true
        }
    }

    fn mocks() -> (MockTts, MockTts) {
        (MockTts::new(), MockTts::new())
    }

    struct Pair {
        router: Box<dyn TtsEngine>,
        handle: TtsRouterHandle,
        spoken_a: Arc<StdMutex<Vec<String>>>,
        spoken_b: Arc<StdMutex<Vec<String>>>,
        flag_a: Arc<AtomicBool>,
        flag_b: Arc<AtomicBool>,
        stops_a: Arc<StdMutex<u32>>,
        stops_b: Arc<StdMutex<u32>>,
    }

    fn router_pair() -> Pair {
        let (a, b) = mocks();
        let p = (
            a.spoken.clone(),
            b.spoken.clone(),
            a.flag.clone(),
            b.flag.clone(),
            a.stop_count.clone(),
            b.stop_count.clone(),
        );
        let (router, handle) = create_routed_with(
            vec![
                ("a", Box::new(a) as Box<dyn TtsEngine>),
                ("b", Box::new(b) as Box<dyn TtsEngine>),
            ],
            "a",
            tts_fish::shared_config(tts_fish::FishConfig {
                api_key: None,
                api_base: String::new(),
                model: String::new(),
                reference_id: None,
            }),
        );
        Pair {
            router,
            handle,
            spoken_a: p.0,
            spoken_b: p.1,
            flag_a: p.2,
            flag_b: p.3,
            stops_a: p.4,
            stops_b: p.5,
        }
    }

    #[test]
    fn speak_routes_to_active_and_switch_moves_traffic() {
        let mut p = router_pair();
        p.router.speak("one", false);
        p.handle.set_engine("b").unwrap();
        p.router.speak("two", false);
        assert_eq!(*p.spoken_a.lock().unwrap(), vec!["one"]);
        assert_eq!(*p.spoken_b.lock().unwrap(), vec!["two"]);
    }

    #[test]
    fn unknown_engine_rejected_with_valid_set() {
        let p = router_pair();
        let err = p.handle.set_engine("nope").unwrap_err();
        assert!(err.contains("a") && err.contains("b"), "error names valid: {err}");
        assert_eq!(p.handle.engine(), "a");
    }

    #[test]
    fn reported_flag_ors_all_engines() {
        let p = router_pair();
        p.flag_a.store(true, Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        while !p.router.is_speaking() && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(p.router.is_speaking(), "mirror must OR engine A's flag");
        p.flag_a.store(false, Ordering::SeqCst);
        p.flag_b.store(true, Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        while !p.router.is_speaking() && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(p.router.is_speaking(), "mirror must OR engine B's flag");
        p.flag_b.store(false, Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        while p.router.is_speaking() && t0.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!p.router.is_speaking());
    }

    #[test]
    fn stop_and_switch_stops_every_engine() {
        let mut p = router_pair();
        p.router.stop();
        p.handle.set_engine("b").unwrap();
        // Router::stop hit both; the engine switch hit both again.
        assert_eq!(*p.stops_a.lock().unwrap(), 2);
        assert_eq!(*p.stops_b.lock().unwrap(), 2);
    }

    #[test]
    fn set_voice_and_list_forward_to_active() {
        let mut p = router_pair();
        assert!(p.router.set_voice("v"));
        assert_eq!(p.router.list_voices().len(), 1);
        p.handle.set_engine("b").unwrap();
        assert_eq!(p.router.list_voices().len(), 1);
    }

    #[test]
    fn info_reports_inventory_and_key_presence() {
        let p = router_pair();
        let info = p.handle.info();
        assert_eq!(info.engine, "a");
        assert_eq!(info.engines, vec!["a".to_string(), "b".to_string()]);
        assert!(!info.fish_key_configured);
    }
}
