//! Shared library target for the Moon Tauri app.
//!
//! Exists so the voice pipeline (src/voice/) is ONE implementation shared by
//! the app bin (src/main.rs) and the voice_spike e2e harness bin
//! (src/bin/voice_spike.rs). Everything here is gated behind the `voice`
//! feature — a `--no-default-features --features custom-protocol` build
//! compiles this crate to an empty lib and never touches whisper.cpp / cpal.

#[cfg(feature = "voice")]
pub mod voice;
