//! Microphone capture: cpal input stream → mono 16kHz sample chunks.
//!
//! CRITICAL: cpal `Stream`s are `!Send`. [`CpalSource`] is therefore created
//! and dropped ON the pipeline thread itself (the controller only holds a
//! factory closure). The cpal data callback (a CoreAudio thread on macOS)
//! downmixes interleaved channels to mono and ships raw native-rate chunks
//! over an mpsc channel; the pipeline thread resamples to 16k on receive.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::endpoint::TARGET_RATE;
use super::lock_unpoisoned;

/// Abstract audio source so controller tests run without an audio device.
/// Yields chunks of 16kHz MONO samples; `Ok(None)` means "no data yet"
/// (timeout), which keeps the pipeline loop ticking for control messages.
pub trait AudioSource {
    fn next_chunk(&mut self, timeout: Duration) -> Result<Option<Vec<f32>>, String>;
}

/// Downmix interleaved multi-channel samples to mono by averaging.
pub fn downmix_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Naive ONE-SHOT linear resampler — for a single contiguous buffer (the
/// spike's whole-file path). Do NOT call it per streaming chunk: it carries
/// no state, so every chunk boundary drops the tail samples that needed the
/// next chunk's first sample and resets the fractional phase. Live capture
/// uses [`StreamingResampler`] instead.
pub fn resample_linear(input: &[f32], from_rate: f64, to_rate: f64) -> Vec<f32> {
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

/// Streaming linear resampler: carries the fractional read position AND the
/// last sample of the previous chunk across calls, so per-cpal-callback
/// chunking introduces no boundary artifacts. With the stateless
/// [`resample_linear`] a 512-sample 48k chunk emitted 170 outputs whose last
/// read position was 507 — samples 510–511 were dropped at EVERY chunk
/// boundary (~0.4% periodic time compression), and non-integer ratios
/// (44.1k→16k = 2.75625) additionally reset the fractional phase each chunk.
pub struct StreamingResampler {
    /// Input samples consumed per output sample (`from_rate / to_rate`).
    ratio: f64,
    /// Index of the NEXT output sample's read position within the virtual
    /// buffer `[prev?] ++ input`.
    pos: f64,
    /// Last input sample of the previous chunk (interpolation seed).
    prev: Option<f32>,
}

impl StreamingResampler {
    pub fn new(from_rate: f64, to_rate: f64) -> Self {
        Self {
            ratio: from_rate / to_rate,
            pos: 0.0,
            prev: None,
        }
    }

    /// Resample one chunk, continuing exactly where the previous chunk left
    /// off: global output sample k is read at input position k·ratio, the
    /// same positions a one-shot resample of the concatenated stream uses.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if (self.ratio - 1.0).abs() < f64::EPSILON {
            return input.to_vec(); // same-rate passthrough, no state needed
        }
        if input.is_empty() {
            return Vec::new();
        }
        // Virtual buffer: [prev?] ++ input, indexed by `pos`.
        let offset = usize::from(self.prev.is_some());
        let virt_len = input.len() + offset;
        let at = |i: usize| -> f32 {
            if offset == 1 && i == 0 {
                self.prev.unwrap_or(0.0)
            } else {
                input[i - offset]
            }
        };
        let mut out = Vec::with_capacity((input.len() as f64 / self.ratio) as usize + 2);
        // Interpolation needs idx+1: a read position at/after the final
        // sample WAITS for the next chunk instead of being dropped.
        while self.pos + 1.0 < virt_len as f64 {
            let idx = self.pos as usize;
            let frac = (self.pos - idx as f64) as f32;
            let a = at(idx);
            let b = at(idx + 1);
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        // Carry the final sample as the next chunk's seed; re-base `pos`
        // onto it (the loop guarantees pos ≥ virt_len-1 here, so pos ≥ 0).
        self.prev = Some(at(virt_len - 1));
        self.pos -= (virt_len - 1) as f64;
        out
    }
}

/// RMS level of a chunk, for the `voice-state` listening visualizer (0–1 for
/// normalized samples).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

// ── macOS microphone permission (TCC) ───────────────────────────────────
//
// A DENIED microphone does NOT surface through cpal on macOS: CoreAudio
// still enumerates the default device, `build_input_stream` succeeds, and
// the data callback delivers all-zero samples forever — no
// `cpal::StreamError` ever fires. So authorization is checked EXPLICITLY
// before the stream opens; a denial becomes an `Err`, which the pipeline
// surfaces as the `voice-error` VOICE.md requires for "Mic permission
// denied" (otherwise the moon pulses "listening" at level 0 forever).

/// Map a raw `AVAuthorizationStatus` to the user-facing permission error.
/// `0` NotDetermined → `None` (the system prompts on first capture);
/// `1` Restricted / `2` Denied → `Some(error)`;
/// `3` Authorized (and unknown future values) → `None`.
pub fn mic_permission_error(status: i64) -> Option<String> {
    match status {
        1 | 2 => Some(
            "Mic permission denied — allow Luna under System Settings → \
             Privacy & Security → Microphone, then turn voice back on"
                .to_string(),
        ),
        _ => None,
    }
}

/// Raw microphone `AVAuthorizationStatus` via AVCaptureDevice. The class is
/// looked up at runtime (objc2 is already a voice dep); the empty extern
/// block links AVFoundation so the lookup can't miss. `"soun"` is
/// `AVMediaTypeAudio`'s documented constant value.
#[cfg(target_os = "macos")]
fn mic_authorization_status() -> i64 {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2_foundation::NSString;
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
        return 3; // class missing (ancient macOS): behave as authorized
    };
    let media = NSString::from_str("soun");
    let status: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
    status as i64
}

