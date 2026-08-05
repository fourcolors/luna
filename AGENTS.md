# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `fourcolors/luna`. See `docs/agents/issue-tracker.md`.

### Triage labels

Engineering skills use the canonical five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Luna uses a single root context with root-level ADRs when they exist. See `docs/agents/domain.md`.

- Moon OS window drag/resize: `apps/ui-moon-tauri/docs/window-drag-snap.md` (AppKit owns free motion; no JS setPosition loops).
- Moon Chrome-tab thread detach/redock: `apps/ui-moon-tauri/docs/chrome-tab-interaction.md` (principles + phased plan; read before changing pull-out/redock).
- Build/test: `bun run install:safe`, then `bun run test` (vitest), `bun run test:bun`, `bun run typecheck` - see root `package.json` scripts.
- Moon UI E2E (macOS): `cd apps/ui-moon-tauri && bun run test:e2e:ci` builds with Cargo feature `wdio-e2e` (embedded WebDriver) and runs WebdriverIO specs under `e2e/` - see `apps/ui-moon-tauri/e2e/README.md`.
- Run the chat server locally: `bun run scripts/luna-chat-server-entry.ts` (boots `apps/server/src/chat-server.ts` via the path-stable launcher).
- Thread lifecycle: the idle reaper releases only a thread's RUNTIME; recovery on next touch goes through `ensureThreadLive` and the per-thread PubSub map in `packages/chat-service/src/chat-service.ts` (must stay outside the thread scope so pre-reap subscribers keep receiving frames).
- Server auto-update: new installs use the host-side `luna-guardian-<profile>.timer`; its pinned updater respects `deploy.autoUpdate` (absent = true) and connect-aware deferral. The legacy `luna-autodeploy-<profile>.timer` is removed when guardian installs - see `docs/autodeploy.md`.
- Runtime guardian: `scripts/luna-guardian` is the independent deep-health/recovery/update module; systemd `Type=notify` remains the fast liveness mechanism. Update transactions are locked and journaled outside the checkout so a killed deploy resumes instead of no-oping at a half-applied HEAD.
- Guardian rollout completion: a merge/release is not deployed until the pinned `luna-guardian accept <profile> --expected-sha <full-sha> --min-cycles 2` interface passes; it proves timer handoff, exact runtime/engine SHA, watchdog supervision, clean transaction state, `luna-doctor`, and consecutive healthy cycles. Connected-session deferral leaves completion pending.
- Model routing: an omitted thread model means the broker's `"default"` LANE, never a concrete model id.
  The string `"default"` is a sentinel; lane/chain resolution lives in `packages/core/src/overflow-chain.ts` (`pickLaneTarget`) and the SDK adapter (`packages/adapter-sdk/src/adapter.ts`), provider kinds in `packages/core/src/provider-profile.ts`, role defaults in `packages/core/src/provider-settings/resolver.ts`.
  Never pre-stamp a default model in chat-service; default-model preferences belong in the adapter's default-lane resolution so configured overflow chains and non-Anthropic deployments keep working (PR #253).
- Ollama embedder boot probe (`makeOllamaEmbedderLayer` in `packages/core/src/embedder/embedder.ts`): bounded retry (`maxProbeAttempts`, default 3) then, opt-in via `degradeOnProbeFailure` (default false), a non-fatal degrade if the vector dimension is already known (`LUNA_OLLAMA_EMBED_DIMENSION` / `opts.dimension`), so a deploy-time bad-response window can't crash-loop boot.
  `selectEmbedderLayer` in `packages/memory-tools/src/layer.ts` always passes `degradeOnProbeFailure: true` for the chat-server deploy path; other callers of `makeOllamaEmbedderLayer` fail fast on exhausted retries unless they opt in too.
  Degrade requires a known dimension - an unknown dimension still fails boot fatally, since a guessed dimension would corrupt the `float32[dim]` vectorlite table sizing in `packages/memory/src/backends/sqlite-vector.ts`.
  A declared-vs-probed dimension mismatch is a config error and is never retried or degraded at boot; if boot was degraded (probe failed), the first successful real `embed()` re-checks length vs the declared dimension and fails sticky-loud so a wrong env dim is not only seen as a wall of per-write sqlite-vector errors.
  Provisioning: `scripts/luna-server-install` / `scripts/luna-container-create` accept `--ollama-probe-attempts` / `--ollama-probe-backoff-ms` (and related ollama flags) into `.env`.
- Vault is a metadata registry plus tiered value storage; `vault_items` never contains values. `LUNA_VAULT_STORAGE` defaults to `auto` (Darwin Keychain, encrypted Luna vault elsewhere), while `env` is the explicit plaintext escape hatch. Reads, writes, all-tier deletion, integrity behavior, migration, backup, and verification are documented in `docs/audits/luna-vault-keychain-migration.md`; composition lives in `apps/ui-web/scripts/secret-chain.ts`, routing in `vault-secret-store.ts`, and registry/sync logic in `packages/vault/src/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
