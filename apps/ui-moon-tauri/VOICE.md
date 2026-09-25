# Moon Voice — Rust ↔ Webview Contract

Local voice pipeline for the Luna Moon desktop client. The entire audio loop
(mic capture → VAD endpointing → whisper STT → TTS playback) lives in Rust
inside the Tauri core. The webview never touches audio — only text and lean
state events cross the IPC bridge. The Luna server is unchanged: voice input
arrives as ordinary `user-message` frames; spoken replies are synthesized
client-side from the existing `assistant-delta` stream.

```
┌─ Rust (src-tauri/src/voice/) ─────────────────────────────────┐
│ cpal mic → mono/16k → Silero VAD endpointer → whisper (Metal) │
│      TTS router → AVSpeechSynthesizer | Fish Audio ◄─ speak_text │
└── events: voice-state / voice-transcript / voice-error ───────┘
                       ▲ commands │ events ▼
┌─ Webview (frontend/index.html, VoiceEngine) ──────────────────┐
│ transcript → existing user-message send path                  │
│ assistant-delta → sentence splitter → speakable filter        │
│      → speak_text per sentence                                │
│ voice-state → moon visuals (data-voice-state)                 │
└───────────────────────────────────────────────────────────────┘
```

## Modes

| Mode  | Meaning |
|-------|---------|
| `off` | Pipeline stopped, no mic access, no TTS. Default. |
| `ptt` | Push-to-talk: capture only between `voice_ptt_down` and `voice_ptt_up` (mic button hold, or global shortcut hold). |
| `auto`| Hands-free: VAD arms continuously; an utterance auto-endpoints after silence. **Half-duplex**: while TTS is speaking, mic frames are discarded (no AEC in v1); listening re-arms ~300ms after speech ends. |

## States (Rust-owned state machine)

`off → starting → idle ⇄ listening → transcribing → idle` plus `speaking`
(TTS active; in `auto` mode mic is suppressed during `speaking`).
`error` is terminal until the next mode change.

## Tauri commands (webview → Rust)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `voice_status` | – | `VoiceStatus` | Snapshot; safe anytime. |
| `voice_set_mode` | `{ mode: "off"\|"ptt"\|"auto" }` | `VoiceStatus` | Starts/stops the pipeline thread. Model loads lazily on first non-off mode (emits `starting` then `idle`). |
| `voice_ptt_down` | – | – | `ptt` mode only; begins capture. |
| `voice_ptt_up` | – | – | Ends capture window → endpoint → transcribe. |
| `voice_cancel` | – | – | Discard in-flight capture/transcription. |
| `speak_text` | `{ text: string, interrupt: bool }` | – | Enqueue one sentence. `interrupt: true` clears the queue first. No-op when mode is `off` (returns Ok). |
| `voice_stop_speaking` | – | – | Stop playback + clear TTS queue. |
| `voice_list_voices` | – | `Voice[]` | `{ id, name, lang, quality }` — served by the ACTIVE engine (AVSpeech voices on `system`; the Fish catalog on `fish`, empty without a key). |
| `voice_set_voice` | `{ id: string }` | – | Persisted by the frontend, re-applied each session via this call. |
| `voice_set_config` | `{ silenceHangMs?: number }` | – | Endpointing tunables; clamped server-side (200–2000ms). |
| `voice_ensure_model` | – | – (resolves when present) | Downloads ggml model to `~/.luna/models/` via spawned `curl`; progress via `voice-model-progress`. Idempotent. |
| `voice_tts_info` | – | `TtsInfo` | `{ engine, engines, fishKeyConfigured }` — the key itself never crosses IPC. |
| `voice_set_tts_engine` | `{ engine: "system"\|"fish" }` | `String` | Switch live (next `speak_text`); stops every engine first. |
| `voice_fish_set_key` | `{ key: string }` | – | Writes/clears `~/.luna/fish-api-key` (0600, atomic; blank deletes). |

## Events (Rust → webview, via `emit_to("main", …)`)

| Event | Payload | Cadence |
|---|---|---|
| `voice-state` | `{ state, mode, level?: number }` | On every transition; while `listening`, also ~10 Hz with `level` (RMS 0–1) for the visualizer. |
| `voice-transcript` | `{ text: string, final: true }` | Once per utterance (whisper is batch; partials are a later upgrade). Empty/blank transcripts are NOT emitted. |
| `voice-model-progress` | `{ downloadedBytes, totalBytes, done, error? }` | ~2 Hz during `voice_ensure_model`. |
| `voice-error` | `{ message: string }` | Mic permission denied, model load failure, device loss. Frontend surfaces non-blocking banner. |

## Frontend behaviors (VoiceEngine in index.html)

- **Transcript handling**: if the chat input is empty → fill and auto-send
  through the existing send path (identical to typing + Enter, including
  `client` info). If the user has a non-empty draft → append with a space,
  do NOT auto-send (they were mid-edit).
- **Spoken replies**: when mode ≠ `off` and the `speakReplies` setting is on,
  accumulate `assistant-delta` text per message, split into sentences, pass
  each through the speakable filter, and call `speak_text` as sentences
  complete. Flush the remainder on `assistant-done` (per message — yes, this
  speaks intermediate agentic steps; that's intentional, it reads as
  "let me check that…"). `turn-complete` is a safety flush. New user send,
  Esc, or `voice_cancel` → `voice_stop_speaking`.