/// Live microphone source. Holds the (!Send) cpal stream for its lifetime;
/// dropping it stops capture.
pub struct CpalSource {
    _stream: cpal::Stream,
    rx: mpsc::Receiver<Vec<f32>>,
    /// Stream-error slot filled by cpal's error callback (device loss etc.);
    /// surfaced as `Err` from `next_chunk` so the pipeline can fail cleanly.
    err: Arc<Mutex<Option<String>>>,
    resampler: StreamingResampler,
}

impl CpalSource {
    pub fn start() -> Result<Self, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        // TCC check FIRST: a denied mic opens a working-looking stream that
        // only ever yields silence (see module notes above).
        #[cfg(target_os = "macos")]
        if let Some(msg) = mic_permission_error(mic_authorization_status()) {
            return Err(msg);
        }

        let host = cpal::default_host();
        let device = host.default_input_device().ok_or_else(|| {
            "no default input device — check microphone permission".to_string()
        })?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("no input config: {e}"))?;
        // cpal 0.17: SampleRate is a plain u32 type alias.
        let native_rate: u32 = config.sample_rate();
        let channels = config.channels() as usize;
        let sample_format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();

        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let make_err_cb = |slot: Arc<Mutex<Option<String>>>| {
            move |e: cpal::StreamError| {
                *lock_unpoisoned(&slot) = Some(e.to_string());
            }
        };

        // Device-unusable/format failures surface here as a build error —
        // mapped to Err, never panicked. (Permission denial does NOT come
        // through here; it was checked explicitly above.)
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                {
                    let tx = tx.clone();
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let _ = tx.send(downmix_mono(data, channels));
                    }
                },
                make_err_cb(err.clone()),
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                {
                    let tx = tx.clone();
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> =
                            data.iter().map(|&s| s as f32 / 32768.0).collect();
                        let _ = tx.send(downmix_mono(&floats, channels));
                    }
                },
                make_err_cb(err.clone()),
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                {
                    let tx = tx.clone();
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let floats: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect();
                        let _ = tx.send(downmix_mono(&floats, channels));
                    }
                },
                make_err_cb(err.clone()),
                None,
            ),
            other => {
                return Err(format!("unsupported input sample format: {other:?}"))
            }
        }
        .map_err(|e| format!("failed to open microphone stream: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("failed to start microphone stream: {e}"))?;

        Ok(Self {
            _stream: stream,
            rx,
            err,
            // Stateful: carries phase + the boundary sample across the
            // independent cpal callback chunks (one continuous stream).
            resampler: StreamingResampler::new(native_rate as f64, TARGET_RATE as f64),
        })
    }
}

