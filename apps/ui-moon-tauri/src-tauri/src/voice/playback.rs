//! Audio playback seam for network TTS engines (tts_fish.rs).
//!
//! AVSpeechSynthesizer renders straight to the output device, so the existing
//! TTS path never needed a playback abstraction. The Fish engine receives
//! raw PCM bytes over HTTP and must drive an output stream itself — this is
//! that seam. Mirrors capture.rs's discipline: cpal `Stream`s are `!Send`,
//! so [`CpalSink`] is created, used, and dropped on the TTS worker thread.
//!
//! The trait exists so engine unit tests inject a sample-collecting sink
//! ([`QueueSink`]) and never touch an audio device.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::lock_unpoisoned;

/// Mono f32 samples are written here at the sink's device rate; channel
/// duplication happens inside the sink (the Fish API returns mono PCM).
pub trait AudioSink: Send {
    /// Non-blocking enqueue; playback drains at device pace.
    fn write(&mut self, samples: &[f32]);
    /// Sample rate the sink was opened with — the engine resamples INTO it.
    fn rate(&self) -> u32;
    /// True while enqueued audio remains unplayed (drives the engine's
    /// speaking flag between HTTP completion and audible end).
    fn has_pending(&self) -> bool;
    /// Drop all unplayed audio (stop/interrupt path).
    fn flush(&mut self);
}

/// cpal output stream draining a shared mono queue into every channel.
/// Callbacks output silence on underrun; the stream stays open for the
/// engine's lifetime once created (lazy — first speak, not app boot, so a
/// voice-off session never holds the output device).
pub struct CpalSink {
    _stream: cpal::Stream,
    queue: Arc<Mutex<VecDeque<f32>>>,
    rate: u32,
}

impl CpalSink {
    pub fn open() -> Result<Self, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "no default output device".to_string())?;
        let config = device
            .default_output_config()
            .map_err(|e| format!("no output config: {e}"))?;
        let rate: u32 = config.sample_rate();
        let channels = config.channels() as usize;
        let stream_config: cpal::StreamConfig = config.into();

        let queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
        let q = queue.clone();
        let stream = device
            .build_output_stream(
                &stream_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let mut queue = lock_unpoisoned(&q);
                    // Mono source: pull one sample per frame, write it to
                    // every channel. Underrun tail → zeros.
                    for frame in data.chunks_mut(channels) {
                        let s = queue.pop_front().unwrap_or(0.0);
                        for c in frame.iter_mut() {
                            *c = s;
                        }
                    }
                },
                |e: cpal::StreamError| {
                    eprintln!("voice/playback: output stream error: {e}");
                },
                None,
            )
            .map_err(|e| format!("failed to open output stream: {e}"))?;
        stream
            .play()
            .map_err(|e| format!("failed to start output stream: {e}"))?;
        Ok(Self {
            _stream: stream,
            queue,
            rate,
        })
    }
}

impl AudioSink for CpalSink {
    fn write(&mut self, samples: &[f32]) {
        lock_unpoisoned(&self.queue).extend(samples.iter().copied());
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn has_pending(&self) -> bool {
        !lock_unpoisoned(&self.queue).is_empty()
    }
    fn flush(&mut self) {
        lock_unpoisoned(&self.queue).clear();
    }
}

/// Test sink: collects every written sample; `has_pending` flips off after
/// `drain_after` writes so speaking-flag tests exercise the drain path.
pub struct QueueSink {
    rate: u32,
    pub written: Vec<f32>,
    /// Simulated unplayed backlog (counts down per `release()`).
    pending: usize,
}

impl QueueSink {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            written: Vec::new(),
            pending: 0,
        }
    }
    /// Simulate playback draining (tests).
    pub fn release(&mut self, n: usize) {
        self.pending = self.pending.saturating_sub(n);
    }
}

impl AudioSink for QueueSink {
    fn write(&mut self, samples: &[f32]) {
        self.pending += samples.len();
        self.written.extend_from_slice(samples);
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn has_pending(&self) -> bool {
        self.pending > 0
    }
    fn flush(&mut self) {
        self.pending = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_sink_collects_and_drains() {
        let mut s = QueueSink::new(44_100);
        assert!(!s.has_pending());
        s.write(&[0.1, -0.2, 0.3]);
        assert!(s.has_pending());
        assert_eq!(s.written, vec![0.1, -0.2, 0.3]);
        s.release(3);
        assert!(!s.has_pending());
        s.write(&[0.9]);
        s.flush();
        assert!(!s.has_pending());
    }

    /// Real-device smoke: opens the default output. Marked ignore — needs an
    /// output device (headless CI may not have one).
    #[test]
    #[ignore = "hardware: opens the default output device"]
    fn cpal_sink_opens_and_accepts_samples() {
        let mut s = CpalSink::open().expect("output device");
        s.write(&vec![0.0f32; 4096]);
        assert!(s.has_pending());
        s.flush();
        assert!(!s.has_pending());
    }
}