- **Sentence splitter**: boundary = `[.!?]` (optionally followed by closing
  quote/paren) + whitespace, with ≥ 2 words before the boundary; don't split
  inside code fences; flush on message end regardless.
- **Speakable filter** (markdown → speech): fenced code blocks → `"I've put
  the code in the chat."` (once per consecutive run of blocks); inline code →
  its literal text; links → link text only; strip heading/emphasis/list
  markers, tables → `"There's a table in the chat."`; strip emoji.
- **Moon visuals**: `moonWrapper.dataset.voiceState = state` (`""` when off).
  CSS drives: `listening` = soft watercolor pulse scaled by `level`,
  `transcribing` = brief inward shimmer, `speaking` = gentle outward ripple.
  Painterly, no gloss.
- **Mic button**: in the chat header; click toggles listening in `auto`
  mode, press-and-hold acts as PTT in `ptt` mode.
- **Global PTT shortcut**: registered Rust-side (tauri-plugin-global-shortcut
  supports Pressed/Released) only while mode = `ptt`. Default
  `Cmd+Shift+Space`.

## Settings (localStorage keys, Settings → Voice section)

| Key | Values | Default |
|---|---|---|
| `luna_voice_mode` | `off\|ptt\|auto` | `off` |
| `luna_voice_speak_replies` | `"1"\|"0"` | `"1"` |
| `luna_voice_tts_engine` | `system\|fish` | `system` |
| `luna_voice_id` | AVSpeech voice identifier (system engine) | unset (system default) |
| `luna_voice_fish_id` | Fish `reference_id` (fish engine) | unset (Fish default voice) |
| `luna_voice_silence_hang_ms` | number | `600` |

On boot, frontend re-applies persisted settings via `voice_set_mode`,
`voice_set_tts_engine` (engine BEFORE voice — `voice_set_voice` targets the
active engine), `voice_set_voice`, `voice_set_config`.

## Fish Audio engine

`engine = "fish"` routes `speak_text` through Fish Audio instead of the
platform synthesizer. API shape (defaults; `LUNA_FISH_API_BASE` /
`LUNA_FISH_MODEL` override for tests or a self-hosted endpoint):

- `POST {base}/v1/tts` with `Authorization: Bearer <key>` and
  `model: <id>` (`s2.1-pro-free` — Fish's free dev tier); body
  `{ text, format: "wav", sample_rate, reference_id? }`.
- `GET {base}/model` (own voices) + the public catalog merge into
  `voice_list_voices`; a picked voice is stored as `reference_id`.

The key resolves `FISH_API_KEY` env → `~/.luna/fish-api-key` (0600). Audio
streams into the cpal output sink as it downloads (WAV header parsed
incrementally — a non-RIFF body is an API error, surfaced as `voice-error`),
resampled to the device rate. Stop kills the in-flight `curl`.

Non-macOS builds: the platform engine is `NoopTts`, so Fish is the only real
engine there — first speech support off macOS.

## Rust module layout (src-tauri/src/voice/)

```
mod.rs        VoiceController: state machine, pipeline thread lifecycle,
              command entry points, event emission. Owns Arc<Mutex<Shared>>.
capture.rs    cpal input stream (created and owned BY the pipeline thread —
              cpal streams are !Send), downmix + resample to 16k mono.
endpoint.rs   VAD endpointer (from the spike), generic over the
              speech-probability fn so unit tests inject synthetic probs.
stt.rs        SttEngine trait + WhisperEngine (ONE long-lived context +
              state, reused across utterances — re-creating state re-inits
              the Metal backend, measured +300ms in the spike).
tts.rs        TtsEngine trait + NoopTts + create_platform_tts() factory.
tts_router.rs TtsRouter: engine registry + active selection + a mirror
              thread OR-ing every engine's speaking flag into one atomic
              (correct across mid-utterance engine switches). TtsRouterHandle
              backs voice_tts_info / voice_set_tts_engine / voice_fish_set_key.
tts_avspeech.rs  (cfg target_os = "macos") AVSpeechSynthesizer engine on a
              dedicated thread with a command channel; isSpeaking polled
              ~10 Hz to drive the speaking state.
tts_fish.rs   Fish Audio engine: spawned `curl` POST streams WAV into the
              sink; pump thread parses the RIFF header, pipes PCM16 through
              the resampler; own+public /model catalog → list_voices.
playback.rs   AudioSink trait + CpalSink (cpal output stream, shared sample
              queue → device callback) + QueueSink test sink.
model.rs      whisper model presence check + curl-spawn download with
              file-size-poll progress (tokio::process, already a dep).
```

Cargo: voice deps live under a `voice` feature, **on by default** for the
app; `voice-spike` bin requires it. Non-macOS builds compile with NoopTts.

## Testing

- Rust: endpointer unit tests with injected probability sequences;
  controller transition tests with mock Stt/Tts engines (no audio device
  needed); the spike binary remains the live e2e harness.
- JS (moon-app.test.ts pattern — script extracted from index.html into
  jsdom): sentence splitter + speakable filter + transcript draft/auto-send
  rules + settings persistence. `window.__TAURI__.core.invoke` and
  `event.listen` must be mocked in the test bootstrap.
- Whole-pipeline audio e2e: `say` → wav → spike (already in place).