impl AudioSource for CpalSource {
    fn next_chunk(&mut self, timeout: Duration) -> Result<Option<Vec<f32>>, String> {
        if let Some(e) = lock_unpoisoned(&self.err).take() {
            return Err(format!("microphone stream error: {e}"));
        }
        match self.rx.recv_timeout(timeout) {
            Ok(chunk) => Ok(Some(self.resampler.process(&chunk))),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("microphone stream closed unexpectedly".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_same_rate_is_passthrough() {
        let input = vec![0.1, -0.2, 0.3, 0.4];
        assert_eq!(resample_linear(&input, 16_000.0, 16_000.0), input);
    }

    #[test]
    fn resample_48k_to_16k_thirds_the_length_and_keeps_dc() {
        let input = vec![0.5f32; 4800];
        let out = resample_linear(&input, 48_000.0, 16_000.0);
        assert_eq!(out.len(), 1600);
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resample_preserves_a_ramp_monotonically() {
        let input: Vec<f32> = (0..480).map(|i| i as f32 / 480.0).collect();
        let out = resample_linear(&input, 48_000.0, 16_000.0);
        assert_eq!(out.len(), 160);
        for w in out.windows(2) {
            assert!(w[1] >= w[0], "resampled ramp must stay monotonic");
        }
        assert!(out[0].abs() < 1e-6);
    }

    #[test]
    fn downmix_averages_interleaved_channels() {
        // Stereo L=1.0, R=0.0 → mono 0.5.
        let stereo = vec![1.0, 0.0, 1.0, 0.0, 1.0, 0.0];
        assert_eq!(downmix_mono(&stereo, 2), vec![0.5, 0.5, 0.5]);
        // Mono passthrough.
        let mono = vec![0.25, 0.75];
        assert_eq!(downmix_mono(&mono, 1), mono);
    }

    #[test]
    fn rms_of_constant_signal_is_its_amplitude() {
        assert!((rms(&vec![0.6f32; 160]) - 0.6).abs() < 1e-6);
        assert_eq!(rms(&[]), 0.0);
    }

    // ── StreamingResampler (regression: per-chunk boundary drops) ────────

    #[test]
    fn streaming_resampler_matches_one_shot_across_48k_chunk_boundaries() {
        // 3 cpal-sized chunks at the "exact ratio 3" case: chunked output
        // must equal the one-shot resample of the whole buffer sample-for-
        // sample. The stateless version emitted 170 per 512-sample chunk
        // (510 total), dropping 2 boundary samples per callback.
        let input: Vec<f32> = (0..1536).map(|i| (i as f32 * 0.37).sin()).collect();
        let whole = resample_linear(&input, 48_000.0, 16_000.0);
        let mut rs = StreamingResampler::new(48_000.0, 16_000.0);
        let mut chunked = Vec::new();
        for c in input.chunks(512) {
            chunked.extend(rs.process(c));
        }
        assert_eq!(chunked.len(), 512, "exactly 1536/3 outputs — nothing dropped");
        assert_eq!(chunked.len(), whole.len());
        for (k, (a, b)) in chunked.iter().zip(whole.iter()).enumerate() {
            assert!((a - b).abs() < 1e-6, "sample {k} diverged: {a} vs {b}");
        }
    }

    #[test]
    fn streaming_resampler_carries_fractional_phase_for_44_1k_mics() {
        // ratio 2.75625: the old per-chunk reset both dropped tail samples
        // AND snapped the fractional phase to 0 at every boundary. A pure
        // ramp must come out with a uniform step across ALL boundaries.
        let n = 4410 * 4;
        let input: Vec<f32> = (0..n).map(|i| i as f32).collect();
        let whole = resample_linear(&input, 44_100.0, 16_000.0);
        let mut rs = StreamingResampler::new(44_100.0, 16_000.0);
        let mut chunked = Vec::new();
        for c in input.chunks(441) {
            chunked.extend(rs.process(c));
        }
        assert_eq!(
            chunked.len(),
            whole.len(),
            "no samples dropped at chunk boundaries"
        );
        for (k, (a, b)) in chunked.iter().zip(whole.iter()).enumerate() {
            assert!((a - b).abs() < 1e-2, "sample {k}: {a} vs {b}");
        }
        for (k, w) in chunked.windows(2).enumerate() {
            let step = w[1] - w[0];
            assert!(
                (step - 2.75625).abs() < 1e-2,
                "non-uniform step {step} at output {k} (boundary glitch)"
            );
        }
    }

    #[test]
    fn streaming_resampler_same_rate_is_passthrough_and_empty_is_empty() {
        let mut rs = StreamingResampler::new(16_000.0, 16_000.0);
        let input = vec![0.1, -0.2, 0.3];
        assert_eq!(rs.process(&input), input);
        let mut rs = StreamingResampler::new(48_000.0, 16_000.0);
        assert!(rs.process(&[]).is_empty());
    }

    // ── mic permission (regression: denied TCC never produced voice-error) ──

    #[test]
    fn mic_permission_mapping_denied_and_restricted_error_others_pass() {
        // AVAuthorizationStatus: 0 NotDetermined, 1 Restricted, 2 Denied,
        // 3 Authorized. Only the first two must block (and say why).
        let denied = mic_permission_error(2).expect("denied must error");
        assert!(denied.contains("Mic permission denied"));
        assert!(denied.contains("System Settings"));
        assert!(mic_permission_error(1).is_some(), "restricted blocks too");
        assert_eq!(mic_permission_error(0), None, "not-determined: system prompts");
        assert_eq!(mic_permission_error(3), None, "authorized proceeds");
        assert_eq!(mic_permission_error(99), None, "unknown future status proceeds");
    }

    /// The ObjC plumbing itself: reading the TCC status is side-effect-free
    /// (no prompt, no audio) and must land in the documented enum range.
    #[cfg(target_os = "macos")]
    #[test]
    fn mic_authorization_status_is_a_known_avfoundation_value() {
        let s = mic_authorization_status();
        assert!((0..=3).contains(&s), "unexpected AVAuthorizationStatus {s}");
    }
}
