# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Build/test: `bun run install:safe`, then `bun run test` (vitest), `bun run test:bun`, `bun run typecheck` - see root `package.json` scripts.
- Model routing: an omitted thread model means the broker's `"default"` LANE, never a concrete model id.
  The string `"default"` is a sentinel; lane/chain resolution lives in `packages/core/src/overflow-chain.ts` (`pickLaneTarget`) and the SDK adapter (`packages/adapter-sdk/src/adapter.ts`), provider kinds in `packages/core/src/provider-profile.ts`, role defaults in `packages/core/src/provider-settings/resolver.ts`.
  Never pre-stamp a default model in chat-service; default-model preferences belong in the adapter's default-lane resolution so configured overflow chains and non-Anthropic deployments keep working (PR #253).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
