# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `fourcolors/luna`. See `docs/agents/issue-tracker.md`.

### Triage labels

Engineering skills use the canonical five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Luna uses a single root context with root-level ADRs when they exist. See `docs/agents/domain.md`.

- Build/test: `bun run install:safe`, then `bun run test` (vitest), `bun run test:bun`, `bun run typecheck` - see root `package.json` scripts.
- Run the chat server locally: `bun run --filter '@luna/ui-web' server:chat` (`apps/ui-web/scripts/chat-server.ts`).
- Thread lifecycle: the idle reaper releases only a thread's RUNTIME; recovery on next touch goes through `ensureThreadLive` and the per-thread PubSub map in `packages/chat-service/src/chat-service.ts` (must stay outside the thread scope so pre-reap subscribers keep receiving frames).
- Server auto-update: both channels auto-update via host-side systemd timers by default (stable 15min, dev 3min); the registry knob `deploy.autoUpdate` (absent = true) gates `--from-timer` runs only and never bypasses the connect-aware deferral - see `docs/autodeploy.md` and `scripts/luna-autodeploy`.
- Model routing: an omitted thread model means the broker's `"default"` LANE, never a concrete model id.
  The string `"default"` is a sentinel; lane/chain resolution lives in `packages/core/src/overflow-chain.ts` (`pickLaneTarget`) and the SDK adapter (`packages/adapter-sdk/src/adapter.ts`), provider kinds in `packages/core/src/provider-profile.ts`, role defaults in `packages/core/src/provider-settings/resolver.ts`.
  Never pre-stamp a default model in chat-service; default-model preferences belong in the adapter's default-lane resolution so configured overflow chains and non-Anthropic deployments keep working (PR #253).
- Ollama embedder boot probe (`makeOllamaEmbedderLayer` in `packages/core/src/embedder/embedder.ts`): bounded retry (`maxProbeAttempts`, default 3) then, opt-in via `degradeOnProbeFailure` (default false), a non-fatal degrade if the vector dimension is already known (`LUNA_OLLAMA_EMBED_DIMENSION` / `opts.dimension`), so a deploy-time bad-response window can't crash-loop boot.
  `selectEmbedderLayer` in `packages/memory-tools/src/layer.ts` always passes `degradeOnProbeFailure: true` for the chat-server deploy path; other callers of `makeOllamaEmbedderLayer` fail fast on exhausted retries unless they opt in too.
  Degrade requires a known dimension - an unknown dimension still fails boot fatally, since a guessed dimension would corrupt the `float32[dim]` vectorlite table sizing in `packages/memory/src/backends/sqlite-vector.ts`.
  A declared-vs-probed dimension mismatch is a config error and is never retried or degraded.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
